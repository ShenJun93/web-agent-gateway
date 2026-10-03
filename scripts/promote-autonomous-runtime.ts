import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
const Supervisor = join(LocalBase, 'Start-WagLocalSupervisor.ps1');
const InstalledExtension = join(LocalBase, 'browser-extension-v2');
const LocalState = join(LocalBase, 'state');
const MaintenanceLease = join(LocalState, 'maintenance-v1.json');
const MaintenanceAck = join(LocalState, 'maintenance-v1.ack.json');
const SupervisorPidFile = join(LocalBase, 'logs', 'wag-local-supervisor.pid');
const MutationState = 'E:\\AI-BROWSER\\wag-acceptance\\devspace-state\\wag-mutation.sqlite';
const ExtensionReleaseState = MutationState + '.browser-control-pairing.json.extension-release.json';
const UrlFile = MutationState + '.operator-url';
const Capability = 'autonomous-local-runtime-v1';
const RuntimeSupportFiles = [
  'scripts/install-wag-local-launchers.ps1',
  'scripts/wag-local-doctor.ps1',
  'scripts/wag-local-product-health.ps1',
  'scripts/wag-local-clean-install-acceptance.ps1',
  'scripts/wag-local-provision.ps1',
  'scripts/wag-local-setup.ps1',
  'scripts/wag-local-start.ps1',
  'scripts/wag-local-supervisor.ps1',
  'scripts/wag-local-tunnel-launcher.ps1',
  'docs/benchmarks/devspace-pin.json',
  'packaging/runtime-package-lock.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
] as const;

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

function treeSha256(root: string): string {
  const files: string[] = [];
  const visit = (dir: string, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const absolute = join(dir, name);
      const relative = prefix ? prefix + '/' + name : name;
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) files.push(relative);
      else throw new Error('Unsupported runtime asset type: ' + absolute);
    }
  };
  visit(root);
  const hash = createHash('sha256');
  for (const relative of files) {
    hash.update(relative.replaceAll('\\', '/'), 'utf8');
    hash.update('\0');
    hash.update(readFileSync(join(root, ...relative.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function runtimeLauncherSources(root: string): readonly (readonly [string, string])[] {
  return [
    [join(root, 'scripts', 'wag-local-tunnel-launcher.ps1'), Launcher],
    [join(root, 'scripts', 'wag-local-start.ps1'), Starter],
    [join(root, 'scripts', 'wag-local-supervisor.ps1'), Supervisor],
  ] as const;
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

function syncLocalLaunchers(runtimeRoot: string): void {
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for WAG launchers');
  for (const [source, target] of runtimeLauncherSources(runtimeRoot)) {
    if (!existsSync(source)) throw new Error('Prepared WAG launcher missing: ' + source);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
}

function verifiedSupervisorPid(): number | undefined {
  if (!existsSync(SupervisorPidFile)) return undefined;
  const value = Number(readFileSync(SupervisorPidFile, 'utf8').trim());
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  const check = run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + String(value)
      + "' -ErrorAction SilentlyContinue; if($null -eq $p){exit 1};"
      + "if($p.Name -ne 'pwsh.exe' -or $p.CommandLine -notmatch 'Start-WagLocalSupervisor\\.ps1'){exit 2};"
      + "Write-Output $p.ProcessId",
  ], { allowFailure: true });
  return check.status === 0 ? value : undefined;
}

function stopSupervisor(pid: number): void {
  run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "Stop-Process -Id " + String(pid) + " -Force -ErrorAction Stop",
  ]);
  rmSync(SupervisorPidFile, { force: true });
}

function startSupervisor(): number {
  rmSync(SupervisorPidFile, { force: true });
  const command = [
    "$ErrorActionPreference='Stop'",
    "$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source",
    "$p=Start-Process -FilePath $pwsh -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',"
      + psSingleQuote(Supervisor) + ") -WindowStyle Hidden -PassThru",
    "Write-Output $p.Id",
  ].join(';');
  const launched = run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ]);
  const pid = Number(launched.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('WAG supervisor restart PID missing');
  return pid;
}

interface MaintenanceToken {
  readonly leaseId: string;
  readonly restartSupervisor: boolean;
  readonly supervisorPid?: number;
}

async function acquireMaintenance(head: string): Promise<MaintenanceToken> {
  mkdirSync(LocalState, { recursive: true });
  const leaseId = 'maint_' + randomUUID();
  const lease = {
    schema: 'WAG_LOCAL_MAINTENANCE_V1',
    leaseId,
    sourceHead: head,
    issuedAtUtc: new Date().toISOString(),
    expiresAtUtc: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  const temp = MaintenanceLease + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(lease, null, 2) + '\n', 'utf8');
  renameSync(temp, MaintenanceLease);
  rmSync(MaintenanceAck, { force: true });

  const pid = verifiedSupervisorPid();
  const installedSupportsLease = existsSync(Supervisor)
    && readFileSync(Supervisor, 'utf8').includes('WAG_LOCAL_MAINTENANCE_V1');
  if (pid === undefined) return { leaseId, restartSupervisor: true };

  if (!installedSupportsLease) {
    try {
      stopSupervisor(pid);
      return { leaseId, restartSupervisor: true, supervisorPid: pid };
    } catch (error) {
      rmSync(MaintenanceLease, { force: true });
      rmSync(MaintenanceAck, { force: true });
      throw error;
    }
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!existsSync(MaintenanceAck)) continue;
    try {
      const ack = JSON.parse(readFileSync(MaintenanceAck, 'utf8')) as Record<string, unknown>;
      if (ack.schema === 'WAG_LOCAL_MAINTENANCE_ACK_V1'
          && ack.leaseId === leaseId
          && Number(ack.supervisorPid) === pid) {
        return { leaseId, restartSupervisor: false, supervisorPid: pid };
      }
    } catch { /* retry bounded */ }
  }
  rmSync(MaintenanceLease, { force: true });
  rmSync(MaintenanceAck, { force: true });
  throw new Error('WAG supervisor did not acknowledge maintenance lease');
}

