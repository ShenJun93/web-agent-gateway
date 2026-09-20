import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import test from 'node:test';
import { main, type CliDependencies } from '../src/cli.js';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import { PrivateRuntimeError } from '../src/private-runtime.js';

class CaptureWritable extends Writable {
  private chunks: string[] = [];
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(String(chunk));
    callback();
  }
  text() { return this.chunks.join(''); }
}

function config(): PrivateGatewayConfig {
  return {
    allowedRoots: [process.cwd()],
    devspace: { baseUrl: 'http://127.0.0.1:7676', resourceUrl: 'http://127.0.0.1:7676/mcp' },
    verifyProfiles: {},
  };
}
function makeCliHarness() {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((resolvePromise) => { resolveShutdown = resolvePromise; });
  let runtimeClosed = 0;
  let stdioClosed = 0;

  const deps: CliDependencies = {
    env: { DEVSPACE_OAUTH_OWNER_TOKEN: 'owner-token-that-must-not-leak' },
    stdin: process.stdin,
    stdout,
    stderr,
    loadConfig: async () => config(),
    bootstrap: async () => ({
      gateway: {} as never,
      executor: {} as never,
      health: { status: 'ok', executor: 'devspace', protocolVersion: '2026-07-28', toolCount: 6 },
      close: async () => { runtimeClosed += 1; },
    }),
    startStdio: async () => ({ close: async () => { stdioClosed += 1; } }),
    waitForShutdown: async () => shutdown,
    telemetry: { record() {} },
  };

  return {
    deps, stdout, stderr,
    requestShutdown: resolveShutdown,
    runtimeClosed: () => runtimeClosed,
    stdioClosed: () => stdioClosed,
  };
}
test('doctor emits only health JSON and closes the private runtime', async () => {
  const h = makeCliHarness();
  const code = await main(['doctor', '--config', resolve('private.json')], h.deps);
  assert.equal(code, 0);
  assert.equal(JSON.parse(h.stdout.text()).status, 'ok');
  assert.equal(h.stderr.text(), '');
  assert.equal(h.runtimeClosed(), 1);
  assert.equal(h.stdioClosed(), 0);
});

test('serve-stdio keeps stdout for MCP framing and owns orderly shutdown', async () => {
  const h = makeCliHarness();
  const running = main(['serve-stdio', '--config', resolve('private.json')], h.deps);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(h.stdout.text(), '');
  assert.match(h.stderr.text(), /"type":"gateway.ready"/);
  h.requestShutdown();
  assert.equal(await running, 0);
  assert.equal(h.stdioClosed(), 1);
  assert.equal(h.runtimeClosed(), 1);
});
test('CLI usage and config failures return stable sanitized diagnostics', async () => {
  const secret = 'owner-token-that-must-not-leak';
  const usage = makeCliHarness();
  usage.deps.env.DEVSPACE_OAUTH_OWNER_TOKEN = secret;
  assert.equal(await main(['unknown', '--config', resolve('private.json')], usage.deps), 1);
  assert.match(usage.stderr.text(), /"code":"CLI_USAGE"/);
  assert.equal(usage.stderr.text().includes(secret), false);

  const relative = makeCliHarness();
  assert.equal(await main(['doctor', '--config', 'relative.json'], relative.deps), 1);
  assert.match(relative.stderr.text(), /"code":"CLI_USAGE"/);

  const invalid = makeCliHarness();
  invalid.deps.loadConfig = async () => { throw new Error(`bad config containing ${secret}`); };
  assert.equal(await main(['doctor', '--config', resolve('private.json')], invalid.deps), 1);
  assert.match(invalid.stderr.text(), /"code":"CONFIG_INVALID"/);
  assert.equal(invalid.stderr.text().includes(secret), false);
});

test('CLI preserves stable private runtime error codes without leaking causes', async () => {
  const h = makeCliHarness();
  h.deps.bootstrap = async () => {
    throw new PrivateRuntimeError('DEVSPACE_AUTH_FAILED', { cause: new Error('sensitive upstream body') });
  };
  assert.equal(await main(['doctor', '--config', resolve('private.json')], h.deps), 1);
  assert.match(h.stderr.text(), /"code":"DEVSPACE_AUTH_FAILED"/);
  assert.equal(h.stderr.text().includes('sensitive upstream body'), false);
});

test('serve-browser-operator announces the review channel on stderr and never on stdout', async () => {
  const h = makeCliHarness();
  let started: Parameters<NonNullable<CliDependencies['startBrowserOperator']>>[0] | undefined;
  let closed = 0;
  const localAppData = String.raw`C:\Users\wag\AppData\Local`;
  h.deps.env.LOCALAPPDATA = localAppData;
  h.deps.startBrowserOperator = async (options) => {
    started = options;
    return {
      admissionUrl: 'http://127.0.0.1:41111/admit',
      operatorOrigin: 'http://127.0.0.1:41112',
      operatorBootstrapUrl: 'http://127.0.0.1:41112/bootstrap?token=secret-bootstrap',
      operatorUrlFile: `${options.statePath}.operator-url`,
      close: async () => { closed += 1; },
    };
  };

  const running = main(['serve-browser-operator', '--config', resolve('private.json')], h.deps);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  // The host reads this exact discovery path by default, so neither side configures the other.
  assert.equal(started?.discoveryPath, String.raw`${localAppData}\WebAgentGateway\browser-adapter-v4.json`);
  assert.equal(started?.statePath, String.raw`${localAppData}\WebAgentGateway\browser-operator-v4.sqlite`);

  const lines = h.stderr.text().trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(lines.map((line) => line.type), ['gateway.ready', 'gateway.operator']);
  assert.equal(lines[0]!.mode, 'browser-operator');
  assert.equal(lines[0]!.adapterId, 'browser.chatgpt.native.operator.v4');
  // stdout is untouched: this mode has no MCP framing of its own, and the review channel is a
  // local secret that must not be piped anywhere.
  assert.equal(h.stdout.text(), '');
  assert.equal(h.stderr.text().includes('secret-bootstrap'), false, 'the bootstrap token stays local');

  h.requestShutdown();
  assert.equal(await running, 0);
  assert.equal(closed, 1);
  assert.equal(h.stdioClosed(), 0, 'no stdio server is started in this mode');
});

test('serve-browser-operator refuses to start without a usable LOCALAPPDATA', async () => {
  const h = makeCliHarness();
  delete h.deps.env.LOCALAPPDATA;
  let started = 0;
  h.deps.startBrowserOperator = async () => { started += 1; throw new Error('must not be reached'); };

  assert.equal(await main(['serve-browser-operator', '--config', resolve('private.json')], h.deps), 1);
  assert.equal(started, 0);
  assert.equal(JSON.parse(h.stderr.text()).code, 'CLI_USAGE');
});
