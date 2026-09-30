import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReceipt, type Diagnostic } from './product-health.js';
import {
  checkProductUpdate,
  isProductUpdateSourceConfigured,
  type ProductUpdateCheck,
} from './product-update-discovery.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const localAppData = process.env.LOCALAPPDATA ?? '';
const wagLocal = join(localAppData, 'WAG-Local');
const logsDir = join(wagLocal, 'logs');
const receiptsDir = join(wagLocal, 'receipts');
const defaultProfile = '$HOME/.config/tunnel-client/web-agent-gateway.yaml';

export interface DoctorSignals {
  tunnelClientPinPresent: boolean;
  tunnelClientExecutable: boolean;
  tunnelProfilePresent: boolean;
  staleLauncherPid: boolean;
  staleDevspacePid: boolean;
  staleSupervisorPid: boolean;
  port7677Collision: boolean;
  port8080Collision: boolean;
  controlPlaneReachable: boolean;
  controlPlaneAuthorizationFailed: boolean;
  stackReady: boolean;
  updateConfigured: boolean;
}

export interface DoctorRepairAction {
  code: string;
  state: 'SUCCEEDED' | 'SKIPPED' | 'FAILED';
  message: string;
}

interface ProcessIdentity {
  name: string;
  commandLine: string;
}

interface LastFailure {
  code: 'AUTHORIZATION' | 'NETWORK' | 'PORT_COLLISION' | 'TUNNEL_CLIENT' | 'WSL' | 'DEVSPACE' | 'UNKNOWN';
  source: string;
  observedAtUtc: string;
}

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

function readPid(path: string): number | null {
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, 'utf8').trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function processIdentity(pid: number | null): ProcessIdentity | null {
  if (!pid) return null;
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

function validWslAbsolutePath(value: string): boolean {
  return value.startsWith('/')
    && !value.includes('\r')
    && !value.includes('\n')
    && !value.split('/').includes('..');
}

function readTunnelClientPin(): string | null {
  const path = join(wagLocal, 'tunnel-client-path.txt');
  if (!existsSync(path)) return null;
  const value = readFileSync(path, 'utf8').trim();
  return validWslAbsolutePath(value) ? value : null;
}

function wslFileExists(path: string): boolean {
  return runOptional('wsl.exe', ['-e', 'test', '-f', path]).ok;
}

function wslExecutableExists(path: string): boolean {
  return runOptional('wsl.exe', ['-e', 'test', '-x', path]).ok;
}

function defaultTunnelProfilePresent(): boolean {
  const result = runOptional('wsl.exe', [
    '-e', 'sh', '-lc',
    'test -f "$HOME/.config/tunnel-client/web-agent-gateway.yaml"',
  ]);
  return result.ok;
}

function tunnelClientVersion(path: string | null): string | null {
  if (!path || !wslExecutableExists(path)) return null;
  const result = runOptional('wsl.exe', ['-e', path, '--version']);
  return result.ok && result.stdout ? result.stdout : null;
}

function discoverRunningTunnelClientPath(): string | null {
  const pgrep = runOptional('wsl.exe', ['-e', 'pgrep', '-f', 'tunnel-client']);
  if (!pgrep.ok || !pgrep.stdout) return null;
  for (const line of pgrep.stdout.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const ps = runOptional('wsl.exe', ['-e', 'ps', '-p', String(pid), '-o', 'args=']);
    if (!ps.ok) continue;
    const match = ps.stdout.trim().match(/^(\/\S*\/tunnel-client) run --profile web-agent-gateway$/);
    const candidate = match?.[1] ?? null;
    if (candidate && validWslAbsolutePath(candidate) && wslExecutableExists(candidate)) return candidate;
  }
  return null;
}

function exactTunnelRunning(path: string | null): boolean {
  if (!path) return false;
  const pgrep = runOptional('wsl.exe', ['-e', 'pgrep', '-f', 'tunnel-client']);
  if (!pgrep.ok || !pgrep.stdout) return false;
  for (const line of pgrep.stdout.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const ps = runOptional('wsl.exe', ['-e', 'ps', '-p', String(pid), '-o', 'args=']);
    if (!ps.ok) continue;
    if (ps.stdout.trim() === path + ' run --profile web-agent-gateway') return true;
  }
  return false;
}

function stalePid(
  path: string,
  expected: (identity: ProcessIdentity) => boolean,
): boolean {
  if (!existsSync(path)) return false;
  const pid = readPid(path);
  const identity = processIdentity(pid);
  return pid === null || identity === null || !expected(identity);
}

function isOwnedDevspace(identity: ProcessIdentity | null): boolean {
  if (!identity) return false;
  return identity.name.toLowerCase() === 'node.exe'
    && /dist[\\/]cli\.js/i.test(identity.commandLine)
    && /\bserve\b/i.test(identity.commandLine);
}

function classifyLastFailure(): LastFailure | null {
  const candidates = [
    'wag-local.stderr.log',
    'wag-tunnel-host.stderr.log',
    'wag-local-supervisor.log',
    'wag-local-supervisor-starter.stderr.log',
    'wag-local-devspace-repair.stderr.log',
    'devspace-recovery.stderr.log',
  ].map((name) => join(logsDir, name))
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  const patterns: Array<[LastFailure['code'], RegExp]> = [
    ['AUTHORIZATION', /401|unauthor|forbidden|credential.*invalid/i],
    ['NETWORK', /network is unreachable|ENETUNREACH|EAI_AGAIN|ENOTFOUND|dns/i],
    ['PORT_COLLISION', /EADDRINUSE|port\s+(?:7677|8080).*already owned|address already in use/i],
    ['TUNNEL_CLIENT', /tunnel-client.*(?:missing|not found|not executable)|WAG_TUNNEL_CLIENT_PIN_MISSING/i],
    ['WSL', /WSL.*(?:unavailable|failed)|wsl\.exe.*(?:failed|not found)/i],
    ['DEVSPACE', /DevSpace.*(?:missing|failed|repair|clone)/i],
  ];

  for (const path of candidates) {
    let text = '';
    try {
      const bytes = readFileSync(path);
      text = bytes.subarray(Math.max(0, bytes.length - 64 * 1024)).toString('utf8');
    } catch {
      continue;
    }

    let winner: { code: LastFailure['code']; index: number } | null = null;
    for (const [code, pattern] of patterns) {
      const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'))];
      const index = matches.length > 0 ? matches[matches.length - 1]!.index ?? -1 : -1;
      if (index >= 0 && (winner === null || index > winner.index)) winner = { code, index };
    }
    if (winner) return {
      code: winner.code,
      source: basename(path),
      observedAtUtc: new Date(statSync(path).mtimeMs).toISOString(),
    };
  }
  return null;
}

async function controlPlaneReachable(): Promise<boolean> {
  try {
    await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      signal: AbortSignal.timeout(3500),
      headers: { 'user-agent': 'wag-local-doctor/1' },
    });
    return true;
  } catch {
    return false;
  }
}

