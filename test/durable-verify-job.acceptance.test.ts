import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableVerifyJobCoordinator } from '../src/durable-verify-job.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DevspaceVerifyExecutionPort } from '../src/executor/devspace-verify.js';
import { DevspaceExecutor, type ExecResult } from '../src/executor/devspace.js';
import { resolveVerifyProfile } from '../src/verify-profile.js';
import { startPinnedDevspace } from './devspace-fixture.js';

class FakeDevspaceVerifyExecutor {
  result: ExecResult = { output: 'failed check', exitCode: 1, running: false };
  opened: string[] = [];
  execCalls: Array<{ workspaceId: string; command: string; maxOutputTokens: number; timeoutMs: number }> = [];
  interrupts: Array<{ workspaceId: string; sessionId: number; maxOutputTokens: number }> = [];

  async openWorkspace(root: string) {
    this.opened.push(root);
    return 'devspace-ws';
  }

  async execCommand(workspaceId: string, command: string, maxOutputTokens: number, timeoutMs: number) {
    this.execCalls.push({ workspaceId, command, maxOutputTokens, timeoutMs });
    return this.result;
  }

  async interruptCommand(workspaceId: string, sessionId: number, maxOutputTokens: number) {
    this.interrupts.push({ workspaceId, sessionId, maxOutputTokens });
  }
}

test('DevSpace verify adapter returns exact completed evidence for the resolved profile', async () => {
  const executor = new FakeDevspaceVerifyExecutor();
  const port = new DevspaceVerifyExecutionPort(executor);
  const profile = resolveVerifyProfile({
    argv: ['node', 'verify.mjs'], timeoutMs: 1_234, maxOutputTokens: 567,
  });
  const evidence = await port.execute('E:/fixture', profile);
  assert.deepEqual(evidence, { status: 'completed', exitCode: 1, output: 'failed check' });
  assert.deepEqual(executor.opened, ['E:/fixture']);
  assert.deepEqual(executor.execCalls, [{
    workspaceId: 'devspace-ws', command: profile.command,
    maxOutputTokens: 567, timeoutMs: 1_234,
  }]);
  assert.deepEqual(executor.interrupts, []);
});
test('DevSpace verify adapter interrupts only the exact running session and remains unconfirmed', async () => {
  const executor = new FakeDevspaceVerifyExecutor();
  executor.result = { output: 'partial', running: true, sessionId: 42 };
  const port = new DevspaceVerifyExecutionPort(executor);
  const profile = resolveVerifyProfile({
    argv: ['node', 'slow.mjs'], timeoutMs: 100, maxOutputTokens: 500,
  });
  const evidence = await port.execute('E:/fixture', profile);
  assert.deepEqual(evidence, { status: 'unconfirmed', errorClass: 'EXECUTION_TIMEOUT_UNCONFIRMED' });
  assert.deepEqual(executor.interrupts, [{
    workspaceId: 'devspace-ws', sessionId: 42, maxOutputTokens: 500,
  }]);
});

test('exact pinned DevSpace durable verify survives SQLite reopen with redacted persisted evidence', async (t) => {
  const previousSecret = process.env.WAG_TEST_SECRET;
  process.env.WAG_TEST_SECRET = 'sentinel-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.WAG_TEST_SECRET;
    else process.env.WAG_TEST_SECRET = previousSecret;
  });
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'env.mjs'), [
    "console.log(process.env.WAG_TEST_SECRET ?? 'absent')",
    "console.log(process.env.DEVSPACE_OAUTH_OWNER_TOKEN ?? 'absent')",
  ].join('\n'));

  const stateDir = await mkdtemp(join(tmpdir(), 'wag-durable-verify-acceptance-'));
  const dbPath = join(stateDir, 'state.sqlite');
  const caller = createGatewayCallerContext({
    ownerId: 'owner-a', sessionId: 'session-a', adapterId: 'adapter-a',
  });
  const profiles = { env: { argv: ['node', 'env.mjs'] } } as const;
  const port = new DevspaceVerifyExecutionPort(new DevspaceExecutor(fixture));
  let store = new SqliteDurableStore(dbPath);
  t.after(async () => { store.close(); await rm(stateDir, { recursive: true, force: true }); });
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: fixture.workspaceRoot, backendKind: port.kind, createdAt: 1_000,
  });
  let coordinator = new DurableVerifyJobCoordinator({
    store, profiles: () => profiles, ports: [port], now: () => 2_000,
  });
  const job = coordinator.enqueue(caller, workspace.workspaceId, 'env');
  await coordinator.dispatch(job.jobId);
  const first = coordinator.result(caller, job.jobId);
  assert.equal(first.state, 'SUCCEEDED');
  assert.equal(first.exitCode, 0);
  assert.equal(first.output?.replace(/\r/g, ''), 'absent\nabsent');
  assert.equal(first.outputTruncated, false);
  assert.doesNotMatch(JSON.stringify(first), /sessionId|devspaceWorkspaceId|sentinel-secret/);

  const firstEvents = store.listVerifyJobEvents(job.jobId);
  const serializedEvents = JSON.stringify(firstEvents);
  assert.doesNotMatch(serializedEvents, /sentinel-secret|env\.mjs|DEVSPACE_OAUTH_OWNER_TOKEN/);
  assert.ok(!serializedEvents.includes(fixture.workspaceRoot));
  store.close();

  store = new SqliteDurableStore(dbPath);
  coordinator = new DurableVerifyJobCoordinator({
    store, profiles: () => profiles, ports: [port], now: () => 3_000,
  });
  const reopened = coordinator.result(caller, job.jobId);
  assert.equal(reopened.jobId, job.jobId);
  assert.equal(reopened.state, 'SUCCEEDED');
  assert.equal(reopened.exitCode, 0);
  assert.equal(reopened.output?.replace(/\r/g, ''), 'absent\nabsent');
  assert.deepEqual(
    store.listVerifyJobEvents(job.jobId).map((event) => event.toState),
    ['QUEUED', 'EXECUTING', 'SUCCEEDED'],
  );
});
