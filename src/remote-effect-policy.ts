import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import { buildSafeGitEnv } from './safe-git.js';

const execFileAsync = promisify(execFile);

const REMOTE_MUTATING_GIT_SUBCOMMANDS = new Set(['push', 'send-pack']);
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'archive', 'bisect', 'branch', 'cat-file', 'check-attr', 'check-ignore',
  'check-mailmap', 'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'config',
  'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'fetch', 'for-each-ref',
  'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log', 'ls-files',
  'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mv', 'name-rev', 'notes', 'prune', 'pull',
  'range-diff', 'read-tree', 'reflog', 'remote', 'repack', 'replace', 'reset', 'restore',
  'rev-list', 'rev-parse', 'rm', 'show', 'show-branch', 'sparse-checkout', 'status',
  'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var',
  'verify-commit', 'verify-pack', 'verify-tag', 'worktree', 'write-tree',
]);

const GIT_NO_VALUE_GLOBALS = new Set([
  '--version', '--help', '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects',
  '--bare', '--literal-pathspecs', '--no-optional-locks', '--no-lazy-fetch',
]);
const GIT_VALUE_GLOBALS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env',
]);

export class RemoteEffectPolicyError extends Error {
  constructor(message = 'Gateway denied remote Git/GitHub effect through generic execution surface') {
    super(message);
    this.name = 'RemoteEffectPolicyError';
  }
}

interface ParsedGitInvocation {
  readonly subcommand?: string;
  readonly subcommandIndex?: number;
  readonly globalArgs: readonly string[];
  readonly ambiguous: boolean;
  readonly injectedAliasConfig: boolean;
}

function executableName(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return basename(normalized).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/i, '');
}

function isAliasConfigSetting(value: string): boolean {
  const key = value.slice(0, Math.max(value.indexOf('='), 0)).trim().toLowerCase();
  return key.startsWith('alias.');
}

function parseGitInvocation(argv: readonly string[]): ParsedGitInvocation {
  const globalArgs: string[] = [];
  let injectedAliasConfig = false;
  let index = 1;

  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;

    if (GIT_NO_VALUE_GLOBALS.has(arg)) {
      globalArgs.push(arg);
      index += 1;
      continue;
    }

    if (GIT_VALUE_GLOBALS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) return { globalArgs, ambiguous: true, injectedAliasConfig };
      if (arg === '-c' && isAliasConfigSetting(value)) injectedAliasConfig = true;
      if (arg === '--config-env' && value.toLowerCase().startsWith('alias.')) injectedAliasConfig = true;
      globalArgs.push(arg, value);
      index += 2;
      continue;
    }

    if (arg.startsWith('-C') && arg.length > 2) {
      globalArgs.push(arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      const value = arg.slice(2);
      if (isAliasConfigSetting(value)) injectedAliasConfig = true;
      globalArgs.push(arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')
      || arg.startsWith('--namespace=') || arg.startsWith('--super-prefix=')) {
      globalArgs.push(arg);
      index += 1;
      continue;
    }

    // --exec-path can alter which git-* program is executed. --config-env can inject arbitrary
    // config from inherited environment. Generic execution has no reason to accept either form.
    if (arg === '--exec-path' || arg.startsWith('--exec-path=')
      || arg.startsWith('--config-env=')) {
      return { globalArgs, ambiguous: true, injectedAliasConfig };
    }

    return { globalArgs, ambiguous: true, injectedAliasConfig };
  }

  const subcommand = argv[index];
  if (subcommand !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(subcommand)) {
    return { globalArgs, ambiguous: true, injectedAliasConfig };
  }
  return {
    ...(subcommand === undefined
      ? {}
      : { subcommand: subcommand.toLowerCase(), subcommandIndex: index }),
    globalArgs,
    ambiguous: false,
    injectedAliasConfig,
  };
}

async function configuredAliasExists(
  gitExecutable: string,
  globalArgs: readonly string[],
  subcommand: string,
  cwd: string,
): Promise<boolean> {
  try {
    const result = await execFileAsync(
      gitExecutable,
      [...globalArgs, 'config', '--get', `alias.${subcommand}`],
      {
        cwd,
        env: buildSafeGitEnv(process.env),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 64 * 1024,
      },
    );
    return result.stdout.trim().length > 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === '1') return false;
    throw new RemoteEffectPolicyError('Gateway could not prove Git alias safety for generic execution');
  }
}

function shellScript(argv: readonly string[]): string | undefined {
  const name = executableName(argv[0] ?? '');
  if (name === 'cmd') {
    const index = argv.findIndex((arg, i) => i > 0 && /^\/(?:c|k)$/i.test(arg));
    return index < 0 ? undefined : argv.slice(index + 1).join(' ');
  }
  if (name === 'powershell' || name === 'pwsh') {
    const command = argv.findIndex((arg, i) => i > 0 && /^-(?:command|c)$/i.test(arg));
    if (command >= 0) return argv.slice(command + 1).join(' ');
    const encoded = argv.findIndex((arg, i) => i > 0 && /^-(?:encodedcommand|enc)$/i.test(arg));
    if (encoded >= 0 && argv[encoded + 1]) {
      try { return Buffer.from(argv[encoded + 1]!, 'base64').toString('utf16le'); }
      catch { throw new RemoteEffectPolicyError('Gateway rejected uninspectable PowerShell command'); }
    }
    return undefined;
  }
  if (name === 'bash' || name === 'sh' || name === 'zsh') {
    const index = argv.findIndex((arg, i) => i > 0 && arg === '-c');
    return index < 0 ? undefined : argv[index + 1];
  }
  return undefined;
}

