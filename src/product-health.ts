import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export type ProductStatus = 'READY' | 'DEGRADED' | 'OFFLINE';

export interface Diagnostic {
  code: string;
  severity: 'INFO' | 'WARN' | 'ERROR';
  message: string;
}

interface WrapperBinding {
  cliPath: string;
  configPath: string;
}

interface Probe {
  ok: boolean;
  status?: number;
}

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const localAppData = process.env.LOCALAPPDATA ?? '';
const wagLocal = join(localAppData, 'WAG-Local');
const tunnelProfileReadCommand = 'cat "$HOME/.config/tunnel-client/web-agent-gateway.yaml"';

export function parseTunnelProfile(text: string): string {
  const commands = [...text.matchAll(/^\s*command:\s*["']?([^"'\r\n]+)["']?\s*$/gm)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (commands.length !== 1 || !commands[0]!.startsWith('/')) {
    throw new Error('WAG_TUNNEL_PROFILE_INVALID');
  }
  return commands[0]!;
}

export function parseWrapper(text: string): WrapperBinding {
  const normalized = text.replace(/\\\r?\n/g, ' ');
  const cliPaths = [...normalized.matchAll(
    /"([A-Za-z]:\/[^"\r\n]+\/dist\/cli\.js)"|'([A-Za-z]:\/[^'\r\n]+\/dist\/cli\.js)'|([A-Za-z]:\/\S+\/dist\/cli\.js)/g,
  )].map((match) => match[1] ?? match[2] ?? match[3]).filter((value): value is string => Boolean(value));
  const configPaths = [...normalized.matchAll(
    /--config\s+(?:"([A-Za-z]:\/[^"\r\n]+)"|'([A-Za-z]:\/[^'\r\n]+)'|([A-Za-z]:\/\S+))/g,
  )].map((match) => match[1] ?? match[2] ?? match[3]).filter((value): value is string => Boolean(value));
  if (cliPaths.length !== 1 || configPaths.length !== 1) {
    throw new Error('WAG_WRAPPER_BINDING_INVALID');
  }
  return { cliPath: cliPaths[0]!, configPath: configPaths[0]! };
}

export function isDevelopmentCheckout(packageRoot: string, gitTopLevel: string | null): boolean {
  if (!gitTopLevel) return false;
  const normalize = (value: string) => resolve(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return normalize(packageRoot) === normalize(gitTopLevel);
}

export function classifyStatus(core: {
  devspaceDiscovery: boolean;
  tunnelReady: boolean;
  mcpRoundTrip: boolean;
}): ProductStatus {
  if (core.devspaceDiscovery && core.tunnelReady && core.mcpRoundTrip) return 'READY';
  if (!core.devspaceDiscovery && !core.tunnelReady && !core.mcpRoundTrip) return 'OFFLINE';
  return 'DEGRADED';
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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

async function httpProbe(url: string): Promise<Probe> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false };
  }
}

