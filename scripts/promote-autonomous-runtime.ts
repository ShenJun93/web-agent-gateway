import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREPARE = '--prepare-runtime';
const ACTIVATE = '--activate-prepared-runtime';
const WORKER = '--activate-prepared-runtime-worker';
const PROMOTE_CURRENT = '--promote-current';

const Repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RuntimeBase = 'E:\\WAG-Runtime';
const LogDir = 'E:\\WAG-Acceptance\\promotion-logs';
const Wrapper = '/home/pacmap/bin/wag-mcp-stdio.sh';
const LocalBase = join(process.env.LOCALAPPDATA ?? '', 'WAG-Local');
const Launcher = join(LocalBase, 'Start-WagLocalTunnel.ps1');
const Starter = join(LocalBase, 'Start-WagLocal.ps1');
const LauncherSource = join(Repo, 'scripts', 'wag-local-tunnel-launcher.ps1');
const StarterSource = join(Repo, 'scripts', 'wag-local-start.ps1');
const UrlFile = 'E:\\AI-BROWSER\\wag-acceptance\\devspace-state\\wag-mutation.sqlite.operator-url';
const Capability = 'autonomous-local-runtime-v1';

function run(
  file: string,
  args: readonly string[],
  options: { cwd?: string; allowFailure?: boolean } = {},
) {
  const result = spawnSync(file, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      'Command failed (' + String(result.status) + '): ' + file + ' ' + args.join(' ')
      + '\nSTDOUT:\n' + String(result.stdout ?? '').trim()
      + '\nSTDERR:\n' + String(result.stderr ?? '').trim(),
    );
  }
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function git(args: readonly string[], cwd = Repo): string {
  return run('git.exe', ['-C', cwd, ...args]).stdout.trim();
}

function assertHead(value: string | undefined): asserts value is string {
  if (!/^[a-f0-9]{40}$/.test(value ?? '')) {
    throw new Error('Expected an exact 40-hex source HEAD');
  }
}

function ensureJunction(path: string, target: string): void {
  if (existsSync(path)) return;
  symlinkSync(target, path, 'junction');
}

function wrapperCli(root: string): string {
  return root.replaceAll('\\', '/') + '/dist/cli.js';
}

function currentWrapperCli(): string {
  const text = run('wsl.exe', ['-e', 'cat', Wrapper]).stdout;
  const matches = [...text.matchAll(/E:\/WAG-Runtime\/[A-Za-z0-9._-]+\/dist\/cli\.js/g)]
    .map((match) => match[0]);
  if (matches.length !== 1) {
    throw new Error('Expected exactly one pinned WAG CLI in wrapper; found ' + String(matches.length));
  }
  return matches[0]!;
}

function switchWrapper(expectedOld: string, next: string): void {
  const python = [
    'import sys',
    'p, old, new = sys.argv[1:]',
    'with open(p, "r", encoding="utf-8", newline=None) as f: s = f.read()',
    'if new not in s:',
    '    if old not in s: raise SystemExit("expected WAG CLI path not found")',
    '    s = s.replace(old, new, 1)',
    'with open(p, "w", encoding="utf-8", newline="\\n") as f: f.write(s)',
  ].join('\n');

  run('wsl.exe', ['-e', 'python3', '-c', python, Wrapper, expectedOld, next]);
  run('wsl.exe', ['-e', 'chmod', '700', Wrapper]);
}

