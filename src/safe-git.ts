/**
 * The single Git execution policy for every trusted WAG Git subprocess.
 *
 * Before this module there were two subtly different policies — the inspection helpers pinned
 * `core.fsmonitor` but not `core.hooksPath`, the commit helper pinned both — and neither
 * constructed the child environment. That is the shape of bug this module exists to prevent:
 * a new Git call site that forgets one flag.
 *
 * The repository is untrusted. So is the parent environment: WAG's Git children run inside an
 * execution backend whose environment came from whatever shell started it, and `GIT_DIR` alone
 * is enough to point every command at a different repository while `--show-toplevel` still
 * reports the admitted worktree (measured; see `docs/research/2026-09-20-wag-git-execution-surface.md`).
 *
 * Two exports matter:
 *
 * - `buildSafeGitEnv` / `SAFE_GIT_BASE_ARGS` for Git spawned in this process, which is how the
 *   adversarial tests drive the policy directly;
 * - `SAFE_GIT_RUNNER_SOURCE`, the same policy as a JavaScript fragment, embedded in the helper
 *   sources that run inside the execution backend — the backend accepts one shell command string
 *   and offers no argv channel, so the helper is how WAG reaches argv at all.
 *
 * Both paths are generated from the same constants, so the policy cannot drift between them.
 */

/**
 * Environment variables Git reads that redirect where it looks, inject configuration, or make it
 * execute another program. Every one is removed from the child environment. WAG re-adds the two
 * it owns — `GIT_INDEX_FILE`, and the object-directory pair used for a non-persisting preview —
 * explicitly, per operation, through `buildSafeGitEnv`'s `gitOverrides`.
 *
 * Grouped by what they do rather than alphabetically, so a reviewer can see the shape of the
 * surface rather than a list.
 */
export const REMOVED_GIT_ENV_KEYS: readonly string[] = [
  // Repository/worktree/index/object routing: any of these silently retargets the operation.
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_INDEX_VERSION', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
  // Configuration injection: another way to set every key below without touching .git/config.
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  // Program execution.
  'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_PAGER', 'PAGER', 'GIT_EDITOR', 'EDITOR', 'VISUAL',
  'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND', 'GIT_MERGE_AUTOEDIT', 'GIT_ATTR_NOSYSTEM',
  // Pathspec interpretation: these change what a literal path means.
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
  // Identity: the author is read from configuration, bound and reviewed; an inherited override
  // would let the environment change who a reviewed commit is attributed to.
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
  // Protocol and transport. v1 never talks to a remote, so none of these may be inherited.
  'GIT_ALLOW_PROTOCOL', 'GIT_PROTOCOL_FROM_USER', 'GIT_PROTOCOL', 'GIT_TRANSLOOP_DEBUG',
];

/**
 * `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` are numbered, so they need a prefix rule rather
 * than an exact list. `GIT_TRACE*` is removed too: it is not an execution vector by itself, but
 * several of its forms write to a caller-chosen path and all of them add unbounded noise to the
 * output this code parses.
 */
export const REMOVED_GIT_ENV_PREFIXES: readonly string[] = [
  'GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_', 'GIT_TRACE',
];

/**
 * Configuration keys whose value Git treats as a command line, overridden to empty on every
 * invocation. A repository sets these in its own `.git/config`, which WAG never controls.
 *
 * Command-line `-c` beats `GIT_CONFIG_COUNT` injection — measured — so this is the right level
 * to pin them at.
 *
 * `core.hooksPath` is the exception: an empty value makes Git fall back to `$GIT_DIR/hooks`,
 * which is exactly the attacker-controlled directory. It is pointed at an empty directory the
 * runner owns instead, and is therefore added per-invocation rather than listed here.
 */
export const NEUTRALIZED_GIT_CONFIG_KEYS: readonly string[] = [
  'core.fsmonitor=',
  'core.pager=',
  'core.editor=',
  'core.askPass=',
  'core.sshCommand=',
  'diff.external=',
  'gpg.program=',
  'credential.helper=',
  'sequence.editor=',
  'init.templateDir=',
  'protocol.allow=never',
  'uploadpack.packObjectsHook=',
];

