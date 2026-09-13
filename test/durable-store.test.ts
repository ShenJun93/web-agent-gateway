import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'wag-durable-store-'));
  const path = join(dir, 'state.sqlite');
  return { dir, path, store: new SqliteDurableStore(path) };
}

const identity = { ownerId: 'owner_a', sessionId: 'session_a', adapterId: 'adapter_a' };

test('workspace record survives close and reopen', async (t) => {
  const { dir, path, store } = await tempStore();
  const created = store.openWorkspaceRecord({
    ...identity, canonicalRoot: 'E:/fixture', backendKind: 'fake', createdAt: 1_000,
  });
  store.close();

  const reopened = new SqliteDurableStore(path);
  t.after(async () => { reopened.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(reopened.getWorkspace(created.workspaceId), created);
});

test('mutation plan stays immutable while approval and claim advance once', async (t) => {
  const { dir, store } = await tempStore();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const workspace = store.openWorkspaceRecord({
    ...identity, canonicalRoot: 'E:/fixture', backendKind: 'fake', createdAt: 1_000,
  });
  const mutation = store.createMutation({
    ...identity,
    workspaceId: workspace.workspaceId,
    backendKind: 'fake',
    path: 'note.txt',
    baseSha256: 'a'.repeat(64),
    before: 'beta',
    after: 'BETA',
    resultSha256: 'b'.repeat(64),
    fingerprint: 'c'.repeat(64),
    additions: 1,
    removals: 1,
    createdAt: 1_000,
    reviewDeadline: 1_060,
  });
  const approved = store.approveMutation(mutation.mutationId, 1_050, 60);
  assert.equal(approved?.state, 'QUEUED');
  assert.equal(approved?.executionAdmissionDeadline, 1_110);
  assert.equal(store.approveMutation(mutation.mutationId, 1_051, 60), undefined);
  const claimed = store.claimMutation(mutation.mutationId, 1_055);
  assert.equal(claimed?.state, 'EXECUTING');
  assert.equal(store.claimMutation(mutation.mutationId, 1_056), undefined);
  const current = store.getMutation(mutation.mutationId)!;
  assert.equal(current.before, 'beta');
  assert.equal(current.after, 'BETA');
  assert.equal(current.fingerprint, 'c'.repeat(64));
});

test('audit events contain transition metadata but not stored file contents', async (t) => {
  const { dir, store } = await tempStore();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const workspace = store.openWorkspaceRecord({ ...identity, canonicalRoot: 'E:/fixture', backendKind: 'fake', createdAt: 10 });
  const mutation = store.createMutation({
    ...identity, workspaceId: workspace.workspaceId, backendKind: 'fake', path: 'note.txt',
    baseSha256: 'a'.repeat(64), before: 'secret-before', after: 'secret-after',
    resultSha256: 'b'.repeat(64), fingerprint: 'c'.repeat(64), additions: 1, removals: 1,
    createdAt: 10, reviewDeadline: 70,
  });
  store.approveMutation(mutation.mutationId, 20, 60);
  store.claimMutation(mutation.mutationId, 21);
  assert.equal(store.finishMutation(mutation.mutationId, 'SUCCEEDED', 22, '{"sha":"b"}'), true);
  const events = store.listAuditEvents(mutation.mutationId);
  assert.deepEqual(events.map((event) => event.toState), ['PENDING_APPROVAL', 'QUEUED', 'EXECUTING', 'SUCCEEDED']);
  assert.doesNotMatch(JSON.stringify(events), /secret-before|secret-after/);
});
