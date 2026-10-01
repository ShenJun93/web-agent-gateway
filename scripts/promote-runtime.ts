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
import { dirname, join } from 'node:path';

const PREPARE = '--prepare';
const ACTIVATE = '--activate';
const WORKER = '--activate-worker';

const Repo = 'E:\\Projects\\web-agent-gateway\\.worktrees\\claude-autonomous-wag-harness-v1';
const RuntimeBase = 'E:\\WAG-Runtime';
const AcceptanceBase = 'E:\\WAG-Acceptance';
const LogDir = join(AcceptanceBase, 'promotion-logs');
const Wrapper = '/home/pacmap/bin/wag-mcp-stdio.sh';
const LocalBase = join(process.env.LOCALAPPDATA ?? '', 'WAG-Local');
const Launcher = join(LocalBase, 'Start-WagLocalTunnel.ps1');
const Starter = join(LocalBase, 'Start-WagLocal.ps1');
const Supervisor = join(LocalBase, 'Start-WagLocalSupervisor.ps1');
const LauncherSource = join(Repo, 'scripts', 'wag-local-tunnel-launcher.ps1');
const StarterSource = join(Repo, 'scripts', 'wag-local-start.ps1');
const SupervisorSource = join(Repo, 'scripts', 'wag-local-supervisor.ps1');
const UrlFile = 'E:\\AI-BROWSER\\wag-acceptance\\devspace-state\\wag-mutation.sqlite.operator-url';
const Capability = 'autonomous-local-runtime-v1';

const prepareIndex = process.argv.indexOf(PREPARE);
const activateIndex = process.argv.indexOf(ACTIVATE);
const workerIndex = process.argv.indexOf(WORKER);
const selected = Number(prepareIndex >= 0) + Number(activateIndex >= 0) + Number(workerIndex >= 0);
if (selected !== 1) throw new Error('Choose exactly one of --prepare, --activate, --activate-worker');

const head = process.argv[
  prepareIndex >= 0 ? prepareIndex + 1 : activateIndex >= 0 ? activateIndex + 1 : workerIndex + 1
];
if (!/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('An exact 40-hex source HEAD is required');
if ((activateIndex >= 0 || workerIndex >= 0) && (!process.env.LOCALAPPDATA || !existsSync(Launcher))) {
  throw new Error('WAG launcher missing: ' + Launcher);
}

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
      + '\nSTDOUT:\n' + (result.stdout ?? '').trim()
      + '\nSTDERR:\n' + (result.stderr ?? '').trim(),
    );
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function git(args: readonly string[], cwd = Repo): string {
  return run('git.exe', ['-C', cwd, ...args]).stdout.trim();
}

function ensureJunction(path: string, target: string): void {
  if (existsSync(path)) return;
  symlinkSync(target, path, 'junction');
}

function wrapperCli(root: string): string {
  return root.replaceAll('\\', '/') + '/dist/cli.js';
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

function currentWrapperCli(): string {
  const text = run('wsl.exe', ['-e', 'cat', Wrapper]).stdout;
  const matches = [...text.matchAll(/E:\/WAG-Runtime\/[A-Za-z0-9._-]+\/dist\/cli\.js/g)]
    .map((match) => match[0]);
  if (matches.length !== 1) {
    throw new Error('Expected exactly one pinned WAG CLI in wrapper; found ' + String(matches.length));
  }
  return matches[0]!;
}

function wagTunnelPid(): number | undefined {
  const listener = run('wsl.exe', [
    '-e', 'bash', '-lc',
    'ss -ltnp 2>/dev/null | grep -E "127\\.0\\.0\\.1:8080[[:space:]]" || true',
  ]).stdout;
  const pids = [...listener.matchAll(/pid=(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((value, index, all) => all.indexOf(value) === index);
  if (pids.length === 0) return undefined;
  if (pids.length !== 1) throw new Error('Expected <=1 WAG tunnel on :8080; found ' + pids.length);
  const pid = pids[0]!;
  const cmdline = run('wsl.exe', [
    '-e', 'bash', '-lc',
    "tr '\\0' ' ' < /proc/" + String(pid) + "/cmdline 2>/dev/null",
  ]).stdout.trim();
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
    const probe = run('wsl.exe', ['-e', 'kill', '-0', String(pid)], { allowFailure: true });
    if (probe.status !== 0) return;
  }
  throw new Error('WAG tunnel PID ' + pid + ' did not exit');
}

function psSingleQuote(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function windowsPidAlive(pid: number): boolean {
  return run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    'if (Get-Process -Id ' + String(pid) + ' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }',
  ], { allowFailure: true }).status === 0;
}

function syncLocalLaunchers(): void {
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for WAG launchers');
  for (const [source, target] of [[LauncherSource, Launcher], [StarterSource, Starter], [SupervisorSource, Supervisor]] as const) {
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

  const launcherArgs = [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', Launcher,
  ];
  const bootstrap = [
    "$ErrorActionPreference = 'Stop'",
    '$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source',
    '$p = Start-Process -FilePath $pwsh'
      + ' -ArgumentList @(' + launcherArgs.map(psSingleQuote).join(', ') + ')'
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
  if (launched.status !== 0) throw new Error('WAG launcher bootstrap failed: ' + launched.status);

  const hostPid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '');
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0) {
    throw new Error('WAG launcher did not persist a valid host PID');
  }
  return { hostPid, stdout, stderr };
}

async function waitForWag(started: ReturnType<typeof startWagTunnel>, label: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (existsSync(UrlFile)) {
      const candidate = readFileSync(UrlFile, 'utf8').trim();
      if (/^http:\/\/127\.0\.0\.1:\d+\/bootstrap\?token=/.test(candidate)
        && wagTunnelPid() !== undefined) return;
    }
    if (!windowsPidAlive(started.hostPid)) break;
  }
  throw new Error(label + ' did not become ready; launcherPid=' + started.hostPid
    + '; stdout=' + started.stdout + '; stderr=' + started.stderr);
}

interface PreparedRuntime {
  readonly root: string;
  readonly cli: string;
  readonly receipt: string;
}

function preparedRuntime(sourceHead: string): PreparedRuntime {
  if (git(['rev-parse', 'HEAD']) !== sourceHead) {
    throw new Error('Runtime source HEAD must equal the current committed development HEAD');
  }
  const short = sourceHead.slice(0, 12);
  const root = join(RuntimeBase, short);
  const markerPath = join(root, 'RUNTIME.json');
  if (!existsSync(markerPath) || !existsSync(join(root, 'dist', 'cli.js'))) {
    throw new Error('Prepared runtime is incomplete: ' + root);
  }
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
    sourceHead?: unknown;
    capability?: unknown;
  };
  if (marker.sourceHead !== sourceHead || marker.capability !== Capability) {
    throw new Error('Prepared runtime marker mismatch');
  }
  return {
    root,
    cli: wrapperCli(root),
    receipt: join(LogDir, 'activate-' + short + '.json'),
  };
}