function wagTunnelPid(): number | undefined {
  const listener = run(
    'wsl.exe',
    ['-e', 'bash', '-lc', 'ss -ltnp 2>/dev/null | grep -E "127\\.0\\.0\\.1:8080[[:space:]]" || true'],
  ).stdout;

  const pids = [...listener.matchAll(/pid=(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((value, index, all) => all.indexOf(value) === index);

  if (pids.length === 0) return undefined;
  if (pids.length !== 1) throw new Error('Expected <=1 WAG tunnel on :8080');

  const pid = pids[0]!;
  const cmdline = run(
    'wsl.exe',
    ['-e', 'bash', '-lc', "tr '\\0' ' ' < /proc/" + String(pid) + '/cmdline 2>/dev/null'],
  ).stdout.trim();
  if (!cmdline.includes('tunnel-client') || !cmdline.includes('web-agent-gateway')) {
    throw new Error(':8080 belongs to an unexpected process: ' + cmdline);
  }
  return pid;
}

async function stopWagTunnel(): Promise<void> {
  const pid = wagTunnelPid();
  if (pid === undefined) return;
  run('wsl.exe', ['-e', 'kill', '-TERM', String(pid)]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (run('wsl.exe', ['-e', 'kill', '-0', String(pid)], { allowFailure: true }).status !== 0) return;
  }
  throw new Error('WAG tunnel PID did not exit: ' + String(pid));
}

function psSingleQuote(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function windowsPidAlive(pid: number): boolean {
  return run(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'if (Get-Process -Id ' + String(pid) + ' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }',
    ],
    { allowFailure: true },
  ).status === 0;
}

function syncLocalLaunchers(): void {
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for WAG launchers');
  for (const [source, target] of [[LauncherSource, Launcher], [StarterSource, Starter]] as const) {
    if (!existsSync(source)) throw new Error('Canonical WAG launcher missing: ' + source);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
}

function startWagTunnel(tag: string) {
  syncLocalLaunchers();
  mkdirSync(LogDir, { recursive: true });
  const stdout = join(LogDir, 'wag-' + tag + '.stdout.log');
  const stderr = join(LogDir, 'wag-' + tag + '.stderr.log');
  const pidFile = join(LogDir, 'wag-' + tag + '.launcher.pid');
  rmSync(stdout, { force: true });
  rmSync(stderr, { force: true });
  rmSync(pidFile, { force: true });

  const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', Launcher];
  const bootstrap = [
    "$ErrorActionPreference = 'Stop'",
    '$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source',
    '$p = Start-Process -FilePath $pwsh'
      + ' -ArgumentList @(' + args.map(psSingleQuote).join(', ') + ')'
      + ' -WindowStyle Hidden'
      + ' -RedirectStandardOutput ' + psSingleQuote(stdout)
      + ' -RedirectStandardError ' + psSingleQuote(stderr)
      + ' -PassThru',
    '[IO.File]::WriteAllText(' + psSingleQuote(pidFile) + ', [string]$p.Id)',
  ].join('\n');

  const launched = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', bootstrap],
    { windowsHide: true, stdio: 'ignore' },
  );
  if (launched.error) throw launched.error;
  if (launched.status !== 0) throw new Error('WAG launcher bootstrap failed');

  const hostPid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '');
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0) throw new Error('WAG launcher PID missing');
  return { hostPid, stdout, stderr };
}

async function waitForWag(started: ReturnType<typeof startWagTunnel>, label: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (existsSync(UrlFile)) {
      const value = readFileSync(UrlFile, 'utf8').trim();
      if (/^http:\/\/127\.0\.0\.1:\d+\/bootstrap\?token=/.test(value) && wagTunnelPid() !== undefined) {
        return;
      }
    }
    if (!windowsPidAlive(started.hostPid)) break;
  }
  throw new Error(
    label + ' did not become ready'
    + '; launcherPid=' + String(started.hostPid)
    + '; stdoutLog=' + started.stdout
    + '; stderrLog=' + started.stderr,
  );
}

interface PreparedRuntime {
  readonly root: string;
  readonly cli: string;
  readonly receipt: string;
}

function preparedRuntime(head: string): PreparedRuntime {
  assertHead(head);
  const short = head.slice(0, 12);
  const root = join(RuntimeBase, short);
  const markerPath = join(root, 'RUNTIME.json');
  if (!existsSync(markerPath) || !existsSync(join(root, 'dist', 'cli.js'))) {
    throw new Error('Prepared runtime is incomplete: ' + root);
  }
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
    sourceHead?: unknown;
    capability?: unknown;
  };
  if (marker.sourceHead !== head) throw new Error('Prepared runtime sourceHead mismatch');
  if (marker.capability !== Capability) throw new Error('Prepared runtime capability mismatch');
  return {
    root,
    cli: wrapperCli(root),
    receipt: join(LogDir, 'activate-' + short + '.json'),
  };
}

function prepareRuntime(head: string): PreparedRuntime {
  assertHead(head);
  if (git(['rev-parse', 'HEAD']) !== head) {
    throw new Error('Refusing to prepare a runtime that is not the current committed HEAD');
  }
  const branch = git(['branch', '--show-current']);
  if (!branch || /^(main|master|release)$/.test(branch)) throw new Error('Unsafe development branch: ' + branch);

  const short = head.slice(0, 12);
  const root = join(RuntimeBase, short);
  const staging = 'E:\\WAG-Acceptance\\runtime-build-' + short;
  const buildNodeModules = join(Repo, 'node_modules');
  if (!existsSync(buildNodeModules)) {
    throw new Error('worktree node_modules required for runtime build');
  }

  if (existsSync(staging)) {
    run('git.exe', ['-C', Repo, 'worktree', 'remove', '--force', staging], { allowFailure: true });
    rmSync(staging, { recursive: true, force: true });
  }

  run('git.exe', ['-C', Repo, 'worktree', 'add', '--detach', staging, head]);
  try {
    ensureJunction(join(staging, 'node_modules'), buildNodeModules);
    const cmdExe = process.env.ComSpec ?? 'cmd.exe';
    run(cmdExe, ['/d', '/s', '/c', 'npm.cmd run typecheck'], { cwd: staging });
    run(cmdExe, ['/d', '/s', '/c', 'npm.cmd run build'], { cwd: staging });

    mkdirSync(root, { recursive: true });
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    cpSync(join(staging, 'dist'), join(root, 'dist'), { recursive: true });
    cpSync(join(staging, 'package.json'), join(root, 'package.json'));
    ensureJunction(join(root, 'node_modules'), buildNodeModules);
    writeFileSync(
      join(root, 'RUNTIME.json'),
      JSON.stringify({
        sourceHead: head,
        sourceWorktree: Repo,
        preparedAtUtc: new Date().toISOString(),
        capability: Capability,
      }, null, 2) + '\n',
      'utf8',
    );
  } finally {
    run('git.exe', ['-C', Repo, 'worktree', 'remove', '--force', staging], { allowFailure: true });
    rmSync(staging, { recursive: true, force: true });
  }

  const prepared = preparedRuntime(head);
  console.log('WAG_RUNTIME_PREPARED=True');
  console.log('SOURCE_HEAD=' + head);
  console.log('RUNTIME=' + prepared.root);
  return prepared;
}

