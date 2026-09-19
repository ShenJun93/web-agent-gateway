import { gzipSync } from 'node:zlib';
import type { DevspaceExecutor } from './devspace.js';
import type { GitCommitBackend, GitCommitPlan, GitCommitRequest, GitCommitResult } from '../git-commit-backend.js';

const HELPER_BEGIN_MARKER = '__WAG_BEGIN__';
const COMMIT_OUTPUT_TOKENS = 8_000;
/** Marker the executor inserts when its own ring buffer dropped output. */
const EXECUTOR_TRUNCATION_MARKER = '... output truncated';
/**
 * cmd.exe refuses a command line over 8191 characters. Measured on this machine: at 8146 it runs,
 * at 8246 it exits 1 with "The command line is too long." The margin leaves room for the
 * executor's own wrapping.
 */
const MAX_COMMAND_LENGTH = 8_000;

/**
 * WAG-owned helper, base64url-encoded and evaluated by a `node -e` stub because the executor
 * accepts one shell command string and offers no argv, env or stdin channel.
 *
 * Nothing untrusted is evaluated. Selected paths, the branch name and the commit message travel
 * as one base64url JSON payload argument, are decoded to plain values here, and reach git only as
 * argv elements or as `spawnSync` stdin. The helper never builds a shell string.
 *
 * It commits with plumbing (`read-tree` / `add` / `write-tree` / `commit-tree` / `update-ref`)
 * against a private index, so the operator's real index is never touched.
 *
 * Plumbing alone is NOT hook-free: an independent review showed `post-index-change` and
 * `reference-transaction` still fire, including from a `core.hooksPath` the repository points
 * into its own worktree. Every invocation therefore also pins `core.hooksPath` to an empty
 * directory this process owns. Both properties are verified against this machine's git and
 * recorded in ADR-0023.
 */
