import { isAbsolute, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { loadPrivateGatewayConfig } from './private-config.js';
import {
  bootstrapPrivateGateway,
  PrivateRuntimeError,
  type PrivateGatewayRuntime,
} from './private-runtime.js';
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
}
type CliCommand = 'doctor' | 'serve-stdio';
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

  let config;
  try {
    config = await deps.loadConfig(parsed.configPath);
  } catch (error) {
    emitError(deps.stderr, 'CONFIG_INVALID', error);
    return 1;
  }
  let runtime: PrivateGatewayRuntime;
  try {
    runtime = await deps.bootstrap(config, { env: deps.env, telemetry: deps.telemetry });
  } catch (error) {
    const code = error instanceof PrivateRuntimeError ? error.code : 'CLI_INTERNAL';
    emitError(deps.stderr, code, error);
    return 1;
  }

  if (parsed.command === 'doctor') {
    try {
      deps.stdout.write(`${JSON.stringify(runtime.health)}\n`);
      return 0;
    } finally {
      await runtime.close();
    }
  }

  let stdio: GatewayStdioServer;
  try {
    stdio = await deps.startStdio({
      gateway: runtime.gateway,
      input: deps.stdin,
      output: deps.stdout,
    });
  } catch (error) {
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
    try {
      await stdio.close();
    } catch (error) {
      emitError(deps.stderr, 'CLI_INTERNAL', error);
      exitCode = 1;
    }
    try {
      await runtime.close();
    } catch (error) {
      emitError(deps.stderr, 'CLI_INTERNAL', error);
      exitCode = 1;
    }
  }
  return exitCode;
}

function parseCli(argv: string[]): ParsedCli {
  if (argv.length !== 3 || argv[1] !== '--config') throw new CliUsageError('Invalid CLI arguments');
  if (argv[0] !== 'doctor' && argv[0] !== 'serve-stdio') throw new CliUsageError('Unknown command');
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
