import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type ProductDoctorCheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface ProductDoctorCheck {
  id: string;
  status: ProductDoctorCheckStatus;
  code: string;
  message: string;
}

export interface ProductDoctorRuntimeIdentity {
  cli_path?: string;
  deployed?: boolean;
  source_head?: string;
  extension_source_head?: string;
  extension_sha256?: string;
  capability?: string;
}

export interface ProductDoctorLocalSnapshot {
  supervisorRunning: boolean;
  maintenanceActive: boolean;
  tunnelHealth: boolean;
  tunnelReady: boolean;
  devspaceReady: boolean;
  installedExtensionSha256: string | null;
  cliDoctorSupportReady: boolean;
}

export interface ProductDoctorMcpInput {
  gatewayHealth: unknown;
  runtime: ProductDoctorRuntimeIdentity;
  browserExtension?: unknown;
  productConfig: unknown;
  mcpTools: readonly string[];
  local: ProductDoctorLocalSnapshot;
  generatedAtUtc?: string;
}

interface Probe {
  ok: boolean;
  status?: number;
}

const HEAD = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function treeSha256(root: string): string | null {
  if (!existsSync(root) || !statSync(root).isDirectory()) return null;
  const files: string[] = [];
  const visit = (directory: string, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const relative = prefix ? prefix + '/' + name : name;
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) files.push(relative);
      else return;
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

function readPositivePid(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function exactSupervisorRunning(pid: number | null): boolean {
  if (!pid || process.platform !== 'win32') return false;
  const script = [
    '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + String(pid) + '" -ErrorAction SilentlyContinue;',
    'if($null -eq $p){exit 3};',
    "if([string]$p.Name -ne 'pwsh.exe'){exit 4};",
    "if([string]$p.CommandLine -notmatch 'Start-WagLocalSupervisor\\.ps1'){exit 5};",
    'exit 0',
  ].join('');
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 3_000,
  });
  return !result.error && result.status === 0;
}

async function httpProbe(url: string): Promise<Probe> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false };
  }
}

function runtimeRoot(runtime: ProductDoctorRuntimeIdentity): string | null {
  if (!runtime.cli_path) return null;
  try {
    return dirname(dirname(resolve(runtime.cli_path)));
  } catch {
    return null;
  }
}

export async function collectProductDoctorLocalSnapshot(
  runtime: ProductDoctorRuntimeIdentity,
  localAppData = process.env.LOCALAPPDATA ?? '',
): Promise<ProductDoctorLocalSnapshot> {
  const wagLocal = localAppData ? join(localAppData, 'WAG-Local') : '';
  const supervisorPid = wagLocal
    ? readPositivePid(join(wagLocal, 'logs', 'wag-local-supervisor.pid'))
    : null;
  const installedExtension = wagLocal ? join(wagLocal, 'browser-extension-v2') : '';
  const maintenanceActive = Boolean(wagLocal)
    && (existsSync(join(wagLocal, 'state', 'maintenance-v1.json'))
      || existsSync(join(wagLocal, 'state', 'maintenance-v1.ack.json')));

  const [tunnelHealth, tunnelReady, devspace] = await Promise.all([
    httpProbe('http://127.0.0.1:8080/healthz'),
    httpProbe('http://127.0.0.1:8080/readyz'),
    httpProbe('http://127.0.0.1:7677/.well-known/oauth-authorization-server'),
  ]);

  const root = runtimeRoot(runtime);
  const cliDoctorSupportReady = root !== null
    && [
      'scripts/wag-local-doctor.ps1',
      'scripts/wag-local-product-health.ps1',
      'docs/benchmarks/devspace-pin.json',
    ].every((relative) => existsSync(join(root, ...relative.split('/'))));

  return {
    supervisorRunning: exactSupervisorRunning(supervisorPid),
    maintenanceActive,
    tunnelHealth: tunnelHealth.ok,
    tunnelReady: tunnelReady.ok,
    devspaceReady: devspace.ok,
    installedExtensionSha256: installedExtension ? treeSha256(installedExtension) : null,
    cliDoctorSupportReady,
  };
}

function makeCheck(
  id: string,
  status: ProductDoctorCheckStatus,
  code: string,
  message: string,
): ProductDoctorCheck {
  return { id, status, code, message };
}

