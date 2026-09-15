import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableVerifyJobCoordinator } from '../src/durable-verify-job.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { VerifyExecutionEvidence, VerifyExecutionPort } from '../src/verify-execution-port.js';
import { resolveVerifyProfile, type VerifyProfile } from '../src/verify-profile.js';

const caller = createGatewayCallerContext({
  ownerId: 'owner-a', sessionId: 'session-a', adapterId: 'adapter-a',
});

class FakePort implements VerifyExecutionPort {
  readonly kind = 'fake';
  calls = 0;
  evidence: VerifyExecutionEvidence = { status: 'completed', exitCode: 0, output: 'ok' };
  throwOnExecute = false;
  async execute() {
    this.calls += 1;
    if (this.throwOnExecute) throw new Error('backend failed');
    return this.evidence;
  }
}
async function setup(t: test.TestContext, nowRef = { value: 1_000 }) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-durable-verify-job-'));
  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: dir, backendKind: 'fake', createdAt: nowRef.value,
  });
  let profiles: Readonly<Record<string, VerifyProfile>> = {
    test: { argv: ['node', 'verify.mjs'] },
  };
  const port = new FakePort();
  const coordinator = new DurableVerifyJobCoordinator({
    store, profiles: () => profiles, ports: [port], now: () => nowRef.value,
  });
  return {
    dir, store, workspace, port, coordinator, nowRef,
    setProfiles(value: Readonly<Record<string, VerifyProfile>>) { profiles = value; },
  };
}
test('enqueue persists exact caller authority and fixed dispatch deadline', async (t) => {
  const { store, workspace, coordinator } = await setup(t);
  const view = coordinator.enqueue(caller, workspace.workspaceId, 'test');
  assert.match(view.jobId, /^job_/);
  assert.equal(view.state, 'QUEUED');
  assert.equal(view.createdAt, 1_000);
  assert.equal(view.dispatchDeadline, 301_000);
  const record = store.getVerifyJob(view.jobId)!;
  assert.equal(record.ownerId, caller.ownerId);
  assert.equal(record.sessionId, caller.sessionId);
  assert.equal(record.adapterId, caller.adapterId);
  assert.equal(record.workspaceId, workspace.workspaceId);
  assert.equal(record.dispatchDeadline, 301_000);
});

test('enqueue rejects every caller authority mismatch', async (t) => {
  const { workspace, coordinator } = await setup(t);
  for (const denied of [
    createGatewayCallerContext({ ...caller, ownerId: 'owner-b' }),
    createGatewayCallerContext({ ...caller, sessionId: 'session-b' }),
    createGatewayCallerContext({ ...caller, adapterId: 'adapter-b' }),
  ]) assert.throws(() => coordinator.enqueue(denied, workspace.workspaceId, 'test'), /Gateway denied verify workspace/);
});
test('result uses one denial for unknown and wrong-owner job ids', async (t) => {
  const { workspace, coordinator } = await setup(t);
  const created = coordinator.enqueue(caller, workspace.workspaceId, 'test');
  const wrongOwner = createGatewayCallerContext({ ...caller, ownerId: 'owner-b' });
  for (const read of [
    () => coordinator.result(wrongOwner, created.jobId),
    () => coordinator.result(caller, 'job_missing'),
  ]) {
    assert.throws(read, (error: unknown) =>
      error instanceof Error && error.message === 'Gateway denied verify job');
  }
  assert.equal(coordinator.result(caller, created.jobId).jobId, created.jobId);
});

test('dispatch claims once and persists non-zero completed execution as success', async (t) => {
  const { workspace, coordinator, port } = await setup(t);
  port.evidence = { status: 'completed', exitCode: 7, output: 'failed check' };
  const job = coordinator.enqueue(caller, workspace.workspaceId, 'test');
  await Promise.all([coordinator.dispatch(job.jobId), coordinator.dispatch(job.jobId)]);
  assert.equal(port.calls, 1);
  assert.deepEqual(coordinator.result(caller, job.jobId), {
    ...job, state: 'SUCCEEDED', completedAt: 1_000,
    exitCode: 7, output: 'failed check', outputTruncated: false,
  });
  await coordinator.dispatch(job.jobId);
  assert.equal(port.calls, 1, 'terminal job must never execute again');
});

test('initial dispatch fails queued work before the port on deadline or profile drift', async (t) => {
  const { workspace, coordinator, port, nowRef, setProfiles } = await setup(t);
  const expired = coordinator.enqueue(caller, workspace.workspaceId, 'test');
  nowRef.value = expired.dispatchDeadline;
  await coordinator.dispatch(expired.jobId);
  assert.equal(coordinator.result(caller, expired.jobId).errorClass, 'DISPATCH_DEADLINE_EXPIRED');
  assert.equal(port.calls, 0);
  nowRef.value = 10_000;
  setProfiles({ test: { argv: ['node', 'verify.mjs'] } });
  const drifted = coordinator.enqueue(caller, workspace.workspaceId, 'test');
  setProfiles({ test: { argv: ['node', 'changed.mjs'] } });
  await coordinator.dispatch(drifted.jobId);
  assert.equal(coordinator.result(caller, drifted.jobId).errorClass, 'PROFILE_PLAN_DRIFT');
  assert.equal(port.calls, 0);
});

