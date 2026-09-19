import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { main, type CliDependencies } from '../src/cli.js';
import type { DevspaceExecutor } from '../src/executor/devspace.js';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import {
  PRIVATE_STDIO_ADAPTER_ID,
  startRepositoryEngineeringRuntime,
} from '../src/repository-engineering-runtime.js';

const fakeExecutor = {} as unknown as DevspaceExecutor;

function config(repositoryEngineering?: PrivateGatewayConfig['repositoryEngineering']): PrivateGatewayConfig {
  return {
    allowedRoots: [process.cwd()],
    devspace: { baseUrl: 'http://127.0.0.1:7676', resourceUrl: 'http://127.0.0.1:7676/mcp' },
    verifyProfiles: {},
    ...(repositoryEngineering === undefined ? {} : { repositoryEngineering }),
  };
}

class CaptureWritable extends PassThrough {
  private chunks: string[] = [];
  constructor() { super(); this.on('data', (chunk) => this.chunks.push(String(chunk))); }
  text(): string { return this.chunks.join(''); }
}

/** Startup spans several async hops, so wait on the observable outcome, not a fixed tick. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// --------------------------------------------------------------------------
// Gate 4 — runtime assembly
// --------------------------------------------------------------------------

test('disabled repository engineering opens no store, binds no port, and builds no caller context', async () => {
  let operatorStarts = 0;
  const runtime = await startRepositoryEngineeringRuntime(config(), {
    startOperatorServer: async () => { operatorStarts += 1; throw new Error('must not start'); },
  });

  assert.deepEqual(runtime.profile, { inspect: false, mutation: false });
  assert.equal(runtime.openWorkspaceId, undefined);
  assert.equal(runtime.mutationContext, undefined);
  assert.equal(runtime.operator, undefined);

  await runtime.attach(fakeExecutor);
  assert.equal(operatorStarts, 0, 'attach must be inert when mutation is disabled');
  assert.equal(runtime.mutationContext, undefined);

  await runtime.close();
  await runtime.close();
});

test('search-only opt-in stays read-only and still assembles no mutation state', async () => {
  const runtime = await startRepositoryEngineeringRuntime(config({ inspect: true }));
  assert.deepEqual(runtime.profile, { inspect: true, mutation: false });
  assert.equal(runtime.openWorkspaceId, undefined);
  await runtime.attach(fakeExecutor);
  assert.equal(runtime.mutationContext, undefined);
  assert.equal(runtime.operator, undefined);
  await runtime.close();
});

/** Cleans up runtimes before their state directory; hooks run in registration order. */
function scoped(t: test.TestContext, root: string) {
  const runtimes: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return <T extends { close(): Promise<void> }>(runtime: T): T => { runtimes.push(runtime); return runtime; };
}

test('mutation opt-in binds workspace.open to durable records owned by a per-process session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-runtime-'));
  const track = scoped(t, root);
  const statePath = join(root, 'control-plane.sqlite');

  const first = track(await startRepositoryEngineeringRuntime(
    config({ inspect: true, mutation: { statePath, ownerId: 'local.private.stdio' } }),
    { startOperatorServer: async () => ({ origin: 'http://127.0.0.1:1', bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=x', close: async () => {} }) },
  ));

  assert.deepEqual(first.profile, { inspect: true, mutation: true });
  assert.ok(first.openWorkspaceId, 'mutation previews resolve workspaces from the store');
  const workspaceId = first.openWorkspaceId!(process.cwd());
  assert.match(workspaceId, /^ws_/);

  await first.attach(fakeExecutor);
  assert.ok(first.mutationContext);
  assert.equal(first.mutationContext!.callerContext.adapterId, PRIVATE_STDIO_ADAPTER_ID);
  assert.equal(first.mutationContext!.callerContext.ownerId, 'local.private.stdio');
  assert.match(first.mutationContext!.callerContext.sessionId, /^sid_/);

  const second = track(await startRepositoryEngineeringRuntime(
    config({ inspect: false, mutation: { statePath: join(root, 'other.sqlite'), ownerId: 'local.private.stdio' } }),
  ));
  await second.attach(fakeExecutor);
  assert.notEqual(
    second.mutationContext!.callerContext.sessionId,
    first.mutationContext!.callerContext.sessionId,
    'each gateway process must be a distinct session so approval authority cannot be inherited',
  );
  assert.match(second.operator!.origin, /^http:\/\/127\.0\.0\.1:/, 'operator review must be loopback-only');
});

test('attach is single-use and releases the durable store when it fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-runtime-fail-'));
  const track = scoped(t, root);
  const statePath = join(root, 'control-plane.sqlite');

  const runtime = track(await startRepositoryEngineeringRuntime(
    config({ inspect: false, mutation: { statePath, ownerId: 'local.private.stdio' } }),
    { startOperatorServer: async () => { throw new Error('operator bind failed'); } },
  ));
  await assert.rejects(() => runtime.attach(fakeExecutor), /operator bind failed/);
  assert.equal(runtime.mutationContext, undefined, 'a failed attach must expose no mutation authority');

  await stat(statePath);
  await rm(statePath, { force: true });
  await stat(statePath).then(
    () => assert.fail('state file must be deletable, proving the store handle was released'),
    () => undefined,
  );

  await runtime.close();

  const reusable = track(await startRepositoryEngineeringRuntime(
    config({ inspect: false, mutation: { statePath: join(root, 'again.sqlite'), ownerId: 'local.private.stdio' } }),
    { startOperatorServer: async () => ({ origin: 'http://127.0.0.1:1', bootstrapUrl: 'http://127.0.0.1:1/b', close: async () => {} }) },
  ));
  await reusable.attach(fakeExecutor);
  await assert.rejects(() => reusable.attach(fakeExecutor), /already attached/);
});

