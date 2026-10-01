import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  SAFE_GIT_BASE_ARGS,
  SAFE_GIT_GLOBAL_FLAGS,
  buildSafeGitEnv,
} from './safe-git.js';
import type {
  RemoteGitInspectInput,
  RemoteGitInspectObservation,
  RemoteGitPushBackend,
  RemoteGitPushBackendOutcome,
  RemoteGitPushInput,
  RemoteGitPushPlan,
} from './remote-git-push.js';
import type { RemoteGitPushRecord } from './remote-git-push-store.js';

const execFileAsync = promisify(execFile);
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_GIT_OUTPUT = 256 * 1024;
const READ_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 60_000;

const DANGEROUS_CONFIG = [
  /^alias\./i,
  /^core\.sshcommand$/i,
  /^core\.hookspath$/i,
  /^protocol\..*\.allow$/i,
  /^url\..*\.(?:insteadof|pushinsteadof)$/i,
  /^remote\..*\.pushurl$/i,
  /^hook\./i,
  /^http\..*extraheader$/i,
  /^http\..*proxy$/i,
  /^http\.proxy$/i,
  /^remote\..*\.proxy$/i,
] as const;

type RemoteCredentialMode = 'none' | 'system-gcm';

export interface RemoteGitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type RemoteGitCommandRunner = (
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number; env: Readonly<Record<string, string>> },
) => Promise<RemoteGitCommandResult>;

export interface RemoteGitPushBackendOptions {
  hooksDir: string;
  runner?: RemoteGitCommandRunner;
  parentEnv?: NodeJS.ProcessEnv;
}

export class LocalRemoteGitPushBackend implements RemoteGitPushBackend {
  readonly #hooksDir: string;
  readonly #runner: RemoteGitCommandRunner;
  readonly #parentEnv: NodeJS.ProcessEnv;

  constructor(options: RemoteGitPushBackendOptions) {
    if (!isAbsolute(options.hooksDir)) {
      throw new Error('Remote Git push hooks directory must be absolute');
    }
    this.#hooksDir = resolve(options.hooksDir);
    this.#runner = options.runner ?? runGitProcess;
    this.#parentEnv = options.parentEnv ?? process.env;
  }

