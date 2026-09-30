import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  readReleaseState,
  transactionalRollback,
  transactionalUpdate,
  uninstallOwnedArtifacts,
  type ReleaseManifest,
  type ReleaseState,
} from './product-release.js';
import { parseTunnelProfile, parseWrapper } from './product-health.js';

interface ProductReleaseArgs {
  packageRoot?: string;
  manifestPath?: string;
  output?: string;
}

export interface ProductUninstallArgs {
  output?: string;
  keepState?: boolean;
  removeManagedDevspace?: boolean;
}

interface Binding {
  wrapperPath: string;
  wrapperText: string;
  cliPath: string;
  configPath: string;
}

interface LegacyBaselineMarker {
  schema: 'WAG_LOCAL_LEGACY_BASELINE_V1';
  releaseId: string;
  cliPath: string;
  configPath: string;
  wrapperPath: string;
  sourceHead: string | null;
  createdAtUtc: string;
}

const localAppData = process.env.LOCALAPPDATA ?? '';
const installRoot = join(localAppData, 'WAG-Local');
const receiptsRoot = join(installRoot, 'receipts');

function runText(file: string, args: string[], cwd?: string): string {
  return execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runOptional(file: string, args: string[], cwd?: string): { ok: boolean; stdout: string } {
  try {
    return { ok: true, stdout: runText(file, args, cwd) };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function runLong(file: string, args: string[], cwd?: string, timeout = 190_000): boolean {
  const result = spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
  return !result.error && result.status === 0;
}

function loadBinding(): Binding {
  const profileText = runText('wsl.exe', [
    '-e', 'sh', '-lc', 'cat "$HOME/.config/tunnel-client/web-agent-gateway.yaml"',
  ]);
  const wrapperPath = parseTunnelProfile(profileText);
  const wrapperText = runText('wsl.exe', ['-e', 'cat', wrapperPath]);
  const binding = parseWrapper(wrapperText);
  return {
    wrapperPath,
    wrapperText,
    cliPath: binding.cliPath,
    configPath: binding.configPath,
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.tmp-' + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

function buildWrapper(releaseRoot: string, configPath: string): string {
  const cli = join(releaseRoot, 'dist', 'cli.js').replaceAll('\\', '/');
  const config = configPath.replaceAll('\\', '/');
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'exec node.exe \\',
    `  "${cli}" \\`,
    '  serve-stdio \\',
    `  --config "${config}"`,
    '',
  ].join('\n');
}

function writeWrapperAtomic(wrapperPath: string, text: string): void {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const script = [
    'set -eu',
    'umask 077',
    'tmp=$(mktemp "$2.tmp.XXXXXX")',
    'trap \'rm -f "$tmp"\' EXIT',
    'printf "%s" "$1" | base64 -d > "$tmp"',
    'chmod 700 "$tmp"',
    'mv -f "$tmp" "$2"',
    'trap - EXIT',
  ].join('; ');
  runText('wsl.exe', ['-e', 'sh', '-c', script, 'sh', b64, wrapperPath]);
}

function readTunnelClientPath(): string {
  const pin = join(installRoot, 'tunnel-client-path.txt');
  if (!existsSync(pin)) throw new Error('WAG_TUNNEL_CLIENT_PIN_MISSING');
  const value = readFileSync(pin, 'utf8').trim();
  if (!value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error('WAG_TUNNEL_CLIENT_PIN_INVALID');
  }
  return value;
}

function exactTunnelPids(path: string): number[] {
  const pgrep = runOptional('wsl.exe', ['-e', 'pgrep', '-f', 'tunnel-client']);
  if (!pgrep.ok || !pgrep.stdout) return [];
  const expected = path + ' run --profile web-agent-gateway';
  const result: number[] = [];
  for (const line of pgrep.stdout.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const ps = runOptional('wsl.exe', ['-e', 'ps', '-p', String(pid), '-o', 'args=']);
    if (ps.ok && ps.stdout.trim() === expected) result.push(pid);
  }
  return result;
}

function stopExactTunnel(path: string): void {
  const pids = exactTunnelPids(path);
  if (pids.length > 1) throw new Error('WAG_TUNNEL_PROCESS_AMBIGUOUS');
  if (pids.length === 0) return;

  runText('wsl.exe', ['-e', 'kill', '-TERM', String(pids[0]!)]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (exactTunnelPids(path).length === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  runOptional('wsl.exe', ['-e', 'kill', '-KILL', String(pids[0]!)]);
  if (exactTunnelPids(path).length !== 0) throw new Error('WAG_TUNNEL_STOP_FAILED');
}


function httpOkSync(url: string): boolean {
  const escaped = url.replaceAll("'", "''");
  const script = [
    "try{$r=Invoke-WebRequest -Uri '" + escaped + "' -UseBasicParsing -TimeoutSec 5;",
    'if($r.StatusCode -ge 200 -and $r.StatusCode -lt 300){exit 0}}catch{};exit 2',
  ].join('');
  return runOptional('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', script]).ok;
}

function localStackReadySync(): boolean {
  return httpOkSync('http://127.0.0.1:7677/.well-known/oauth-authorization-server')
    && httpOkSync('http://127.0.0.1:8080/readyz')
    && httpOkSync('http://127.0.0.1:8080/healthz');
}

function readLegacyMarker(releaseRoot: string): LegacyBaselineMarker | null {
  const path = join(releaseRoot, 'LEGACY-BASELINE.json');
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LegacyBaselineMarker>;
  if (value.schema !== 'WAG_LOCAL_LEGACY_BASELINE_V1'
      || typeof value.releaseId !== 'string'
      || typeof value.cliPath !== 'string'
      || typeof value.configPath !== 'string'
      || typeof value.wrapperPath !== 'string'
      || typeof value.createdAtUtc !== 'string') {
    throw new Error('WAG_LEGACY_BASELINE_INVALID');
  }
  return value as LegacyBaselineMarker;
}

function discoverLegacySourceHead(cliPath: string): string | null {
  try {
    const runtimeRoot = dirname(dirname(resolve(cliPath)));
    const marker = JSON.parse(readFileSync(join(runtimeRoot, 'RUNTIME.json'), 'utf8')) as {
      sourceHead?: unknown;
      source_head?: unknown;
    };
    const value = typeof marker.sourceHead === 'string'
      ? marker.sourceHead
      : typeof marker.source_head === 'string'
        ? marker.source_head
        : '';
    return /^[a-f0-9]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function captureLegacyBaseline(): ReleaseState {
  const existing = readReleaseState(installRoot);
  if (existing) return existing;
  if (!localStackReadySync()) throw new Error('WAG_LEGACY_BASELINE_NOT_READY');

  const binding = loadBinding();
  if (!existsSync(binding.cliPath)) throw new Error('WAG_LEGACY_BASELINE_CLI_MISSING');

  const sourceHead = discoverLegacySourceHead(binding.cliPath);
  const identity = sourceHead
    ?? createHash('sha256').update(binding.cliPath).update('\0').update(binding.wrapperText).digest('hex');
  const releaseId = 'legacy-' + identity.slice(0, 12);
  const baselineRoot = join(installRoot, 'runtime', releaseId);
  const baselineMarker = join(baselineRoot, 'LEGACY-BASELINE.json');

  if (!existsSync(baselineMarker)) {
    const staging = baselineRoot + '.staging-' + randomUUID();
    try {
      mkdirSync(join(staging, 'launchers'), { recursive: true });
      for (const name of [
        'Start-WagLocal.ps1',
        'Start-WagLocalTunnel.ps1',
        'Start-WagLocalSupervisor.ps1',
      ]) {
        const source = join(installRoot, name);
        if (!existsSync(source)) throw new Error('WAG_LEGACY_BASELINE_LAUNCHER_MISSING');
        copyFileSync(source, join(staging, 'launchers', name));
      }
      writeFileSync(join(staging, 'wrapper.sh'), binding.wrapperText, 'utf8');
      const marker: LegacyBaselineMarker = {
        schema: 'WAG_LOCAL_LEGACY_BASELINE_V1',
        releaseId,
        cliPath: resolve(binding.cliPath),
        configPath: resolve(binding.configPath),
        wrapperPath: binding.wrapperPath,
        sourceHead,
        createdAtUtc: new Date().toISOString(),
      };
      writeFileSync(
        join(staging, 'LEGACY-BASELINE.json'),
        JSON.stringify(marker, null, 2) + '\n',
        'utf8',
      );
      mkdirSync(dirname(baselineRoot), { recursive: true });
      renameSync(staging, baselineRoot);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } else {
    const marker = readLegacyMarker(baselineRoot);
    if (!marker || marker.releaseId !== releaseId || resolve(marker.cliPath) !== resolve(binding.cliPath)) {
      throw new Error('WAG_LEGACY_BASELINE_CONFLICT');
    }
  }

  const state: ReleaseState = {
    schema: 'WAG_LOCAL_RELEASE_STATE_V1',
    activeReleaseId: releaseId,
    previousReleaseId: null,
    channel: 'development',
    migrationVersion: 1,
    updatedAtUtc: new Date().toISOString(),
  };
  writeJsonAtomic(join(installRoot, 'state', 'release-state.json'), state);
  return state;
}

function restoreLegacyLaunchers(releaseRoot: string): void {
  for (const name of [
    'Start-WagLocal.ps1',
    'Start-WagLocalTunnel.ps1',
    'Start-WagLocalSupervisor.ps1',
  ]) {
    const source = join(releaseRoot, 'launchers', name);
    const target = join(installRoot, name);
    if (!existsSync(source)) throw new Error('WAG_LEGACY_BASELINE_LAUNCHER_MISSING');
    const temp = target + '.tmp-' + randomUUID();
    copyFileSync(source, temp);
    renameSync(temp, target);
  }
}

function switchLegacyBaseline(releaseRoot: string, marker: LegacyBaselineMarker): void {
  if (!existsSync(marker.cliPath)) throw new Error('WAG_LEGACY_BASELINE_CLI_MISSING');
  const wrapperSnapshot = join(releaseRoot, 'wrapper.sh');
  if (!existsSync(wrapperSnapshot)) throw new Error('WAG_LEGACY_BASELINE_WRAPPER_MISSING');

  const tunnelClient = readTunnelClientPath();
  stopOwnedSupervisor();
  restoreLegacyLaunchers(releaseRoot);
  writeWrapperAtomic(marker.wrapperPath, readFileSync(wrapperSnapshot, 'utf8'));
  stopExactTunnel(tunnelClient);
  startInstalledStack();
  startOwnedSupervisor();
}

function installLaunchersFrom(releaseRoot: string): void {
  const installer = join(releaseRoot, 'scripts', 'install-wag-local-launchers.ps1');
  if (!existsSync(installer)) throw new Error('WAG_RELEASE_LAUNCHER_INSTALLER_MISSING');
  if (!runLong('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', installer, '-NoStart',
  ], releaseRoot, 60_000)) {
    throw new Error('WAG_RELEASE_LAUNCHER_INSTALL_FAILED');
  }
}


function startOwnedSupervisor(): void {
  const supervisor = join(installRoot, 'Start-WagLocalSupervisor.ps1');
  if (!existsSync(supervisor)) throw new Error('WAG_RELEASE_SUPERVISOR_MISSING');

  const escaped = supervisor.replaceAll("'", "''");
  const command = [
    "$p=Start-Process -FilePath 'pwsh.exe' -ArgumentList @(",
    "'-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File','" + escaped + "'",
    ') -WindowStyle Hidden -PassThru;',
    'if($null -eq $p){exit 2};',
    'Start-Sleep -Milliseconds 500;',
    'if($p.HasExited -and $p.ExitCode -ne 0){exit $p.ExitCode}',
  ].join('');
  if (!runOptional('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', command]).ok) {
    throw new Error('WAG_RELEASE_SUPERVISOR_START_FAILED');
  }
}

function startInstalledStack(): void {
  const starter = join(installRoot, 'Start-WagLocal.ps1');
  if (!existsSync(starter)) throw new Error('WAG_RELEASE_STARTER_MISSING');
  if (!runLong('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', starter,
    '-StartupTimeoutSeconds', '180',
    '-Attempts', '2',
  ], installRoot)) {
    throw new Error('WAG_RELEASE_START_FAILED');
  }
}

function switchInstalledRuntime(releaseRoot: string | null): Promise<void> {
  if (!releaseRoot) return Promise.reject(new Error('WAG_RELEASE_SWITCH_TARGET_MISSING'));

  const legacy = readLegacyMarker(releaseRoot);
  if (legacy) {
    switchLegacyBaseline(releaseRoot, legacy);
    return Promise.resolve();
  }

  const cli = join(releaseRoot, 'dist', 'cli.js');
  if (!existsSync(cli)) return Promise.reject(new Error('WAG_RELEASE_SWITCH_CLI_MISSING'));

  const binding = loadBinding();
  const tunnelClient = readTunnelClientPath();
  stopOwnedSupervisor();
  installLaunchersFrom(releaseRoot);
  writeWrapperAtomic(binding.wrapperPath, buildWrapper(releaseRoot, binding.configPath));
  stopExactTunnel(tunnelClient);
  startInstalledStack();
  startOwnedSupervisor();
  return Promise.resolve();
}

function writeRuntimeMarker(releaseRoot: string, manifest: ReleaseManifest): void {
  const marker: Record<string, unknown> = {
    packageVersion: manifest.version,
    releaseId: manifest.releaseId,
    channel: manifest.channel,
    migrationVersion: manifest.migrationVersion,
    capability: 'autonomous-local-runtime-v1',
    installedAtUtc: new Date().toISOString(),
  };
  const git = manifest.sourceProvenance.match(/^git:([a-f0-9]{40})$/);
  if (git) marker.sourceHead = git[1];
  writeFileSync(join(releaseRoot, 'RUNTIME.json'), JSON.stringify(marker, null, 2) + '\n', 'utf8');
}

async function acceptCandidate(releaseRoot: string, manifest: ReleaseManifest): Promise<boolean> {
  for (const path of [
    join(releaseRoot, 'dist', 'cli.js'),
    join(releaseRoot, 'scripts', 'install-wag-local-launchers.ps1'),
    join(releaseRoot, 'scripts', 'wag-local-doctor.ps1'),
    join(releaseRoot, 'scripts', 'wag-local-start.ps1'),
    join(releaseRoot, 'packaging', 'runtime-package-lock.json'),
    join(releaseRoot, 'package.json'),
  ]) {
    if (!existsSync(path)) return false;
  }

  writeFileSync(
    join(releaseRoot, 'package-lock.json'),
    readFileSync(join(releaseRoot, 'packaging', 'runtime-package-lock.json')),
  );
  if (!runLong('npm.cmd', [
    'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--prefix', releaseRoot,
  ], releaseRoot)) {
    return false;
  }

  writeRuntimeMarker(releaseRoot, manifest);
  const help = runOptional(process.execPath, [join(releaseRoot, 'dist', 'cli.js'), '--help'], releaseRoot);
  return help.ok && help.stdout.includes('web-agent-gateway doctor');
}

async function postSwitchHealth(releaseRoot: string): Promise<boolean> {
  if (readLegacyMarker(releaseRoot)) {
    return localStackReadySync();
  }

  const doctor = join(releaseRoot, 'scripts', 'wag-local-doctor.ps1');
  if (!existsSync(doctor)) return false;
  const receipt = join(receiptsRoot, 'wag-local-update-post-switch-doctor.json');
  rmSync(receipt, { force: true });
  const ok = runLong('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', doctor,
    '-Output', receipt,
  ], releaseRoot, 60_000);
  if (!ok || !existsSync(receipt)) return false;
  try {
    const value = JSON.parse(readFileSync(receipt, 'utf8')) as { status?: unknown };
    return value.status === 'READY';
  } catch {
    return false;
  }
}

function loadManifest(path: string): ReleaseManifest {
  const value = JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest;
  return value;
}

function writeReceipt(path: string, receipt: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
}

export async function runProductUpdate(args: ProductReleaseArgs): Promise<number> {
  if (process.platform !== 'win32') throw new Error('WAG_UPDATE_WINDOWS_ONLY');
  if (!localAppData) throw new Error('LOCALAPPDATA is required');
  if (!args.packageRoot) throw new Error('WAG_UPDATE_PACKAGE_REQUIRED');

  const packageRoot = resolve(args.packageRoot);
  const manifestPath = resolve(args.manifestPath ?? join(packageRoot, 'RELEASE.json'));
  const manifest = loadManifest(manifestPath);
  if (!readReleaseState(installRoot)) {
    captureLegacyBaseline();
  }
  let activeRoot = '';

  const receipt = await transactionalUpdate({
    installRoot,
    packageRoot,
    manifest,
    acceptCandidate: (root) => acceptCandidate(root, manifest),
    switchRuntime: async (root) => {
      await switchInstalledRuntime(root);
      activeRoot = root ?? '';
    },
    postSwitchHealth: async () => activeRoot.length > 0 && postSwitchHealth(activeRoot),
  });

  const output = resolve(args.output ?? join(receiptsRoot, 'wag-local-update.json'));
  writeReceipt(output, receipt);
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  return receipt.state === 'SUCCEEDED' ? 0 : 2;
}

export async function runProductRollback(args: Pick<ProductReleaseArgs, 'output'>): Promise<number> {
  if (process.platform !== 'win32') throw new Error('WAG_ROLLBACK_WINDOWS_ONLY');
  if (!localAppData) throw new Error('LOCALAPPDATA is required');

  let activeRoot = '';
  const receipt = await transactionalRollback({
    installRoot,
    switchRuntime: async (root) => {
      await switchInstalledRuntime(root);
      activeRoot = root ?? '';
    },
    postSwitchHealth: async () => activeRoot.length > 0 && postSwitchHealth(activeRoot),
  });

  const output = resolve(args.output ?? join(receiptsRoot, 'wag-local-rollback.json'));
  writeReceipt(output, receipt);
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  return receipt.state === 'SUCCEEDED' ? 0 : 2;
}

interface ProcessIdentity {
  name: string;
  commandLine: string;
}

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, 'utf8').trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function processIdentity(pid: number): ProcessIdentity | null {
  const script = [
    '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + String(pid) + '" -ErrorAction SilentlyContinue;',
    'if($null -eq $p){exit 3};',
    '[pscustomobject]@{name=[string]$p.Name;commandLine=[string]$p.CommandLine}|ConvertTo-Json -Compress',
  ].join('');
  const result = runOptional('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', script]);
  if (!result.ok || !result.stdout) return null;
  try {
    const value = JSON.parse(result.stdout) as { name?: unknown; commandLine?: unknown };
    return {
      name: typeof value.name === 'string' ? value.name : '',
      commandLine: typeof value.commandLine === 'string' ? value.commandLine : '',
    };
  } catch {
    return null;
  }
}

function stopOwnedSupervisor(): boolean {
  const pidPath = join(installRoot, 'logs', 'wag-local-supervisor.pid');
  const pid = readPidFile(pidPath);
  if (!pid) return false;
  const identity = processIdentity(pid);
  if (!identity
      || identity.name.toLowerCase() !== 'pwsh.exe'
      || !/Start-WagLocalSupervisor\.ps1/i.test(identity.commandLine)) {
    return false;
  }
  return runOptional('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `Stop-Process -Id ${pid} -Force -ErrorAction Stop`,
  ]).ok;
}

function portOwner(port: number): number | null {
  const script = [
    '$p=Get-NetTCPConnection -State Listen -LocalPort ' + String(port),
    ' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess;',
    'if($null -ne $p){[Console]::Write([string]$p)}',
  ].join('');
  const result = runOptional('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', script]);
  if (!result.ok || !result.stdout) return null;
  const value = Number(result.stdout);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stopOwnedDevspace(): boolean {
  const pidPath = join(installRoot, 'logs', 'devspace-wag-7677.pid');
  const pid = readPidFile(pidPath);
  if (!pid) return false;
  const identity = processIdentity(pid);
  if (!identity
      || identity.name.toLowerCase() !== 'node.exe'
      || !/dist[\\/]cli\.js/i.test(identity.commandLine)
      || !/\bserve\b/i.test(identity.commandLine)
      || portOwner(7677) !== pid) {
    return false;
  }
  return runOptional('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `Stop-Process -Id ${pid} -Force -ErrorAction Stop`,
  ]).ok;
}