function parseMajor(version: string): number | null {
  const match = version.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function classifyMcpProbeFailure(value: string): string {
  if (/REPOSITORY_ENGINEERING_START_FAILED/.test(value)) return 'WAG_MCP_PROBE_REPOSITORY_START';
  if (/STDIO_START_FAILED/.test(value)) return 'WAG_MCP_PROBE_STDIO_START';
  if (/DEVSPACE_AUTH_FAILED|DEVSPACE_OWNER_TOKEN_MISSING/.test(value)) return 'WAG_MCP_PROBE_DEVSPACE_AUTH';
  if (/CONFIG_INVALID/.test(value)) return 'WAG_MCP_PROBE_CONFIG';
  if (/EADDRINUSE|address already in use/i.test(value)) return 'WAG_MCP_PROBE_PORT_BUSY';
  if (/SQLITE_BUSY|database is locked|database table is locked/i.test(value)) return 'WAG_MCP_PROBE_SQLITE_BUSY';
  if (/DEVSPACE_AUTH|unauthor|forbidden|\b401\b|\b403\b/i.test(value)) return 'WAG_MCP_PROBE_AUTH';
  if (/CONFIG_INVALID|config/i.test(value)) return 'WAG_MCP_PROBE_CONFIG';
  if (/Connection closed|transport|ECONNRESET|EPIPE/i.test(value)) return 'WAG_MCP_PROBE_TRANSPORT';
  return 'WAG_MCP_PROBE_UNKNOWN';
}

async function collectMcp(cliPath: string, configPath: string) {
  const ownerToken = process.env.DEVSPACE_OAUTH_OWNER_TOKEN;
  if (!ownerToken) throw new Error('DEVSPACE_OWNER_TOKEN_MISSING');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'serve-stdio', '--config', configPath],
    env: {
      ...getDefaultEnvironment(),
      WAG_PRODUCT_HEALTH_PROBE: '1',
      DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });

  const client = new Client(
    { name: 'wag-local-product-health', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const healthResult = await client.callTool({ name: 'health', arguments: {} });
    if (healthResult.isError === true) throw new Error('MCP_HEALTH_TOOL_ERROR');

    const health = (healthResult.structuredContent ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      toolNames: listed.tools.map((tool) => tool.name),
      health: {
        status: typeof health.status === 'string' ? health.status : null,
        executor: typeof health.executor === 'string' ? health.executor : null,
        protocolVersion: typeof health.protocolVersion === 'string' ? health.protocolVersion : null,
        toolCount: typeof health.toolCount === 'number' ? health.toolCount : null,
        mcpToolCount: typeof health.mcpToolCount === 'number' ? health.mcpToolCount : null,
        authorityMode: typeof health.authorityMode === 'string' ? health.authorityMode : null,
        runtimeSourceHead:
          typeof (health.runtime as Record<string, unknown> | undefined)?.source_head === 'string'
            ? String((health.runtime as Record<string, unknown>).source_head)
            : null,
        runtimeCapability:
          typeof (health.runtime as Record<string, unknown> | undefined)?.capability === 'string'
            ? String((health.runtime as Record<string, unknown>).capability)
            : null,
      },
      stderrHadSecret: stderr.includes(ownerToken),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(classifyMcpProbeFailure(message + '\n' + stderr));
  } finally {
    await client.close().catch(() => undefined);
  }
}

function parseArgs(argv: string[]): { output: string } {
  let output = join(wagLocal, 'receipts', 'wag-local-product-health.json');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value after --output');
      output = resolve(value);
      index += 1;
      continue;
    }
    throw new Error('Unknown argument: ' + argv[index]);
  }
  return { output };
}