/**
 * Flags applied to every Git invocation regardless of subcommand.
 *
 * `--no-optional-locks` keeps read-only inspection from writing the index as a side effect.
 * `-P` disables the pager, which is a program Git would otherwise execute.
 * `--literal-pathspecs` makes a filename mean itself: without it a path beginning with `:` is
 * pathspec magic, and WAG's paths come from an untrusted repository listing.
 */
export const SAFE_GIT_GLOBAL_FLAGS: readonly string[] = [
  '--no-optional-locks', '--literal-pathspecs', '-P',
];

/** Global flags plus every neutralizing `-c`, in the order they are passed. */
export const SAFE_GIT_BASE_ARGS: readonly string[] = [
  ...SAFE_GIT_GLOBAL_FLAGS,
  ...NEUTRALIZED_GIT_CONFIG_KEYS.flatMap((setting) => ['-c', setting]),
];

/**
 * Environment values a Git child genuinely needs. Everything else is dropped, so the policy is
 * an allowlist with a denylist inside it rather than "copy the parent and delete a few keys" —
 * a new secret in the parent environment must not become a new leak here.
 *
 * `PATH` is required to find `git` itself. The Windows entries are required for Git for Windows
 * to locate its own installation and for temp/user paths to resolve.
 */
export const ALLOWED_BASE_ENV_KEYS: readonly string[] = [
  'PATH', 'Path', 'PATHEXT',
  'SYSTEMROOT', 'SystemRoot', 'SYSTEMDRIVE', 'SystemDrive', 'WINDIR', 'windir',
  'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'ProgramData',
  'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)', 'ProgramW6432',
  'LANG', 'LC_ALL',
];

/**
 * Strips comment-only lines and indentation from a helper source before it goes on the wire.
 *
 * The execution backend takes one `cmd.exe` command line, which refuses anything over 8191
 * characters, and these helpers are heavily commented on purpose — the comments are where the
 * measured reasoning behind each flag lives. Removing them at the boundary keeps both: readable
 * source in the repository, and a command that fits.
 *
 * Deliberately conservative. Only whole lines whose trimmed form begins a comment are dropped,
 * so no inline `//` inside a string or a regular expression can ever be misread as one.
 */
export function minifyHelperSource(source: string): string {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .join('\n');
}

/**
 * Distinct content-filter driver names from `git config --name-only --get-regexp '^filter\.'`.
 *
 * Kept as a pure function so the policy can be exercised without a child process, and so the
 * in-process path and the embedded helper cannot disagree about what counts as a driver.
 */
export function parseFilterDriverNames(configOutput: string): string[] {
  const names = new Set<string>();
  for (const line of configOutput.split('\n')) {
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(line.trim());
    if (match) names.add(match[1]!);
  }
  return [...names];
}

/**
 * Config-defined hooks: `hook.<name>.command` plus `hook.<name>.event`, honoured from the
 * repository's own `.git/config` since Git 2.53.
 *
 * Measured on git 2.55.0.windows.2: a repository with `hook.evil.command` and
 * `hook.evil.event=reference-transaction` executes that command on a plain `update-ref`, and
 * pinning `core.hooksPath` at an empty directory does **nothing** to stop it — the two
 * mechanisms are independent. The same hook fires for commit-class events. Overriding either
 * `command` or `enabled` suppresses it; both are set, because one of them being enough today is
 * not a reason to depend on it.
 */
export function parseConfigHookNames(configOutput: string): string[] {
  const names = new Set<string>();
  for (const line of configOutput.split('\n')) {
    const match = /^hook\.(.+)\.(command|event|enabled)$/.exec(line.trim());
    if (match) names.add(match[1]!);
  }
  return [...names];
}

/**
 * The configuration that disables every named content filter and config-defined hook, as
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` environment pairs.
 *
 * Not `-c`. A driver name is chosen by the repository and may contain `=`, and Git splits a
 * `-c` argument on the **first** `=`: for a driver named `a=b`, `-c filter.a=b.clean=` sets the
 * unrelated key `filter.a` to `b.clean=` and leaves the hostile `filter.a=b.clean` untouched.
 * Measured on git 2.55.0.windows.2, and it is arbitrary command execution when it happens. The
 * environment form keeps the key and the value in separate variables, so no name can escape it.
 *
 * Precedence is the same as `-c` — both are command-line scope, above the repository's own
 * config — and WAG passes no competing `-c` for any `filter.*` or `hook.*` key.
 */