  async inspect(
    workspaceRoot: string,
    input: RemoteGitInspectInput,
  ): Promise<RemoteGitInspectObservation> {
    await this.#ensureHooksDir();
    const context = await this.#inspectRepository(workspaceRoot, input.remote);
    for (const ref of input.refs) await this.#assertReadableHeadRef(workspaceRoot, ref);
    const observed = await this.#observeRemoteRefs(
      workspaceRoot,
      context.resolvedPushUrl,
      input.refs,
      context.credentialMode,
    );
    return {
      repositoryIdentity: context.repositoryIdentity,
      effectiveFetchUrl: context.resolvedFetchUrl,
      effectivePushUrl: context.resolvedPushUrl,
      defaultBranch: observed.defaultBranch ?? null,
      refs: input.refs.map((ref) => ({ ref, oid: observed.refs.get(ref) ?? null })),
      authenticationState:
        context.resolvedPushUrl.startsWith('https:') && context.credentialMode === 'system-gcm'
          ? 'AVAILABLE'
          : 'UNKNOWN',
    };
  }

  async plan(workspaceRoot: string, input: RemoteGitPushInput): Promise<RemoteGitPushPlan> {
    await this.#ensureHooksDir();
    const context = await this.#inspectRepository(workspaceRoot, input.remote);
    await this.#assertCommit(workspaceRoot, input.sourceOid);
    await this.#assertDestinationRef(workspaceRoot, input.destinationRef);

    const remote = await this.#observeRemote(
      workspaceRoot,
      context.resolvedPushUrl,
      input.destinationRef,
      context.credentialMode,
    );
    if (remote.defaultBranch === undefined) {
      throw new Error('Gateway could not prove remote Git default branch');
    }
    if (remote.defaultBranch === input.destinationRef) {
      throw new Error('Gateway denied remote Git push default branch');
    }

    let aheadCommitCount: number | undefined;
    let changedFilesSummary: string;
    if (remote.destinationOid !== undefined) {
      await this.#assertCommit(workspaceRoot, remote.destinationOid);
      await this.#assertFastForward(workspaceRoot, remote.destinationOid, input.sourceOid);
      aheadCommitCount = await this.#aheadCount(
        workspaceRoot,
        remote.destinationOid,
        input.sourceOid,
      );
      changedFilesSummary = await this.#changedFilesSummary(workspaceRoot, input.sourceOid);
    } else {
      const remoteReviewRefGlob = await this.#freshRemoteReviewRefs(
        workspaceRoot,
        context.resolvedPushUrl,
        context.credentialMode,
      );
      aheadCommitCount = await this.#newlyReachableCount(
        workspaceRoot,
        input.sourceOid,
        remoteReviewRefGlob,
      );
      changedFilesSummary = await this.#newlyReachableFilesSummary(
        workspaceRoot,
        input.sourceOid,
        remoteReviewRefGlob,
      );
    }

    return {
      repositoryIdentity: context.repositoryIdentity,
      resolvedPushUrl: context.resolvedPushUrl,
      sourceOid: input.sourceOid,
      destinationRef: input.destinationRef,
      expectedRemoteState: remote.destinationOid === undefined
        ? { kind: 'ABSENT' }
        : { kind: 'OID', oid: remote.destinationOid },
      commitSubject: await this.#commitSubject(workspaceRoot, input.sourceOid),
      changedFilesSummary,
      ...(aheadCommitCount === undefined ? {} : { aheadCommitCount }),
    };
  }

  async execute(record: RemoteGitPushRecord): Promise<RemoteGitPushBackendOutcome> {
    await this.#ensureHooksDir();
    try {
      const context = await this.#inspectRepository(
        record.workspaceRoot,
        record.remoteDisplayName,
      );
      if (
        context.repositoryIdentity !== record.repositoryIdentity
        || context.resolvedPushUrl !== record.resolvedPushUrl
      ) {
        return {
          outcome: 'NOT_OBSERVED',
          errorClass: 'REMOTE_IDENTITY_DRIFT',
        };
      }
      await this.#assertCommit(record.workspaceRoot, record.sourceOid);
      await this.#assertDestinationRef(record.workspaceRoot, record.destinationRef);

      const before = await this.#observeRemote(
        record.workspaceRoot,
        record.resolvedPushUrl,
        record.destinationRef,
        context.credentialMode,
      );
      if (before.defaultBranch === undefined) {
        return { outcome: 'NOT_OBSERVED', errorClass: 'DEFAULT_BRANCH_UNPROVEN' };
      }
      if (before.defaultBranch === record.destinationRef) {
        return { outcome: 'NOT_OBSERVED', errorClass: 'DEFAULT_BRANCH_REFUSED' };
      }
      if (!expectedMatches(record, before.destinationOid)) {
        return {
          outcome: before.destinationOid === record.sourceOid ? 'SUCCEEDED' : 'NOT_OBSERVED',
          ...(before.destinationOid === undefined ? {} : { observedRemoteOid: before.destinationOid }),
          ...(before.destinationOid === record.sourceOid ? {} : { errorClass: 'REMOTE_STATE_DRIFT' }),
        } as RemoteGitPushBackendOutcome;
      }
      if (record.expectedRemoteState.kind === 'OID') {
        await this.#assertCommit(record.workspaceRoot, record.expectedRemoteState.oid);
        await this.#assertFastForward(
          record.workspaceRoot,
          record.expectedRemoteState.oid,
          record.sourceOid,
        );
      }

      const lease = record.expectedRemoteState.kind === 'OID'
        ? '--force-with-lease=' + record.destinationRef + ':' + record.expectedRemoteState.oid
        : '--force-with-lease=' + record.destinationRef + ':';
      const refspec = record.sourceOid + ':' + record.destinationRef;
      await this.#run(
        record.workspaceRoot,
        [
          ...this.#remoteSafeBaseArgs(context.credentialMode),
          'push',
          '--no-verify',
          '--porcelain',
          lease,
          record.resolvedPushUrl,
          refspec,
        ],
        PUSH_TIMEOUT_MS,
        true,
      ).catch(() => undefined);

      return this.reconcile(record);
    } catch (error) {
      const reconciled = await this.reconcile(record).catch(() => ({
        outcome: 'OUTCOME_UNKNOWN' as const,
      }));
      if (reconciled.outcome === 'SUCCEEDED') return reconciled;
      return {
        ...reconciled,
        errorClass: errorClass(error),
      };
    }
  }

  async reconcile(record: RemoteGitPushRecord): Promise<RemoteGitPushBackendOutcome> {
    try {
      const context = await this.#inspectRepository(
        record.workspaceRoot,
        record.remoteDisplayName,
      );
      if (
        context.repositoryIdentity !== record.repositoryIdentity
        || context.resolvedPushUrl !== record.resolvedPushUrl
      ) {
        return { outcome: 'OUTCOME_UNKNOWN', errorClass: 'REMOTE_IDENTITY_DRIFT' };
      }
      const observed = await this.#observeRemote(
        record.workspaceRoot,
        record.resolvedPushUrl,
        record.destinationRef,
        context.credentialMode,
      );
      if (observed.destinationOid === record.sourceOid) {
        return { outcome: 'SUCCEEDED', observedRemoteOid: record.sourceOid };
      }
      if (expectedMatches(record, observed.destinationOid)) {
        return {
          outcome: 'NOT_OBSERVED',
          ...(observed.destinationOid === undefined ? {} : { observedRemoteOid: observed.destinationOid }),
        };
      }
      if (observed.destinationOid !== undefined) {
        return {
          outcome: 'DIVERGENT_REMOTE',
          observedRemoteOid: observed.destinationOid,
        };
      }
      return {
        outcome: 'DIVERGENT_REMOTE',
        observedRemoteOid: 'ABSENT',
      };
    } catch (error) {
      return {
        outcome: 'OUTCOME_UNKNOWN',
        errorClass: errorClass(error),
      };
    }
  }

  async #inspectRepository(workspaceRoot: string, remoteName: string): Promise<{
    repositoryIdentity: string;
    resolvedFetchUrl: string;
    resolvedPushUrl: string;
    credentialMode: RemoteCredentialMode;
  }> {
    const credentialMode = await this.#assertDangerousConfigAbsent(workspaceRoot);

    const rootResult = await this.#run(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'rev-parse', '--show-toplevel'],
      READ_TIMEOUT_MS,
    );
    const gitDirResult = await this.#run(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'rev-parse', '--absolute-git-dir'],
      READ_TIMEOUT_MS,
    );
    const commonDirResult = await this.#run(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      READ_TIMEOUT_MS,
    );
    const canonicalWorkspace = await canonicalPath(workspaceRoot);
    const canonicalHooks = await canonicalPath(this.#hooksDir);
    if (pathContains(canonicalWorkspace, canonicalHooks)) {
      throw new Error('Gateway denied remote Git push hooks directory inside repository');
    }
    const observedRoot = await canonicalPath(singleLine(rootResult.stdout, 'repository root'));
    if (foldPath(canonicalWorkspace) !== foldPath(observedRoot)) {
      throw new Error('Gateway denied remote Git push repository root drift');
    }
    const gitDir = await canonicalPath(singleLine(gitDirResult.stdout, 'git dir'));
    const commonDir = await canonicalPath(singleLine(commonDirResult.stdout, 'git common dir'));

    const fetchUrlResult = await this.#run(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'remote', 'get-url', '--all', remoteName],
      READ_TIMEOUT_MS,
    );
    const fetchLines = nonEmptyLines(fetchUrlResult.stdout);
    if (fetchLines.length !== 1) {
      throw new Error('Gateway denied ambiguous remote Git fetch URL');
    }
    const resolvedFetchUrl = canonicalRemotePushUrl(fetchLines[0]!);

    const pushUrlResult = await this.#run(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'remote', 'get-url', '--push', '--all', remoteName],
      READ_TIMEOUT_MS,
    );
    const pushLines = nonEmptyLines(pushUrlResult.stdout);
    if (pushLines.length !== 1) {
      throw new Error('Gateway denied ambiguous remote Git push URL');
    }
    const resolvedPushUrl = canonicalRemotePushUrl(pushLines[0]!);
    const repositoryIdentity = 'repo_' + sha256(
      [foldPath(canonicalWorkspace), foldPath(gitDir), foldPath(commonDir)].join('\0'),
    );
    return {
      repositoryIdentity,
      resolvedFetchUrl,
      resolvedPushUrl,
      credentialMode: resolvedPushUrl.startsWith('https:') ? credentialMode : 'none',
    };
  }

  async #assertDangerousConfigAbsent(workspaceRoot: string): Promise<RemoteCredentialMode> {
    const result = await this.#runAllowExit(
      workspaceRoot,
      [
        ...SAFE_GIT_GLOBAL_FLAGS,
        'config',
        '--show-origin',
        '--show-scope',
        '--name-only',
        '--get-regexp',
        '.',
      ],
      READ_TIMEOUT_MS,
    );
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error('Gateway could not prove effective Git config safety');
    }

    let hasCredentialHelper = false;
    for (const line of nonEmptyLines(result.stdout)) {
      const key = configKeyFromLine(line);
      if (key === undefined) {
        throw new Error('Gateway could not parse effective Git config');
      }
      if (key.toLowerCase() === 'credential.helper') {
        hasCredentialHelper = true;
        continue;
      }
      if (DANGEROUS_CONFIG.some((pattern) => pattern.test(key))) {
        throw new Error('Gateway denied dangerous effective Git config: ' + key);
      }
    }
    if (!hasCredentialHelper) return 'none';

    const helpers = await this.#runAllowExit(
      workspaceRoot,
      [
        ...SAFE_GIT_GLOBAL_FLAGS,
        'config',
        '--show-origin',
        '--show-scope',
        '--get-all',
        'credential.helper',
      ],
      READ_TIMEOUT_MS,
    );
    if (helpers.exitCode !== 0) {
      throw new Error('Gateway could not prove credential helper provenance');
    }

    const trustedOrigins = trustedGitForWindowsSystemConfigOrigins(this.#parentEnv);
    const lines = nonEmptyLines(helpers.stdout);
    if (lines.length === 0 || trustedOrigins.size === 0) {
      throw new Error('Gateway denied dangerous effective Git config: credential.helper');
    }
    for (const line of lines) {
      const entry = scopedConfigValue(line);
      if (
        entry === undefined
        || entry.scope !== 'system'
        || !trustedOrigins.has(normalizeConfigOrigin(entry.origin))
        || (entry.value !== 'manager' && entry.value !== 'manager-core')
      ) {
        throw new Error('Gateway denied dangerous effective Git config: credential.helper');
      }
    }
    return 'system-gcm';
  }

  async #assertCommit(workspaceRoot: string, oid: string): Promise<void> {
    if (!OID.test(oid)) throw new Error('Gateway denied remote Git push object id');
    const result = await this.#runAllowExit(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'cat-file', '-e', oid + '^{commit}'],
      READ_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) throw new Error('Gateway denied remote Git push missing commit');
  }

  async #assertReadableHeadRef(workspaceRoot: string, ref: string): Promise<void> {
    const result = await this.#runAllowExit(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'check-ref-format', ref],
      READ_TIMEOUT_MS,
    );
    if (result.exitCode !== 0 || !ref.startsWith('refs/heads/')) {
      throw new Error('Gateway denied remote Git inspect ref');
    }
  }

  async #assertDestinationRef(workspaceRoot: string, ref: string): Promise<void> {
    await this.#assertReadableHeadRef(workspaceRoot, ref);
    const name = ref.slice('refs/heads/'.length).toLowerCase();
    if (name === 'main' || name === 'master') {
      throw new Error('Gateway denied remote Git push protected branch');
    }
  }

  async #assertFastForward(workspaceRoot: string, oldOid: string, sourceOid: string): Promise<void> {
    const result = await this.#runAllowExit(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'merge-base', '--is-ancestor', oldOid, sourceOid],
      READ_TIMEOUT_MS,
    );
    if (result.exitCode === 1) {
      throw new Error('Gateway denied non-fast-forward remote Git push');
    }
    if (result.exitCode !== 0) {
      throw new Error('Gateway could not prove remote Git push ancestry');
    }
  }

  async #aheadCount(workspaceRoot: string, oldOid: string, sourceOid: string): Promise<number> {
    const result = await this.#run(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'rev-list', '--count', oldOid + '..' + sourceOid],
      READ_TIMEOUT_MS,
    );
    const value = Number(singleLine(result.stdout, 'ahead count'));
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Gateway rejected remote Git push ahead count');
    }
    return value;
  }

  async #freshRemoteReviewRefs(
    workspaceRoot: string,
    url: string,
    credentialMode: RemoteCredentialMode,
  ): Promise<string> {
    const refPrefix = 'refs/wag/remote-review/' + sha256(url).slice(0, 16);
    await this.#run(
      workspaceRoot,
      [
        ...this.#remoteSafeBaseArgs(credentialMode),
        'fetch',
        '--no-tags',
        '--prune',
        '--no-write-fetch-head',
        url,
        '+refs/heads/*:' + refPrefix + '/*',
      ],
      PUSH_TIMEOUT_MS,
      true,
    );
    return refPrefix + '/*';
  }

  async #newlyReachableCount(
    workspaceRoot: string,
    sourceOid: string,
    remoteReviewRefGlob: string,
  ): Promise<number> {
    const result = await this.#run(
      workspaceRoot,
      [
        ...this.#remoteSafeBaseArgs(),
        'rev-list',
        '--count',
        sourceOid,
        '--not',
        '--glob=' + remoteReviewRefGlob,
      ],
      READ_TIMEOUT_MS,
    );
    const value = Number(singleLine(result.stdout, 'newly reachable count'));
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Gateway rejected remote Git push newly reachable count');
    }
    return value;
  }

  async #newlyReachableFilesSummary(
    workspaceRoot: string,
    sourceOid: string,
    remoteReviewRefGlob: string,
  ): Promise<string> {
    const result = await this.#run(
      workspaceRoot,
      [
        ...this.#remoteSafeBaseArgs(),
        'log',
        '--format=',
        '--name-only',
        '--max-count=256',
        sourceOid,
        '--not',
        '--glob=' + remoteReviewRefGlob,
      ],
      READ_TIMEOUT_MS,
    );
    const candidates = [...new Set(nonEmptyLines(result.stdout))];
    const shown: string[] = [];
    for (const path of candidates) {
      if (shown.length >= 20) break;
      const candidate = 'newly reachable files (showing ' + (shown.length + 1) + '): '
        + [...shown, path].join('; ');
      if (candidate.length > 1000) break;
      shown.push(path);
    }
    return shown.length === 0
      ? 'newly reachable files (showing 0): none'
      : 'newly reachable files (showing ' + shown.length + '): ' + shown.join('; ');
  }

  async #commitSubject(workspaceRoot: string, sourceOid: string): Promise<string> {
    const result = await this.#run(
      workspaceRoot,
      [...this.#remoteSafeBaseArgs(), 'show', '-s', '--format=%s', sourceOid],
      READ_TIMEOUT_MS,
    );
    const subject = singleLine(result.stdout, 'commit subject');
    if (subject.length === 0 || subject.length > 512) {
      throw new Error('Gateway rejected remote Git push commit subject');
    }
    return subject;
  }

  async #changedFilesSummary(workspaceRoot: string, sourceOid: string): Promise<string> {
    const result = await this.#run(
      workspaceRoot,
      [
        ...this.#remoteSafeBaseArgs(),
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--shortstat',
        '-r',
        sourceOid,
      ],
      READ_TIMEOUT_MS,
    );
    const summary = result.stdout.trim().replace(/\s+/g, ' ');
    return summary === '' ? 'source commit changes: none' : 'source commit changes: ' + summary;
  }

  async #observeRemote(
    workspaceRoot: string,
    url: string,
    destinationRef: string,
    credentialMode: RemoteCredentialMode,
  ): Promise<{ destinationOid?: string; defaultBranch?: string }> {
    const observed = await this.#observeRemoteRefs(
      workspaceRoot,
      url,
      [destinationRef],
      credentialMode,
    );
    const destinationOid = observed.refs.get(destinationRef);
    return {
      ...(destinationOid === undefined ? {} : { destinationOid }),
      ...(observed.defaultBranch === undefined ? {} : { defaultBranch: observed.defaultBranch }),
    };
  }

  async #observeRemoteRefs(
    workspaceRoot: string,
    url: string,
    refs: readonly string[],
    credentialMode: RemoteCredentialMode,
  ): Promise<{ refs: Map<string, string>; defaultBranch?: string }> {
    const result = await this.#run(
      workspaceRoot,
      [
        ...this.#remoteSafeBaseArgs(credentialMode),
        'ls-remote',
        '--symref',
        url,
        'HEAD',
        ...refs,
      ],
      READ_TIMEOUT_MS,
      true,
    );
    const requested = new Set(refs);
    const observed = new Map<string, string>();
    let defaultBranch: string | undefined;
    for (const line of nonEmptyLines(result.stdout)) {
      const symref = /^ref:\s+(\S+)\s+HEAD$/.exec(line);
      if (symref) {
        if (defaultBranch !== undefined && defaultBranch !== symref[1]) {
          throw new Error('Gateway rejected ambiguous remote Git default branch');
        }
        defaultBranch = symref[1]!;
        continue;
      }
      const direct = /^([0-9a-f]{40}|[0-9a-f]{64})\s+(\S+)$/.exec(line);
      if (!direct) throw new Error('Gateway rejected malformed remote Git observation');
      const ref = direct[2]!;
      if (ref === 'HEAD') continue;
      if (!requested.has(ref)) throw new Error('Gateway rejected unexpected remote Git ref');
      const existing = observed.get(ref);
      if (existing !== undefined && existing !== direct[1]) {
        throw new Error('Gateway rejected ambiguous remote Git ref state');
      }
      observed.set(ref, direct[1]!);
    }
    return {
      refs: observed,
      ...(defaultBranch === undefined ? {} : { defaultBranch }),
    };
  }

  #remoteSafeBaseArgs(credentialMode: RemoteCredentialMode = 'none'): string[] {
    return [
      ...safeGitBaseArgsForCredentialMode(credentialMode),
      '-c', 'credential.interactive=false',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always',
      '-c', 'http.followRedirects=false',
      '-c', 'core.hooksPath=' + this.#hooksDir,
    ];
  }

  async #run(
    cwd: string,
    args: readonly string[],
    timeoutMs: number,
    remote = false,
  ): Promise<RemoteGitCommandResult> {
    const result = await this.#runAllowExit(cwd, args, timeoutMs, remote);
    if (result.exitCode !== 0) {
      throw new Error(result.timedOut ? 'REMOTE_GIT_TIMEOUT' : 'REMOTE_GIT_COMMAND_FAILED');
    }
    return result;
  }

  async #runAllowExit(
    cwd: string,
    args: readonly string[],
    timeoutMs: number,
    remote = false,
  ): Promise<RemoteGitCommandResult> {
    const env = buildSafeGitEnv(
      this.#parentEnv,
      remote && process.platform !== 'win32'
        ? { GIT_SSH_COMMAND: 'ssh -F /dev/null -oBatchMode=yes -oClearAllForwardings=yes -oProxyCommand=none -oProxyJump=none' }
        : remote
          ? { GIT_SSH_COMMAND: 'ssh -F NUL -oBatchMode=yes -oClearAllForwardings=yes -oProxyCommand=none -oProxyJump=none' }
          : {},
    );
    if (remote) env.GCM_INTERACTIVE = 'Never';
    return this.#runner(cwd, args, { timeoutMs, env });
  }

  async #ensureHooksDir(): Promise<void> {
    await mkdir(this.#hooksDir, { recursive: true });
    const info = await lstat(this.#hooksDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Remote Git push hooks directory is not WAG-owned directory material');
    }
    if ((await readdir(this.#hooksDir)).length !== 0) {
      throw new Error('Remote Git push hooks directory must be empty');
    }
  }
}

export function canonicalRemotePushUrl(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('Gateway denied remote Git push URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Gateway denied unsupported remote Git push URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    throw new Error('Gateway denied unsupported remote Git push protocol');
  }
  if (url.password !== '' || (url.protocol === 'https:' && url.username !== '')) {
    throw new Error('Gateway denied credential-bearing remote Git push URL');
  }
  if (
    url.hostname === ''
    || url.pathname === ''
    || url.pathname === '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('Gateway denied remote Git push URL');
  }
  return url.href;
}

function configKeyFromLine(line: string): string | undefined {
  const parts = line.trim().split(/\s+/);
  const key = parts[parts.length - 1];
  if (!key || /\s/.test(key)) return undefined;
  return key;
}

function scopedConfigValue(line: string): { scope: string; origin: string; value: string } | undefined {
  const parts = line.split('\t');
  if (parts.length < 3) return undefined;
  const scope = parts[0]?.trim();
  const origin = parts[1]?.trim();
  const value = parts.slice(2).join('\t').trim();
  if (!scope || !origin || !value) return undefined;
  return { scope, origin, value };
}

function normalizeConfigOrigin(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/{2,}/g, '/').toLowerCase();
}