// --------------------------------------------------------------------------
// Gate 5 — CLI wiring
// --------------------------------------------------------------------------

function cliHarness(repositoryEngineering?: PrivateGatewayConfig['repositoryEngineering']) {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((resolvePromise) => { resolveShutdown = resolvePromise; });
  const closed: string[] = [];
  const stdioOptions: Record<string, unknown>[] = [];

  const deps: CliDependencies = {
    env: { DEVSPACE_OAUTH_OWNER_TOKEN: 'owner-token-that-must-not-leak' },
    stdin: new PassThrough(),
    stdout,
    stderr,
    loadConfig: async () => config(repositoryEngineering),
    bootstrap: async () => ({
      gateway: {} as never,
      executor: fakeExecutor,
      health: { status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 6 },
      close: async () => { closed.push('runtime'); },
    }),
    startStdio: async (options) => {
      stdioOptions.push(options as unknown as Record<string, unknown>);
      return { close: async () => { closed.push('stdio'); } };
    },
    waitForShutdown: async () => shutdown,
    telemetry: { record() {} },
    startRepositoryEngineering: async (loaded) => {
      const runtime = await startRepositoryEngineeringRuntime(loaded, {
        startOperatorServer: async () => ({
          origin: 'http://127.0.0.1:65000',
          bootstrapUrl: 'http://127.0.0.1:65000/bootstrap?token=operator-secret',
          close: async () => {},
        }),
      });
      const close = runtime.close.bind(runtime);
      runtime.close = async () => { closed.push('engineering'); await close(); };
      return runtime;
    },
  };
  return { deps, stdout, stderr, closed, stdioOptions, requestShutdown: resolveShutdown };
}

test('serve-stdio forwards the resolved capability profile to the MCP surface', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = cliHarness({ inspect: true, mutation: { statePath: join(root, 'state.sqlite'), ownerId: 'local.private.stdio' } });

  const running = main(['serve-stdio', '--config', resolve('private.json')], h.deps);
  await until(() => h.stdioOptions.length > 0, 'the stdio surface to start');

  assert.equal(h.stdioOptions.length, 1);
  assert.equal(h.stdioOptions[0]!.inspect, true);
  assert.ok(h.stdioOptions[0]!.mutationContext, 'mutation opt-in must reach the stdio surface');

  h.requestShutdown();
  assert.equal(await running, 0);
  assert.deepEqual(h.closed, ['stdio', 'engineering', 'runtime'],
    'teardown must release the transport, then review state, then the privileged runtime');
});