function releaseMaintenance(token: MaintenanceToken): number | undefined {
  rmSync(MaintenanceLease, { force: true });
  rmSync(MaintenanceAck, { force: true });
  return token.restartSupervisor ? startSupervisor() : token.supervisorPid;
}

interface AssetTransaction {
  readonly root: string;
  readonly extensionBackup?: string;
  readonly launcherBackups: readonly { target: string; backup?: string }[];
}

function deployPreparedAssets(prepared: PreparedRuntime): AssetTransaction {
  mkdirSync(LocalState, { recursive: true });
  const root = join(LocalState, 'promotion-' + prepared.root.split(/[\\/]/).at(-1)! + '-' + randomUUID());
  const nextExtension = join(root, 'browser-extension-v2.next');
  const extensionBackup = join(root, 'browser-extension-v2.previous');
  const launcherBackupRoot = join(root, 'launchers');
  mkdirSync(root, { recursive: true });
  cpSync(prepared.extensionRoot, nextExtension, { recursive: true });
  if (treeSha256(nextExtension) !== prepared.extensionSha256) {
    throw new Error('Staged extension SHA256 mismatch');
  }

  let previousExtension: string | undefined;
  if (existsSync(InstalledExtension)) {
    renameSync(InstalledExtension, extensionBackup);
    previousExtension = extensionBackup;
  }
  try {
    renameSync(nextExtension, InstalledExtension);
    const launcherBackups: { target: string; backup?: string }[] = [];
    mkdirSync(launcherBackupRoot, { recursive: true });
    for (const [, target] of runtimeLauncherSources(prepared.root)) {
      if (existsSync(target)) {
        const backup = join(launcherBackupRoot, target.split(/[\\/]/).at(-1)!);
        cpSync(target, backup);
        launcherBackups.push({ target, backup });
      } else {
        launcherBackups.push({ target });
      }
    }
    syncLocalLaunchers(prepared.root);
    if (treeSha256(InstalledExtension) !== prepared.extensionSha256) {
      throw new Error('Installed extension SHA256 mismatch');
    }
    return { root, extensionBackup: previousExtension, launcherBackups };
  } catch (error) {
    rmSync(InstalledExtension, { recursive: true, force: true });
    if (previousExtension && existsSync(previousExtension)) renameSync(previousExtension, InstalledExtension);
    throw error;
  }
}

