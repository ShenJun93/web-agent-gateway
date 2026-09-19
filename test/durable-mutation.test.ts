import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { FileMutationBackend } from '../src/file-mutation-backend.js';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
// @ts-expect-error MutationCaller compatibility alias must remain removed.
import type { MutationCaller as RetiredMutationCaller } from '../src/durable-mutation.js';

const retiredMutationCallerTypeGuard: RetiredMutationCaller | undefined = undefined;
void retiredMutationCallerTypeGuard;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const caller = createGatewayCallerContext({ ownerId: 'owner-a', sessionId: 'session-a', adapterId: 'adapter-a' });

async function setup(t: test.TestContext, nowRef = { value: 1_000 }) {
  const root = await mkdtemp(join(tmpdir(), 'wag-durable-mutation-'));
  const dbPath = join(root, 'state.sqlite');
  const store = new SqliteDurableStore(dbPath);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const backend = new FsTestBackend();
  const workspace = store.openWorkspaceRecord({ ...caller, canonicalRoot: root, backendKind: backend.kind, createdAt: nowRef.value });
  const coordinator = new DurableMutationCoordinator({ store, backends: [backend], now: () => nowRef.value });
  return { root, store, backend, workspace, coordinator, nowRef };
}

test('preview persists an immutable plan and result enforces caller identity', async (t) => {
  const { root, store, workspace, coordinator } = await setup(t);
  const original = 'alpha\nbeta\ngamma\n';
  await writeFile(join(root, 'note.txt'), original);

  const preview = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  });
  assert.equal(preview.status, 'approval_required');
  assert.match(preview.mutationId, /^mut_/);
  assert.equal(store.getMutation(preview.mutationId)?.after, 'BETA');
  assert.equal(coordinator.result(caller, preview.mutationId).state, 'PENDING_APPROVAL');
  for (const denied of [
    createGatewayCallerContext({ ...caller, ownerId: 'owner-b' }),
    createGatewayCallerContext({ ...caller, sessionId: 'session-b' }),
    createGatewayCallerContext({ ...caller, adapterId: 'adapter-b' }),
  ]) {
    assert.throws(() => coordinator.result(denied, preview.mutationId), /identity/);
  }
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), original);
});

test('local approval executes exactly the stored mutation once', async (t) => {
  const { root, workspace, coordinator, backend } = await setup(t);
  const original = 'alpha\nbeta\ngamma\n';
  const candidate = 'alpha\nBETA\ngamma\n';
  await writeFile(join(root, 'note.txt'), original);
  const preview = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  });

  assert.equal(await coordinator.approveLocal(preview.mutationId), true);
  assert.equal(coordinator.result(caller, preview.mutationId).state, 'SUCCEEDED');
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), candidate);
  assert.equal(backend.writes, 1);
  assert.equal(await coordinator.approveLocal(preview.mutationId), false);
  assert.equal(backend.writes, 1);
});

test('review and execution-admission deadlines fail closed without extension', async (t) => {
  const nowRef = { value: 10_000 };
  const { root, workspace, coordinator, store } = await setup(t, nowRef);
  const original = 'alpha\nbeta\n';
  await writeFile(join(root, 'note.txt'), original);
  const first = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  });
  nowRef.value = 70_000;
  assert.equal(await coordinator.approveLocal(first.mutationId), false);
  await coordinator.reconcile();
  assert.equal(store.getMutation(first.mutationId)?.state, 'EXPIRED');

  nowRef.value = 100_000;
  const second = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  });
  const queued = store.approveMutation(second.mutationId, nowRef.value, 60_000);
  assert.equal(queued?.executionAdmissionDeadline, 160_000);
  nowRef.value = 160_000;
  await coordinator.reconcile();
  assert.equal(store.getMutation(second.mutationId)?.state, 'EXPIRED');
});

test('restart reconciliation resolves result, base, and divergent executing states', async (t) => {
  const nowRef = { value: 200_000 };
  const { root, workspace, coordinator, store, backend } = await setup(t, nowRef);
  const original = 'alpha\nbeta\n';
  const candidate = 'alpha\nBETA\n';
  const makeExecuting = async () => {
    await writeFile(join(root, 'note.txt'), original);
    const preview = await coordinator.preview(caller, workspace.workspaceId, {
      path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
    });
    store.approveMutation(preview.mutationId, nowRef.value, 60_000);
    store.claimMutation(preview.mutationId, nowRef.value);
    return preview.mutationId;
  };

  const completed = await makeExecuting();
  await writeFile(join(root, 'note.txt'), candidate);
  await coordinator.reconcile();
  assert.equal(store.getMutation(completed)?.state, 'SUCCEEDED');

  const retryable = await makeExecuting();
  await coordinator.reconcile();
  assert.equal(store.getMutation(retryable)?.state, 'SUCCEEDED');
  assert.equal(backend.writes, 1, 'base-hash recovery executes once');

  const unknown = await makeExecuting();
  await writeFile(join(root, 'note.txt'), 'alpha\nOTHER\n');
  await coordinator.reconcile();
  assert.equal(store.getMutation(unknown)?.state, 'OUTCOME_UNKNOWN');
  assert.equal(backend.writes, 1, 'divergent recovery must not write');
});

test('preview retains existing path, content, size and match safety checks', async (t) => {
  const { root, workspace, coordinator } = await setup(t);
  await writeFile(join(root, 'note.txt'), 'beta\nbeta\n');
  const duplicate = 'beta\nbeta\n';
  await assert.rejects(coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(duplicate), before: 'beta', after: 'BETA',
  }), /exactly once/);
  await assert.rejects(coordinator.preview(caller, workspace.workspaceId, {
    path: '.env', baseSha256: sha256(duplicate), before: 'beta', after: 'BETA',
  }), /sensitive path/);
  await assert.rejects(coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: '0'.repeat(64), before: 'beta', after: 'BETA',
  }), /base SHA-256 mismatch/);
});

class FsTestBackend implements FileMutationBackend {
  readonly kind = 'test-fs';
  writes = 0;
  async readExact(root: string, path: string): Promise<string> {
    return readFile(join(root, path), 'utf8');
  }
  async readExactIfPresent(root: string, path: string): Promise<string | undefined> {
    try { return await readFile(join(root, path), 'utf8'); }
    catch { return undefined; }
  }
  async createNew(root: string, path: string, candidate: string): Promise<void> {
    this.writes += 1;
    await writeFile(join(root, path), candidate, { flag: 'wx' });
  }
  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    const target = join(root, path);
    if (await readFile(target, 'utf8') !== original) throw new Error('stale target');
    this.writes += 1;
    await writeFile(target, candidate);
  }
}