function prepareRuntime(sourceHead: string): PreparedRuntime {
  if (git(['rev-parse', 'HEAD']) !== sourceHead) {
    throw new Error('Refusing to prepare a runtime that is not current committed HEAD');
  }
  const branch = git(['branch', '--show-current']);
  if (!branch || /^(main|master|release)$/.test(branch)) {
    throw new Error('Unsafe development branch: ' + branch);
  }

  const short = sourceHead.slice(0, 12);
  const root = join(RuntimeBase, short);
  const staging = join(AcceptanceBase, 'runtime-build-' + short);
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const mainRepo = dirname(commonDir);
  const mainNodeModules = join(mainRepo, 'node_modules');
  const buildNodeModules = join(Repo, 'node_modules');
  if (!existsSync(buildNodeModules) || !existsSync(mainNodeModules)) {
    throw new Error('node_modules prerequisite missing');
  }

  if (existsSync(staging)) {
    run('git.exe', ['-C', Repo, 'worktree', 'remove', '--force', staging], { allowFailure: true });
    rmSync(staging, { recursive: true, force: true });
  }

  run('git.exe', ['-C', Repo, 'worktree', 'add', '--detach', staging, sourceHead]);
  try {
    ensureJunction(join(staging, 'node_modules'), buildNodeModules);
    const cmd = process.env.ComSpec ?? 'cmd.exe';
    run(cmd, ['/d', '/s', '/c', 'npm.cmd run typecheck'], { cwd: staging });
    run(cmd, ['/d', '/s', '/c', 'npm.cmd run build'], { cwd: staging });

    mkdirSync(root, { recursive: true });
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    cpSync(join(staging, 'dist'), join(root, 'dist'), { recursive: true });
    cpSync(join(staging, 'package.json'), join(root, 'package.json'));
    ensureJunction(join(root, 'node_modules'), mainNodeModules);
    writeFileSync(join(root, 'RUNTIME.json'), JSON.stringify({
      sourceHead,
      sourceWorktree: Repo,
      preparedAtUtc: new Date().toISOString(),
      capability: Capability,
    }, null, 2) + '\n', 'utf8');
  } finally {
    run('git.exe', ['-C', Repo, 'worktree', 'remove', '--force', staging], { allowFailure: true });
    rmSync(staging, { recursive: true, force: true });
  }

  const prepared = preparedRuntime(sourceHead);
  console.log('WAG_RUNTIME_PREPARED=True');
  console.log('SOURCE_HEAD=' + sourceHead);
  console.log('RUNTIME=' + prepared.root);
  return prepared;
}

function writeActivationReceipt(path: string, value: Record<string, unknown>): void {
  mkdirSync(LogDir, { recursive: true });
  const temp = path + '.activating';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

async function activateWorker(sourceHead: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const prepared = preparedRuntime(sourceHead);
  const previousCli = currentWrapperCli();

  if (previousCli === prepared.cli) {
    writeActivationReceipt(prepared.receipt, {
      state: 'ALREADY_ACTIVE',
      sourceHead,
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

    const started = startWagTunnel('activate-' + sourceHead.slice(0, 12));
    await waitForWag(started, 'Activated WAG runtime');
    writeActivationReceipt(prepared.receipt, {
      state: 'SUCCEEDED',
      sourceHead,
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
          const restored = startWagTunnel('rollback-' + sourceHead.slice(0, 12));
          await waitForWag(restored, 'Rollback WAG runtime');
        }
        rollback = 'succeeded';
      } catch (rollbackError) {
        rollback = 'failed:' + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    writeActivationReceipt(prepared.receipt, {
      state: 'FAILED',
      sourceHead,
      previousCli,
      cli: prepared.cli,
      error: error instanceof Error ? error.message : String(error),
      rollback,
      completedAtUtc: new Date().toISOString(),
    });
    throw error;
  }
}

function scheduleActivation(sourceHead: string): void {
  const prepared = preparedRuntime(sourceHead);
  const script = process.argv[1];
  if (!script) throw new Error('Activation script path unavailable');
  rmSync(prepared.receipt, { force: true });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', script, WORKER, sourceHead],
    { cwd: Repo, detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  console.log('WAG_RUNTIME_ACTIVATION_SCHEDULED=True');
  console.log('SOURCE_HEAD=' + sourceHead);
  console.log('RECEIPT=' + prepared.receipt);
}

if (prepareIndex >= 0) {
  prepareRuntime(head!);
} else if (workerIndex >= 0) {
  await activateWorker(head!);
} else {
  scheduleActivation(head!);
}
