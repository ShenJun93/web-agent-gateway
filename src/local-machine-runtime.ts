import { spawn } from 'node:child_process';
import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { sameAuthorityTuple } from './authority-tuple.js';
import type { GatewayCallerContext } from './caller-context.js';
import type { SqliteDurableStore, WorkspaceRecord } from './durable-store.js';
import { sanitizeLocalMachineEnvironment } from './environment-policy.js';
import { describeReadableUtf8Text } from './file-read-metadata.js';
import { assertReadTarget, validateReadPath } from './path-policy.js';
import {
  WorkspaceIdentityRegistry,
  type WorkspaceIdentityObservation,
} from './workspace-identity.js';

const BACKEND_KIND = 'local-machine';
const MAX_READ_BYTES = 64 * 1024;
const MAX_COMMAND_ARGS = 32;
const MAX_ARG_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_TOKENS = 4_000;
const MAX_OUTPUT_TOKENS = 20_000;

export async function observeLocalMachineWorkspaceIdentity(
  root: string,
): Promise<WorkspaceIdentityObservation> {
  const canonicalRoot = await realpath(root);
  const info = await stat(canonicalRoot, { bigint: true });
  if (!info.isDirectory()) throw new Error('Gateway denied local-machine root is not a directory');
  return {
    canonicalRoot,
    backendKind: BACKEND_KIND,
    fsDevice: String(info.dev),
    fsInode: String(info.ino),
  };
}

export interface LocalMachineCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface LocalMachineContext {
  open(path: string): Promise<object>;
  list(workspaceId: string, path?: string, maxEntries?: number): Promise<object>;
  read(workspaceId: string, path: string): Promise<object>;
  commandRun(workspaceId: string, argv: readonly string[], options?: LocalMachineCommandOptions): Promise<object>;
  processStart(workspaceId: string, argv: readonly string[], options?: Pick<LocalMachineCommandOptions, 'cwd'>): Promise<object>;
  describe(workspaceId: string): Promise<object>;
}