export async function collectReceipt() {
  const diagnostics: Diagnostic[] = [];
  const pin = JSON.parse(readFileSync(join(repoRoot, 'docs', 'benchmarks', 'devspace-pin.json'), 'utf8')) as {
    revision: string;
    package_version?: string;
  };

  const packageInfo = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: string };
  const packageVersion = typeof packageInfo.version === 'string' ? packageInfo.version : null;
  const gitTopLevel = runOptional('git.exe', ['-C', repoRoot, 'rev-parse', '--show-toplevel']);
  const developmentCheckout = gitTopLevel.ok && isDevelopmentCheckout(repoRoot, gitTopLevel.stdout);
  const repoHead = developmentCheckout
    ? runOptional('git.exe', ['-C', repoRoot, 'rev-parse', 'HEAD']).stdout || null
    : null;
  const repoBranch = developmentCheckout
    ? runOptional('git.exe', ['-C', repoRoot, 'branch', '--show-current']).stdout || null
    : null;
  const repoStatus = developmentCheckout
    ? runOptional('git.exe', ['-C', repoRoot, 'status', '--porcelain']).stdout
    : '';
  const repoClean = developmentCheckout ? repoStatus.length === 0 : null;

  const nodeVersion = process.version;
  const nodeMajor = parseMajor(nodeVersion);
  const nodeSupported = nodeMajor !== null && nodeMajor >= 22 && nodeMajor < 27;
  if (!nodeSupported) diagnostics.push({
    code: 'WAG_NODE_VERSION_UNSUPPORTED',
    severity: 'ERROR',
    message: 'Node must satisfy >=22.19 <27.',
  });

  const pwsh = runOptional('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  const pwshMajor = parseMajor(pwsh.stdout);
  const pwshSupported = pwsh.ok && pwshMajor !== null && pwshMajor >= 7;
  if (!pwshSupported) diagnostics.push({
    code: 'WAG_POWERSHELL7_UNAVAILABLE',
    severity: 'ERROR',
    message: 'PowerShell 7 is required for the supported WAG Local launcher.',
  });

  const wsl = runOptional('wsl.exe', ['-e', 'true']);
  if (!wsl.ok) diagnostics.push({
    code: 'WAG_WSL_UNAVAILABLE',
    severity: 'ERROR',
    message: 'WSL is unavailable.',
  });

  let binding: WrapperBinding | null = null;
  try {
    const profileText = runText('wsl.exe', ['-e', 'sh', '-lc', tunnelProfileReadCommand]);
    const wrapperPath = parseTunnelProfile(profileText);
    const wrapperText = runText('wsl.exe', ['-e', 'cat', wrapperPath]);
    binding = parseWrapper(wrapperText);
  } catch {
    diagnostics.push({
      code: 'WAG_WRAPPER_BINDING_INVALID',
      severity: 'ERROR',
      message: 'The WAG tunnel profile/wrapper could not be resolved to one runtime and config.',
    });
  }

  let runtimeMarker: Record<string, unknown> | null = null;
  let runtimeCliSha256: string | null = null;
  if (binding) {
    const runtimeRoot = dirname(dirname(binding.cliPath));
    const markerPath = join(runtimeRoot, 'RUNTIME.json');
    runtimeCliSha256 = sha256File(binding.cliPath);
    if (existsSync(markerPath)) {
      try {
        runtimeMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
      } catch {
        diagnostics.push({
          code: 'WAG_RUNTIME_MARKER_INVALID',
          severity: 'ERROR',
          message: 'The active runtime marker is not valid JSON.',
        });
      }
    } else {
      diagnostics.push({
        code: 'WAG_RUNTIME_MARKER_MISSING',
        severity: 'ERROR',
        message: 'The active WAG runtime marker is missing.',
      });
    }
  }

  const expectedLaunchers = {
    tunnel: join(repoRoot, 'scripts', 'wag-local-tunnel-launcher.ps1'),
    start: join(repoRoot, 'scripts', 'wag-local-start.ps1'),
    supervisor: join(repoRoot, 'scripts', 'wag-local-supervisor.ps1'),
  };
  const installedLaunchers = {
    tunnel: join(wagLocal, 'Start-WagLocalTunnel.ps1'),
    start: join(wagLocal, 'Start-WagLocal.ps1'),
    supervisor: join(wagLocal, 'Start-WagLocalSupervisor.ps1'),
  };
  const launcherHashes = {
    tunnel: {
      expected: sha256File(expectedLaunchers.tunnel),
      installed: sha256File(installedLaunchers.tunnel),
    },
    start: {
      expected: sha256File(expectedLaunchers.start),
      installed: sha256File(installedLaunchers.start),
    },
    supervisor: {
      expected: sha256File(expectedLaunchers.supervisor),
      installed: sha256File(installedLaunchers.supervisor),
    },
  };
  const launchersMatch =
    launcherHashes.tunnel.expected !== null
    && launcherHashes.tunnel.expected === launcherHashes.tunnel.installed
    && launcherHashes.start.expected !== null
    && launcherHashes.start.expected === launcherHashes.start.installed
    && launcherHashes.supervisor.expected !== null
    && launcherHashes.supervisor.expected === launcherHashes.supervisor.installed;
  if (!launchersMatch) diagnostics.push({
    code: 'WAG_LAUNCHER_DRIFT',
    severity: 'ERROR',
    message: 'Installed WAG Local launchers do not match the repository-owned canonical copies.',
  });

  const startupDir = runOptional('pwsh.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    "[Environment]::GetFolderPath('Startup')",
  ]);
  const startupShortcut = startupDir.ok && startupDir.stdout.length > 0
    ? join(startupDir.stdout, 'WAG Local.lnk')
    : null;
  const startupShortcutPresent = startupShortcut !== null && existsSync(startupShortcut);
  if (!startupShortcutPresent) diagnostics.push({
    code: 'WAG_AUTOSTART_MISSING',
    severity: 'WARN',
    message: 'The per-user WAG Local Startup shortcut is missing.',
  });

  let startupTargetsSupervisor = false;
  if (startupShortcutPresent && startupShortcut) {
    const shortcut = runOptional('pwsh.exe', [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('" + startupShortcut.replaceAll("'", "''") + "');$s.TargetPath; $s.Arguments",
    ]);
    startupTargetsSupervisor = shortcut.ok && shortcut.stdout.includes('Start-WagLocalSupervisor.ps1');
    if (!startupTargetsSupervisor) diagnostics.push({
      code: 'WAG_AUTOSTART_TARGET_DRIFT',
      severity: 'ERROR',
      message: 'The WAG Local Startup shortcut does not target the supervisor.',
    });
  }

  const supervisorPidPath = join(wagLocal, 'logs', 'wag-local-supervisor.pid');
  let supervisorPid: number | null = null;
  let supervisorRunning = false;
  if (existsSync(supervisorPidPath)) {
    const parsed = Number(readFileSync(supervisorPidPath, 'utf8').trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      supervisorPid = parsed;
      supervisorRunning = runOptional('pwsh.exe', [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        "if(Get-Process -Id " + String(parsed) + " -ErrorAction SilentlyContinue){exit 0}else{exit 1}",
      ]).ok;
    }
  }
  if (!supervisorRunning) diagnostics.push({
    code: 'WAG_SUPERVISOR_NOT_RUNNING',
    severity: 'WARN',
    message: 'The WAG Local recovery supervisor is not currently running.',
  });

  const devspaceDir = join(wagLocal, 'DevSpace-Pin-' + pin.revision.slice(0, 7));
  const devspaceHead = existsSync(join(devspaceDir, '.git'))
    ? runOptional('git.exe', ['-C', devspaceDir, 'rev-parse', 'HEAD']).stdout || null
    : null;
  const devspacePinMatch = devspaceHead === pin.revision;
  if (!devspaceHead) diagnostics.push({
    code: 'WAG_DEVSPACE_PIN_MISSING',
    severity: 'ERROR',
    message: 'The managed exact-pinned DevSpace checkout is missing.',
  });
  else if (!devspacePinMatch) diagnostics.push({
    code: 'WAG_DEVSPACE_PIN_MISMATCH',
    severity: 'ERROR',
    message: 'The managed DevSpace checkout does not match the accepted exact revision.',
  });

  const devspace = await httpProbe('http://127.0.0.1:7677/.well-known/oauth-authorization-server');
  if (!devspace.ok) diagnostics.push({
    code: 'WAG_DEVSPACE_DISCOVERY_DOWN',
    severity: 'ERROR',
    message: 'DevSpace OAuth discovery is not healthy.',
  });

  const tunnelHealth = await httpProbe('http://127.0.0.1:8080/healthz');
  const tunnelReady = await httpProbe('http://127.0.0.1:8080/readyz');
  const tunnelOk = tunnelHealth.ok && tunnelReady.ok;
  if (!tunnelOk) diagnostics.push({
    code: 'WAG_TUNNEL_NOT_READY',
    severity: 'ERROR',
    message: 'The local tunnel is not both live and ready.',
  });

  let mcp: Awaited<ReturnType<typeof collectMcp>> | null = null;
  if (binding) {
    try {
      mcp = await collectMcp(binding.cliPath, binding.configPath);
      if (mcp.stderrHadSecret) diagnostics.push({
        code: 'WAG_SECRET_LEAK_STDERR',
        severity: 'ERROR',
        message: 'A credential value appeared in WAG stdio stderr.',
      });
      if (mcp.health.status !== 'ok') diagnostics.push({
        code: 'WAG_MCP_HEALTH_NOT_OK',
        severity: 'ERROR',
        message: 'The MCP health tool did not report status=ok.',
      });
      if (mcp.health.authorityMode !== 'AUTONOMOUS_LOCAL') diagnostics.push({
        code: 'WAG_AUTHORITY_MODE_UNEXPECTED',
        severity: 'ERROR',
        message: 'The active private local surface is not AUTONOMOUS_LOCAL.',
      });
      if (mcp.health.mcpToolCount !== mcp.toolNames.length) diagnostics.push({
        code: 'WAG_MCP_SURFACE_COUNT_MISMATCH',
        severity: 'ERROR',
        message: 'health.mcpToolCount does not match MCP listTools.',
      });
    } catch (error) {
      const failure = error instanceof Error && /^WAG_MCP_PROBE_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'WAG_MCP_PROBE_UNKNOWN';
      diagnostics.push({
        code: 'WAG_MCP_ROUNDTRIP_FAILED',
        severity: 'ERROR',
        message: 'A fresh local stdio MCP client could not complete health/listTools (' + failure + ').',
      });
    }
  }

  const status = classifyStatus({
    devspaceDiscovery: devspace.ok,
    tunnelReady: tunnelOk,
    mcpRoundTrip: Boolean(mcp?.ok),
  });

  const runtimeSourceHead = typeof runtimeMarker?.sourceHead === 'string'
    ? String(runtimeMarker.sourceHead)
    : mcp?.health.runtimeSourceHead ?? null;
  const sourceRuntimeAligned = repoHead === null ? null : runtimeSourceHead === repoHead;
  if (repoHead !== null && sourceRuntimeAligned === false) diagnostics.push({
    code: 'WAG_DEVELOPMENT_SOURCE_RUNTIME_DRIFT',
    severity: 'INFO',
    message: 'The development repository HEAD differs from the currently deployed runtime source HEAD.',
  });
  if (repoClean === false) diagnostics.push({
    code: 'WAG_SOURCE_WORKTREE_DIRTY',
    severity: 'WARN',
    message: 'The development source worktree is dirty.',
  });

  return {
    schema: 'WAG_LOCAL_PRODUCT_HEALTH_V1',
    generatedAtUtc: new Date().toISOString(),
    status,
    source: {
      mode: developmentCheckout ? 'development-checkout' : 'installed-package',
      packageVersion,
      branch: repoBranch,
      head: repoHead,
      clean: repoClean,
      runtimeAligned: sourceRuntimeAligned,
    },
    host: {
      nodeVersion,
      nodeSupported,
      pwshVersion: pwsh.stdout || null,
      pwshSupported,
      wslAvailable: wsl.ok,
    },
    runtime: {
      sourceHead: runtimeSourceHead,
      capability: typeof runtimeMarker?.capability === 'string'
        ? String(runtimeMarker.capability)
        : mcp?.health.runtimeCapability ?? null,
      cliSha256: runtimeCliSha256,
    },
    launchers: {
      matchCanonical: launchersMatch,
      hashes: launcherHashes,
      startupShortcutPresent,
      startupTargetsSupervisor,
      supervisorPid,
      supervisorRunning,
    },
    devspace: {
      expectedRevision: pin.revision,
      packageVersion: pin.package_version ?? null,
      installedRevision: devspaceHead,
      pinMatch: devspacePinMatch,
      discoveryHttpStatus: devspace.status ?? null,
      discoveryReady: devspace.ok,
    },
    tunnel: {
      healthHttpStatus: tunnelHealth.status ?? null,
      readyHttpStatus: tunnelReady.status ?? null,
      ready: tunnelOk,
    },
    mcp: {
      roundTrip: Boolean(mcp?.ok),
      status: mcp?.health.status ?? null,
      executor: mcp?.health.executor ?? null,
      protocolVersion: mcp?.health.protocolVersion ?? null,
      executorToolCount: mcp?.health.toolCount ?? null,
      mcpToolCount: mcp?.health.mcpToolCount ?? null,
      listedToolCount: mcp?.toolNames.length ?? null,
      tools: mcp?.toolNames ?? [],
      authorityMode: mcp?.health.authorityMode ?? null,
    },
    diagnostics,
  };
}

export async function runProductHealthCli(argv = process.argv.slice(2)): Promise<number> {
  const { output } = parseArgs(argv);
  const receipt = await collectReceipt();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  return receipt.status === 'READY' ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProductHealthCli();
}
