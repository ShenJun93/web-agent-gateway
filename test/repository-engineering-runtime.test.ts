import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { adapterCorrelationDigest } from '../src/adapter-admission.js';
import { main, type CliDependencies } from '../src/cli.js';
import { SqliteDurableStore } from '../src/durable-store.js';
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

  assert.deepEqual(runtime.profile, { inspect: false, mutation: false, gitCommit: false });
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
  assert.deepEqual(runtime.profile, { inspect: true, mutation: false, gitCommit: false });
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

  assert.deepEqual(first.profile, { inspect: true, mutation: true, gitCommit: false });
  assert.ok(first.openWorkspaceId, 'mutation previews resolve workspaces from the store');
  const workspaceId = first.openWorkspaceId!(process.cwd());
  assert.match(workspaceId, /^ws_/);

  await first.attach(fakeExecutor);
  assert.ok(first.mutationContext);
  assert.equal(first.mutationContext!.leaseOnly, true,
    'direct stdio mutations must be Goal-Lease-only, with no per-change operator fallback');
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
  assert.ok(h.stdioOptions[0]!.machineContext,
    'mutation opt-in must also wire the Goal-Lease local-machine backend to stdio');

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
    profile: { inspect: true, mutation: true, gitCommit: false },
    openWorkspaceId: () => 'ws_stub',
    attach: async () => { throw new Error('reconcile failed'); },
    close: async () => { closed.push('engineering'); },
  });
  assert.equal(await main(['serve-stdio', '--config', resolve('private.json')], h.deps), 1);
  assert.match(h.stderr.text(), /"code":"REPOSITORY_ENGINEERING_START_FAILED"/);
  assert.equal(h.stdioOptions.length, 0);
  assert.deepEqual(h.closed, ['engineering', 'runtime']);
});
test('stdio git commit inherits the configured mutation review TTL', async () => {
  const statePath = join(
    process.cwd(),
    `.wag-runtime-ttl-${process.pid}-${Date.now()}.sqlite`,
  );

  const runtime = await startRepositoryEngineeringRuntime(
    config({
      inspect: true,
      mutation: {
        statePath,
        ownerId: 'local.private.stdio',
        reviewTtlMs: 300_000,
      },
      gitCommit: {},
    }),
    {
      startOperatorServer: async () => ({
        origin: 'http://127.0.0.1:1',
        bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=x',
        close: async () => {},
      }),
    },
  );

  try {
    await runtime.attach(fakeExecutor);

    assert.ok(runtime.gitCommitContext, 'git commit must be enabled after attach');
    assert.equal(runtime.gitCommitContext!.leaseOnly, true,
      'direct stdio commits must be Goal-Lease-only, with no per-change operator fallback');

    const coordinator = runtime.gitCommitContext!.coordinator as unknown as {
      reviewTtlMs: number;
    };

    assert.equal(
      coordinator.reviewTtlMs,
      300_000,
      'stdio commit review must inherit mutation.reviewTtlMs',
    );
  } finally {
    await runtime.close();
    await rm(statePath, { force: true });
    await rm(`${statePath}.operator-url`, { force: true });
  }
});

test('command authority requires a Goal Lease and stays bound to its exact workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-command-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerId = 'local.private.stdio';
  const operator = async () => ({
    origin: 'http://127.0.0.1:1',
    bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=x',
    close: async () => {},
  });

  const noLease = await startRepositoryEngineeringRuntime(
    config({
      inspect: true,
      mutation: { statePath: join(root, 'no-lease.sqlite'), ownerId },
      gitCommit: {},
    }),
    { startOperatorServer: operator },
  );
  try {
    const workspace = noLease.openWorkspaceId!(await realpath(root));
    await noLease.attach(fakeExecutor);
    assert.ok(noLease.commandContext, 'full profile publishes command.run independently of current lease matches');
    await assert.rejects(
      async () => noLease.commandContext!.authorize(workspace),
      /NO_LEASE/,
      'publishing command.run must not grant authority when no durable lease matches',
    );
  } finally {
    await noLease.close();
  }

  const statePath = join(root, 'leased.sqlite');
  const correlation = 'session_11111111-2222-3333-4444-555555555555';
  const leaseId = 'lease_command_runtime';
  const workspaceRoot = await realpath(root);
  const now = Date.now();
  const store = new SqliteDurableStore(statePath);
  try {
    const session = store.getOrCreateAdapterSession({
      ownerId,
      adapterId: PRIVATE_STDIO_ADAPTER_ID,
      correlationSha256: adapterCorrelationDigest(ownerId, PRIVATE_STDIO_ADAPTER_ID, correlation),
      createdAt: now,
    });
    store.insertGoalLease({
      leaseId,
      createdAt: now,
      notBefore: now - 1_000,
      expiresAt: now + 60_000,
      bindings: JSON.stringify({
        workspaceRoots: [workspaceRoot],
        allowedTools: ['command.run'],
        pathPatterns: ['src/**'],
        maxFiles: 1,
        maxBytes: 1,
        maxDiffBytes: 1,
        admittedSessions: [session.sessionId],
        admittedAdapters: [PRIVATE_STDIO_ADAPTER_ID],
        commitSemantics: 'none',
      }),
    });
  } finally {
    store.close();
  }

  const leased = await startRepositoryEngineeringRuntime(
    config({
      inspect: true,
      mutation: {
        statePath,
        ownerId,
        sessionCorrelation: correlation,
      },
      gitCommit: {},
    }),
    { startOperatorServer: operator },
  );
  try {
    const grantedWorkspace = leased.openWorkspaceId!(workspaceRoot);
    const otherWorkspace = leased.openWorkspaceId!(join(workspaceRoot, 'other'));
    await leased.attach(fakeExecutor);

    assert.ok(leased.commandContext, 'a full profile resolves command authority without a configured lease selector');
    await leased.commandContext!.authorize(grantedWorkspace);
    await assert.rejects(
      async () => leased.commandContext!.authorize(otherWorkspace),
      /NO_LEASE/,
      'opening another trusted workspace must produce zero matching leases',
    );
  } finally {
    await leased.close();
  }
});