export function classifyDoctorDiagnostics(signals: DoctorSignals): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const push = (code: string, severity: Diagnostic['severity'], message: string) => {
    diagnostics.push({ code, severity, message });
  };

  if (!signals.tunnelClientPinPresent) {
    push('WAG_TUNNEL_CLIENT_PIN_MISSING',
      signals.stackReady && signals.tunnelClientExecutable ? 'WARN' : 'ERROR',
      signals.tunnelClientExecutable
        ? 'The tunnel-client path pin is missing, but the exact running WAG tunnel-client was discovered.'
        : 'The per-user tunnel-client path pin is missing or invalid.');
  } else if (!signals.tunnelClientExecutable) {
    push('WAG_TUNNEL_CLIENT_MISSING', 'ERROR',
      'The pinned tunnel-client is not executable in WSL.');
  }

  if (!signals.tunnelProfilePresent) {
    push('WAG_TUNNEL_PROFILE_MISSING', 'ERROR',
      'The WAG tunnel-client profile is missing.');
  }

  if (signals.staleLauncherPid) {
    push('WAG_STALE_LAUNCHER_PID', 'WARN',
      'The launcher PID receipt does not identify the exact WAG tunnel launcher.');
  }
  if (signals.staleDevspacePid) {
    push('WAG_STALE_DEVSPACE_PID', 'WARN',
      'The DevSpace PID receipt does not identify the exact managed DevSpace process.');
  }
  if (signals.staleSupervisorPid) {
    push('WAG_STALE_SUPERVISOR_PID', 'WARN',
      'The supervisor PID receipt does not identify the exact WAG supervisor.');
  }

  if (signals.port7677Collision) {
    push('WAG_PORT_7677_COLLISION_UNRELATED', 'ERROR',
      'Port 7677 is occupied by a process that is not the WAG-owned DevSpace process.');
  }
  if (signals.port8080Collision) {
    push('WAG_PORT_8080_COLLISION_UNRELATED', 'ERROR',
      'Port 8080 is occupied while the exact WAG tunnel-client is not running.');
  }

  if (!signals.controlPlaneReachable) {
    push('WAG_CONTROL_PLANE_NETWORK_UNREACHABLE', signals.stackReady ? 'WARN' : 'ERROR',
      'The OpenAI control-plane endpoint is not reachable from this host.');
  }
  if (signals.controlPlaneAuthorizationFailed) {
    push('WAG_CONTROL_PLANE_AUTHORIZATION_FAILED', 'ERROR',
      'The latest active tunnel failure indicates rejected or expired control-plane authorization.');
  }

  if (!signals.updateConfigured) {
    push('WAG_UPDATE_CHECK_UNCONFIGURED', 'INFO',
      'No stable update channel is configured yet; update availability is unknown.');
  }

  return diagnostics;
}

