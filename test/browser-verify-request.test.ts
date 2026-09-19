import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { BrowserVerifyRequestCoordinator } from '../src/browser-verify-request.js';
import { DurableVerifyJobCoordinator } from '../src/durable-verify-job.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { VerifyExecutionEvidence, VerifyExecutionPort } from '../src/verify-execution-port.js';
import type { VerifyProfile } from '../src/verify-profile.js';

const caller = createGatewayCallerContext({
  ownerId: 'owner-browser',
  sessionId: 'session-browser',
  adapterId: 'browser.chatgpt.native.verify.v3',
});

class FakePort implements VerifyExecutionPort {
  readonly kind = 'fake';
  calls = 0;
  evidence: VerifyExecutionEvidence = { status: 'completed', exitCode: 1, output: 'two tests; one pass; one fail' };
  async execute() {
    this.calls += 1;
    return this.evidence;
  }
}

async function setup(t: test.TestContext, nowRef = { value: 1_000 }) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-browser-verify-'));
  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: dir, backendKind: 'fake', createdAt: nowRef.value,
  });
  let profiles: Readonly<Record<string, VerifyProfile>> = {
    unit: { argv: ['node', 'verify.mjs'] },
    other: { argv: ['node', 'other.mjs'] },
  };
  let browserProfiles: readonly string[] = ['unit'];
  const port = new FakePort();
  const jobs = new DurableVerifyJobCoordinator({
    store, profiles: () => profiles, ports: [port], now: () => nowRef.value,
  });
  const coordinator = new BrowserVerifyRequestCoordinator({
    store,
    profiles: () => profiles,
    browserProfiles: () => browserProfiles,
    jobs,
    now: () => nowRef.value,
  });
  return {
    dir, store, workspace, port, jobs, coordinator, nowRef,
    setProfiles(value: Readonly<Record<string, VerifyProfile>>) { profiles = value; },
    setBrowserProfiles(value: readonly string[]) { browserProfiles = value; },
  };
}

test('preview persists only a bounded caller-owned request and performs zero execution', async (t) => {
  const { store, workspace, port, coordinator } = await setup(t);
  const preview = coordinator.preview(caller, workspace.workspaceId, 'unit');
  assert.equal(preview.status, 'approval_required');
  assert.match(preview.request_id, /^verifyreq_/);
  assert.equal(preview.profile, 'unit');
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(preview.expires_at, 61_000);
  assert.equal(port.calls, 0);
  assert.deepEqual(store.listRecoverableVerifyJobs(), []);

  const record = store.getBrowserVerifyRequest(preview.request_id)!;
  assert.equal(record.ownerId, caller.ownerId);
  assert.equal(record.sessionId, caller.sessionId);
  assert.equal(record.adapterId, caller.adapterId);
  assert.equal(record.workspaceId, workspace.workspaceId);
  assert.equal(record.state, 'PENDING_APPROVAL');
  assert.equal(record.linkedJobId, undefined);
  assert.equal(record.reviewDeadline, 61_000);
  assert.doesNotMatch(JSON.stringify(coordinator.result(caller, preview.request_id)), /job_/);
});

test('preview rejects foreign workspaces, non-allowlisted profiles, restart-resumable profiles, and live duplicates', async (t) => {
  const a = await setup(t);
  const foreign = createGatewayCallerContext({ ...caller, sessionId: 'session-foreign' });
  assert.throws(() => a.coordinator.preview(foreign, a.workspace.workspaceId, 'unit'), /Gateway denied verify request/);
  assert.throws(() => a.coordinator.preview(caller, a.workspace.workspaceId, 'other'), /Gateway denied verify profile/);

  a.setProfiles({ unit: { argv: ['node', 'verify.mjs'], resumeQueuedAfterRestart: true } });
  assert.throws(() => a.coordinator.preview(caller, a.workspace.workspaceId, 'unit'), /Gateway denied verify profile/);

  a.setProfiles({ unit: { argv: ['node', 'verify.mjs'] } });
  a.coordinator.preview(caller, a.workspace.workspaceId, 'unit');
  assert.throws(() => a.coordinator.preview(caller, a.workspace.workspaceId, 'unit'), /Gateway denied verify request/);
  assert.equal(a.port.calls, 0);
});