function trustedGitForWindowsSystemConfigOrigins(env: NodeJS.ProcessEnv): Set<string> {
  const roots = new Set<string>();
  for (const key of [
    'ProgramFiles',
    'PROGRAMFILES',
    'ProgramW6432',
    'PROGRAMW6432',
    'ProgramFiles(x86)',
    'PROGRAMFILES(X86)',
  ]) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') roots.add(value.trim());
  }

  // The production tunnel intentionally starts WAG with a minimal environment, so ProgramFiles
  // may be absent even though Git for Windows still reads its system config from the standard
  // installation root. Derive those two roots from the system drive instead of weakening the
  // provenance check to an arbitrary system-scope file.
  const systemDrive = (
    env.SystemDrive
    ?? env.SYSTEMDRIVE
    ?? 'C:'
  ).replace(/[\\/]$/, '');
  roots.add(systemDrive + '\\Program Files');
  roots.add(systemDrive + '\\Program Files (x86)');

  return new Set(
    [...roots].map((root) => normalizeConfigOrigin(
      'file:' + root.replaceAll('\\', '/').replace(/\/$/, '') + '/Git/etc/gitconfig',
    )),
  );
}

function safeGitBaseArgsForCredentialMode(mode: RemoteCredentialMode): string[] {
  if (mode === 'none') return [...SAFE_GIT_BASE_ARGS];
  const result: string[] = [];
  let removed = 0;
  for (let index = 0; index < SAFE_GIT_BASE_ARGS.length; index += 1) {
    if (
      SAFE_GIT_BASE_ARGS[index] === '-c'
      && SAFE_GIT_BASE_ARGS[index + 1] === 'credential.helper='
    ) {
      removed += 1;
      index += 1;
      continue;
    }
    result.push(SAFE_GIT_BASE_ARGS[index]!);
  }
  if (removed !== 1) {
    throw new Error('Gateway remote Git credential policy is internally inconsistent');
  }
  return result;
}