export function classifyProductUpdateDiagnostic(update: ProductUpdateCheck): Diagnostic[] {
  const diagnostic = (code: string, severity: Diagnostic['severity'], message: string): Diagnostic[] => [
    { code, severity, message },
  ];
  switch (update.status) {
    case 'UNCONFIGURED':
    case 'CURRENT':
      return [];
    case 'DISABLED':
      return diagnostic('WAG_UPDATE_CHECK_DISABLED', 'INFO',
        'Automatic update checks are disabled by the local product preference.');
    case 'OFFLINE':
      return diagnostic('WAG_UPDATE_FEED_UNREACHABLE', 'WARN',
        'The configured signed update feed could not be reached; the installed runtime was not changed.');
    case 'INVALID_CONFIG':
      return diagnostic('WAG_UPDATE_CONFIG_INVALID', 'WARN',
        'The local update source/settings configuration is invalid; update discovery failed closed.');
    case 'INVALID_METADATA':
      return diagnostic('WAG_UPDATE_METADATA_INVALID', 'WARN',
        'Update metadata failed signature/schema validation; no package was downloaded or staged.');
    case 'EXPIRED':
      return diagnostic('WAG_UPDATE_METADATA_EXPIRED', 'WARN',
        'The signed update metadata is expired; no package was downloaded or staged.');
    case 'NO_COMPATIBLE_RELEASE':
      return diagnostic('WAG_UPDATE_NO_COMPATIBLE_RELEASE', 'INFO',
        'The configured channel has no signed release compatible with this installed runtime.');
    case 'CURRENT_VERSION_UNKNOWN':
      return diagnostic('WAG_UPDATE_CURRENT_VERSION_UNKNOWN', 'INFO',
        'Signed update metadata is valid, but the installed version cannot be compared safely.');
    case 'UPDATE_AVAILABLE':
      return diagnostic('WAG_UPDATE_AVAILABLE', 'INFO',
        'A signed compatible update is available; WAG will not download, stage, or switch it automatically.');
  }
}

function dedupeDiagnostics(values: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.code)) return false;
    seen.add(value.code);
    return true;
  });
}