test('operator bootstrap URL is local-only and never reaches the MCP transport', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-cli-operator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = cliHarness({ inspect: false, mutation: { statePath: join(root, 'state.sqlite'), ownerId: 'local.private.stdio' } });

  const running = main(['serve-stdio', '--config', resolve('private.json')], h.deps);
  await until(() => h.stderr.text().includes('gateway.operator'), 'the operator review server to start');

  assert.equal(h.stdout.text(), '', 'stdout carries MCP framing only');
  assert.match(h.stderr.text(), /"type":"gateway\.profile","inspect":false,"mutation":true/);
  assert.match(h.stderr.text(), /"type":"gateway\.operator"/);
  assert.match(h.stderr.text(), /"origin":"http:\/\/127\.0\.0\.1:65000"/);
  assert.match(h.stderr.text(), /"urlFile":/);
  assert.equal(h.stderr.text().includes('operator-secret'), false,
    'the single-use bootstrap token must not reach the inherited stderr pipe');
  assert.equal(h.stderr.text().includes('owner-token-that-must-not-leak'), false);

  // It is written beside the state database instead, and removed on shutdown.
  const urlFile = join(root, 'state.sqlite.operator-url');
  assert.match(await readFile(urlFile, 'utf8'), /operator-secret/);

  h.requestShutdown();
  assert.equal(await running, 0);
});

test('doctor stays silent for the shipped default profile and reports an opted-in one', async (t) => {
  const quiet = cliHarness();
  assert.equal(await main(['doctor', '--config', resolve('private.json')], quiet.deps), 0);
  assert.equal(JSON.parse(quiet.stdout.text()).status, 'ok');
  assert.equal(quiet.stderr.text(), '', 'the default profile must produce no diagnostics');
  assert.deepEqual(quiet.closed, ['engineering', 'runtime']);

  const root = await mkdtemp(join(tmpdir(), 'wag-dc-doctor-'));
  const track = scoped(t, root);
  const loud = cliHarness({ inspect: true });
  assert.equal(await main(['doctor', '--config', resolve('private.json')], loud.deps), 0);
  assert.equal(JSON.parse(loud.stdout.text()).status, 'ok');
  assert.match(loud.stderr.text(), /"type":"gateway\.profile","inspect":true,"mutation":false/);
  assert.equal(loud.stderr.text().includes('gateway.operator'), false);

  // doctor is a preflight: it reports the profile without binding the operator review port.
  let operatorStarts = 0;
  const mutating = cliHarness({ inspect: true, mutation: { statePath: join(root, 'doctor.sqlite'), ownerId: 'local.private.stdio' } });
  mutating.deps.startRepositoryEngineering = async (loaded) => track(await startRepositoryEngineeringRuntime(loaded, {
    startOperatorServer: async () => { operatorStarts += 1; throw new Error('doctor must not bind the operator port'); },
  }));
  assert.equal(await main(['doctor', '--config', resolve('private.json')], mutating.deps), 0);
  assert.equal(operatorStarts, 0);
  assert.match(mutating.stderr.text(), /"type":"gateway\.profile","inspect":true,"mutation":true/);
  assert.equal(mutating.stderr.text().includes('gateway.operator'), false);
});

test('a repository engineering failure fails closed without starting the stdio surface', async () => {
  const h = cliHarness();
  h.deps.startRepositoryEngineering = async () => { throw new Error('state path unusable'); };
  assert.equal(await main(['serve-stdio', '--config', resolve('private.json')], h.deps), 1);
  assert.match(h.stderr.text(), /"code":"REPOSITORY_ENGINEERING_START_FAILED"/);
  assert.equal(h.stderr.text().includes('state path unusable'), false);
  assert.equal(h.stdioOptions.length, 0);
  assert.deepEqual(h.closed, []);
});

test('an attach failure closes the privileged runtime and never serves the surface', async () => {
  const h = cliHarness();
  const closed = h.closed;
  h.deps.startRepositoryEngineering = async () => ({
    profile: { inspect: true, mutation: true },
    openWorkspaceId: () => 'ws_stub',
    attach: async () => { throw new Error('reconcile failed'); },
    close: async () => { closed.push('engineering'); },
  });
  assert.equal(await main(['serve-stdio', '--config', resolve('private.json')], h.deps), 1);
  assert.match(h.stderr.text(), /"code":"REPOSITORY_ENGINEERING_START_FAILED"/);
  assert.equal(h.stdioOptions.length, 0);
  assert.deepEqual(h.closed, ['engineering', 'runtime']);
});