function nextAction(check: ProductDoctorCheck): string | null {
  if (check.status === 'PASS') return null;
  const actions: Record<string, string> = {
    runtime: 'Restore or promote the expected WAG runtime, then rerun product.doctor.',
    extension_assets: 'Redeploy the browser extension from the active runtime release.',
    extension_release: 'Allow the WAG extension to reconnect/reload, then rerun product.doctor.',
    supervisor: 'Restart the WAG Local supervisor or run the repair-capable CLI doctor.',
    tunnel: 'Repair the WAG local tunnel before browser/Git automation continues.',
    devspace: 'Repair the exact managed DevSpace runtime before repository mutation work continues.',
    maintenance: 'Wait for the bounded promotion maintenance lease to complete or expire.',
    config: 'Repair the validated WAG product configuration before changing authority.',
    git_policy: 'Reconcile Git tool publication with the configured remote Git policy.',
    media_preflight: 'Restore machine.media.inspect and verify.media on the published MCP surface.',
    browser_upload: 'Restore browser.upload_file before workflows that require file upload.',
    browser_download: 'Restore browser.download before workflows that require file downloads.',
    browser_dialog: 'Restore browser.dialog.get and browser.dialog.respond for bounded JavaScript dialog handling.',
    browser_permission: 'Restore browser.permission.set for origin-bound permission policy handling.',
    artifact_lifecycle: 'Restore artifact.list, artifact.describe, and artifact.export so downloaded artifacts remain usable.',
    browser_reliability: 'Restore browser.wait_for, browser.assert, and browser.media.inspect.',
    mcp_surface: 'Restart WAG with a coherent published MCP surface.',
    cli_doctor_support: 'Promote a runtime that includes the packaged doctor/health support files.',
  };
  return actions[check.id] ?? null;
}

