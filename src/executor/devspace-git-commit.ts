import { gzipSync } from 'node:zlib';
import { SAFE_GIT_RUNNER_SOURCE, minifyHelperSource } from '../safe-git.js';
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
const COMMIT_HELPER_SOURCE = minifyHelperSource(`
${SAFE_GIT_RUNNER_SOURCE}
const { realpathSync, statSync, readFileSync } = require('fs');
const { mkdtempSync: mkdtempSync2, rmSync: rmSync2 } = require('fs');
const { tmpdir: tmpdir2 } = require('os');
const { join: join2 } = require('path');

const mode = process.argv[2];
// The payload is gzipped as well as base64url-encoded: the executor runs one bounded command
// string, and an 8 KiB message or a large path set does not fit uncompressed.
const input = JSON.parse(require('zlib').gunzipSync(Buffer.from(process.argv[3], 'base64url')).toString('utf8'));

/**
 * Compares two paths by identity rather than by spelling: git prints forward slashes, Windows
 * compares case-insensitively and may hand back 8.3 short names.
 */
function samePath(left, right) {
  var a;
  var b;
  try { a = realpathSync.native(left); } catch { return false; }
  try { b = realpathSync.native(right); } catch { return false; }
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
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
  // Every statSync and every pathspec below is relative to the working directory, which the
  // execution backend chose. A cwd one level down would still satisfy the check above while
  // resolving 'a.txt' to a different file than the host validated.
  if (!samePath(process.cwd(), input.root)) fail('WORKTREE_MISMATCH');

  // Load-bearing: the recursing form is required. update-ref dereferences a symref, so a HEAD
  // pointing at a branch that is itself a symref to main would otherwise move main while this
  // check saw only the intermediate name. --quiet without --no-recurse resolves to the terminal
  // ref, which is the one the protected-branch policy must judge.
  const symbolic = git(['symbolic-ref', '--quiet', 'HEAD']);
  if (symbolic.status !== 0) fail('DETACHED_HEAD');
  const ref = symbolic.stdout.trim();
  if (!ref.startsWith('refs/heads/')) fail('DETACHED_HEAD');
  const branch = ref.slice('refs/heads/'.length);

  // The worktree assertion alone is not enough: an inherited GIT_DIR leaves --show-toplevel
  // reporting the admitted worktree while every ref, HEAD and branch comes from another
  // repository. The environment that could do that is now constructed rather than inherited,
  // and the git dir is bound into the preview so approval can prove it did not move.
  const gitDir = gitOk(['rev-parse', '--absolute-git-dir']).trim();
  const commonDir = gitOk(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    try { statSync(join2(gitDir, marker)); fail('OPERATION_IN_PROGRESS'); }
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

  // commit-tree stamps a committer as well, from committer.name/committer.email in the same
  // untrusted configuration. Binding only the author left that free to differ from what the
  // operator was shown.
  const committerIdent = git(['var', 'GIT_COMMITTER_IDENT']);
  if (committerIdent.status !== 0) fail('IDENTITY_UNSET');
  const committer = committerIdent.stdout.trim().replace(/ [0-9]+ [+-][0-9]{4}$/, '');
  if (committer === '') fail('IDENTITY_UNSET');

  return {
    ref, branch, head: head.stdout.trim(), author: author, committer: committer,
    gitDir: gitDir, commonDir: commonDir,
  };
}

/**
 * v1 commits the exact bytes the operator reviewed. That is only the same thing as what git
 * would have stored when the repository asks for no conversion, so a path whose attributes
 * would transform it is refused rather than silently resolved one way or the other.
 *
 * Measured: with a .gitattributes of text=auto, the reviewed bytes alpha\\r\\nbeta\\r\\n were
 * committed as alpha\\nbeta\\n by the previous git-add pipeline, and check-attr filter reported
 * unspecified throughout, so the existing filter gate never saw it. working-tree-encoding is
 * worse: a 30-byte reviewed file became a 14-byte blob.
 *
 * Returns the tree entry mode for each path: the mode HEAD already records, so an executable
 * stays executable on a checkout where core.fileMode is false, and 100644 for a new file.
 */
function assertSelectable(paths, head, eol, autoForm) {
  const autocrlf = git(['config', '--get', 'core.autocrlf']).stdout.trim().toLowerCase();
  const eolConvertsByDefault = autocrlf === 'true' || autocrlf === 'input';
  const modes = {};
  for (const path of paths) {
    let stats;
    try { stats = statSync(path); }
    catch { fail('PATH_MISSING:' + path); }
    if (!stats.isFile()) fail('PATH_NOT_REGULAR_FILE:' + path);

    const attrs = {};
    const raw = gitOk(['check-attr', 'filter', 'text', 'working-tree-encoding', '--', path]);
    for (const line of raw.split('\\n')) {
      const marker = ': ';
      const last = line.lastIndexOf(marker);
      if (last === -1) continue;
      const value = line.slice(last + marker.length).trim();
      const rest = line.slice(0, last);
      const name = rest.slice(rest.lastIndexOf(marker) + marker.length);
      attrs[name] = value;
    }
    const unset = function (value) { return value === undefined || value === 'unspecified' || value === 'unset'; };

    // A filter driver is both an execution vector and a content contract: an lfs repository
    // expects a pointer blob, not the file. v1 refuses rather than guessing which is meant.
    if (!unset(attrs.filter)) fail('PATH_HAS_FILTER_ATTRIBUTE:' + path);
    if (!unset(attrs['working-tree-encoding'])) fail('PATH_HAS_ENCODING_ATTRIBUTE:' + path);

    // End-of-line conversion only changes anything when there is a CR to convert, so a file
    // with LF endings is never refused for it.
    // 'unset' is the explicit -text form: the repository is saying do not convert this, and it
    // overrides core.autocrlf. 'unspecified' means the attribute is silent, so the config
    // default decides. Anything else (set, auto, a value) means convert.
    // 'unset' is -text and means no. 'set' and 'auto' mean yes. Anything else is a value git
    // does not recognize, and git falls back to core.autocrlf rather than converting.
    const textAttr = attrs.text;
    eol[path] = textAttr === 'unset' ? false
      : (textAttr === 'set' || textAttr === 'auto') ? true
        : eolConvertsByDefault;
    // Only the 'auto' forms skip content git would call binary; an explicit 'text' converts
    // regardless. Recorded per path so contentFor does not have to re-derive it.
    autoForm[path] = textAttr !== 'set';

    const listed = gitOk(['ls-tree', '-z', head, '--', path]).split('\\u0000')[0] || '';
    if (listed === '') {
      modes[path] = '100644';
    } else {
      const entryMode = listed.slice(0, listed.indexOf(' '));
      // 120000 is a symlink and 160000 a gitlink; neither is a regular file whose bytes a
      // human reviewed, and replacing one with a blob would be a silent type change.
      if (entryMode !== '100644' && entryMode !== '100755') fail('UNSUPPORTED_ENTRY_MODE:' + path);
      modes[path] = entryMode;
    }
  }
  return modes;
}
/** Builds the resulting tree in a private index; the real index is never opened for writing. */
/**
 * Opens the object/index context a plan runs in.
 *
 * Proposing must not change the repository. The previous git-add pipeline wrote loose blobs
 * and trees into the real object store before any human saw the proposal. Here the primary
 * object directory is a WAG-owned temporary one and the repository own objects are reachable
 * as an alternate, so reads still resolve and every write lands in the scratch directory.
 *
 * The candidate tree only exists inside that context, so it has to stay open until the delta
 * has been read back out of it. On approval the same objects are written for real, because a
 * commit has to outlive this process.
 */
/**
 * The bytes that will become the blob.
 *
 * End-of-line conversion cannot simply be refused: with core.autocrlf=true, which is the
 * common Windows setting, every text file git checks out has CRLF on disk while the blob in
 * HEAD has LF. Committing the worktree bytes verbatim would rewrite every such file.
 *
 * So WAG does the conversion itself, in code, only when the effective attributes say git
 * would, and reports which paths it touched so the operator approves a known transformation
 * rather than an invisible one. What is never allowed is the repository performing the
 * conversion through a filter or an encoding attribute, which is a program or a re-encode.
 */
function looksBinaryToGit(probe) {
  // git's convert_is_binary, over the first 8000 bytes: a NUL, a lone CR, or too few printable
  // characters. Checking only the NUL made WAG strip CR bytes that git add would have kept.
  let printable = 0;
  let nonprintable = 0;
  for (let index = 0; index < probe.length; index += 1) {
    const byte = probe[index];
    if (byte === 0) return true;
    if (byte === 13 && probe[index + 1] !== 10) return true;
    if (byte === 8 || byte === 12 || byte === 27 || byte === 127) { nonprintable += 1; continue; }
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) { nonprintable += 1; continue; }
    printable += 1;
  }
  return (printable >> 7) < nonprintable;
}

function contentFor(path, convertEol, isAutoForm) {
  const raw = readFileSync(path);
  if (!convertEol) return { data: raw, normalized: false };
  if (isAutoForm && looksBinaryToGit(raw.subarray(0, 8000))) return { data: raw, normalized: false };
  const out = Buffer.alloc(raw.length);
  let length = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 13 && raw[index + 1] === 10) continue;
    out[length] = raw[index];
    length += 1;
  }
  const data = out.subarray(0, length);
  return { data: data, normalized: length !== raw.length };
}
function openScratch(persist) {
  const scratch = mkdtempSync2(join2(tmpdir2(), 'wag-commit-scratch-'));
  const overrides = { GIT_INDEX_FILE: join2(scratch, 'index') };
  if (!persist) {
    const objects = join2(scratch, 'objects');
    const fsModule = require('fs');
    fsModule.mkdirSync(join2(objects, 'info'), { recursive: true });
    overrides.GIT_OBJECT_DIRECTORY = objects;
    // The repository's own objects are reached through the alternates FILE, not through
    // GIT_ALTERNATE_OBJECT_DIRECTORIES: git splits that variable on the platform path
    // separator, which on Windows is ';' — a legal NTFS filename character — and quoting it
    // makes git refuse to normalize the path at all. The file is one path per line.
    fsModule.writeFileSync(join2(objects, 'info', 'alternates'), join2(gitCommonDir(), 'objects') + '\\n');
  }
  return {
    env: gitEnv(overrides),
    dispose: function () {
      try { rmSync2(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

let cachedCommonDir = null;
function gitCommonDir() {
  if (cachedCommonDir === null) {
    cachedCommonDir = gitOk(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  }
  return cachedCommonDir;
}

function buildTree(env, oldHead, paths, modes, eol, autoForm, normalizedOut) {
  gitOk(['read-tree', oldHead], { env });
  for (const path of paths) {
    // --no-filters is the whole point: no clean filter runs, and no attribute-driven re-encode
    // happens between disk and object. The only transformation is the end-of-line one WAG
    // performed itself above, and it is reported.
    const prepared = contentFor(path, eol[path] === true, autoForm[path] !== false);
    if (prepared.normalized) normalizedOut.push(path);
    const blob = gitOk(['hash-object', '-w', '--no-filters', '-t', 'blob', '--stdin'], {
      env, input: prepared.data,
    }).trim();
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(blob)) fail('HASH_OBJECT_BAD_OUTPUT:' + path);
    // The mode is chosen explicitly rather than sampled from a filesystem that does not record
    // it on Windows. update-index accepts a nonsense mode with exit 0 and silently coerces it,
    // so the entry it produced is read back and compared rather than assumed.
    gitOk(['update-index', '--add', '--cacheinfo', modes[path] + ',' + blob + ',' + path], { env });
    const staged = gitOk(['ls-files', '--stage', '-z', '--', path], { env }).split('\\u0000')[0] || '';
    if (staged.slice(0, staged.indexOf(' ')) !== modes[path]) fail('UNSUPPORTED_ENTRY_MODE:' + path);
    if (staged.indexOf(blob) === -1) fail('PATH_NOT_STAGED:' + path);
  }
  return gitOk(['write-tree'], { env }).trim();
}

/**
 * The authoritative statement of what the commit does. Per-path guards are not enough: adding
 * a regular file whose path is a directory in HEAD resolves the conflict by dropping the whole
 * subtree, so the only safe check is the resulting tree delta itself.
 */
function describeChanges(env, oldHead, tree) {
  const raw = gitOk([
    'diff-tree', '--no-ext-diff', '--no-textconv', '--name-status', '--no-renames', '-r', '-z',
    oldHead, tree,
  ], { env });
  const fields = raw.split('\\u0000').filter(function (value) { return value !== ''; });
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

function plan(persist) {
  const state = inspectRepository();
  const eol = Object.create(null);
  const autoForm = Object.create(null);
  const modes = assertSelectable(input.paths, state.head, eol, autoForm);
  const oldTree = gitOk(['rev-parse', state.head + '^{tree}']).trim();
  const normalized = [];
  const scratch = openScratch(persist === true);
  try {
    const tree = buildTree(scratch.env, state.head, input.paths, modes, eol, autoForm, normalized);
    if (tree === oldTree) fail('NO_CHANGES_SELECTED');
    const changes = describeChanges(scratch.env, state.head, tree);
    return {
      branch: state.branch, ref: state.ref, head: state.head,
      tree: tree, changes: changes, author: state.author, committer: state.committer,
      gitDir: state.gitDir, commonDir: state.commonDir,
      eolNormalized: normalized,
    };
  } finally {
    scratch.dispose();
  }
}
function commit() {
  // persist: the objects must outlive this process now, so they go to the real object store.
  const planned = plan(true);
  if (planned.branch !== input.expectedBranch) fail('BRANCH_DRIFT');
  if (planned.head !== input.expectedOldHead) fail('HEAD_DRIFT');
  if (planned.tree !== input.expectedTree) fail('CONTENT_DRIFT');
  if (planned.author !== input.expectedAuthor) fail('AUTHOR_DRIFT');
  if (planned.committer !== input.expectedCommitter) fail('COMMITTER_DRIFT');
  if (!samePath(planned.gitDir, input.expectedGitDir)) fail('REPOSITORY_DRIFT');
  if (!samePath(planned.commonDir, input.expectedCommonDir)) fail('REPOSITORY_DRIFT');

  // Message arrives as stdin data, never as an argument and never as shell syntax.
  const created = git(['commit-tree', planned.tree, '-p', planned.head], { input: input.message });
  if (created.status !== 0) fail('COMMIT_TREE_FAILED:' + String(created.stderr).trim().split('\\n')[0]);
  const commitSha = created.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)) fail('COMMIT_TREE_BAD_OUTPUT');

  const parents = gitOk(['rev-list', '--parents', '-n', '1', commitSha]).trim().split(/\\s+/);
  if (parents.length !== 2 || parents[1] !== planned.head) fail('UNEXPECTED_PARENTS');

  // Compare-and-swap: a branch that moved since the preview loses instead of being clobbered.
  const updated = git(['update-ref', planned.ref, commitSha, planned.head]);
  if (updated.status !== 0) fail('REF_CAS_FAILED');

  return { branch: planned.branch, commit: commitSha, tree: planned.tree, previousHead: planned.head, changes: planned.changes };
}

try {
  const output = mode === 'commit' ? commit() : plan(false);
  process.stdout.write('__WAG_BEGIN__' + JSON.stringify(output));
} finally {
  // The empty hooks directory outlives every git call in this process and nothing else.
  disposeGitRunner();
}
`);

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
    'WORKTREE_MISMATCH', 'REPOSITORY_DRIFT', 'IDENTITY_UNSET', 'AUTHOR_DRIFT',
    'PATH_HAS_ENCODING_ATTRIBUTE', 'UNSUPPORTED_ENTRY_MODE', 'PATH_NOT_STAGED',
    'HASH_OBJECT_BAD_OUTPUT', 'TOO_MANY_CONFIGURED_DRIVERS', 'COMMITTER_DRIFT',
    'DETACHED_HEAD', 'OPERATION_IN_PROGRESS', 'UNMERGED_ENTRIES', 'NO_HEAD_COMMIT',
    'PATH_MISSING', 'PATH_NOT_REGULAR_FILE', 'PATH_HAS_FILTER_ATTRIBUTE',
    'NO_CHANGES_SELECTED', 'UNSUPPORTED_CHANGE', 'BRANCH_DRIFT', 'HEAD_DRIFT', 'CONTENT_DRIFT',
    'COMMIT_TREE_FAILED', 'COMMIT_TREE_BAD_OUTPUT', 'UNEXPECTED_PARENTS', 'REF_CAS_FAILED',
  ];
  for (const reason of known) {
    if (output.includes(reason)) return reason;
  }
  return 'UNKNOWN';
}
