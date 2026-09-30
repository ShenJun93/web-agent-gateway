#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BROWSER_OPERATOR_ADAPTER_ID } from './adapter-admission.js';
import {
  startBrowserOperatorRuntime,
  type BrowserOperatorRuntime,
} from './browser-operator-runtime.js';
import { loadPrivateGatewayConfig, type PrivateGatewayConfig } from './private-config.js';
import { createProductMcpContext } from './product-ux.js';
import {
  runProductRollback,
  runProductUninstall,
  runProductUpdate,
  type ProductUninstallArgs,
} from './product-release-runtime.js';
import {
  bootstrapPrivateGateway,
  PrivateRuntimeError,
  type PrivateGatewayRuntime,
} from './private-runtime.js';
import {
  startRepositoryEngineeringRuntime,
  type RepositoryEngineeringRuntime,
} from './repository-engineering-runtime.js';
import {
  startGatewayStdioServer,
  type GatewayStdioServer,
} from './stdio-server.js';
import type { GatewayTelemetryEvent, TelemetrySink } from './telemetry.js';
import {
  startRemoteRelayDeviceRuntime,
  type RemoteRelayDeviceRuntime,
} from './remote-relay-device-runtime.js';

export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  loadConfig: typeof loadPrivateGatewayConfig;
  bootstrap: typeof bootstrapPrivateGateway;
  startStdio: typeof startGatewayStdioServer;
  waitForShutdown: () => Promise<void>;
  telemetry: TelemetrySink;
  /** Per-user installer bootstrap; injected by setup tests. */
  runSetup?: (argv: string[]) => Promise<number>;
  /** Product doctor entrypoint; injected by doctor tests. */
  runDoctor?: (argv: string[]) => Promise<number>;
  /** Transactional product update; injected by product lifecycle tests. */
  runUpdate?: (args: ProductUpdateArgs) => Promise<number>;
  /** Explicit rollback; injected by product lifecycle tests. */
  runRollback?: (args: ProductRollbackArgs) => Promise<number>;
  /** Supported uninstall; injected by product lifecycle tests. */
  runUninstall?: (args: ProductUninstallArgs) => Promise<number>;
  /** Defaults to the real assembly; injected only by tests. */
  startRepositoryEngineering?: typeof startRepositoryEngineeringRuntime;
  /** Defaults to the real assembly; injected only by tests. */
  startBrowserOperator?: typeof startBrowserOperatorRuntime;
  /** Defaults to the real outbound relay-device assembly; injected only by tests. */
  startRemoteRelayDevice?: typeof startRemoteRelayDeviceRuntime;
  /** Remote-device service lifetime is signal-driven and must not depend on stdin staying open. */
  waitForRemoteShutdown?: () => Promise<void>;
}
type CliCommand = 'doctor' | 'serve-stdio' | 'serve-browser-operator' | 'serve-remote-relay-device';
interface ParsedCli { command: CliCommand; configPath: string; }
interface ProductUpdateArgs { packageRoot: string; manifestPath?: string; output?: string; }
interface ProductRollbackArgs { output?: string; }

class CliUsageError extends Error {}

