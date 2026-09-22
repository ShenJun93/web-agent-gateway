import { isAbsolute, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { BROWSER_OPERATOR_ADAPTER_ID } from './adapter-admission.js';
import {
  startBrowserOperatorRuntime,
  type BrowserOperatorRuntime,
} from './browser-operator-runtime.js';
import { loadPrivateGatewayConfig } from './private-config.js';
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
  /** Defaults to the real assembly; injected only by tests. */
  startRepositoryEngineering?: typeof startRepositoryEngineeringRuntime;
  /** Defaults to the real assembly; injected only by tests. */
  startBrowserOperator?: typeof startBrowserOperatorRuntime;
}
type CliCommand = 'doctor' | 'serve-stdio' | 'serve-browser-operator';
interface ParsedCli { command: CliCommand; configPath: string; }

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

  let stdio: GatewayStdioServer;
  try {
    stdio = await deps.startStdio({
      gateway: runtime.gateway,
      input: deps.stdin,
      output: deps.stdout,
      inspect: engineering.profile.inspect,
      mutationContext: engineering.mutationContext,
      gitCommitContext: engineering.gitCommitContext,
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
  // Announced loudly when on, and silent when off. An autonomous-admission mode that is only
  // visible by reading a config file is one an operator can be running without knowing.
  if (runtime.goalLeaseId !== undefined) {
    deps.stderr.write(`${JSON.stringify({
      type: 'gateway.goalLease',
      leaseId: runtime.goalLeaseId,
      note: 'autonomous admission is ENABLED for actions inside this lease; npm run lease:stop halts it',
    })}\n`);
  }
  // Announced for the same reason, and phrased to keep the two authorities apart. A delegation
  // lifts Run and never Approve: an effect still needs the operator, or a lease that admits it.
  if (runtime.goalUiDelegationId !== undefined) {
    deps.stderr.write(`${JSON.stringify({
      type: 'gateway.goalUiDelegation',
      delegationId: runtime.goalUiDelegationId,
      discoveryPath: runtime.delegationDiscoveryPath,
      note: 'delegated Run is ENABLED for proposals inside this delegation; APPROVAL is unchanged '
        + 'and still requires the operator or an active lease. npm run lease:stop halts it',
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
  const { inspect, mutation, gitCommit, stableSessionId } = engineering.profile;
  if (!inspect && !mutation && !gitCommit) return;
  stderr.write(`${JSON.stringify({
    type: 'gateway.profile',
    inspect,
    mutation,
    gitCommit,
    // Only when a correlation makes it stable, so the default profile line is byte-identical to
    // what it was. This is how a human finds the session id a Goal Lease has to be bound to.
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
  if (argv[0] !== 'doctor' && argv[0] !== 'serve-stdio' && argv[0] !== 'serve-browser-operator') {
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

function usageText(): string {
  return [
    'Usage:',
    '  web-agent-gateway doctor --config <absolute-path>',
    '  web-agent-gateway serve-stdio --config <absolute-path>',
    '  web-agent-gateway serve-browser-operator --config <absolute-path>',
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
    telemetry: telemetryToStderr(process.stderr),
  };
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