export function createLocalMachineContext(options: {
  store: SqliteDurableStore;
  callerContext: GatewayCallerContext;
  workspaceIdentities: WorkspaceIdentityRegistry;
  killSwitch: () => boolean;
}): LocalMachineContext {
  const { store, callerContext, workspaceIdentities } = options;

  function assertEffectAllowed(): void {
    if (options.killSwitch()) {
      throw new Error('Gateway denied local-machine effect: KILL_SWITCH_ENGAGED');
    }
  }

  async function ownedWorkspace(workspaceId: string): Promise<{ workspace: WorkspaceRecord }> {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace || workspace.backendKind !== BACKEND_KIND || !sameAuthorityTuple(workspace, callerContext)) {
      throw new Error('Gateway denied local-machine workspace');
    }
    const observation = await observeLocalMachineWorkspaceIdentity(workspace.canonicalRoot);
    workspaceIdentities.record(workspaceId, observation);
    return { workspace };
  }

  async function resolveCwd(root: string, requested?: string): Promise<string> {
    if (requested === undefined || requested === '' || requested === '.') return root;
    const safe = validateReadPath(requested.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
    await assertReadTarget(root, safe);
    const target = await realpath(resolve(root, safe));
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error('Gateway denied local-machine cwd is not a directory');
    return target;
  }

  return {
    async open(path) {
      const requested = path.trim();
      if (!requested || !isAbsolute(requested) || requested.includes('\0')) {
        throw new Error('Gateway denied invalid local-machine root');
      }
      if (process.platform === 'win32' && requested.replaceAll('/', '\\').startsWith('\\\\')) {
        throw new Error('Gateway denied unsafe local-machine namespace');
      }
      const observation = await observeLocalMachineWorkspaceIdentity(requested);
      const workspace = store.openWorkspaceRecord({
        ownerId: callerContext.ownerId,
        sessionId: callerContext.sessionId,
        adapterId: callerContext.adapterId,
        canonicalRoot: observation.canonicalRoot,
        backendKind: BACKEND_KIND,
        createdAt: Date.now(),
      });
      workspaceIdentities.record(workspace.workspaceId, observation);
      return {
        workspace_id: workspace.workspaceId,
        root: observation.canonicalRoot,
        authority: { mode: 'AUTONOMOUS_LOCAL', kill_switch: options.killSwitch() ? 'ENGAGED' : 'CLEAR' },
      };
    },

    async describe(workspaceId) {
      const { workspace } = await ownedWorkspace(workspaceId);
      return {
        workspace_id: workspaceId,
        root: workspace.canonicalRoot,
        backend: BACKEND_KIND,
        authority: {
          mode: 'AUTONOMOUS_LOCAL',
          kill_switch: options.killSwitch() ? 'ENGAGED' : 'CLEAR',
        },
      };
    },

    async list(workspaceId, path = '.', maxEntries = 200) {
      const { workspace } = await ownedWorkspace(workspaceId);
      const safePath = path === '.' ? '.' : validateReadPath(path);
      const target = safePath === '.'
        ? workspace.canonicalRoot
        : await realpath(resolve(workspace.canonicalRoot, safePath));
      if (safePath !== '.') await assertReadTarget(workspace.canonicalRoot, safePath);
      const limit = Math.min(Math.max(maxEntries, 1), 1_000);
      const entries = await readdir(target, { withFileTypes: true });
      return {
        path: safePath,
        entries: entries.slice(0, limit).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory'
            : entry.isFile() ? 'file'
            : entry.isSymbolicLink() ? 'symlink'
            : 'other',
        })),
        truncated: entries.length > limit,
      };
    },

    async read(workspaceId, path) {
      const { workspace } = await ownedWorkspace(workspaceId);
      const safePath = validateReadPath(path);
      await assertReadTarget(workspace.canonicalRoot, safePath);
      const target = await realpath(resolve(workspace.canonicalRoot, safePath));
      const bytes = await readFile(target);
      if (bytes.length > MAX_READ_BYTES) throw new Error('Gateway rejected local-machine read exceeds 64 KiB');
      let raw: string;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('Gateway rejected local-machine non-UTF-8 content'); }
      return redactRead(describeReadableUtf8Text(raw));
    },

    async commandRun(workspaceId, argv, commandOptions = {}) {
      const { workspace } = await ownedWorkspace(workspaceId);
      validateArgv(argv);
      assertEffectAllowed();
      const cwd = await resolveCwd(workspace.canonicalRoot, commandOptions.cwd);
      const timeoutMs = Math.min(Math.max(commandOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS);
      const maxOutputTokens = Math.min(
        Math.max(commandOptions.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, 100),
        MAX_OUTPUT_TOKENS,
      );
      // Revalidate the emergency stop immediately before process creation.
      assertEffectAllowed();
      return runBounded(argv, cwd, timeoutMs, maxOutputTokens);
    },

    async processStart(workspaceId, argv, commandOptions = {}) {
      const { workspace } = await ownedWorkspace(workspaceId);
      validateArgv(argv);
      assertEffectAllowed();
      const cwd = await resolveCwd(workspace.canonicalRoot, commandOptions.cwd);
      // Revalidate the emergency stop immediately before process creation.
      assertEffectAllowed();
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: sanitizeLocalMachineEnvironment(process.env),
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      const pid = child.pid;
      if (!pid) throw new Error('Gateway local-machine process did not start');
      child.unref();
      return { pid, cwd, started: true };
    },
  };
}

async function runBounded(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputTokens: number,
): Promise<object> {
  const startedAt = Date.now();
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env: sanitizeLocalMachineEnvironment(process.env),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const maxBytes = maxOutputTokens * 4;
  let output = '';
  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  const append = (chunk: Buffer) => {
    if (truncated) return;
    const remaining = maxBytes - bytes;
    if (remaining <= 0) { truncated = true; return; }
    const part = chunk.subarray(0, remaining);
    output += part.toString('utf8');
    bytes += part.length;
    if (part.length !== chunk.length) truncated = true;
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  timer.unref?.();

  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code ?? -1));
  }).finally(() => clearTimeout(timer));

  return {
    exitCode,
    output: redactSecrets(output.trimEnd()),
    timedOut,
    truncated,
    durationMs: Date.now() - startedAt,
    cwd,
  };
}

function validateArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_COMMAND_ARGS) {
    throw new Error('Gateway rejected local-machine argv');
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.includes('\0')
      || Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES) {
      throw new Error('Gateway rejected local-machine argv');
    }
  }
}

function redactRead<T extends { content: string }>(value: T): T & { redacted: boolean } {
  const content = redactSecrets(value.content);
  return { ...value, content, redacted: content !== value.content };
}

function redactSecrets(value: string): string {
  return value
    .replace(/(?i:bearer)\s+[A-Za-z0-9._~+\/-]{12,}/g, 'Bearer <REDACTED>')
    .replace(
      /(^|\n)(\s*[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL)[A-Za-z0-9_]*\s*=\s*)([^\r\n]+)/gi,
      (_m, prefix, key) => `${prefix}${key}<REDACTED>`,
    );
}