function expectedMatches(record: RemoteGitPushRecord, observedOid: string | undefined): boolean {
  return record.expectedRemoteState.kind === 'ABSENT'
    ? observedOid === undefined
    : observedOid === record.expectedRemoteState.oid;
}

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function singleLine(value: string, label: string): string {
  const lines = nonEmptyLines(value);
  if (lines.length !== 1) throw new Error('Gateway rejected malformed ' + label);
  return lines[0]!;
}

async function canonicalPath(path: string): Promise<string> {
  return resolve(await realpath(path));
}

function foldPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function pathContains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  if (/^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return error.constructor.name;
}

async function runGitProcess(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number; env: Readonly<Record<string, string>> },
): Promise<RemoteGitCommandResult> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      env: options.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const value = error as Error & {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
      signal?: NodeJS.Signals;
    };
    const code = typeof value.code === 'number'
      ? value.code
      : typeof value.code === 'string' && /^\d+$/.test(value.code)
        ? Number(value.code)
        : 2;
    return {
      exitCode: code,
      stdout: typeof value.stdout === 'string' ? value.stdout : value.stdout?.toString('utf8') ?? '',
      stderr: typeof value.stderr === 'string' ? value.stderr : value.stderr?.toString('utf8') ?? '',
      ...(value.killed || value.signal ? { timedOut: true } : {}),
    };
  }
}