export function driverOverrideEnv(
  filters: readonly string[],
  hooks: readonly string[],
): Record<string, string> {
  if (filters.length + hooks.length > MAX_CONFIGURED_DRIVERS) {
    throw new Error('TOO_MANY_CONFIGURED_DRIVERS');
  }
  const settings: [string, string][] = [
    ...filters.flatMap((name): [string, string][] => [
      [`filter.${name}.clean`, ''],
      [`filter.${name}.smudge`, ''],
      [`filter.${name}.process`, ''],
      [`filter.${name}.required`, 'false'],
    ]),
    ...hooks.flatMap((name): [string, string][] => [
      [`hook.${name}.command`, ''],
      [`hook.${name}.enabled`, 'false'],
    ]),
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(settings.length) };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** Bound on how many drivers one repository may make WAG neutralize. */
export const MAX_CONFIGURED_DRIVERS = 64;

/**
 * Builds the explicit child environment for a Git subprocess.
 *
 * Construction is positive: start empty, copy the values Git needs, then add the WAG-owned
 * overrides for this one operation. A key that is not in the allowlist cannot reach the child
 * even if a future caller sets it, and no `GIT_*` survives from the parent at all.
 */
export function buildSafeGitEnv(
  parentEnv: NodeJS.ProcessEnv,
  gitOverrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_BASE_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  // Never prompt: without a terminal an askpass/credential prompt becomes a hang, and with one
  // it becomes an interactive surface a remote caller triggered.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  // HOME/USERPROFILE stay on the allowlist, so the operator's own global config is still read.
  // That is deliberate: core.autocrlf and the operator's identity live there, and the operator
  // is not the untrusted party. What must not reach git is the *repository's* executable
  // configuration, which is handled by the driver suppression above, and anything inherited.
  for (const [key, value] of Object.entries(gitOverrides)) {
    if (!key.startsWith('GIT_')) throw new Error(`Safe git override must be a GIT_ variable: ${key}`);
    env[key] = value;
  }
  return env;
}

/** True when this key must never be inherited by a Git child. Exported for the policy tests. */
export function isRemovedGitEnvKey(key: string): boolean {
  if (REMOVED_GIT_ENV_KEYS.includes(key)) return true;
  return REMOVED_GIT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * The same policy as a JavaScript fragment for the in-backend helpers.
 *
 * It defines `git(args, options)`, `gitOk(args, options)` and `fail(reason)`, creates the empty
 * hooks directory the policy needs, and exposes `disposeGitRunner()` for the caller to invoke in
 * a `finally`. Callers pass `{ env: gitEnv({ GIT_INDEX_FILE: ... }) }` to add WAG-owned values.
 *
 * Written as a `String.raw` template: it must contain no backtick, because it is embedded in a
 * template literal. Kept free of shell metacharacters for the same reason the rest of this path
 * is — it travels base64url-encoded inside one command string.
 */
export const SAFE_GIT_RUNNER_SOURCE = String.raw`
const { spawnSync: __spawnSync } = require('child_process');
const { mkdtempSync: __mkdtempSync, rmSync: __rmSync } = require('fs');
const { tmpdir: __tmpdir } = require('os');
const { join: __join } = require('path');

// The allowlist, not the denylist: the child environment is built from nothing upwards, so the
// list of variables to remove has no job to do here. It is enforced in this module's tests
// instead, where it documents the surface being excluded.
const __ALLOWED_BASE_ENV_KEYS = __ALLOWED_KEYS__;
const __MAX_CONFIGURED_DRIVERS = __MAX_DRIVERS__;
const __SAFE_GIT_BASE_ARGS = __BASE_ARGS__;

// Plumbing is not hook-free: post-index-change fires on any index write and
// reference-transaction on any ref update, from .git/hooks or from a core.hooksPath the
// repository points into its own worktree. An empty value would fall back to .git/hooks, so
// every invocation is pinned to an empty directory this process owns.
const __hooksDir = __mkdtempSync(__join(__tmpdir(), 'wag-no-hooks-'));

function disposeGitRunner() {
  try { __rmSync(__hooksDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Allowlist-built environment, before the per-repository driver suppression is added. */
function __baseEnv(overrides) {
  const env = {};
  for (const key of __ALLOWED_BASE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  for (const key of Object.keys(overrides || {})) env[key] = overrides[key];
  return env;
}

/**
 * The child environment for any git call: the allowlist, the repository's neutralized filter and
 * hook drivers, then whatever WAG-owned values this one operation needs.
 */
function gitEnv(overrides) {
  if (__driverEnv === null) __driverEnv = __computeDriverEnv();
  const env = __baseEnv(__driverEnv);
  for (const key of Object.keys(overrides || {})) env[key] = overrides[key];
  return env;
}

/**
 * Content filters and config-defined hooks are the two execution vectors no flag closes. Measured: with
 * a .gitattributes saying filter=evil and filter.evil.clean configured, git diff and
 * git diff --stat both run that command, with --no-ext-diff and --no-textconv already applied.
 * status, ls-files and grep do not.
 *
 * The attribute names the driver and the repository chooses both, so there is no fixed key to
 * pin. Enumerating the configured drivers is exact and cheap: one git config --get-regexp,
 * which executes nothing, gives every driver name at every config level. Each is then overridden
 * to empty, which disables the filter while leaving the diff itself correct.
 */
let __driverEnv = null;

function __computeDriverEnv() {
  const listing = __spawnSync('git', __SAFE_GIT_BASE_ARGS.concat(
    ['-c', 'core.hooksPath=' + __hooksDir, 'config', '--name-only', '--get-regexp', '^(filter|hook)\\.'],
  ), { encoding: 'utf8', maxBuffer: 1024 * 1024, env: __baseEnv({}) });
  if (listing.error) throw new Error('git spawn failed');
  // Null-prototype: a driver named __proto__ assigned onto a plain object creates no own
  // property, so Object.keys would silently drop it and it would never be neutralized.
  const filters = Object.create(null);
  const hooks = Object.create(null);
  for (const line of String(listing.stdout || '').split('\n')) {
    const trimmed = line.trim();
    const filter = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(trimmed);
    if (filter) filters[filter[1]] = true;
    const hook = /^hook\.(.+)\.(command|event|enabled)$/.exec(trimmed);
    if (hook) hooks[hook[1]] = true;
  }
  const settings = [];
  for (const name of Object.keys(filters)) {
    settings.push(['filter.' + name + '.clean', '']);
    settings.push(['filter.' + name + '.smudge', '']);
    settings.push(['filter.' + name + '.process', '']);
    settings.push(['filter.' + name + '.required', 'false']);
  }
  for (const name of Object.keys(hooks)) {
    settings.push(['hook.' + name + '.command', '']);
    settings.push(['hook.' + name + '.enabled', 'false']);
  }
  if (Object.keys(filters).length + Object.keys(hooks).length > __MAX_CONFIGURED_DRIVERS) {
    throw new Error('TOO_MANY_CONFIGURED_DRIVERS');
  }
  // Config injection through the environment, never through -c: git splits a -c argument on the
  // first =, so a driver the repository named a=b would escape a -c override entirely.
  const env = { GIT_CONFIG_COUNT: String(settings.length) };
  for (let index = 0; index < settings.length; index += 1) {
    env['GIT_CONFIG_KEY_' + index] = settings[index][0];
    env['GIT_CONFIG_VALUE_' + index] = settings[index][1];
  }
  return env;
}

function git(args, options) {
  const settings = options || {};
  const result = __spawnSync('git', __SAFE_GIT_BASE_ARGS.concat(
    ['-c', 'core.hooksPath=' + __hooksDir],
  ).concat(args), {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...settings,
    env: settings.env || gitEnv({}),
  });
  if (result.error) throw new Error('git spawn failed');
  return result;
}

function gitOk(args, options) {
  const result = git(args, options);
  if (result.status !== 0) {
    throw new Error('git ' + args[0] + ' failed: ' + String(result.stderr).trim().split('\n')[0]);
  }
  return result.stdout;
}

function fail(reason) { throw new Error(reason); }
`
  .replace('__ALLOWED_KEYS__', JSON.stringify(ALLOWED_BASE_ENV_KEYS))
  .replace('__MAX_DRIVERS__', String(MAX_CONFIGURED_DRIVERS))
  .replace('__BASE_ARGS__', JSON.stringify(SAFE_GIT_BASE_ARGS));