function rollbackPreparedAssets(transaction: AssetTransaction): void {
  rmSync(InstalledExtension, { recursive: true, force: true });
  if (transaction.extensionBackup && existsSync(transaction.extensionBackup)) {
    renameSync(transaction.extensionBackup, InstalledExtension);
  }
  for (const entry of transaction.launcherBackups) {
    if (entry.backup && existsSync(entry.backup)) cpSync(entry.backup, entry.target);
    else rmSync(entry.target, { force: true });
  }
  rmSync(transaction.root, { recursive: true, force: true });
}

function commitPreparedAssets(transaction: AssetTransaction): void {
  rmSync(transaction.root, { recursive: true, force: true });
}

interface ExtensionReleaseObservation {
  readonly connected?: boolean;
  readonly observedSourceHead?: string | null;
  readonly expectedSourceHead?: string | null;
  readonly match?: boolean | null;
  readonly reloadRequested?: boolean;
  readonly reloadAccepted?: boolean;
  readonly lastError?: string | null;
}

async function waitForExtensionRelease(head: string, timeoutMs = 30_000): Promise<{
  matched: boolean;
  legacyBootstrap: boolean;
  deferred: boolean;
  observation?: ExtensionReleaseObservation;
}> {
  const deadline = Date.now() + timeoutMs;
  let observation: ExtensionReleaseObservation | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!existsSync(ExtensionReleaseState)) continue;
    try {
      observation = JSON.parse(readFileSync(ExtensionReleaseState, 'utf8')) as ExtensionReleaseObservation;
      if (observation.connected === true
          && observation.expectedSourceHead === head
          && observation.observedSourceHead === head
          && observation.match === true) {
        return { matched: true, legacyBootstrap: false, deferred: false, observation };
      }
      if (observation.connected === true
          && observation.expectedSourceHead === head
          && observation.observedSourceHead == null
          && observation.reloadRequested === true
          && observation.lastError) {
        return { matched: false, legacyBootstrap: true, deferred: false, observation };
      }
    } catch { /* keep polling a bounded state file */ }
  }
  const deferred = observation?.connected === false
    && observation.observedSourceHead == null
    && observation.reloadRequested !== true;
  return {
    matched: false,
    legacyBootstrap: observation?.observedSourceHead == null
      && observation?.reloadRequested === true
      && Boolean(observation?.lastError),
    deferred,
    ...(observation === undefined ? {} : { observation }),
  };
}

