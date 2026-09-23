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
import { DurableCommitCoordinator } from '../src/git-commit.js';
import type { GitCommitBackend, GitCommitPlan, GitCommitResult } from '../src/git-commit-backend.js';
import type { GoalLeaseBindings } from '../src/goal-lease.js';

const NOW = 1_000_000;
const BRANCH = 'feat/revalidate';
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function caller() {
  return createGatewayCallerContext({
    ownerId: 'owner_effect_boundary',
    sessionId: 'session_effect_boundary',
    adapterId: 'adapter.effect-boundary',
  });
}

function mutationBindings(root: string): GoalLeaseBindings {
  const c = caller();
  return {
    workspaceRoots: [root],
    allowedTools: ['mutation.preview'],
    pathPatterns: ['**'],
    maxFiles: 10,
    maxBytes: 1_000_000,
    maxDiffBytes: 100_000,
    admittedSessions: [c.sessionId],
    admittedAdapters: [c.adapterId],
    commitSemantics: 'none',
  };
}

function commitBindings(root: string): GoalLeaseBindings {
  const c = caller();
  return {
    ...mutationBindings(root),
    allowedTools: ['git.commit'],
    pathPatterns: ['src/**'],
    commitSemantics: 'commit-to-bound-branch',
    branch: BRANCH,
    headSha: HEAD,
  };
}

function insertLease(store: SqliteDurableStore, leaseId: string, bindings: GoalLeaseBindings): void {
  store.insertGoalLease({
    leaseId,
    createdAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 60_000,
    bindings: JSON.stringify(bindings),
  });
}

class FsBackend implements FileMutationBackend {
  readonly kind = 'effect-fs';
  writes = 0;

  async readExact(root: string, path: string): Promise<string> {
    return readFile(join(root, path), 'utf8');
  }

  async readExactIfPresent(root: string, path: string): Promise<string | undefined> {
    try { return await readFile(join(root, path), 'utf8'); }
    catch { return undefined; }
  }

  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    assert.equal(await readFile(join(root, path), 'utf8'), original);
    this.writes += 1;
    await writeFile(join(root, path), candidate);
  }

  async createNew(root: string, path: string, candidate: string): Promise<void> {
    this.writes += 1;
    await writeFile(join(root, path), candidate, { flag: 'wx' });
  }
}

interface StubGitBackend extends GitCommitBackend {
  readonly committed: GitCommitResult[];
}

function stubGitBackend(): StubGitBackend {
  const committed: GitCommitResult[] = [];
  return {
    kind: 'effect-git',
    committed,
    async plan(_root, paths): Promise<GitCommitPlan> {
      return {
        branch: BRANCH,
        ref: `refs/heads/${BRANCH}`,
        head: HEAD,
        tree: TREE,
        changes: paths.map((path) => ({ status: 'M', path })),
        author: 'WAG Test <wag@example.invalid>',
        committer: 'WAG Test <wag@example.invalid>',
        gitDir: 'E:/fixture/.git',
        commonDir: 'E:/fixture/.git',
        eolNormalized: [],
      };
    },
    async commit(_root, request): Promise<GitCommitResult> {
      const result: GitCommitResult = {
        branch: request.expectedBranch,
        commit: 'c'.repeat(40),
        tree: request.expectedTree,
        previousHead: request.expectedOldHead,
        changes: request.paths.map((path) => ({ status: 'M', path })),
      };
      committed.push(result);
      return result;
    },
  };
}

async function mutationHarness(t: test.TestContext, overrides: Partial<GoalLeaseBindings> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-effect-boundary-mutation-'));
  const root = join(dir, 'repo');
  await mkdir(root);
  await writeFile(join(root, 'note.txt'), 'one\n');

  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const c = caller();
  const workspace = store.openWorkspaceRecord({
    ...c,
    canonicalRoot: root,
    backendKind: 'effect-fs',
    createdAt: NOW,
  });
  const bindings = { ...mutationBindings(root), ...overrides };
  insertLease(store, 'lease_primary', bindings);
  const backend = new FsBackend();
  const coordinator = new DurableMutationCoordinator({
    store,
    backends: [backend],
    now: () => NOW,
    goalLeaseResolver: { killSwitch: () => false },
  });
  const preview = await coordinator.preview(c, workspace.workspaceId, {
    path: 'note.txt',
    baseSha256: sha256('one\n'),
    before: 'one',
    after: 'two',
  });
  return { store, root, bindings, backend, coordinator, preview };
}