function removeStartupShortcut(): boolean {
  const script = [
    "$startup=[Environment]::GetFolderPath('Startup');",
    "$p=Join-Path $startup 'WAG Local.lnk';",
    'if(-not (Test-Path -LiteralPath $p)){exit 3};',
    '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p);',
    "if(([string]$s.Arguments -match 'Start-WagLocalSupervisor\\.ps1') -or ([string]$s.TargetPath -match 'Start-WagLocalSupervisor\\.ps1')){",
    'Remove-Item -LiteralPath $p -Force -ErrorAction Stop; exit 0',
    '}',
    'exit 4',
  ].join('');
  return runOptional('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', script]).ok;
}

function pathInsideInstallRoot(path: string): boolean {
  const root = resolve(installRoot).replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
  const target = resolve(path).replaceAll('\\', '/').toLowerCase();
  return target === root || target.startsWith(root + '/');
}

function removeOwnedWslProfileAndWrapper(): { removed: boolean; skipped: boolean } {
  try {
    const profileText = runText('wsl.exe', [
      '-e', 'sh', '-lc', 'cat "$HOME/.config/tunnel-client/web-agent-gateway.yaml"',
    ]);
    const wrapperPath = parseTunnelProfile(profileText);
    const wrapperText = runText('wsl.exe', ['-e', 'cat', wrapperPath]);
    const binding = parseWrapper(wrapperText);
    if (!pathInsideInstallRoot(binding.cliPath) && !pathInsideInstallRoot(binding.configPath)) {
      return { removed: false, skipped: true };
    }
    const profilePath = runText('wsl.exe', [
      '-e', 'sh', '-lc', 'printf "%s" "$HOME/.config/tunnel-client/web-agent-gateway.yaml"',
    ]);
    runText('wsl.exe', ['-e', 'rm', '-f', '--', wrapperPath, profilePath]);
    return { removed: true, skipped: false };
  } catch {
    return { removed: false, skipped: true };
  }
}

