import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import {
  createProposalRateLimit,
  DEFAULT_PROPOSAL_ATTEMPTS,
  DEFAULT_PROPOSAL_WINDOW_MS,
} from '../src/proposal-rate-limit.js';
import type { FileMutationBackend } from '../src/file-mutation-backend.js';
import type { GitCommitBackend, GitCommitPlan, GitCommitResult } from '../src/git-commit-backend.js';

/**
 * Two bounds guard proposal creation, and they bound different things (ADR-0026).
 *
 * The live cap bounds how many records one caller can leave in the operator's review list. The
 * attempt window bounds how much local work one caller can drive, which the live cap cannot do:
 * a proposal that fails while being computed creates no record, so a record-counting cap never
 * sees it.
 */
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const caller = createGatewayCallerContext({ ownerId: 'owner-a', sessionId: 'session-a', adapterId: 'adapter-a' });

test('the attempt window is per caller, slides, and a refusal is not free', () => {
  const limit = createProposalRateLimit({ attempts: 3, windowMs: 1_000 });
  const other = createGatewayCallerContext({ ...caller, sessionId: 'session-b' });

  for (let i = 0; i < 3; i += 1) limit.charge(caller, 1_000);
  assert.throws(() => limit.charge(caller, 1_000), /too many attempts/);

  // A different session is a different caller, and starts with a full budget.
  for (let i = 0; i < 3; i += 1) limit.charge(other, 1_000);
  assert.throws(() => limit.charge(other, 1_000), /too many attempts/);

  // Spinning on refusals must neither extend the penalty nor shorten it.
  assert.throws(() => limit.charge(caller, 1_500), /too many attempts/);
  assert.throws(() => limit.charge(caller, 1_999), /too many attempts/);
  limit.charge(caller, 2_001);

  // The shipped defaults are what the coordinators use when nothing overrides them.
  assert.equal(DEFAULT_PROPOSAL_ATTEMPTS, 30);
  assert.equal(DEFAULT_PROPOSAL_WINDOW_MS, 60_000);
});

test('a mutation caller is bounded both by live proposals and by attempts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-proposal-caps-'));
  const store = new SqliteDurableStore(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const now = { value: 1_000 };
  const backend = new CountingFsBackend();
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: root, backendKind: backend.kind, createdAt: now.value,
  });
  const coordinator = new DurableMutationCoordinator({
    store, backends: [backend], now: () => now.value,
  });

  const original = 'alpha\n';
  for (let i = 0; i < 12; i += 1) await writeFile(join(root, `f${i}.txt`), original);
  const propose = (i: number) => coordinator.preview(caller, workspace.workspaceId, {
    path: `f${i}.txt`, baseSha256: sha256(original), before: 'alpha', after: 'ALPHA',
  });

  // Approving also reaches the backend, so what each assertion measures is the delta across the
  // one call it is about, never a running total.
  const readsDuring = async (call: () => Promise<unknown>) => {
    const before = backend.reads;
    await call().catch(() => undefined);
    return backend.reads - before;
  };
  const drain = async () => {
    for (const record of store.listPendingMutations(8)) await coordinator.approveLocal(record.mutationId);
  };

  for (let i = 0; i < 8; i += 1) await propose(i);
  await assert.rejects(propose(8), /too many proposals awaiting review/);
  assert.equal(store.countPendingMutations(caller, now.value), 8);
  // The live cap refused before the backend read, so the ninth proposal cost no file read.
  assert.equal(await readsDuring(() => propose(8)), 0, 'a refused proposal must not reach the backend');

  // Approving drains the review list, which is what makes room again.
  await drain();
  assert.equal(store.countPendingMutations(caller, now.value), 0);
  assert.ok(await readsDuring(() => propose(8)) > 0, 'an admitted proposal does read the base');

  // Nine attempts are now charged: the eight, and this one. The two the live cap refused were
  // not charged, because that cap throws before the window is touched.
  await drain();
  let charged = 9;
  for (;;) {
    const i = charged % 12;
    await writeFile(join(root, `f${i}.txt`), original);
    try {
      await propose(i);
      charged += 1;
    } catch (error) {
      assert.match(String(error), /too many proposal attempts/);
      break;
    }
    await drain();
    assert.ok(charged <= DEFAULT_PROPOSAL_ATTEMPTS, 'the window must refuse at the configured budget');
  }
  assert.equal(charged, DEFAULT_PROPOSAL_ATTEMPTS);
  assert.equal(await readsDuring(() => propose(0)), 0, 'the window refuses before any backend work');

  // A caller whose window has passed is not punished forever.
  now.value += DEFAULT_PROPOSAL_WINDOW_MS + 1;
  await writeFile(join(root, 'f0.txt'), original);
  await propose(0);
  assert.equal(await readFile(join(root, 'f0.txt'), 'utf8'), original, 'a proposal writes nothing');
});

test('a commit caller is charged before the planner runs, even when no record results', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-commit-caps-'));
  const store = new SqliteDurableStore(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const now = { value: 1_000 };
  const backend = new FailingPlanBackend();
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: root, backendKind: backend.kind, createdAt: now.value,
  });
  await writeFile(join(root, 'tracked.txt'), 'x\n');
  const coordinator = new DurableCommitCoordinator({ store, backend, now: () => now.value });

  const propose = () => coordinator.preview(caller, workspace.workspaceId, {
    paths: ['tracked.txt'], message: 'chore: nothing to do\n',
  });

  // This is the finding the window exists for: every one of these plans throws, so the record
  // count stays at zero and a record-counting cap would let them run forever.
  for (let i = 0; i < DEFAULT_PROPOSAL_ATTEMPTS; i += 1) {
    await assert.rejects(propose(), /nothing to commit/);
  }
  assert.equal(store.countPendingCommits(caller, now.value), 0);
  assert.equal(backend.plans, DEFAULT_PROPOSAL_ATTEMPTS);

  await assert.rejects(propose(), /too many proposal attempts/);
  assert.equal(backend.plans, DEFAULT_PROPOSAL_ATTEMPTS, 'the window refuses before the planner');
});

class CountingFsBackend implements FileMutationBackend {
  readonly kind = 'test-fs';
  reads = 0;
  writes = 0;
  async readExact(root: string, path: string): Promise<string> {
    this.reads += 1;
    return readFile(join(root, path), 'utf8');
  }
  async readExactIfPresent(root: string, path: string): Promise<string | undefined> {
    this.reads += 1;
    try { return await readFile(join(root, path), 'utf8'); }
    catch { return undefined; }
  }
  async createNew(root: string, path: string, candidate: string): Promise<void> {
    this.writes += 1;
    await writeFile(join(root, path), candidate, { flag: 'wx' });
  }
  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    if (await readFile(join(root, path), 'utf8') !== original) throw new Error('stale target');
    this.writes += 1;
    await writeFile(join(root, path), candidate);
  }
}

class FailingPlanBackend implements GitCommitBackend {
  readonly kind = 'test-git';
  plans = 0;
  async plan(): Promise<GitCommitPlan> {
    this.plans += 1;
    throw new Error('Gateway refused commit: nothing to commit');
  }
  async commit(): Promise<GitCommitResult> {
    throw new Error('no commit should be reachable in this test');
  }
}