function writeReceipt(path: string, value: Record<string, unknown>): void {
  mkdirSync(LogDir, { recursive: true });
  const temp = path + '.activating';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

async function activateWorker(head: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const prepared = preparedRuntime(head);
  const previousCli = currentWrapperCli();

  if (previousCli === prepared.cli) {
    writeReceipt(prepared.receipt, {
      state: 'ALREADY_ACTIVE',
      sourceHead: head,
      cli: prepared.cli,
      completedAtUtc: new Date().toISOString(),
    });
    return;
  }

  let wrapperChanged = false;
  let oldTunnelStopped = false;
  try {
    switchWrapper(previousCli, prepared.cli);
    wrapperChanged = true;
    await stopWagTunnel();
    oldTunnelStopped = true;
    rmSync(UrlFile, { force: true });

    const started = startWagTunnel('activate-' + head.slice(0, 12));
    await waitForWag(started, 'Activated autonomous WAG runtime');
    writeReceipt(prepared.receipt, {
      state: 'SUCCEEDED',
      sourceHead: head,
      previousCli,
      cli: prepared.cli,
      launcherPid: started.hostPid,
      stdoutLog: started.stdout,
      stderrLog: started.stderr,
      completedAtUtc: new Date().toISOString(),
    });
  } catch (error) {
    let rollback = 'not-required';
    if (wrapperChanged) {
      try {
        switchWrapper(prepared.cli, previousCli);
        if (oldTunnelStopped) {
          await stopWagTunnel();
          rmSync(UrlFile, { force: true });
          const restored = startWagTunnel('rollback-' + head.slice(0, 12));
          await waitForWag(restored, 'Rollback WAG runtime');
        }
        rollback = 'succeeded';
      } catch (rollbackError) {
        rollback = 'failed:' + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }

    writeReceipt(prepared.receipt, {
      state: 'FAILED',
      sourceHead: head,
      previousCli,
      cli: prepared.cli,
      error: error instanceof Error ? error.message : String(error),
      rollback,
      completedAtUtc: new Date().toISOString(),
    });
    throw error;
  }
}

function scheduleActivation(head: string): void {
  const prepared = preparedRuntime(head);
  const script = process.argv[1];
  if (!script) throw new Error('Activation script path unavailable');
  rmSync(prepared.receipt, { force: true });

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', script, WORKER, head],
    { cwd: Repo, detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  console.log('WAG_RUNTIME_ACTIVATION_SCHEDULED=True');
  console.log('SOURCE_HEAD=' + head);
  console.log('RECEIPT=' + prepared.receipt);
}

const prepareIndex = process.argv.indexOf(PREPARE);
const activateIndex = process.argv.indexOf(ACTIVATE);
const workerIndex = process.argv.indexOf(WORKER);
const promoteCurrent = process.argv.includes(PROMOTE_CURRENT);
const selected = Number(prepareIndex >= 0) + Number(activateIndex >= 0)
  + Number(workerIndex >= 0) + Number(promoteCurrent);

if (selected !== 1) {
  throw new Error(
    'Choose exactly one mode: '
    + [PREPARE + ' <HEAD>', ACTIVATE + ' <HEAD>', PROMOTE_CURRENT].join(', '),
  );
}

if (prepareIndex >= 0) {
  const head = process.argv[prepareIndex + 1];
  assertHead(head);
  prepareRuntime(head);
} else if (workerIndex >= 0) {
  const head = process.argv[workerIndex + 1];
  assertHead(head);
  await activateWorker(head);
} else if (activateIndex >= 0) {
  const head = process.argv[activateIndex + 1];
  assertHead(head);
  scheduleActivation(head);
} else {
  const head = git(['rev-parse', 'HEAD']);
  assertHead(head);
  prepareRuntime(head);
  scheduleActivation(head);
}