test('unknown and foreign request ids share the same bounded denial', async (t) => {
  const { workspace, coordinator } = await setup(t);
  const preview = coordinator.preview(caller, workspace.workspaceId, 'unit');
  const foreign = createGatewayCallerContext({ ...caller, ownerId: 'owner-foreign' });
  for (const read of [
    () => coordinator.result(foreign, preview.request_id),
    () => coordinator.result(caller, 'verifyreq_missing'),
  ]) {
    assert.throws(read, (error: unknown) =>
      error instanceof Error && error.message === 'Gateway denied verify request');
  }
});

test('reject and expiry are terminal and create no verify job', async (t) => {
  const a = await setup(t);
  const rejected = a.coordinator.preview(caller, a.workspace.workspaceId, 'unit');
  assert.equal(a.coordinator.rejectLocal(rejected.request_id), true);
  assert.equal(a.coordinator.rejectLocal(rejected.request_id), false);
  assert.equal(a.coordinator.result(caller, rejected.request_id).state, 'REJECTED');
  assert.equal(a.port.calls, 0);
  assert.deepEqual(a.store.listRecoverableVerifyJobs(), []);

  const b = await setup(t);
  const expired = b.coordinator.preview(caller, b.workspace.workspaceId, 'unit');
  b.nowRef.value = expired.expires_at;
  assert.equal(await b.coordinator.approveLocal(expired.request_id), false);
  assert.equal(b.coordinator.result(caller, expired.request_id).state, 'EXPIRED');
  assert.equal(b.port.calls, 0);
  assert.deepEqual(b.store.listRecoverableVerifyJobs(), []);
});

test('local approval atomically creates one internal job and dispatches exactly once', async (t) => {
  const { store, workspace, port, coordinator } = await setup(t);
  const preview = coordinator.preview(caller, workspace.workspaceId, 'unit');
  const approvals = await Promise.all([
    coordinator.approveLocal(preview.request_id),
    coordinator.approveLocal(preview.request_id),
  ]);
  assert.deepEqual(approvals.sort(), [false, true]);
  assert.equal(port.calls, 1);

  const request = store.getBrowserVerifyRequest(preview.request_id)!;
  assert.equal(request.state, 'DISPATCHED');
  assert.match(request.linkedJobId ?? '', /^job_/);
  const events = store.listVerifyJobEvents(request.linkedJobId!);
  assert.deepEqual(events.map((event) => event.toState), ['QUEUED', 'EXECUTING', 'SUCCEEDED']);

  const result = coordinator.result(caller, preview.request_id);
  assert.equal(result.state, 'SUCCEEDED');
  assert.equal(result.exit_code, 1);
  assert.equal(result.output, 'two tests; one pass; one fail');
  assert.equal(result.output_truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /job_/);
  assert.equal(await coordinator.approveLocal(preview.request_id), false);
  assert.equal(port.calls, 1);
});