export async function main(
  argv = process.argv.slice(2),
  dependencies?: CliDependencies,
): Promise<number> {
  const deps = dependencies ?? createDefaultDependencies();
  if (argv.length === 1 && argv[0] === '--help') {
    deps.stdout.write(usageText());
    return 0;
  }
  if (argv[0] === 'update') {
    try {
      const updateArgs = parseProductUpdateArgs(argv.slice(1));
      return await (deps.runUpdate ?? runProductUpdate)(updateArgs);
    } catch (error) {
      emitError(deps.stderr, error instanceof CliUsageError ? 'CLI_USAGE' : 'UPDATE_FAILED', error);
      return 1;
    }
  }
  if (argv[0] === 'rollback') {
    try {
      const rollbackArgs = parseProductRollbackArgs(argv.slice(1));
      return await (deps.runRollback ?? runProductRollback)(rollbackArgs);
    } catch (error) {
      emitError(deps.stderr, error instanceof CliUsageError ? 'CLI_USAGE' : 'ROLLBACK_FAILED', error);
      return 1;
    }
  }
  if (argv[0] === 'uninstall') {
    try {
      const uninstallArgs = parseProductUninstallArgs(argv.slice(1));
      return await (deps.runUninstall ?? runProductUninstall)(uninstallArgs);
    } catch (error) {
      emitError(deps.stderr, error instanceof CliUsageError ? 'CLI_USAGE' : 'UNINSTALL_FAILED', error);
      return 1;
    }
  }
  if (argv[0] === 'doctor' && !(argv.length === 3 && argv[1] === '--config')) {
    try {
      const doctorArgs = mapDoctorArgs(argv.slice(1));
      return await (deps.runDoctor ?? ((args) => runDoctorPowerShell(args, deps.stdout, deps.stderr)))(doctorArgs);
    } catch (error) {
      emitError(deps.stderr, error instanceof CliUsageError ? 'CLI_USAGE' : 'DOCTOR_FAILED', error);
      return 1;
    }
  }
  if (argv[0] === 'setup') {
    try {
      const setupArgs = mapSetupArgs(argv.slice(1));
      return await (deps.runSetup ?? ((args) => runSetupPowerShell(args, deps.stdout, deps.stderr)))(setupArgs);
    } catch (error) {
      emitError(deps.stderr, error instanceof CliUsageError ? 'CLI_USAGE' : 'SETUP_FAILED', error);
      return 1;
    }
  }

  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    emitError(deps.stderr, 'CLI_USAGE', error);
    return 1;
  }

  // The browser operator is its own assembly: it binds a loopback admission server and the
  // operator review server, and it never speaks stdio. It therefore does not pass through the
  // stdio bootstrap below, and the shipped stdio profile cannot reach it.
  if (parsed.command === 'serve-browser-operator') {
    return serveBrowserOperator(deps, parsed.configPath);
  }

  let config;
  try {
    config = await deps.loadConfig(parsed.configPath);
  } catch (error) {
    emitError(deps.stderr, 'CONFIG_INVALID', error);
    return 1;
  }
  let engineering: RepositoryEngineeringRuntime;
  try {
    engineering = await (deps.startRepositoryEngineering ?? startRepositoryEngineeringRuntime)(config);
  } catch (error) {
    emitError(deps.stderr, 'REPOSITORY_ENGINEERING_START_FAILED', error);
    return 1;
  }

  let runtime: PrivateGatewayRuntime;
  try {
    runtime = await deps.bootstrap(config, {
      env: deps.env,
      telemetry: deps.telemetry,
      openWorkspaceId: engineering.openWorkspaceId,
      bindWorkspaceIdentity: engineering.bindWorkspaceIdentity,
    });
  } catch (error) {
    await closeQuietly(engineering);
    const code = error instanceof PrivateRuntimeError ? error.code : 'CLI_INTERNAL';
    emitError(deps.stderr, code, error);
    return 1;
  }

  // doctor is a read-only preflight: report what the config would expose without binding
  // the operator review port or opening a review session.
  if (parsed.command === 'doctor') {
    try {
      emitProfile(deps.stderr, engineering);
      deps.stdout.write(`${JSON.stringify(runtime.health)}\n`);
      return 0;
    } finally {
      await closeQuietly(engineering);
      await runtime.close();
    }
  }

  try {
    await engineering.attach(runtime.executor);
  } catch (error) {
    await closeQuietly(engineering);
    await runtime.close().catch(() => undefined);
    emitError(deps.stderr, 'REPOSITORY_ENGINEERING_START_FAILED', error);
    return 1;
  }
  emitProfile(deps.stderr, engineering);

  if (parsed.command === 'serve-remote-relay-device') {
    return serveRemoteRelayDevice(deps, config, runtime, engineering);
  }

  const productContext = engineering.diagnosticsContext === undefined
    ? undefined
    : createProductMcpContext({
        configPath: parsed.configPath,
        config,
        diagnostics: engineering.diagnosticsContext,
      });

  let stdio: GatewayStdioServer;
  try {
    stdio = await deps.startStdio({
      gateway: runtime.gateway,
      input: deps.stdin,
      output: deps.stdout,
      inspect: engineering.profile.inspect,
      mutationContext: engineering.mutationContext,
      gitCommitContext: engineering.gitCommitContext,
      remoteGitPushContext: engineering.remoteGitPushContext,
      commandContext: engineering.commandContext,
      capabilityContext: engineering.capabilityContext,
      machineContext: engineering.machineContext,
      diagnosticsContext: engineering.diagnosticsContext,
      productContext,
      browserContext: engineering.browserContext,
      desktopContext: engineering.desktopContext,
    });
  } catch (error) {
    await closeQuietly(engineering);
    await runtime.close();
    emitError(deps.stderr, 'STDIO_START_FAILED', error);
    return 1;
  }
  deps.stderr.write(`${JSON.stringify({ type: 'gateway.ready', mode: 'stdio' })}\n`);
  let exitCode = 0;
  try {
    await deps.waitForShutdown();
  } catch (error) {
    emitError(deps.stderr, 'CLI_INTERNAL', error);
    exitCode = 1;
  } finally {
    for (const step of [
      () => stdio.close(),
      () => engineering.close(),
      () => runtime.close(),
    ]) {
      try {
        await step();
      } catch (error) {
        emitError(deps.stderr, 'CLI_INTERNAL', error);
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

async function serveRemoteRelayDevice(
  deps: CliDependencies,
  config: PrivateGatewayConfig,
  runtime: PrivateGatewayRuntime,
  engineering: RepositoryEngineeringRuntime,
): Promise<number> {
  let relay: RemoteRelayDeviceRuntime;
  try {
    relay = await (deps.startRemoteRelayDevice ?? startRemoteRelayDeviceRuntime)({
      config,
      gatewayRuntime: runtime,
      engineering,
      env: deps.env,
      onMetadata(event) {
        deps.stderr.write(`${JSON.stringify({ type: 'gateway.remote-relay', ...event })}\n`);
      },
    });
  } catch (error) {
    await closeQuietly(engineering);
    await runtime.close().catch(() => undefined);
    emitError(deps.stderr, 'REMOTE_RELAY_DEVICE_START_FAILED', error);
    return 1;
  }

  deps.stderr.write(`${JSON.stringify({ type: 'gateway.ready', mode: 'remote-relay-device' })}\n`);
  const controller = new AbortController();
  let exitCode = 0;
  const running = relay.run(controller.signal);
  try {
    const outcome = await Promise.race([
      running.then(() => 'agent-exit' as const),
      (deps.waitForRemoteShutdown ?? waitForProcessSignals)().then(() => 'shutdown' as const),
    ]);
    if (outcome === 'agent-exit') {
      throw new Error('Remote relay device agent exited before shutdown');
    }
    controller.abort();
    await running;
  } catch (error) {
    controller.abort();
    await running.catch(() => undefined);
    emitError(deps.stderr, 'REMOTE_RELAY_DEVICE_FAILED', error);
    exitCode = 1;
  } finally {
    for (const step of [
      () => relay.close(),
      () => engineering.close(),
      () => runtime.close(),
    ]) {
      try {
        await step();
      } catch (error) {
        emitError(deps.stderr, 'CLI_INTERNAL', error);
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

async function closeQuietly(engineering: RepositoryEngineeringRuntime): Promise<void> {
  await engineering.close().catch(() => undefined);
}

/**
 * Serve the proposal-only browser operator adapter (ADR-0026).
 *
 * The discovery file is the one the native host reads by default, so the two agree on a path
 * without either being configured with the other's. It carries the admission URL and its
 * one-time bootstrap and nothing else; the operator review origin is announced here, on this
 * process's own stderr, which the browser cannot see.
 */
async function serveBrowserOperator(deps: CliDependencies, configPath: string): Promise<number> {
  const localAppData = deps.env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) {
    emitError(deps.stderr, 'CLI_USAGE', new Error('LOCALAPPDATA is required'));
    return 1;
  }
  const home = join(localAppData, 'WebAgentGateway');

  let runtime: BrowserOperatorRuntime;
  try {
    runtime = await (deps.startBrowserOperator ?? startBrowserOperatorRuntime)({
      configPath,
      discoveryPath: join(home, 'browser-adapter-v4.json'),
      // Its own file, matching what the v5 native host looks for by default. Sharing the v4 path
      // would let one runtime delete the other's discovery — and let a host admit into the wrong
      // adapter identity, which is the identity a delegation binds.
      delegationDiscoveryPath: join(home, 'browser-adapter-v5.json'),
      statePath: join(home, 'browser-operator-v4.sqlite'),
      env: deps.env,
    });
  } catch (error) {
    emitError(deps.stderr, 'BROWSER_OPERATOR_START_FAILED', error);
    return 1;
  }

  deps.stderr.write(`${JSON.stringify({
    type: 'gateway.ready',
    mode: 'browser-operator',
    adapterId: BROWSER_OPERATOR_ADAPTER_ID,
    admissionUrl: runtime.admissionUrl,
  })}\n`);
  // The origin is announced; the single-use bootstrap is not. Whoever launched this process may
  // log or forward its stderr, so the token lives in a 0600 file the local operator opens.
  deps.stderr.write(`${JSON.stringify({
    type: 'gateway.operator',
    origin: runtime.operatorOrigin,
    urlFile: runtime.operatorUrlFile,
  })}\n`);
  // A delegation lifts browser Run only. Goal Lease is retired from the live authority plane, so
  // every browser filesystem or Git effect still reaches the operator review path.
  if (runtime.goalUiDelegationId !== undefined) {
    deps.stderr.write(`${JSON.stringify({
      type: 'gateway.goalUiDelegation',
      delegationId: runtime.goalUiDelegationId,
      discoveryPath: runtime.delegationDiscoveryPath,
      note: 'delegated Run is ENABLED for proposals inside this delegation; effects still require '
        + 'the operator review path. npm run autonomy:stop halts delegated dispatch',
    })}\n`);
  }

  let exitCode = 0;
  try {
    await deps.waitForShutdown();
  } catch (error) {
    emitError(deps.stderr, 'CLI_INTERNAL', error);
    exitCode = 1;
  } finally {
    try {
      await runtime.close();
    } catch (error) {
      emitError(deps.stderr, 'CLI_INTERNAL', error);
      exitCode = 1;
    }
  }
  return exitCode;
}

/**
 * Local-only capability and operator-review diagnostics. Nothing is emitted for the shipped
 * default profile.
 *
 * The operator origin is announced, but the single-use bootstrap token is not: a stdio
 * gateway's stderr belongs to whichever process spawned it, and in the supported deployment
 * that is the remote-facing tunnel client. The token is written to `urlFile` instead, and the
 * operator reads it from there.
 */
function emitProfile(stderr: Writable, engineering: RepositoryEngineeringRuntime): void {
  const { inspect, mutation, gitCommit, browser, stableSessionId } = engineering.profile;
  if (!inspect && !mutation && !gitCommit && browser !== true) return;
  stderr.write(`${JSON.stringify({
    type: 'gateway.profile',
    inspect,
    mutation,
    gitCommit,
    ...(browser === true ? { browser: true } : {}),
    // Only when a correlation makes it stable, so the default profile line is byte-identical to
    // what it was. The id is reconnect/audit continuity, not an authority grant.
    ...(stableSessionId === undefined ? {} : { stableSessionId }),
  })}\n`);
  if (engineering.operator) {
    stderr.write(`${JSON.stringify({
      type: 'gateway.operator',
      origin: engineering.operator.origin,
      urlFile: engineering.operator.urlFile,
    })}\n`);
  }
}

function parseCli(argv: string[]): ParsedCli {
  if (argv.length !== 3 || argv[1] !== '--config') throw new CliUsageError('Invalid CLI arguments');
  if (
    argv[0] !== 'doctor'
    && argv[0] !== 'serve-stdio'
    && argv[0] !== 'serve-browser-operator'
    && argv[0] !== 'serve-remote-relay-device'
  ) {
    throw new CliUsageError('Unknown command');
  }
  if (!isAbsolute(argv[2])) throw new CliUsageError('Config path must be absolute');
  return { command: argv[0], configPath: argv[2] };
}
function emitError(stderr: Writable, code: string, error: unknown): void {
  const errorClass = error instanceof Error ? error.constructor.name : typeof error;
  stderr.write(`${JSON.stringify({ type: 'gateway.error', code, errorClass })}\n`);
}

function telemetryToStderr(stderr: Writable): TelemetrySink {
  return {
    record(event: GatewayTelemetryEvent) {
      stderr.write(`${JSON.stringify({ type: 'gateway.telemetry', ...event })}\n`);
    },
  };
}

function requireAbsoluteCliPath(value: string, flag: string): string {
  if (!isAbsolute(value)) throw new CliUsageError(`${flag} must be an absolute path`);
  return resolve(value);
}

function parseProductUpdateArgs(argv: string[]): ProductUpdateArgs {
  let packageRoot = '';
  let manifestPath = '';
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--package-root' || arg === '--manifest' || arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new CliUsageError(`Missing value after ${arg}`);
      const absolute = requireAbsoluteCliPath(value, arg);
      if (arg === '--package-root') packageRoot = absolute;
      else if (arg === '--manifest') manifestPath = absolute;
      else output = absolute;
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown update argument: ${arg}`);
  }
  if (!packageRoot) throw new CliUsageError('update requires --package-root');
  return {
    packageRoot,
    ...(manifestPath ? { manifestPath } : {}),
    ...(output ? { output } : {}),
  };
}

function parseProductRollbackArgs(argv: string[]): ProductRollbackArgs {
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new CliUsageError('Missing value after --output');
      output = requireAbsoluteCliPath(value, '--output');
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown rollback argument: ${arg}`);
  }
  return output ? { output } : {};
}

function parseProductUninstallArgs(argv: string[]): ProductUninstallArgs {
  let output: string | undefined;
  let keepState = false;
  let removeManagedDevspace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--keep-state') { keepState = true; continue; }
    if (arg === '--remove-managed-devspace') { removeManagedDevspace = true; continue; }
    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new CliUsageError('Missing value after --output');
      output = requireAbsoluteCliPath(value, '--output');
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown uninstall argument: ${arg}`);
  }
  return {
    keepState,
    removeManagedDevspace,
    ...(output ? { output } : {}),
  };
}

function mapDoctorArgs(argv: string[]): string[] {
  const mapped: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--repair') { mapped.push('-Repair'); continue; }
    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new CliUsageError('Missing value after --output');
      mapped.push('-Output', value);
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown doctor argument: ${arg}`);
  }
  return mapped;
}

async function runDoctorPowerShell(argv: string[], stdout: Writable, stderr: Writable): Promise<number> {
  const script = fileURLToPath(new URL('../scripts/wag-local-doctor.ps1', import.meta.url));
  const result = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...argv,
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  return result.status ?? 1;
}

function mapSetupArgs(argv: string[]): string[] {
  const mapped: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--check-only') { mapped.push('-CheckOnly'); continue; }
    if (arg === '--no-start') { mapped.push('-NoStart'); continue; }
    if (arg === '--no-autostart') { mapped.push('-NoAutostart'); continue; }
    if (arg === '--connector-confirmed') { mapped.push('-ConnectorConfirmed'); continue; }
    const names: Record<string, string> = {
      '--allowed-root': '-AllowedRoot',
      '--output': '-Output',
      '--tunnel-client-path': '-TunnelClientPath',
      '--tunnel-id': '-TunnelId',
      '--runtime-key-ref': '-RuntimeKeyRef',
    };
    const mappedName = names[arg];
    if (mappedName) {
      const value = argv[index + 1];
      if (!value) throw new CliUsageError(`Missing value after ${arg}`);
      mapped.push(mappedName, value);
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown setup argument: ${arg}`);
  }
  return mapped;
}

async function runSetupPowerShell(argv: string[], stdout: Writable, stderr: Writable): Promise<number> {
  const script = fileURLToPath(new URL('../scripts/wag-local-provision.ps1', import.meta.url));
  const result = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...argv,
  ], { encoding: 'utf8', windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  return result.status ?? 1;
}

function usageText(): string {
  return [
    'Usage:',
    '  web-agent-gateway setup [--check-only] [--tunnel-id <tunnel_...>] [--runtime-key-ref env:CONTROL_PLANE_API_KEY] [--connector-confirmed] [--allowed-root <absolute-path>] [--no-start] [--no-autostart]',
    '  web-agent-gateway update --package-root <absolute-path> [--manifest <absolute-path>] [--output <absolute-path>]',
    '  web-agent-gateway rollback [--output <absolute-path>]',
    '  web-agent-gateway uninstall [--keep-state] [--remove-managed-devspace] [--output <absolute-path>]',
    '  web-agent-gateway doctor [--repair] [--output <absolute-path>]',
    '  web-agent-gateway doctor --config <absolute-path>  # legacy runtime preflight',
    '  web-agent-gateway serve-stdio --config <absolute-path>',
    '  web-agent-gateway serve-browser-operator --config <absolute-path>',
    '  web-agent-gateway serve-remote-relay-device --config <absolute-path>',
    '',
  ].join('\n');
}

function createDefaultDependencies(): CliDependencies {
  return {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    loadConfig: loadPrivateGatewayConfig,
    bootstrap: bootstrapPrivateGateway,
    startStdio: startGatewayStdioServer,
    waitForShutdown: waitForProcessShutdown,
    waitForRemoteShutdown: waitForProcessSignals,
    telemetry: telemetryToStderr(process.stderr),
  };
}
async function waitForProcessSignals(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolvePromise();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

async function waitForProcessShutdown(): Promise<void> {
  if (process.stdin.readableEnded || process.stdin.destroyed) return;
  await new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.stdin.off('end', finish);
      process.stdin.off('close', finish);
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolvePromise();
    };
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}