function configuredAllowedRoots(): string[] {
  const path = join(installRoot, 'config', 'wag-local.config.json');
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { allowedRoots?: unknown };
    if (!Array.isArray(value.allowedRoots)) return [];
    return value.allowedRoots.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export async function runProductUninstall(args: ProductUninstallArgs): Promise<number> {
  if (process.platform !== 'win32') throw new Error('WAG_UNINSTALL_WINDOWS_ONLY');
  if (!localAppData) throw new Error('LOCALAPPDATA is required');

  const allowedRoots = configuredAllowedRoots();
  const actions: Record<string, unknown> = {
    supervisorStopped: stopOwnedSupervisor(),
    tunnelStopped: false,
    devspaceStopped: false,
    startupShortcutRemoved: false,
    localConnectorConfigRemoved: false,
    remoteConnectorRemoved: false,
  };

  try {
    const tunnelClient = readTunnelClientPath();
    stopExactTunnel(tunnelClient);
    actions.tunnelStopped = true;
  } catch {
    actions.tunnelStopped = false;
  }

  actions.devspaceStopped = stopOwnedDevspace();
  actions.startupShortcutRemoved = removeStartupShortcut();
  const connector = removeOwnedWslProfileAndWrapper();
  actions.localConnectorConfigRemoved = connector.removed;
  actions.localConnectorConfigSkipped = connector.skipped;

  const removal = uninstallOwnedArtifacts(installRoot, {
    purgeState: !args.keepState,
    removeManagedDevspace: Boolean(args.removeManagedDevspace),
    externalWorkspacePaths: allowedRoots,
  });

  const receipt = {
    schema: 'WAG_LOCAL_UNINSTALL_V1',
    generatedAtUtc: new Date().toISOString(),
    keepState: Boolean(args.keepState),
    removeManagedDevspace: Boolean(args.removeManagedDevspace),
    actions,
    removal,
    remoteConnectorAction: 'REMOVE_MANUALLY_IN_CLIENT_IF_DESIRED',
  };

  const uninstallReceipts = join(localAppData, 'WAG-Local-Uninstall');
  const output = resolve(args.output ?? join(uninstallReceipts, 'wag-local-uninstall.json'));
  writeReceipt(output, receipt);
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');

  const requiredLocalRemoved =
    removal.removedEntries.includes('runtime')
    || !existsSync(join(installRoot, 'runtime'));
  return requiredLocalRemoved ? 0 : 2;
}

export function currentReleaseSummary(): {
  installRoot: string;
  state: ReturnType<typeof readReleaseState>;
} {
  return { installRoot, state: readReleaseState(installRoot) };
}