async function collectSignals(health: Awaited<ReturnType<typeof collectReceipt>>) {
  const pinnedTunnelClientPath = readTunnelClientPin();
  const discoveredTunnelClientPath = discoverRunningTunnelClientPath();
  const tunnelClientPath = pinnedTunnelClientPath ?? discoveredTunnelClientPath;
  const tunnelClientPinPresent = pinnedTunnelClientPath !== null;
  const tunnelClientExecutable = tunnelClientPath !== null && wslExecutableExists(tunnelClientPath);
  const tunnelProfilePresent = defaultTunnelProfilePresent();
  const version = tunnelClientVersion(tunnelClientPath);

  const launcherPidPath = join(logsDir, 'wag-local-launcher.pid');
  const devspacePidPath = join(logsDir, 'devspace-wag-7677.pid');
  const supervisorPidPath = join(logsDir, 'wag-local-supervisor.pid');

  const staleLauncherPid = stalePid(launcherPidPath, (identity) =>
    identity.name.toLowerCase() === 'pwsh.exe'
      && /Start-WagLocalTunnel\.ps1/i.test(identity.commandLine));
  const staleDevspacePid = stalePid(devspacePidPath, isOwnedDevspace);
  const staleSupervisorPid = stalePid(supervisorPidPath, (identity) =>
    identity.name.toLowerCase() === 'pwsh.exe'
      && /Start-WagLocalSupervisor\.ps1/i.test(identity.commandLine));

  const devspacePid = readPid(devspacePidPath);
  const owner7677 = portOwner(7677);
  const port7677Collision = owner7677 !== null
    && (devspacePid === null || owner7677 !== devspacePid || !isOwnedDevspace(processIdentity(owner7677)));

  const exactTunnel = exactTunnelRunning(tunnelClientPath);
  const owner8080 = portOwner(8080);
  const port8080Collision = owner8080 !== null && !exactTunnel && !health.tunnel.ready;

  const reachable = await controlPlaneReachable();
  const lastFailure = classifyLastFailure();
  const stackReady = health.status === 'READY';
  const controlPlaneAuthorizationFailed =
    !stackReady && reachable && lastFailure?.code === 'AUTHORIZATION';

  const signals: DoctorSignals = {
    tunnelClientPinPresent,
    tunnelClientExecutable,
    tunnelProfilePresent,
    staleLauncherPid,
    staleDevspacePid,
    staleSupervisorPid,
    port7677Collision,
    port8080Collision,
    controlPlaneReachable: reachable,
    controlPlaneAuthorizationFailed,
    stackReady,
    updateConfigured: isProductUpdateSourceConfigured(wagLocal),
  };

  return {
    signals,
    tunnelClientPath,
    tunnelClientPinnedPath: pinnedTunnelClientPath,
    tunnelClientDiscoveredPath: discoveredTunnelClientPath,
    tunnelClientVersion: version,
    exactTunnelRunning: exactTunnel,
    portOwners: {
      port7677: owner7677,
      port8080: owner8080,
    },
    lastFailure,
  };
}

function removeStalePid(path: string, actionCode: string, actions: DoctorRepairAction[]): void {
  try {
    rmSync(path, { force: true });
    actions.push({ code: actionCode, state: 'SUCCEEDED', message: 'Removed stale WAG-owned PID receipt.' });
  } catch {
    actions.push({ code: actionCode, state: 'FAILED', message: 'Failed to remove stale WAG-owned PID receipt.' });
  }
}

function runPowerShellScript(path: string, args: string[], timeoutMs: number): boolean {
  const result = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path, ...args,
  ], {
    cwd: packageRoot,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  return !result.error && result.status === 0;
}