/**
 * Interactive/shell text is intentionally stricter than direct argv.
 *
 * WAG cannot resolve a shell's aliases/functions/current directory with the same certainty as an
 * argv call. Direct Git/GitHub CLI commands therefore belong on command.run / machine.command.run,
 * where the executable and subcommand can be inspected before spawn.
 */
export function assertNoGitOrGhShellText(text: string): void {
  // Shells may quote the executable token or place it immediately after an invocation operator
  // (`&\"git\"`, `& 'git'`, `(git ...)`). Treat those spellings exactly like an unquoted token.
  // This remains deliberately narrower than general script/network inspection; the residual-risk
  // boundary below this module still applies to interpreters and arbitrary network clients.
  if (/(^|[\s;&|()])['\"`]?(?:git(?:\.exe)?|git-send-pack(?:\.exe)?|git-http-push(?:\.exe)?|git-remote-[A-Za-z0-9-]+(?:\.exe)?|gh(?:\.exe)?)['\"`]?(?=$|[\s;&|()])/i.test(text)) {
    throw new RemoteEffectPolicyError(
      'Gateway denied Git/GitHub CLI through shell or interactive terminal; use bounded direct argv tools',
    );
  }
}

/**
 * Keeps enough interactive input history to catch a direct Git/GitHub command split across MCP
 * input chunks before the chunk containing the completed command token is written to the shell.
 *
 * This is deliberately not a shell parser. Cursor-control tricks, interpreters and arbitrary
 * network clients remain part of the explicitly documented residual-risk class.
 */
export function nextTerminalRemoteEffectPolicyBuffer(previous: string, input: string): string {
  let current = previous;
  for (const char of input) {
    if (char === '\u0003') {
      current = '';
      continue;
    }
    if (char === '\b' || char === '\u007f') {
      current = current.slice(0, -1);
      continue;
    }
    current += char;
    if (current.length > 8 * 1024) current = current.slice(-8 * 1024);
  }
  assertNoGitOrGhShellText(current);
  const lf = current.lastIndexOf('\n');
  const cr = current.lastIndexOf('\r');
  const boundary = Math.max(lf, cr);
  return boundary < 0 ? current : current.slice(boundary + 1);
}

/**
 * Closes the known direct Git/GitHub remote-mutation bypasses on generic argv surfaces.
 *
 * This is not network isolation. Interpreters and arbitrary network-capable binaries remain a
 * separate residual-risk class and must not be represented as closed by this policy.
 */
export async function assertGenericExecutionRemoteEffectPolicy(
  argv: readonly string[],
  cwd: string,
): Promise<void> {
  if (!Array.isArray(argv) || argv.length === 0) return;
  const name = executableName(argv[0]!);

  if (name === 'gh') {
    // v1 is deliberately fail-closed: no GitHub CLI form is admitted through generic execution.
    throw new RemoteEffectPolicyError('Gateway denied GitHub CLI through generic execution surface');
  }

  if (
    name === 'git-send-pack'
    || name === 'git-http-push'
    || name.startsWith('git-remote-')
  ) {
    throw new RemoteEffectPolicyError();
  }

  if (name === 'git') {
    const parsed = parseGitInvocation(argv);
    if (parsed.ambiguous || parsed.injectedAliasConfig) {
      throw new RemoteEffectPolicyError('Gateway denied ambiguous Git invocation through generic execution surface');
    }
    const subcommand = parsed.subcommand;
    if (subcommand === undefined) return;
    if (REMOTE_MUTATING_GIT_SUBCOMMANDS.has(subcommand)) throw new RemoteEffectPolicyError();

    const subcommandArgs = parsed.subcommandIndex === undefined
      ? []
      : argv.slice(parsed.subcommandIndex + 1);
    if (
      (subcommand === 'submodule' && subcommandArgs.some((arg) => arg.toLowerCase() === 'foreach'))
      || (subcommand === 'bisect' && subcommandArgs.some((arg) => arg.toLowerCase() === 'run'))
    ) {
      throw new RemoteEffectPolicyError(
        'Gateway denied Git nested command execution through generic execution surface',
      );
    }

    if (ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) return;

    // Unknown git subcommands may be aliases or git-<name> executables. Neither receives generic
    // authority: aliases can expand to shell commands and external subcommands are arbitrary code.
    if (await configuredAliasExists(argv[0]!, parsed.globalArgs, subcommand, cwd)) {
      throw new RemoteEffectPolicyError('Gateway denied Git alias through generic execution surface');
    }
    throw new RemoteEffectPolicyError('Gateway denied unrecognized Git subcommand through generic execution surface');
  }

  const script = shellScript(argv);
  if (script !== undefined) assertNoGitOrGhShellText(script);
}