const COMMIT_HELPER_SOURCE = String.raw`
const { spawnSync } = require('child_process');
const { mkdtempSync, realpathSync, rmSync, statSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { gunzipSync } = require('zlib');

const mode = process.argv[2];
// The payload is gzipped as well as base64url-encoded: the executor runs one bounded command
// string, and an 8 KiB message or a large path set does not fit uncompressed.
const input = JSON.parse(gunzipSync(Buffer.from(process.argv[3], 'base64url')).toString('utf8'));

/**
 * Compares two paths by identity rather than by spelling: git prints forward slashes, Windows
 * compares case-insensitively and may hand back 8.3 short names. Both sides are resolved with
 * the native realpath before comparison.
 */
function samePath(left, right) {
  var a;
  var b;
  try { a = realpathSync.native(left); } catch { return false; }
  try { b = realpathSync.native(right); } catch { return false; }
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// Plumbing does not run the porcelain hooks, but it DOES run post-index-change on every index
// write and reference-transaction on every ref update, from .git/hooks or from a core.hooksPath
// the repository can point into its own worktree. Every git invocation is therefore pinned to an
// empty hooks directory this process owns, which makes hook execution impossible rather than
// merely unlikely.
const hooksDir = mkdtempSync(join(tmpdir(), 'wag-no-hooks-'));

function git(args, options) {
  const result = spawnSync('git', [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + hooksDir,
  ].concat(args), {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options,
  });
  if (result.error) throw new Error('git spawn failed');
  return result;
}
function gitOk(args, options) {
  const result = git(args, options);
  if (result.status !== 0) throw new Error('git ' + args[0] + ' failed: ' + String(result.stderr).trim().split('\n')[0]);
  return result.stdout;
}
function fail(reason) { throw new Error(reason); }

function inspectRepository() {
  // The repository is untrusted, and so is .git/config. A hostile core.worktree makes every
  // later git add read a directory of the attacker's choosing while statSync, check-attr and
  // diff-tree all still describe the innocent path the operator was shown; a workspace nested
  // inside a larger repository makes the commit land on the outer repository's branch. Both are
  // the same bug: nothing had asserted that this is the admitted repository. rev-parse reports
  // the effective worktree, including a configured core.worktree, so one comparison closes both.
  const topLevel = git(['rev-parse', '--show-toplevel']);
  if (topLevel.status !== 0) fail('WORKTREE_MISMATCH');
  if (!samePath(topLevel.stdout.trim(), input.root)) fail('WORKTREE_MISMATCH');

  // Load-bearing: the recursing form is required. update-ref dereferences a symref, so a HEAD
  // pointing at a branch that is itself a symref to main would otherwise move main while this
  // check saw only the intermediate name. --quiet without --no-recurse resolves to the terminal
  // ref, which is the one the protected-branch policy must judge.
  const symbolic = git(['symbolic-ref', '--quiet', 'HEAD']);
  if (symbolic.status !== 0) fail('DETACHED_HEAD');
  const ref = symbolic.stdout.trim();
  if (!ref.startsWith('refs/heads/')) fail('DETACHED_HEAD');
  const branch = ref.slice('refs/heads/'.length);

  const gitDir = gitOk(['rev-parse', '--absolute-git-dir']).trim();
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    try { statSync(join(gitDir, marker)); fail('OPERATION_IN_PROGRESS'); }
    catch (error) { if (String(error.message).indexOf('OPERATION_IN_PROGRESS') !== -1) throw error; }
  }
  if (gitOk(['ls-files', '--unmerged']).trim() !== '') fail('UNMERGED_ENTRIES');

  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0) fail('NO_HEAD_COMMIT');

  // commit-tree fails outright without an identity, which would be a failure after approval.
  // It also comes from the untrusted repository configuration, so it is reported, bound and
  // shown to the operator rather than silently accepted.
  const ident = git(['var', 'GIT_AUTHOR_IDENT']);
  if (ident.status !== 0) fail('IDENTITY_UNSET');
  const author = ident.stdout.trim().replace(/ [0-9]+ [+-][0-9]{4}$/, '');
  if (author === '') fail('IDENTITY_UNSET');

  return { ref, branch, head: head.stdout.trim(), author: author };
}

function assertSelectable(paths) {
  for (const path of paths) {
    let stats;
    try { stats = statSync(path); }
    catch { fail('PATH_MISSING:' + path); }
    if (!stats.isFile()) fail('PATH_NOT_REGULAR_FILE:' + path);
    // A filter attribute makes git add execute a configured clean command.
    const attr = gitOk(['check-attr', 'filter', '--', path]).trim();
    const value = attr.slice(attr.lastIndexOf(': ') + 2);
    if (value !== 'unspecified' && value !== 'unset') fail('PATH_HAS_FILTER_ATTRIBUTE:' + path);
  }
}

/** Builds the resulting tree in a private index; the real index is never opened for writing. */
function buildTree(oldHead, paths) {
  const indexDir = mkdtempSync(join(tmpdir(), 'wag-commit-index-'));
  const indexFile = join(indexDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    gitOk(['read-tree', oldHead], { env });
    for (const path of paths) {
      gitOk(['add', '--', ':(literal)' + path], { env });
      // git add stages a deletion for a removed file; prove the path is still present.
      if (gitOk(['ls-files', '--', ':(literal)' + path], { env }).trim() === '') fail('PATH_NOT_STAGED:' + path);
    }
    return gitOk(['write-tree'], { env }).trim();
  } finally {
    try { rmSync(indexDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * The authoritative statement of what the commit does. Per-path guards are not enough: adding a
 * regular file whose path is a directory in HEAD resolves the conflict by dropping the whole
 * subtree, so the only safe check is the resulting tree delta itself.
 */
function describeChanges(oldHead, tree) {
  const raw = gitOk(['diff-tree', '--name-status', '--no-renames', '-r', '-z', oldHead, tree]);
  const fields = raw.split('\u0000').filter(function (value) { return value !== ''; });
  const changes = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status !== 'A' && status !== 'M') fail('UNSUPPORTED_CHANGE:' + status + ':' + path);
    changes.push({ status: status, path: path });
  }
  if (changes.length === 0) fail('NO_CHANGES_SELECTED');
  return changes;
}

function plan() {
  const state = inspectRepository();
  assertSelectable(input.paths);
  const oldTree = gitOk(['rev-parse', state.head + '^{tree}']).trim();
  const tree = buildTree(state.head, input.paths);
  if (tree === oldTree) fail('NO_CHANGES_SELECTED');
  const changes = describeChanges(state.head, tree);
  return {
    branch: state.branch, ref: state.ref, head: state.head,
    tree: tree, changes: changes, author: state.author,
  };
}

function commit() {
  const planned = plan();
  if (planned.branch !== input.expectedBranch) fail('BRANCH_DRIFT');
  if (planned.head !== input.expectedOldHead) fail('HEAD_DRIFT');
  if (planned.tree !== input.expectedTree) fail('CONTENT_DRIFT');
  if (planned.author !== input.expectedAuthor) fail('AUTHOR_DRIFT');

  // Message arrives as stdin data, never as an argument and never as shell syntax.
  const created = git(['commit-tree', planned.tree, '-p', planned.head], { input: input.message });
  if (created.status !== 0) fail('COMMIT_TREE_FAILED:' + String(created.stderr).trim().split('\n')[0]);
  const commitSha = created.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)) fail('COMMIT_TREE_BAD_OUTPUT');

  const parents = gitOk(['rev-list', '--parents', '-n', '1', commitSha]).trim().split(/\s+/);
  if (parents.length !== 2 || parents[1] !== planned.head) fail('UNEXPECTED_PARENTS');

  // Compare-and-swap: a branch that moved since the preview loses instead of being clobbered.
  const updated = git(['update-ref', planned.ref, commitSha, planned.head]);
  if (updated.status !== 0) fail('REF_CAS_FAILED');

  return { branch: planned.branch, commit: commitSha, tree: planned.tree, previousHead: planned.head, changes: planned.changes };
}

try {
  const output = mode === 'commit' ? commit() : plan();
  process.stdout.write('__WAG_BEGIN__' + JSON.stringify(output));
} finally {
  // The empty hooks directory outlives every git call in this process and nothing else.
  try { rmSync(hooksDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
`;