async function repairKnownSafe(
  health: Awaited<ReturnType<typeof collectReceipt>>,
  observed: Awaited<ReturnType<typeof collectSignals>>,
): Promise<DoctorRepairAction[]> {
  const actions: DoctorRepairAction[] = [];
  const { signals } = observed;

  if (signals.staleLauncherPid) {
    removeStalePid(join(logsDir, 'wag-local-launcher.pid'), 'WAG_REPAIR_STALE_LAUNCHER_PID', actions);
  }
  if (signals.staleDevspacePid) {
    removeStalePid(join(logsDir, 'devspace-wag-7677.pid'), 'WAG_REPAIR_STALE_DEVSPACE_PID', actions);
  }
  if (signals.staleSupervisorPid) {
    removeStalePid(join(logsDir, 'wag-local-supervisor.pid'), 'WAG_REPAIR_STALE_SUPERVISOR_PID', actions);
  }

  if (!signals.tunnelClientPinPresent && observed.tunnelClientPath && signals.tunnelClientExecutable) {
    try {
      const pinPath = join(wagLocal, 'tunnel-client-path.txt');
      mkdirSync(dirname(pinPath), { recursive: true });
      writeFileSync(pinPath, observed.tunnelClientPath, 'utf8');
      actions.push({
        code: 'WAG_REPAIR_TUNNEL_CLIENT_PIN',
        state: 'SUCCEEDED',
        message: 'Pinned the exact running WAG tunnel-client path in the per-user install root.',
      });
    } catch {
      actions.push({
        code: 'WAG_REPAIR_TUNNEL_CLIENT_PIN',
        state: 'FAILED',
        message: 'Failed to persist the discovered WAG tunnel-client path pin.',
      });
    }
  }

  const unsafeExternalBlock =
    signals.port7677Collision
    || signals.port8080Collision
    || !signals.tunnelClientExecutable
    || !signals.tunnelProfilePresent
    || !signals.controlPlaneReachable
    || signals.controlPlaneAuthorizationFailed;

  const launcherNeedsRepair =
    !health.launchers.matchCanonical
    || !health.launchers.startupShortcutPresent
    || !health.launchers.startupTargetsSupervisor;

  if (launcherNeedsRepair) {
    if (health.source.mode !== 'installed-package') {
      actions.push({
        code: 'WAG_REPAIR_LAUNCHERS',
        state: 'SKIPPED',
        message: 'Launcher replacement is skipped from a development checkout; run the installed doctor.',
      });
    } else {
      const installer = join(packageRoot, 'scripts', 'install-wag-local-launchers.ps1');
      const ok = existsSync(installer) && runPowerShellScript(installer, ['-NoStart'], 60_000);
      actions.push({
        code: 'WAG_REPAIR_LAUNCHERS',
        state: ok ? 'SUCCEEDED' : 'FAILED',
        message: ok
          ? 'Restored canonical per-user launchers and login Startup registration.'
          : 'Canonical launcher repair failed.',
      });
    }
  }

  const starter = join(wagLocal, 'Start-WagLocal.ps1');
  if ((!health.devspace.pinMatch || !health.devspace.discoveryReady) && !signals.port7677Collision) {
    const ok = existsSync(starter)
      && runPowerShellScript(starter, ['-EnsureDevSpaceOnly', '-StartupTimeoutSeconds', '180', '-Attempts', '2'], 190_000);
    actions.push({
      code: 'WAG_REPAIR_DEVSPACE',
      state: ok ? 'SUCCEEDED' : 'FAILED',
      message: ok
        ? 'Repaired the exact managed DevSpace checkout/process.'
        : 'Managed DevSpace repair failed.',
    });
  }

  if (!unsafeExternalBlock && health.status !== 'READY') {
    const ok = existsSync(starter)
      && runPowerShellScript(starter, ['-StartupTimeoutSeconds', '180', '-Attempts', '2'], 190_000);
    actions.push({
      code: 'WAG_REPAIR_LOCAL_STACK',
      state: ok ? 'SUCCEEDED' : 'FAILED',
      message: ok ? 'Started the WAG-owned local stack.' : 'WAG local stack recovery failed.',
    });
  } else if (health.status !== 'READY' && unsafeExternalBlock) {
    actions.push({
      code: 'WAG_REPAIR_LOCAL_STACK',
      state: 'SKIPPED',
      message: 'Local stack start was skipped because an external prerequisite or unrelated port collision remains.',
    });
  }

  if (!health.launchers.supervisorRunning && !unsafeExternalBlock) {
    const supervisor = join(wagLocal, 'Start-WagLocalSupervisor.ps1');
    if (!existsSync(supervisor)) {
      actions.push({
        code: 'WAG_REPAIR_SUPERVISOR',
        state: 'FAILED',
        message: 'Installed supervisor script is missing.',
      });
    } else {
      const escaped = supervisor.replaceAll("'", "''");
      const command = [
        "$p=Start-Process -FilePath 'pwsh.exe' -ArgumentList @(",
        "'-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File','" + escaped + "'",
        ') -WindowStyle Hidden -PassThru;',
        'if($null -eq $p){exit 1}',
      ].join('');
      const ok = runOptional('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', command]).ok;
      actions.push({
        code: 'WAG_REPAIR_SUPERVISOR',
        state: ok ? 'SUCCEEDED' : 'FAILED',
        message: ok ? 'Started the exact WAG recovery supervisor.' : 'Supervisor start failed.',
      });
    }
  }

  return actions;
}

function parseArgs(argv: string[]): { repair: boolean; output: string } {
  let repair = false;
  let output = join(receiptsDir, 'wag-local-doctor.json');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--repair') {
      repair = true;
      continue;
    }
    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value after --output');
      output = resolve(value);
      index += 1;
      continue;
    }
    throw new Error('Unknown doctor argument: ' + arg);
  }
  return { repair, output };
}