export function buildProductDoctorMcpReport(input: ProductDoctorMcpInput): object {
  const health = record(input.gatewayHealth);
  const config = record(input.productConfig);
  const capabilities = record(config.capabilities);
  const browser = record(input.browserExtension);
  const tools = [...input.mcpTools];
  const toolSet = new Set(tools);
  const checks: ProductDoctorCheck[] = [];

  const runtimeHead = HEAD.test(input.runtime.source_head ?? '') ? input.runtime.source_head! : null;
  const extensionHead = HEAD.test(input.runtime.extension_source_head ?? '')
    ? input.runtime.extension_source_head!
    : null;
  const expectedExtensionSha = SHA256.test(input.runtime.extension_sha256 ?? '')
    ? input.runtime.extension_sha256!
    : null;

  checks.push(
    input.runtime.deployed === true && health.status === 'ok' && runtimeHead !== null
      ? makeCheck('runtime', 'PASS', 'WAG_DOCTOR_RUNTIME_READY', 'Active deployed runtime reports status=ok with a valid source HEAD.')
      : makeCheck('runtime', 'FAIL', 'WAG_DOCTOR_RUNTIME_INVALID', 'Active runtime identity or gateway health is not coherent.'),
  );

  if (expectedExtensionSha === null) {
    checks.push(makeCheck(
      'extension_assets',
      'WARN',
      'WAG_DOCTOR_EXTENSION_SHA_UNAVAILABLE',
      'The active runtime does not expose an extension asset SHA.',
    ));
  } else if (input.local.installedExtensionSha256 === expectedExtensionSha) {
    checks.push(makeCheck(
      'extension_assets',
      'PASS',
      'WAG_DOCTOR_EXTENSION_ASSETS_MATCH',
      'Installed browser extension bytes match the active runtime release.',
    ));
  } else {
    checks.push(makeCheck(
      'extension_assets',
      'FAIL',
      'WAG_DOCTOR_EXTENSION_ASSETS_MISMATCH',
      'Installed browser extension bytes do not match the active runtime release.',
    ));
  }

  const browserEnabled = bool(capabilities.browser_enabled) === true;
  const observedHead = text(browser.observedSourceHead);
  const expectedHead = text(browser.expectedSourceHead);
  if (!browserEnabled) {
    checks.push(makeCheck(
      'extension_release',
      'PASS',
      'WAG_DOCTOR_BROWSER_DISABLED',
      'Browser integration is disabled by the validated product configuration.',
    ));
  } else if (
    bool(browser.connected) === true
    && bool(browser.match) === true
    && runtimeHead !== null
    && extensionHead === runtimeHead
    && observedHead === runtimeHead
    && expectedHead === runtimeHead
    && browser.lastError == null
  ) {
    checks.push(makeCheck(
      'extension_release',
      'PASS',
      'WAG_DOCTOR_EXTENSION_RELEASE_MATCH',
      'Browser extension release identity matches the active runtime.',
    ));
  } else {
    checks.push(makeCheck(
      'extension_release',
      'FAIL',
      'WAG_DOCTOR_EXTENSION_RELEASE_MISMATCH',
      'Browser extension release identity is disconnected, stale, or mismatched.',
    ));
  }

  checks.push(
    input.local.supervisorRunning
      ? makeCheck('supervisor', 'PASS', 'WAG_DOCTOR_SUPERVISOR_HEALTHY', 'WAG Local supervisor identity is healthy.')
      : makeCheck('supervisor', 'FAIL', 'WAG_DOCTOR_SUPERVISOR_UNHEALTHY', 'WAG Local supervisor is missing or stale.'),
  );

  checks.push(
    input.local.tunnelHealth && input.local.tunnelReady
      ? makeCheck('tunnel', 'PASS', 'WAG_DOCTOR_TUNNEL_READY', 'Local tunnel health and readiness endpoints are healthy.')
      : makeCheck('tunnel', 'FAIL', 'WAG_DOCTOR_TUNNEL_NOT_READY', 'Local tunnel health/readiness is degraded.'),
  );

  checks.push(
    input.local.devspaceReady
      ? makeCheck('devspace', 'PASS', 'WAG_DOCTOR_DEVSPACE_READY', 'Managed DevSpace discovery endpoint is healthy.')
      : makeCheck('devspace', 'FAIL', 'WAG_DOCTOR_DEVSPACE_NOT_READY', 'Managed DevSpace discovery endpoint is not healthy.'),
  );

  checks.push(
    input.local.maintenanceActive
      ? makeCheck('maintenance', 'WARN', 'WAG_DOCTOR_MAINTENANCE_ACTIVE', 'A bounded promotion maintenance lease is active.')
      : makeCheck('maintenance', 'PASS', 'WAG_DOCTOR_MAINTENANCE_CLEAR', 'No promotion maintenance lease is active.'),
  );

  checks.push(
    config.schema === 'WAG_LOCAL_PRODUCT_CONFIG_V1'
      ? makeCheck('config', 'PASS', 'WAG_DOCTOR_CONFIG_VALID', 'Validated safe product configuration is loaded.')
      : makeCheck('config', 'FAIL', 'WAG_DOCTOR_CONFIG_INVALID', 'Safe product configuration summary is unavailable or invalid.'),
  );

  const remoteGitConfigured = bool(capabilities.remote_git_push_enabled) === true;
  const remoteGitTools = ['git.remote.inspect', 'git.push', 'git.push.result']
    .every((name) => toolSet.has(name));
  checks.push(
    remoteGitConfigured === remoteGitTools
      ? makeCheck(
        'git_policy',
        'PASS',
        'WAG_DOCTOR_GIT_POLICY_COHERENT',
        remoteGitConfigured
          ? 'Remote Git policy is configured and its bounded semantic tools are published.'
          : 'Remote Git policy is disabled and no remote mutation surface is published.',
      )
      : makeCheck('git_policy', 'FAIL', 'WAG_DOCTOR_GIT_POLICY_MISMATCH', 'Configured remote Git policy and published Git tools disagree.'),
  );

  checks.push(
    ['machine.media.inspect', 'verify.media'].every((name) => toolSet.has(name))
      ? makeCheck('media_preflight', 'PASS', 'WAG_DOCTOR_MEDIA_PREFLIGHT_READY', 'Semantic media inspection and verification tools are published.')
      : makeCheck('media_preflight', 'FAIL', 'WAG_DOCTOR_MEDIA_PREFLIGHT_MISSING', 'Semantic media preflight tools are incomplete.'),
  );

  checks.push(
    !browserEnabled || toolSet.has('browser.upload_file')
      ? makeCheck('browser_upload', 'PASS', 'WAG_DOCTOR_BROWSER_UPLOAD_READY', browserEnabled
        ? 'Semantic browser file upload is published.'
        : 'Browser upload is not required while browser integration is disabled.')
      : makeCheck('browser_upload', 'FAIL', 'WAG_DOCTOR_BROWSER_UPLOAD_MISSING', 'Semantic browser file upload is missing.'),
  );

  checks.push(
    !browserEnabled || toolSet.has('browser.download')
      ? makeCheck('browser_download', 'PASS', 'WAG_DOCTOR_BROWSER_DOWNLOAD_READY', browserEnabled
        ? 'Semantic browser download capture is published.'
        : 'Browser download is not required while browser integration is disabled.')
      : makeCheck('browser_download', 'FAIL', 'WAG_DOCTOR_BROWSER_DOWNLOAD_MISSING', 'Semantic browser download capture is missing.'),
  );

  checks.push(
    !browserEnabled || ['browser.dialog.get', 'browser.dialog.respond'].every((name) => toolSet.has(name))
      ? makeCheck('browser_dialog', 'PASS', 'WAG_DOCTOR_BROWSER_DIALOG_READY', browserEnabled
        ? 'Bounded JavaScript dialog observation and response tools are published.'
        : 'Browser dialog tools are not required while browser integration is disabled.')
      : makeCheck('browser_dialog', 'FAIL', 'WAG_DOCTOR_BROWSER_DIALOG_MISSING', 'Browser dialog handling surface is incomplete.'),
  );

  checks.push(
    !browserEnabled || toolSet.has('browser.permission.set')
      ? makeCheck('browser_permission', 'PASS', 'WAG_DOCTOR_BROWSER_PERMISSION_READY', browserEnabled
        ? 'Origin-bound browser permission policy control is published.'
        : 'Browser permission control is not required while browser integration is disabled.')
      : makeCheck('browser_permission', 'FAIL', 'WAG_DOCTOR_BROWSER_PERMISSION_MISSING', 'Browser permission policy surface is incomplete.'),
  );

  checks.push(
    !browserEnabled || ['artifact.list', 'artifact.describe', 'artifact.export']
      .every((name) => toolSet.has(name))
      ? makeCheck('artifact_lifecycle', 'PASS', 'WAG_DOCTOR_ARTIFACT_LIFECYCLE_READY', browserEnabled
        ? 'Caller-owned artifact inspection and workspace export tools are published.'
        : 'Artifact lifecycle tools are not required while browser integration is disabled.')
      : makeCheck('artifact_lifecycle', 'FAIL', 'WAG_DOCTOR_ARTIFACT_LIFECYCLE_MISSING', 'Artifact lifecycle/export surface is incomplete.'),
  );

  checks.push(
    !browserEnabled || ['browser.wait_for', 'browser.assert', 'browser.media.inspect']
      .every((name) => toolSet.has(name))
      ? makeCheck('browser_reliability', 'PASS', 'WAG_DOCTOR_BROWSER_RELIABILITY_READY', browserEnabled
        ? 'Browser wait/assert/media reliability tools are published.'
        : 'Browser reliability tools are not required while browser integration is disabled.')
      : makeCheck('browser_reliability', 'FAIL', 'WAG_DOCTOR_BROWSER_RELIABILITY_MISSING', 'Browser reliability surface is incomplete.'),
  );

  const uniqueTools = new Set(tools);
  checks.push(
    health.status === 'ok' && tools.length > 0 && uniqueTools.size === tools.length && toolSet.has('health')
      ? makeCheck('mcp_surface', 'PASS', 'WAG_DOCTOR_MCP_SURFACE_COHERENT', 'Published MCP tool inventory is non-empty and duplicate-free.')
      : makeCheck('mcp_surface', 'FAIL', 'WAG_DOCTOR_MCP_SURFACE_INVALID', 'Published MCP tool inventory is incoherent.'),
  );

  checks.push(
    input.local.cliDoctorSupportReady
      ? makeCheck('cli_doctor_support', 'PASS', 'WAG_DOCTOR_CLI_SUPPORT_READY', 'Promoted runtime contains CLI doctor/health support files.')
      : makeCheck('cli_doctor_support', input.runtime.deployed ? 'FAIL' : 'WARN', 'WAG_DOCTOR_CLI_SUPPORT_MISSING', 'Promoted runtime is missing CLI doctor/health support files.'),
  );

  const fail = checks.filter((item) => item.status === 'FAIL');
  const warn = checks.filter((item) => item.status === 'WARN');
  const pass = checks.filter((item) => item.status === 'PASS');
  const actions = [...new Set(checks.map(nextAction).filter((value): value is string => value !== null))];

  return {
    schema: 'WAG_LOCAL_PRODUCT_DOCTOR_MCP_V1',
    generated_at_utc: input.generatedAtUtc ?? new Date().toISOString(),
    status: fail.length > 0 ? 'FAIL' : warn.length > 0 ? 'WARN' : 'PASS',
    summary: { pass: pass.length, warn: warn.length, fail: fail.length },
    release: {
      runtime_source_head: runtimeHead,
      extension_source_head: extensionHead,
      expected_extension_sha256: expectedExtensionSha,
      installed_extension_sha256: input.local.installedExtensionSha256,
      browser_observed_source_head: observedHead,
      browser_expected_source_head: expectedHead,
    },
    checks,
    blockers: fail.map((item) => item.id),
    warnings: warn.map((item) => item.id),
    next_actions: actions,
  };
}
