import { gzipSync } from 'node:zlib';
import { minifyHelperSource } from './safe-git.js';

/**
 * How WAG runs a configured verification profile.
 *
 * The execution backend takes one `cmd.exe` command string and offers no argv, env or stdin
 * channel, so the profile used to be rendered as `set "K=V" && npm test` — a shell string whose
 * only protection was a character class strict enough to forbid every metacharacter, and which
 * inherited the backend's whole environment minus one scrubbed key.
 *
 * That left two real gaps. The child inherited every secret the operator's shell happened to
 * export, and the test asserting otherwise passed only because the *test fixture* launches the
 * backend through `sanitizeDevspaceEnvironment` — in production WAG connects to a backend it did
 * not start, so that sanitization never happens. And cancellation sent Ctrl+C, which does not
 * reap a process tree, so a wedged grandchild outlived the job.
 *
 * This module closes both by reusing the mechanism ADR-0024 accepted for git: a WAG-owned helper,
 * gzipped and base64url-encoded, evaluated by a `node -e` stub, which then spawns the profile's
 * argv directly with an environment built upwards from an allowlist.
 *
 * The only thing evaluated is this file's own compile-time constant. The caller-influenced part —
 * the argv, the profile environment, the deadline — travels as a separate base64url JSON argument
 * and is JSON-parsed, never evaluated, so nothing a profile or a repository controls is ever code.
 */

/**
 * Environment a verification child may see. Everything else is dropped, including anything the
 * operator's shell exported and anything the execution backend added.
 *
 * `NODE_OPTIONS` is absent deliberately and by construction: it can inject `--require`, which
 * would run code of someone else's choosing inside every Node-based verification.
 */
export const VERIFY_ALLOWED_ENV_KEYS: readonly string[] = [
  'PATH', 'Path', 'PATHEXT',
  'SYSTEMROOT', 'SystemRoot', 'SYSTEMDRIVE', 'SystemDrive', 'WINDIR', 'windir',
  'COMSPEC', 'ComSpec', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'ProgramData',
  'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)', 'ProgramW6432',
  'LANG', 'LC_ALL', 'TZ',
];

/**
 * Extra grace, in milliseconds, between the executor's yield deadline and the runner's own.
 *
 * The executor yields at the profile's timeout and WAG reports `EXECUTION_TIMEOUT_UNCONFIRMED`,
 * which is an accepted contract (ADR-0016). The runner's deadline sits deliberately after that,
 * so it never changes what WAG reports — its only job is to guarantee the process tree dies
 * instead of leaking when the job is abandoned.
 */
export const VERIFY_TREE_KILL_GRACE_MS = 30_000;

const VERIFY_RUNNER_SOURCE = minifyHelperSource(`
const { spawn, spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join, isAbsolute, delimiter, sep } = require('path');

const input = JSON.parse(require('zlib').gunzipSync(Buffer.from(process.argv[2], 'base64url')).toString('utf8'));

const ALLOWED = ${JSON.stringify(VERIFY_ALLOWED_ENV_KEYS)};

// Built upwards, never copied and trimmed: a secret the operator's shell exported, or one the
// execution backend added, cannot reach the verification unless it is named here.
const env = {};
for (const key of ALLOWED) {
  const value = process.env[key];
  if (typeof value === 'string' && value !== '') env[key] = value;
}
for (const key of Object.keys(input.env || {})) env[key] = input.env[key];

/**
 * Windows has no exec: a PATH entry is only runnable once an extension from PATHEXT is applied,
 * and npm and its peers are .CMD shims rather than executables. Extensions are tried before the
 * bare name, because the bare name is a POSIX shell script that cannot be spawned here.
 */
function resolveExecutable(name) {
  if (name.includes('/') || name.includes(sep) || isAbsolute(name)) return name;
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const order = process.platform === 'win32' ? extensions.concat(['']) : [''];
  for (const dir of String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    for (const extension of order) {
      const candidate = join(dir, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

const resolved = resolveExecutable(input.argv[0]);
const isScript = /\\.(cmd|bat)$/i.test(resolved);
// cmd.exe /s /c strips one layer of quoting, so a path with spaces needs an outer pair around
// the whole command. Every argument is already restricted to characters with no shell meaning.
const file = isScript ? (env.ComSpec || 'cmd.exe') : resolved;
const args = isScript
  ? ['/d', '/s', '/c', '""' + resolved + '"' + input.argv.slice(1).map(function (a) { return ' ' + a; }).join('') + '"']
  : input.argv.slice(1);

const child = spawn(file, args, {
  env: env,
  stdio: 'inherit',
  windowsHide: true,
  windowsVerbatimArguments: isScript,
  detached: process.platform !== 'win32',
});

let settled = false;
function killTree(code) {
  if (settled) return;
  settled = true;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
  process.exit(code);
}

// Ctrl+C is what the gateway sends to cancel, and on its own it does not reap descendants.
for (const signal of ['SIGINT', 'SIGBREAK', 'SIGTERM']) {
  try { process.on(signal, function () { killTree(130); }); } catch { /* not supported here */ }
}
// Deliberately after the executor's own yield: this never changes what the gateway reports, it
// only stops an abandoned tree from outliving the job.
const deadline = setTimeout(function () { killTree(124); }, input.treeKillAfterMs);
if (typeof deadline.unref === 'function') deadline.unref();

child.on('error', function () { process.exit(127); });
child.on('exit', function (code, signal) {
  settled = true;
  clearTimeout(deadline);
  process.exit(signal ? 1 : (code === null ? 1 : code));
});
`);

/**
 * Assembles the one command string the executor accepts.
 *
 * Everything after the stub is base64url, so nothing in it can be shell syntax — the argv, the
 * profile's own environment and the deadline all travel as data and are decoded inside the
 * helper.
 */
export function buildVerifyCommand(
  argv: readonly string[],
  envEntries: readonly (readonly [string, string])[],
  timeoutMs: number,
): string {
  const payload = {
    argv: [...argv],
    env: Object.fromEntries(envEntries),
    treeKillAfterMs: timeoutMs + VERIFY_TREE_KILL_GRACE_MS,
  };
  return [
    'node -e "eval(require(\'zlib\').gunzipSync(Buffer.from(process.argv[1],\'base64url\')).toString(\'utf8\'))"',
    gzipSync(Buffer.from(VERIFY_RUNNER_SOURCE, 'utf8'), { level: 9 }).toString('base64url'),
    gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 }).toString('base64url'),
  ].join(' ');
}
