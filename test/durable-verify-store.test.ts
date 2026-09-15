import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';

const identity = { ownerId: 'owner_a', sessionId: 'session_a', adapterId: 'adapter_a' };

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'wag-verify-store-'));
  const path = join(dir, 'state.sqlite');
  return { dir, path, store: new SqliteDurableStore(path) };
}

function createJob(store: SqliteDurableStore, workspaceId: string, createdAt = 1_000, dispatchDeadline = 301_000) {
  return store.createVerifyJob({
    ...identity,
    workspaceId,
    backendKind: 'fake',
    profileName: 'test',
    planSha256: 'a'.repeat(64),
    createdAt,
    dispatchDeadline,
  });
}
test('verify job row survives close and reopen before execution', async (t) => {
  const { dir, path, store } = await tempStore();
  const workspace = store.openWorkspaceRecord({
    ...identity, canonicalRoot: 'E:/fixture', backendKind: 'fake', createdAt: 900,
  });
  const created = createJob(store, workspace.workspaceId);
  assert.match(created.jobId, /^job_/);
  assert.equal(created.state, 'QUEUED');
  assert.deepEqual(store.getVerifyJob(created.jobId), created);
  store.close();

  const reopened = new SqliteDurableStore(path);
  t.after(async () => { reopened.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(reopened.getVerifyJob(created.jobId), created);
  assert.deepEqual(reopened.listRecoverableVerifyJobs().map((job) => job.jobId), [created.jobId]);
});

test('verify job claim is conditional, persists one attempt id, and respects dispatch deadline', async (t) => {
  const { dir, store } = await tempStore();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const workspace = store.openWorkspaceRecord({
    ...identity, canonicalRoot: 'E:/fixture', backendKind: 'fake', createdAt: 900,
  });
  const job = createJob(store, workspace.workspaceId);
  const claimed = store.claimVerifyJob(job.jobId, 2_000, 'attempt_1');
  assert.equal(claimed?.state, 'EXECUTING');
  assert.equal(claimed?.attemptId, 'attempt_1');
  assert.equal(claimed?.executionStartedAt, 2_000);
  assert.equal(store.claimVerifyJob(job.jobId, 2_001, 'attempt_2'), undefined);

  const expired = createJob(store, workspace.workspaceId, 3_000, 3_100);
  assert.equal(store.claimVerifyJob(expired.jobId, 3_100, 'attempt_expired'), undefined);
});

test('verify job pre-execution failure is terminal and cannot be claimed later', async (t) => {
  const { dir, store } = await tempStore();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const workspace = store.openWorkspaceRecord({
    ...identity, canonicalRoot: 'E:/fixture', backendKind: 'fake', createdAt: 900,
  });
  const job = createJob(store, workspace.workspaceId);
  assert.equal(store.failQueuedVerifyJob(job.jobId, 1_100, 'PROFILE_MISSING'), true);
  assert.equal(store.getVerifyJob(job.jobId)?.state, 'FAILED');
  assert.equal(store.getVerifyJob(job.jobId)?.errorClass, 'PROFILE_MISSING');
  assert.equal(store.failQueuedVerifyJob(job.jobId, 1_101, 'PROFILE_PLAN_DRIFT'), false);
  assert.equal(store.claimVerifyJob(job.jobId, 1_102, 'attempt_late'), undefined);
});

test('verify job completion and transition events persist only bounded metadata', async (t) => {
  const { dir, store } = await tempStore();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const workspace = store.openWorkspaceRecord({
    ...identity, canonicalRoot: 'E:/fixture-secret-root', backendKind: 'fake', createdAt: 900,
  });
  const job = createJob(store, workspace.workspaceId);
  store.claimVerifyJob(job.jobId, 2_000, 'attempt_1');
  assert.equal(store.finishVerifyJob(job.jobId, 'SUCCEEDED', 2_100, {
    exitCode: 1, output: 'sentinel-output', outputTruncated: false,
  }), true);
  assert.equal(store.finishVerifyJob(job.jobId, 'OUTCOME_UNKNOWN', 2_101, undefined, 'EXECUTION_PORT_ERROR_UNCONFIRMED'), false);

  const current = store.getVerifyJob(job.jobId)!;
  assert.equal(current.state, 'SUCCEEDED');
  assert.equal(current.exitCode, 1);
  assert.equal(current.output, 'sentinel-output');
  const events = store.listVerifyJobEvents(job.jobId);
  assert.deepEqual(events.map((event) => event.toState), ['QUEUED', 'EXECUTING', 'SUCCEEDED']);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /sentinel-output|fixture-secret-root|profileName|planSha256/);
});