export class DevspaceGitCommitBackend implements GitCommitBackend {
  readonly kind = 'devspace';

  constructor(private readonly executor: DevspaceExecutor) {}

  async plan(root: string, paths: readonly string[], message: string): Promise<GitCommitPlan> {
    // The message is not used for planning, but it is included so the command-length guard sees
    // the same size the commit will: an input that can never execute is refused before review.
    return this.run(root, 'plan', { root, paths, message }) as Promise<GitCommitPlan>;
  }

  async commit(root: string, request: GitCommitRequest): Promise<GitCommitResult> {
    return this.run(root, 'commit', { root, ...request }) as Promise<GitCommitResult>;
  }

  private async run(root: string, mode: 'plan' | 'commit', payload: unknown): Promise<unknown> {
    // The executor's own errors quote their full tool payload, which for open_workspace includes
    // the absolute canonical root. Collapse them to a reason code before they can reach a caller.
    let devspaceWorkspaceId: string;
    try {
      devspaceWorkspaceId = await this.executor.openWorkspace(root);
    } catch {
      throw new Error('Gateway git commit failed: WORKSPACE_UNAVAILABLE');
    }
    // Helper and payload are both gzipped before base64url encoding. The executor runs the
    // command through cmd.exe on Windows, whose command line is capped at 8191 characters and
    // which refuses — rather than truncates — anything longer. The helper alone exceeds that
    // uncompressed, and an 8 KiB message would exceed it even with the helper compressed, so
    // the assembled command is measured and refused here rather than failing opaquely there.
    // Still base64url throughout, so still free of shell metacharacters.
    const command = [
      'node -e "eval(require(\'zlib\').gunzipSync(Buffer.from(process.argv[1],\'base64url\')).toString(\'utf8\'))"',
      gzipSync(Buffer.from(COMMIT_HELPER_SOURCE, 'utf8'), { level: 9 }).toString('base64url'),
      mode,
      gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 }).toString('base64url'),
    ].join(' ');
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new Error('Gateway git commit failed: INPUT_TOO_LARGE');
    }

    let result;
    try {
      result = await this.executor.execCommand(devspaceWorkspaceId, command, COMMIT_OUTPUT_TOKENS);
    } catch {
      throw new Error('Gateway git commit failed: EXECUTOR_ERROR');
    }
    if (result.running) {
      if (result.sessionId) await this.executor.interruptCommand(devspaceWorkspaceId, result.sessionId);
      throw new Error('Gateway git commit failed: HELPER_DID_NOT_COMPLETE');
    }
    // Only the text before the sentinel is executor framing. The helper's own JSON carries
    // repository filenames, and a file legitimately named after the marker would otherwise make
    // every proposal touching it fail. Real truncation still fails closed: it cuts the JSON, so
    // the parse below rejects it.
    const begin = result.output.indexOf(HELPER_BEGIN_MARKER);
    const framing = begin === -1 ? result.output : result.output.slice(0, begin);
    if (framing.includes(EXECUTOR_TRUNCATION_MARKER)) {
      throw new Error('Gateway git commit failed: OUTPUT_TRUNCATED');
    }
    if (result.exitCode !== 0 || begin === -1) {
      throw new Error(`Gateway git commit failed: ${classifyFailure(result.output)}`);
    }
    try {
      return JSON.parse(result.output.slice(begin + HELPER_BEGIN_MARKER.length));
    } catch {
      // A parse error carries an excerpt of the offending text; replace it with a reason code.
      throw new Error('Gateway git commit failed: MALFORMED_HELPER_OUTPUT');
    }
  }
}

/**
 * Maps the helper's failure to a stable reason. Only WAG-defined reason codes are surfaced, so an
 * arbitrary git stderr string — which may quote repository content — never reaches the caller.
 */
function classifyFailure(output: string): string {
  const known = [
    'WORKTREE_MISMATCH', 'IDENTITY_UNSET', 'AUTHOR_DRIFT',
    'DETACHED_HEAD', 'OPERATION_IN_PROGRESS', 'UNMERGED_ENTRIES', 'NO_HEAD_COMMIT',
    'PATH_MISSING', 'PATH_NOT_REGULAR_FILE', 'PATH_HAS_FILTER_ATTRIBUTE', 'PATH_NOT_STAGED',
    'NO_CHANGES_SELECTED', 'UNSUPPORTED_CHANGE', 'BRANCH_DRIFT', 'HEAD_DRIFT', 'CONTENT_DRIFT',
    'COMMIT_TREE_FAILED', 'COMMIT_TREE_BAD_OUTPUT', 'UNEXPECTED_PARENTS', 'REF_CAS_FAILED',
  ];
  for (const reason of known) {
    if (output.includes(reason)) return reason;
  }
  return 'UNKNOWN';
}