function normalizeHealthDiagnostic(
  item: Diagnostic,
  sourceMode: string,
): Diagnostic {
  if (sourceMode === 'development-checkout' && item.code === 'WAG_LAUNCHER_DRIFT') {
    return {
      ...item,
      severity: 'WARN',
      message: 'Development source launchers differ from the installed runtime; run the installed doctor for canonical launcher drift.',
    };
  }

  const messages: Record<string, string> = {
    WAG_WSL_UNAVAILABLE: 'WSL is unavailable. Restore/start a supported WSL environment, then rerun wag doctor.',
    WAG_DEVSPACE_PIN_MISSING: 'The exact managed DevSpace checkout is missing. Run wag doctor --repair while port 7677 is free.',
    WAG_DEVSPACE_PIN_MISMATCH: 'The managed DevSpace checkout is not at the accepted revision. Run wag doctor --repair while port 7677 is free.',
    WAG_DEVSPACE_DISCOVERY_DOWN: 'DevSpace OAuth discovery is down. Run wag doctor --repair unless port 7677 belongs to another process.',
    WAG_TUNNEL_NOT_READY: 'The local tunnel is not ready. Run wag doctor --repair after network, profile, credential, and port prerequisites are healthy.',
    WAG_AUTOSTART_MISSING: 'The per-user Startup registration is missing. Run the installed wag doctor --repair to restore it.',
    WAG_AUTOSTART_TARGET_DRIFT: 'The Startup shortcut does not target the WAG supervisor. Run the installed wag doctor --repair to restore it.',
    WAG_LAUNCHER_DRIFT: 'Installed launchers differ from the packaged canonical copies. Run the installed wag doctor --repair.',
  };
  return messages[item.code] ? { ...item, message: messages[item.code]! } : item;
}

async function collectDoctorState() {
  const health = await collectReceipt();
  const observed = await collectSignals(health);
  const update = await checkProductUpdate({ installRoot: wagLocal, respectAutoCheck: true });
  const healthDiagnostics = health.diagnostics.map((item) =>
    normalizeHealthDiagnostic(item, health.source.mode));
  const diagnostics = dedupeDiagnostics([
    ...healthDiagnostics,
    ...classifyDoctorDiagnostics(observed.signals),
    ...classifyProductUpdateDiagnostic(update),
  ]);
  return { health, observed, update, diagnostics };
}

export async function runProductDoctorCli(argv = process.argv.slice(2)): Promise<number> {
  const { repair, output } = parseArgs(argv);
  const before = await collectDoctorState();
  const actions = repair ? await repairKnownSafe(before.health, before.observed) : [];
  if (repair && actions.some((action) => action.state === 'SUCCEEDED')) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
  }
  const after = repair ? await collectDoctorState() : before;

  const receipt = {
    schema: 'WAG_LOCAL_DOCTOR_V1',
    generatedAtUtc: new Date().toISOString(),
    repairRequested: repair,
    status: after.health.status,
    version: after.health.source.packageVersion,
    source: after.health.source,
    runtime: after.health.runtime,
    host: after.health.host,
    devspace: after.health.devspace,
    tunnel: {
      ...after.health.tunnel,
      profilePresent: after.observed.signals.tunnelProfilePresent,
      clientPathPinned: after.observed.signals.tunnelClientPinPresent,
      clientExecutable: after.observed.signals.tunnelClientExecutable,
      clientVersion: after.observed.tunnelClientVersion,
      exactProcessRunning: after.observed.exactTunnelRunning,
    },
    connector: {
      localTunnelReady: after.health.tunnel.ready,
      localMcpRoundTrip: after.health.mcp.roundTrip,
      externalClientRoundTrip: 'NOT_TESTABLE_FROM_LOCAL_DOCTOR',
    },
    processState: {
      staleLauncherPid: after.observed.signals.staleLauncherPid,
      staleDevspacePid: after.observed.signals.staleDevspacePid,
      staleSupervisorPid: after.observed.signals.staleSupervisorPid,
      portOwners: after.observed.portOwners,
      port7677Collision: after.observed.signals.port7677Collision,
      port8080Collision: after.observed.signals.port8080Collision,
    },
    network: {
      controlPlaneReachable: after.observed.signals.controlPlaneReachable,
      authorizationFailed: after.observed.signals.controlPlaneAuthorizationFailed,
    },
    update: after.update,
    lastMeaningfulFailure: after.observed.lastFailure,
    diagnostics: after.diagnostics,
    repairs: actions,
    beforeRepair: repair ? {
      status: before.health.status,
      diagnostics: before.diagnostics.map((item) => item.code),
    } : null,
  };

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');

  const hasError = after.diagnostics.some((item) => item.severity === 'ERROR');
  return after.health.status === 'READY' && !hasError ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProductDoctorCli();
}