async function commitHarness(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-effect-boundary-commit-'));
  const root = join(dir, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'original\n');

  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const c = caller();
  const workspace = store.openWorkspaceRecord({
    ...c,
    canonicalRoot: root,
    backendKind: 'effect-git',
    createdAt: NOW,
  });
  const bindings = commitBindings(root);
  insertLease(store, 'lease_primary', bindings);
  const backend = stubGitBackend();
  const coordinator = new DurableCommitCoordinator({
    store,
    backend,
    protectedBranches: ['main'],
    now: () => NOW,
    goalLeaseResolver: { killSwitch: () => false },
  });
  const preview = await coordinator.preview(c, workspace.workspaceId, {
    paths: ['src/a.ts'],
    message: 'effect boundary',
  });
  return { store, bindings, backend, coordinator, preview };
}

test('the mutation last budget slot is reserved once, not double-charged at execution', async (t) => {
  const h = await mutationHarness(t, { maxFiles: 1 });

  assert.deepEqual(await h.coordinator.admitByPolicy(h.preview.mutationId), { admitted: true });
  assert.equal(h.backend.writes, 1);
  assert.equal(await readFile(join(h.root, 'note.txt'), 'utf8'), 'two\n');
  assert.equal(h.store.getMutation(h.preview.mutationId)?.state, 'SUCCEEDED');
});

test('revocation observed at the mutation effect boundary prevents the write', async (t) => {
  const h = await mutationHarness(t);
  const original = h.store.getMutationAuthority.bind(h.store);
  let fired = false;
  Object.defineProperty(h.store, 'getMutationAuthority', {
    configurable: true,
    value: (mutationId: string) => {
      if (!fired) {
        fired = true;
        assert.equal(h.store.revokeGoalLease('lease_primary', NOW), true);
      }
      return original(mutationId);
    },
  });

  assert.deepEqual(await h.coordinator.admitByPolicy(h.preview.mutationId), { admitted: true });
  assert.equal(fired, true);
  assert.equal(h.backend.writes, 0);
  assert.equal(await readFile(join(h.root, 'note.txt'), 'utf8'), 'one\n');
  assert.equal(h.store.getMutation(h.preview.mutationId)?.state, 'FAILED');
  assert.equal(h.store.getMutation(h.preview.mutationId)?.errorClass, 'GoalLease_NO_LEASE');
});

test('a duplicate lease appearing at the mutation effect boundary denies as ambiguous', async (t) => {
  const h = await mutationHarness(t);
  const original = h.store.getMutationAuthority.bind(h.store);
  let fired = false;
  Object.defineProperty(h.store, 'getMutationAuthority', {
    configurable: true,
    value: (mutationId: string) => {
      if (!fired) {
        fired = true;
        insertLease(h.store, 'lease_duplicate', h.bindings);
      }
      return original(mutationId);
    },
  });

  assert.deepEqual(await h.coordinator.admitByPolicy(h.preview.mutationId), { admitted: true });
  assert.equal(h.backend.writes, 0);
  assert.equal(h.store.getMutation(h.preview.mutationId)?.state, 'FAILED');
  assert.equal(h.store.getMutation(h.preview.mutationId)?.errorClass, 'GoalLease_AMBIGUOUS_LEASE');
});

test('a successor cannot silently replace the commit lease that was actually admitted', async (t) => {
  const h = await commitHarness(t);
  const original = h.store.getCommitAuthority.bind(h.store);
  let fired = false;
  Object.defineProperty(h.store, 'getCommitAuthority', {
    configurable: true,
    value: (commitId: string) => {
      if (!fired) {
        fired = true;
        assert.equal(h.store.revokeGoalLease('lease_primary', NOW), true);
        insertLease(h.store, 'lease_successor', h.bindings);
      }
      return original(commitId);
    },
  });

  assert.deepEqual(await h.coordinator.admitByPolicy(h.preview.commitId), { admitted: true });
  assert.equal(fired, true);
  assert.equal(h.backend.committed.length, 0);
  assert.equal(h.store.getCommit(h.preview.commitId)?.state, 'FAILED');
  assert.equal(h.store.getCommit(h.preview.commitId)?.errorClass, 'GoalLease_NO_LEASE');
});

test('a duplicate lease appearing at the commit effect boundary denies as ambiguous', async (t) => {
  const h = await commitHarness(t);
  const original = h.store.getCommitAuthority.bind(h.store);
  let fired = false;
  Object.defineProperty(h.store, 'getCommitAuthority', {
    configurable: true,
    value: (commitId: string) => {
      if (!fired) {
        fired = true;
        insertLease(h.store, 'lease_duplicate', h.bindings);
      }
      return original(commitId);
    },
  });

  assert.deepEqual(await h.coordinator.admitByPolicy(h.preview.commitId), { admitted: true });
  assert.equal(h.backend.committed.length, 0);
  assert.equal(h.store.getCommit(h.preview.commitId)?.state, 'FAILED');
  assert.equal(h.store.getCommit(h.preview.commitId)?.errorClass, 'GoalLease_AMBIGUOUS_LEASE');
});