function startWagTunnel(tag: string) {
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
  readonly extensionRoot: string;
  readonly extensionSha256: string;
  readonly launcherRoot: string;
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
    extensionSourceHead?: unknown;
    extensionSha256?: unknown;
  };
  if (marker.sourceHead !== head) throw new Error('Prepared runtime sourceHead mismatch');
  if (marker.capability !== Capability) throw new Error('Prepared runtime capability mismatch');
  if (marker.extensionSourceHead !== head) throw new Error('Prepared extension sourceHead mismatch');
  const extensionRoot = join(root, 'browser', 'extension');
  if (!existsSync(extensionRoot)) throw new Error('Prepared browser extension is missing');
  const extensionSha256 = treeSha256(extensionRoot);
  if (marker.extensionSha256 !== extensionSha256) throw new Error('Prepared extension SHA256 mismatch');
  const launcherRoot = join(root, 'scripts');
  for (const [source] of runtimeLauncherSources(root)) {
    if (!existsSync(source)) throw new Error('Prepared WAG launcher missing: ' + source);
  }
  for (const relative of RuntimeSupportFiles) {
    if (!existsSync(join(root, ...relative.split('/')))) {
      throw new Error('Prepared WAG runtime support file missing: ' + relative);
    }
  }
  return {
    root,
    cli: wrapperCli(root),
    receipt: join(LogDir, 'activate-' + short + '.json'),
    extensionRoot,
    extensionSha256,
    launcherRoot,
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
    rmSync(join(root, 'browser'), { recursive: true, force: true });
    cpSync(join(staging, 'browser', 'extension'), join(root, 'browser', 'extension'), { recursive: true });
    writeFileSync(
      join(root, 'browser', 'extension', 'release-identity.js'),
      "export const EXTENSION_RELEASE_IDENTITY = Object.freeze({\n"
        + "  schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1',\n"
        + "  sourceHead: '" + head + "',\n"
        + "});\n",
      'utf8',
    );
    for (const relative of RuntimeSupportFiles) {
      const source = join(staging, ...relative.split('/'));
      const target = join(root, ...relative.split('/'));
      if (!existsSync(source)) throw new Error('Runtime support source missing: ' + relative);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
    ensureJunction(join(root, 'node_modules'), buildNodeModules);
    const extensionSha256 = treeSha256(join(root, 'browser', 'extension'));
    writeFileSync(
      join(root, 'RUNTIME.json'),
      JSON.stringify({
        schema: 'WAG_ATOMIC_RUNTIME_RELEASE_V1',
        sourceHead: head,
        sourceWorktree: Repo,
        preparedAtUtc: new Date().toISOString(),
        capability: Capability,
        extensionSourceHead: head,
        extensionSha256,
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

  let maintenance: MaintenanceToken | undefined;
  let transaction: AssetTransaction | undefined;
  let wrapperChanged = false;
  let oldTunnelStopped = false;
  try {
    maintenance = await acquireMaintenance(head);
    transaction = deployPreparedAssets(prepared);

    if (previousCli !== prepared.cli) {
      switchWrapper(previousCli, prepared.cli);
      wrapperChanged = true;
    }
    await stopWagTunnel();
    oldTunnelStopped = true;
    rmSync(UrlFile, { force: true });
    rmSync(ExtensionReleaseState, { force: true });

    const started = startWagTunnel('activate-' + head.slice(0, 12));
    await waitForWag(started, 'Activated autonomous WAG runtime');
    const extension = await waitForExtensionRelease(head);
    if (!extension.matched && !extension.legacyBootstrap && !extension.deferred) {
      throw new Error(
        'Activated browser extension did not converge to runtime source HEAD: '
        + JSON.stringify(extension.observation ?? null),
      );
    }

    commitPreparedAssets(transaction);
    transaction = undefined;
    const supervisorPid = releaseMaintenance(maintenance);
    maintenance = undefined;

    writeReceipt(prepared.receipt, {
      state: extension.matched
        ? 'SUCCEEDED'
        : extension.legacyBootstrap
          ? 'SUCCEEDED_EXTENSION_RELOAD_REQUIRED'
          : 'SUCCEEDED_EXTENSION_DEFERRED',
      sourceHead: head,
      previousCli,
      cli: prepared.cli,
      launcherPid: started.hostPid,
      stdoutLog: started.stdout,
      stderrLog: started.stderr,
      extensionSha256: prepared.extensionSha256,
      extension,
      supervisorPid: supervisorPid ?? null,
      completedAtUtc: new Date().toISOString(),
    });
  } catch (error) {
    let rollback = 'not-required';
    try {
      if (oldTunnelStopped) await stopWagTunnel();
      if (wrapperChanged) switchWrapper(prepared.cli, previousCli);
      if (transaction) {
        rollbackPreparedAssets(transaction);
        transaction = undefined;
      }
      if (oldTunnelStopped) {
        rmSync(UrlFile, { force: true });
        rmSync(ExtensionReleaseState, { force: true });
        const restored = startWagTunnel('rollback-' + head.slice(0, 12));
        await waitForWag(restored, 'Rollback WAG runtime');
      }
      rollback = 'succeeded';
    } catch (rollbackError) {
      rollback = 'failed:' + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    }

    let supervisorPid: number | undefined;
    if (maintenance) {
      try {
        supervisorPid = releaseMaintenance(maintenance);
        maintenance = undefined;
      } catch (releaseError) {
        rollback += ';maintenance-release-failed:'
          + (releaseError instanceof Error ? releaseError.message : String(releaseError));
      }
    }

    writeReceipt(prepared.receipt, {
      state: 'FAILED',
      sourceHead: head,
      previousCli,
      cli: prepared.cli,
      error: error instanceof Error ? error.message : String(error),
      rollback,
      supervisorPid: supervisorPid ?? null,
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