test('approval fails closed on allowlist, profile-plan, and restart-policy drift', async (t) => {
  const a = await setup(t);
  const allowlist = a.coordinator.preview(caller, a.workspace.workspaceId, 'unit');
  a.setBrowserProfiles([]);
  assert.equal(await a.coordinator.approveLocal(allowlist.request_id), false);
  assert.equal(a.coordinator.result(caller, allowlist.request_id).state, 'INVALIDATED');
  assert.equal(a.coordinator.result(caller, allowlist.request_id).error_class, 'PROFILE_NOT_ALLOWED');
  assert.equal(a.port.calls, 0);

  const b = await setup(t);
  const plan = b.coordinator.preview(caller, b.workspace.workspaceId, 'unit');
  b.setProfiles({ unit: { argv: ['node', 'changed.mjs'] } });
  assert.equal(await b.coordinator.approveLocal(plan.request_id), false);
  assert.equal(b.coordinator.result(caller, plan.request_id).error_class, 'PROFILE_PLAN_DRIFT');
  assert.equal(b.port.calls, 0);

  const c = await setup(t);
  const restart = c.coordinator.preview(caller, c.workspace.workspaceId, 'unit');
  c.setProfiles({ unit: { argv: ['node', 'verify.mjs'], resumeQueuedAfterRestart: true } });
  assert.equal(await c.coordinator.approveLocal(restart.request_id), false);
  assert.equal(c.coordinator.result(caller, restart.request_id).error_class, 'RESTART_RESUME_NOT_ALLOWED');
  assert.equal(c.port.calls, 0);
});

test('queued browser-approved job recovered before claim fails closed without execution', async (t) => {
  const { store, workspace, jobs, port, coordinator } = await setup(t);
  const preview = coordinator.preview(caller, workspace.workspaceId, 'unit');
  const record = store.getBrowserVerifyRequest(preview.request_id)!;
  const approved = store.approveBrowserVerifyRequestAndCreateJob({
    requestId: record.requestId,
    now: 2_000,
    dispatchDeadline: 302_000,
    currentPlanSha256: record.planSha256,
  });
  assert.ok(approved);
  assert.equal(approved.job.state, 'QUEUED');
  assert.equal(port.calls, 0);

  await jobs.reconcile();
  assert.equal(port.calls, 0);
  const job = store.getVerifyJob(approved.job.jobId)!;
  assert.equal(job.state, 'FAILED');
  assert.equal(job.errorClass, 'RESTART_RESUME_DISABLED');
  assert.equal(coordinator.result(caller, preview.request_id).state, 'FAILED');
});

test('pending request survives store reopen without refreshing its deadline', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-browser-verify-reopen-'));
  const statePath = join(dir, 'state.sqlite');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  let store = new SqliteDurableStore(statePath);
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: dir, backendKind: 'fake', createdAt: 1_000,
  });
  const port = new FakePort();
  const profiles = { unit: { argv: ['node', 'verify.mjs'] } } satisfies Record<string, VerifyProfile>;
  let jobs = new DurableVerifyJobCoordinator({ store, profiles: () => profiles, ports: [port], now: () => 1_000 });
  let coordinator = new BrowserVerifyRequestCoordinator({
    store, profiles: () => profiles, browserProfiles: () => ['unit'], jobs, now: () => 1_000,
  });
  const preview = coordinator.preview(caller, workspace.workspaceId, 'unit');
  store.close();

  store = new SqliteDurableStore(statePath);
  jobs = new DurableVerifyJobCoordinator({ store, profiles: () => profiles, ports: [port], now: () => 2_000 });
  coordinator = new BrowserVerifyRequestCoordinator({
    store, profiles: () => profiles, browserProfiles: () => ['unit'], jobs, now: () => 2_000,
  });
  assert.equal(coordinator.result(caller, preview.request_id).expires_at, 61_000);
  assert.equal(port.calls, 0);
  store.close();
});

test('proposal limits are enforced before persistence', async (t) => {
  const { store, coordinator } = await setup(t);
  for (let i = 0; i < 8; i += 1) {
    const workspace = store.openWorkspaceRecord({
      ...caller, canonicalRoot: `E:/fixture/${i}`, backendKind: 'fake', createdAt: 1_000 + i,
    });
    coordinator.preview(caller, workspace.workspaceId, 'unit');
  }
  const ninth = store.openWorkspaceRecord({
    ...caller, canonicalRoot: 'E:/fixture/9', backendKind: 'fake', createdAt: 1_100,
  });
  assert.throws(() => coordinator.preview(caller, ninth.workspaceId, 'unit'), /Gateway denied verify request/);
  assert.equal(store.listPendingBrowserVerifyRequests(100).length, 8);
});
