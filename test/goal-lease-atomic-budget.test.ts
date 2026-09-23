import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { FileMutationBackend } from '../src/file-mutation-backend.js';
import { installGoalLeaseAtomicBudgetGuard } from '../src/goal-lease-atomic-budget.js';
import type { GoalLeaseBindings } from '../src/goal-lease.js';

const NOW = 1_000_000;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

class FsBackend implements FileMutationBackend {
  readonly kind = 'atomic-budget-fs';
  readonly writes: string[] = [];

  async readExact(root: string, path: string): Promise<string> {
    return readFile(join(root, path), 'utf8');
  }

  async readExactIfPresent(root: string, path: string): Promise<string | undefined> {
    try { return await readFile(join(root, path), 'utf8'); }
    catch { return undefined; }
  }

  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    assert.equal(await readFile(join(root, path), 'utf8'), original);
    this.writes.push(path);
    await writeFile(join(root, path), candidate);
  }

  async createNew(root: string, path: string, candidate: string): Promise<void> {
    this.writes.push(path);
    await writeFile(join(root, path), candidate, { flag: 'wx' });
  }
}

async function harness(
  t: test.TestContext,
  limits: Pick<GoalLeaseBindings, 'maxFiles' | 'maxBytes' | 'maxDiffBytes'>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-atomic-goal-lease-budget-'));
  const root = join(dir, 'repo');
  const statePath = join(dir, 'state.sqlite');
  await mkdir(root);
  await writeFile(join(root, 'a.txt'), 'alpha\n');
  await writeFile(join(root, 'b.txt'), 'bravo\n');

  const storeA = new SqliteDurableStore(statePath);
  installGoalLeaseAtomicBudgetGuard(statePath);
  const storeB = new SqliteDurableStore(statePath);
  t.after(async () => {
    storeB.close();
    storeA.close();
    await rm(dir, { recursive: true, force: true });
  });

  const caller = createGatewayCallerContext({
    ownerId: 'owner_atomic_budget',
    sessionId: 'session_atomic_budget',
    adapterId: 'adapter.atomic-budget',
  });
  const workspace = storeA.openWorkspaceRecord({
    ...caller,
    canonicalRoot: root,
    backendKind: 'atomic-budget-fs',
    createdAt: NOW,
  });
  const bindings: GoalLeaseBindings = {
    workspaceRoots: [root],
    allowedTools: ['mutation.preview'],
    pathPatterns: ['**'],
    ...limits,
    admittedSessions: [caller.sessionId],
    admittedAdapters: [caller.adapterId],
    commitSemantics: 'none',
  };
  storeA.insertGoalLease({
    leaseId: 'lease_atomic_budget',
    createdAt: NOW - 1,
    notBefore: NOW - 1,
    expiresAt: NOW + 60_000,
    bindings: JSON.stringify(bindings),
  });

  const backendA = new FsBackend();
  const backendB = new FsBackend();
  const coordinatorA = new DurableMutationCoordinator({
    store: storeA,
    backends: [backendA],
    now: () => NOW,
    goalLeaseResolver: { killSwitch: () => false },
  });
  const coordinatorB = new DurableMutationCoordinator({
    store: storeB,
    backends: [backendB],
    now: () => NOW,
    goalLeaseResolver: { killSwitch: () => false },
  });

  const previewA = await coordinatorA.preview(caller, workspace.workspaceId, {
    path: 'a.txt',
    baseSha256: sha256('alpha\n'),
    before: 'alpha',
    after: 'ALPHA',
  });
  const previewB = await coordinatorB.preview(caller, workspace.workspaceId, {
    path: 'b.txt',
    baseSha256: sha256('bravo\n'),
    before: 'bravo',
    after: 'BRAVO',
  });

  // Both processes may have read this exact snapshot before either writer acquired BEGIN IMMEDIATE.
  // Pin B to that stale read after A commits, so the test deterministically exercises the race
  // instead of depending on scheduler timing.
  const staleSpend = storeB.goalLeaseSpend('lease_atomic_budget');
  assert.deepEqual(staleSpend, { filesChanged: 0, bytesWritten: 0 });
  Object.defineProperty(storeB, 'goalLeaseSpend', {
    configurable: true,
    value: () => staleSpend,
  });

  return {
    root,
    storeA,
    storeB,
    backendA,
    backendB,
    coordinatorA,
    coordinatorB,
    previewA,
    previewB,
  };
}

test('two store connections cannot both reserve the last file-budget slot from a stale read', async (t) => {
  const h = await harness(t, { maxFiles: 1, maxBytes: 1_000, maxDiffBytes: 1_000 });

  assert.deepEqual(await h.coordinatorA.admitByPolicy(h.previewA.mutationId), { admitted: true });
  const denied = await h.coordinatorB.admitByPolicy(h.previewB.mutationId);

  assert.equal(denied.admitted, false);
  if (!denied.admitted) assert.equal(denied.code, 'FILE_BUDGET_EXHAUSTED');
  assert.deepEqual(h.backendA.writes, ['a.txt']);
  assert.deepEqual(h.backendB.writes, []);
  assert.equal(await readFile(join(h.root, 'a.txt'), 'utf8'), 'ALPHA\n');
  assert.equal(await readFile(join(h.root, 'b.txt'), 'utf8'), 'bravo\n');

  assert.equal(h.storeA.getMutationAuthority(h.previewA.mutationId)?.leaseId, 'lease_atomic_budget');
  assert.equal(h.storeB.getMutationAuthority(h.previewB.mutationId), undefined);
  assert.equal(h.storeB.getMutation(h.previewB.mutationId)?.state, 'PENDING_APPROVAL');
  assert.deepEqual(h.storeA.goalLeaseSpend('lease_atomic_budget'), {
    filesChanged: 1,
    bytesWritten: 5,
  });
});

test('two store connections cannot both reserve the last byte-budget slot from a stale read', async (t) => {
  const h = await harness(t, { maxFiles: 10, maxBytes: 5, maxDiffBytes: 1_000 });

  assert.deepEqual(await h.coordinatorA.admitByPolicy(h.previewA.mutationId), { admitted: true });
  const denied = await h.coordinatorB.admitByPolicy(h.previewB.mutationId);

  assert.equal(denied.admitted, false);
  if (!denied.admitted) assert.equal(denied.code, 'BYTE_BUDGET_EXHAUSTED');
  assert.deepEqual(h.backendA.writes, ['a.txt']);
  assert.deepEqual(h.backendB.writes, []);
  assert.equal(h.storeB.getMutationAuthority(h.previewB.mutationId), undefined);
  assert.equal(h.storeB.getMutation(h.previewB.mutationId)?.state, 'PENDING_APPROVAL');
  assert.deepEqual(h.storeA.goalLeaseSpend('lease_atomic_budget'), {
    filesChanged: 1,
    bytesWritten: 5,
  });
});