test('a running direct runtime observes issue, ambiguity and revoke without restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-live-lease-resolution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerId = 'local.private.stdio';
  const correlation = 'session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const statePath = join(root, 'state.sqlite');
  const workspaceRoot = await realpath(root);
  const operator = async () => ({
    origin: 'http://127.0.0.1:1',
    bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=x',
    close: async () => {},
  });

  const runtime = await startRepositoryEngineeringRuntime(
    config({
      inspect: true,
      mutation: { statePath, ownerId, sessionCorrelation: correlation },
      gitCommit: {},
    }),
    { startOperatorServer: operator },
  );
  try {
    const workspaceId = runtime.openWorkspaceId!(workspaceRoot);
    await runtime.attach(fakeExecutor);
    assert.ok(runtime.commandContext);
    assert.ok(runtime.capabilityContext);

    await assert.rejects(async () => runtime.commandContext!.authorize(workspaceId), /NO_LEASE/);

    const noLeaseAuthority = await runtime.capabilityContext!.describe(workspaceId) as {
      capabilities: {
        FILE_WRITE: { granted: boolean; denied: boolean; requires_human: boolean; reason: string };
        GIT_COMMIT: { granted: boolean; denied: boolean; requires_human: boolean; reason: string };
      };
    };
    for (const capability of [
      noLeaseAuthority.capabilities.FILE_WRITE,
      noLeaseAuthority.capabilities.GIT_COMMIT,
    ]) {
      assert.equal(capability.granted, false);
      assert.equal(capability.denied, true);
      assert.equal(capability.requires_human, false,
        'direct stdio has no per-change human-review fallback');
      assert.equal(capability.reason, 'GOAL_LEASE_REQUIRED');
    }

    const sessionId = runtime.profile.stableSessionId!;
    const bindings = {
      workspaceRoots: [workspaceRoot],
      allowedTools: ['command.run'],
      pathPatterns: ['**'],
      maxFiles: 4,
      maxBytes: 10_000,
      maxDiffBytes: 4_000,
      admittedSessions: [sessionId],
      admittedAdapters: [PRIVATE_STDIO_ADAPTER_ID],
      commitSemantics: 'none' as const,
    };
    const now = Date.now();
    const store = new SqliteDurableStore(statePath);
    try {
      store.insertGoalLease({
        leaseId: 'lease_runtime_dynamic_a',
        createdAt: now,
        notBefore: now - 1_000,
        expiresAt: now + 60_000,
        bindings: JSON.stringify(bindings),
      });

      await runtime.commandContext!.authorize(workspaceId);

      const authority = await runtime.capabilityContext!.describe(workspaceId) as {
        capabilities: { GIT_PUSH: { granted: boolean; denied: boolean; grantable: boolean } };
      };
      assert.deepEqual(authority.capabilities.GIT_PUSH, {
        granted: false,
        denied: true,
        grantable: false,
        requires_human: true,
        reason: 'REMOTE_EFFECT_NOT_GRANTED',
      });

      store.insertGoalLease({
        leaseId: 'lease_runtime_dynamic_duplicate',
        createdAt: now + 1,
        notBefore: now - 1_000,
        expiresAt: now + 60_000,
        bindings: JSON.stringify(bindings),
      });
      await assert.rejects(async () => runtime.commandContext!.authorize(workspaceId), /AMBIGUOUS_LEASE/);

      assert.equal(store.revokeGoalLease('lease_runtime_dynamic_duplicate', now + 2), true);
      await runtime.commandContext!.authorize(workspaceId);

      assert.equal(store.revokeGoalLease('lease_runtime_dynamic_a', now + 3), true);
      await assert.rejects(async () => runtime.commandContext!.authorize(workspaceId), /NO_LEASE/);
    } finally {
      store.close();
    }
  } finally {
    await runtime.close();
  }
});