test('reconcile resumes only unchanged queued profiles with explicit restart opt-in', async (t) => {
  const { workspace, coordinator, port, setProfiles } = await setup(t);
  setProfiles({ test: { argv: ['node', 'verify.mjs'], resumeQueuedAfterRestart: true } });
  const resumed = coordinator.enqueue(caller, workspace.workspaceId, 'test');
  await coordinator.reconcile();
  assert.equal(port.calls, 1);
  assert.equal(coordinator.result(caller, resumed.jobId).state, 'SUCCEEDED');

  const { workspace: ws2, coordinator: c2, port: p2 } = await setup(t);
  const disabled = c2.enqueue(caller, ws2.workspaceId, 'test');
  await c2.reconcile();
  assert.equal(p2.calls, 0);
  assert.equal(c2.result(caller, disabled.jobId).errorClass, 'RESTART_RESUME_DISABLED');
});
test('reconcile fails queued work before execution on missing/drifted profile or ownership drift', async (t) => {
  const a = await setup(t);
  a.setProfiles({ test: { argv: ['node', 'verify.mjs'], resumeQueuedAfterRestart: true } });
  const missing = a.coordinator.enqueue(caller, a.workspace.workspaceId, 'test');
  a.setProfiles({});
  await a.coordinator.reconcile();
  assert.equal(a.coordinator.result(caller, missing.jobId).errorClass, 'PROFILE_MISSING');
  assert.equal(a.port.calls, 0);

  const b = await setup(t);
  b.setProfiles({ test: { argv: ['node', 'verify.mjs'], resumeQueuedAfterRestart: true } });
  const drifted = b.coordinator.enqueue(caller, b.workspace.workspaceId, 'test');
  b.setProfiles({ test: { argv: ['node', 'changed.mjs'], resumeQueuedAfterRestart: true } });
  await b.coordinator.reconcile();
  assert.equal(b.coordinator.result(caller, drifted.jobId).errorClass, 'PROFILE_PLAN_DRIFT');
  assert.equal(b.port.calls, 0);
  const c = await setup(t);
  const resumeProfile = { argv: ['node', 'verify.mjs'], resumeQueuedAfterRestart: true } as const;
  c.setProfiles({ test: resumeProfile });
  const resolved = resolveVerifyProfile(resumeProfile);
  const foreign = c.store.createVerifyJob({
    ...caller, ownerId: 'owner-b', workspaceId: c.workspace.workspaceId,
    backendKind: 'fake', profileName: 'test', planSha256: resolved.planSha256,
    createdAt: 1_000, dispatchDeadline: 301_000,
  });
  await c.coordinator.reconcile();
  assert.equal(c.store.getVerifyJob(foreign.jobId)?.errorClass, 'WORKSPACE_OWNERSHIP_MISMATCH');
  assert.equal(c.port.calls, 0);
});
test('reconcile marks recovered executing work unknown without replay', async (t) => {
  const { store, workspace, coordinator, port } = await setup(t);
  const job = coordinator.enqueue(caller, workspace.workspaceId, 'test');
  assert.ok(store.claimVerifyJob(job.jobId, 1_100, 'attempt-before-restart'));
  await coordinator.reconcile();
  assert.equal(port.calls, 0);
  assert.equal(coordinator.result(caller, job.jobId).state, 'OUTCOME_UNKNOWN');
  assert.equal(coordinator.result(caller, job.jobId).errorClass, 'RESTART_EXECUTION_UNVERIFIABLE');
});

test('unconfirmed and thrown post-claim execution become distinct unknown outcomes', async (t) => {
  const a = await setup(t);
  a.port.evidence = { status: 'unconfirmed', errorClass: 'EXECUTION_TIMEOUT_UNCONFIRMED' };
  const timedOut = a.coordinator.enqueue(caller, a.workspace.workspaceId, 'test');
  await a.coordinator.dispatch(timedOut.jobId);
  assert.equal(a.coordinator.result(caller, timedOut.jobId).errorClass, 'EXECUTION_TIMEOUT_UNCONFIRMED');

  const b = await setup(t);
  b.port.throwOnExecute = true;
  const thrown = b.coordinator.enqueue(caller, b.workspace.workspaceId, 'test');
  await b.coordinator.dispatch(thrown.jobId);
  assert.equal(b.coordinator.result(caller, thrown.jobId).errorClass, 'EXECUTION_PORT_ERROR_UNCONFIRMED');
});
test('completed output is bounded to 64 KiB without splitting a UTF-8 code point', async (t) => {
  const { workspace, coordinator, port } = await setup(t);
  const exact = 'a'.repeat(65_534) + 'é';
  assert.equal(Buffer.byteLength(exact, 'utf8'), 65_536);
  port.evidence = { status: 'completed', exitCode: 0, output: exact };
  const exactJob = coordinator.enqueue(caller, workspace.workspaceId, 'test');
  await coordinator.dispatch(exactJob.jobId);
  const exactResult = coordinator.result(caller, exactJob.jobId);
  assert.equal(Buffer.byteLength(exactResult.output ?? '', 'utf8'), 65_536);
  assert.equal(exactResult.outputTruncated, false);

  const over = 'a'.repeat(65_535) + 'é';
  port.evidence = { status: 'completed', exitCode: 0, output: over };
  const overJob = coordinator.enqueue(caller, workspace.workspaceId, 'test');
  await coordinator.dispatch(overJob.jobId);
  const overResult = coordinator.result(caller, overJob.jobId);
  assert.equal(overResult.outputTruncated, true);
  assert.equal(Buffer.byteLength(overResult.output ?? '', 'utf8'), 65_535);
  assert.equal(overResult.output, 'a'.repeat(65_535));
});
