import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import { createGatewayCallerContext } from '../src/caller-context.js';
import type { GitCommitBackend, GitCommitPlan, GitCommitResult } from '../src/git-commit-backend.js';
import type { GoalLeaseBindings, LeaseDenialCode } from '../src/goal-lease.js';

/**
 * The autonomous Git commit cycle under a Goal Lease (ADR-0028).
 *
 * The backend here is a stub, and that is a deliberate scope choice rather than a shortcut: what
 * is new is the *gate* — whether a lease admits a commit and on what terms — while the commit
 * machinery itself (drift refusal, CAS on the ref, hook containment, EOL normalization) is
 * covered against a real repository in `git-commit.test.ts` and is untouched by this change.
 *
 * So these tests prove the cycle reaches execution with no human gesture, and prove the five
 * ways a lease refuses one. They do not re-prove that git works.
 */
const BRANCH = 'feat/autonomous';
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

interface StubBackend extends GitCommitBackend { committed: GitCommitResult[] }

function stubBackend(head = HEAD): StubBackend {
  const committed: GitCommitResult[] = [];
  return {
    kind: 'stub-git',
    committed,
    async plan(_root, paths): Promise<GitCommitPlan> {
      return {
        branch: BRANCH,
        ref: `refs/heads/${BRANCH}`,
        head,
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

async function harness(t: { after(fn: () => void | Promise<void>): void }, bindings: Partial<GoalLeaseBindings> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-lease-commit-'));
  const store = new SqliteDurableStore(join(dir, 'store.sqlite'));
  // One hook: the store handle must close before the directory goes, or Windows refuses it.
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const root = join(dir, 'repo');
  await mkdir(root, { recursive: true });
  const caller = createGatewayCallerContext({
    ownerId: 'owner_test', sessionId: 'session_test', adapterId: 'adapter.test',
  });
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: root, backendKind: 'stub-git', createdAt: Date.now(),
  });

  const backend = stubBackend();
  let killSwitch = false;
  let leaseId = '';
  const coordinator = new DurableCommitCoordinator({
    store,
    backend,
    protectedBranches: ['main'],
    goalLease: { get leaseId() { return leaseId; }, killSwitch: () => killSwitch } as
      { leaseId: string; killSwitch: () => boolean },
  });

  const grant = (overrides: Partial<GoalLeaseBindings> = {}) => {
    const full: GoalLeaseBindings = {
      workspaceRoots: [root],
      allowedTools: ['git.commit'],
      pathPatterns: ['src/**'],
      maxFiles: 10,
      maxBytes: 1_000_000,
      maxDiffBytes: 100_000,
      admittedSessions: [caller.sessionId],
      admittedAdapters: [caller.adapterId],
      commitSemantics: 'commit-to-bound-branch',
      branch: BRANCH,
      headSha: HEAD,
      ...bindings,
      ...overrides,
    };
    const id = `lease_${Math.random().toString(36).slice(2)}`;
    const createdAt = Date.now();
    store.insertGoalLease({
      leaseId: id, createdAt, notBefore: createdAt, expiresAt: createdAt + 60_000,
      bindings: JSON.stringify(full),
    });
    leaseId = id;
    return id;
  };

  return {
    store, coordinator, backend, caller, root, grant,
    workspaceId: workspace.workspaceId,
    setKillSwitch(v: boolean) { killSwitch = v; },
  };
}

const codeOf = (d: { admitted: boolean }): LeaseDenialCode => {
  assert.equal(d.admitted, false, 'expected a denial');
  return (d as unknown as { code: LeaseDenialCode }).code;
};

/**
 * The paths a proposal names must exist: `validatePaths` runs the production path policy, which
 * refuses a missing target. A stub backend does not exempt a proposal from that, and should not.
 */
async function seed(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, 'original\n', 'utf8');
  }
}

test('an autonomous commit cycle completes within the lease, with no human gesture', async (t) => {
  const h = await harness(t);
  h.grant();
  await seed(h.root, ['src/a.ts']);
  const preview = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['src/a.ts'], message: 'autonomous change',
  });

  assert.equal(h.backend.committed.length, 0, 'proposing commits nothing');
  assert.deepEqual(await h.coordinator.admitByPolicy(preview.commitId), { admitted: true });

  assert.equal(h.backend.committed.length, 1, 'and admission is what caused the commit');
  assert.equal(h.store.getCommit(preview.commitId)?.state, 'SUCCEEDED');
});

test('a lease granting no commit semantics refuses the whole cycle', async (t) => {
  const h = await harness(t);
  // A lease that grants the tool but not the semantics: the common misconfiguration.
  h.grant({ commitSemantics: 'none', branch: undefined, headSha: undefined });
  await seed(h.root, ['src/a.ts']);
  const preview = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['src/a.ts'], message: 'autonomous change',
  });
  assert.equal(codeOf(await h.coordinator.admitByPolicy(preview.commitId)), 'COMMIT_NOT_GRANTED');
  assert.equal(h.backend.committed.length, 0);
  assert.equal(h.store.getCommit(preview.commitId)?.state, 'PENDING_APPROVAL');
});

test('a commit onto a branch the lease does not bind is refused', async (t) => {
  const h = await harness(t);
  h.grant({ branch: 'some/other/branch' });
  await seed(h.root, ['src/a.ts']);
  const preview = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['src/a.ts'], message: 'autonomous change',
  });
  assert.equal(codeOf(await h.coordinator.admitByPolicy(preview.commitId)), 'BRANCH_NOT_GRANTED');
  assert.equal(h.backend.committed.length, 0);
});

test('a lease bound to a HEAD that has since moved is refused', async (t) => {
  const h = await harness(t);
  // The lease was written against a different base than the proposal was planned against. That
  // is the CAS on history: the repository the lease described is not this one.
  h.grant({ headSha: 'f'.repeat(40) });
  await seed(h.root, ['src/a.ts']);
  const preview = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['src/a.ts'], message: 'autonomous change',
  });
  assert.equal(codeOf(await h.coordinator.admitByPolicy(preview.commitId)), 'HEAD_MOVED');
  assert.equal(h.backend.committed.length, 0);
});

test('one out-of-scope path sinks the whole commit', async (t) => {
  const h = await harness(t);
  h.grant({ pathPatterns: ['src/**'] });
  // Nine granted paths and one that is not. Checking only the first would admit this.
  const paths = [...Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`), 'secrets.env'];
  await seed(h.root, paths);
  const preview = await h.coordinator.preview(h.caller, h.workspaceId, { paths, message: 'sneak' });

  assert.equal(codeOf(await h.coordinator.admitByPolicy(preview.commitId)), 'PATH_NOT_GRANTED');
  assert.equal(h.backend.committed.length, 0, 'nothing was committed');
  assert.equal(h.store.getCommit(preview.commitId)?.state, 'PENDING_APPROVAL');
});

test('the kill switch stops an otherwise valid commit', async (t) => {
  const h = await harness(t);
  h.grant();
  await seed(h.root, ['src/a.ts']);
  const preview = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['src/a.ts'], message: 'autonomous change',
  });
  h.setKillSwitch(true);
  assert.equal(codeOf(await h.coordinator.admitByPolicy(preview.commitId)), 'KILL_SWITCH_ENGAGED');
  assert.equal(h.backend.committed.length, 0);
});

test('with no lease configured the commit coordinator admits nothing by policy', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-lease-commit-'));
  const store = new SqliteDurableStore(join(dir, 'store.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const caller = createGatewayCallerContext({
    ownerId: 'owner_test', sessionId: 'session_test', adapterId: 'adapter.test',
  });
  const root = join(dir, 'repo');
  await mkdir(root, { recursive: true });
  await seed(root, ['src/a.ts']);
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: root, backendKind: 'stub-git', createdAt: Date.now(),
  });
  // No `goalLease` option at all — production's shape.
  const coordinator = new DurableCommitCoordinator({ store, backend: stubBackend(), protectedBranches: ['main'] });
  const preview = await coordinator.preview(caller, workspace.workspaceId, {
    paths: ['src/a.ts'], message: 'autonomous change',
  });
  assert.equal(codeOf(await coordinator.admitByPolicy(preview.commitId)), 'NO_LEASE');
  assert.equal(store.getCommit(preview.commitId)?.state, 'PENDING_APPROVAL',
    'and the record still awaits a human');
});

// -------------------------------------------------------------------------------------------
// The driver, which is what makes a configured lease do anything for commits
// -------------------------------------------------------------------------------------------

test('pending commits are offered to the lease by a driver, not only one id at a time', async (t) => {
  // Measured in production on 2026-09-22: a delegated `git.commit` was admitted as DELEGATED_RUN,
  // the commit record was written, and the lease granted `git.commit` on exactly that branch and
  // HEAD — and the record sat at PENDING_APPROVAL until its review window closed, because the
  // runtime's lease interval drove mutations only. `admitByPolicy` decided one record and nothing
  // called it. This is the counterpart of the mutation-side driver a review added for the same
  // reason, and it is the thing the runtimes now call on their interval.
  const h = await harness(t);
  h.grant();
  await seed(h.root, ['src/a.ts', 'src/b.ts']);
  const first = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['src/a.ts'], message: 'first autonomous change',
  });
  const second = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['src/b.ts'], message: 'second autonomous change',
  });
  assert.equal(h.backend.committed.length, 0, 'proposing commits nothing');

  const admitted = await h.coordinator.admitPendingUnderLease();

  assert.deepEqual([...admitted].sort(), [first.commitId, second.commitId].sort());
  assert.equal(h.store.getCommit(first.commitId)?.state, 'SUCCEEDED');
  assert.equal(h.store.getCommit(second.commitId)?.state, 'SUCCEEDED');
  assert.equal(h.backend.committed.length, 2, 'and the driver is what caused both commits');
});

test('the driver leaves a commit the lease does not cover pending for a human', async (t) => {
  const h = await harness(t);
  h.grant({ pathPatterns: ['src/*.ts'] });
  await seed(h.root, ['src/a.ts', 'docs/readme.md']);
  const granted = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['src/a.ts'], message: 'inside the lease',
  });
  const outside = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['docs/readme.md'], message: 'outside the lease',
  });

  const admitted = await h.coordinator.admitPendingUnderLease();

  assert.deepEqual(admitted, [granted.commitId], 'only the covered one');
  assert.equal(h.store.getCommit(outside.commitId)?.state, 'PENDING_APPROVAL',
    'an uncovered commit is left for a person, which is the correct outcome and not an error');
  assert.equal(h.backend.committed.length, 1);
});

test('with no lease configured the driver admits nothing and reports nothing', async (t) => {
  const h = await harness(t);
  await seed(h.root, ['src/a.ts']);
  const preview = await h.coordinator.preview(h.caller, h.workspaceId, {
    paths: ['src/a.ts'], message: 'no lease is configured',
  });
  assert.deepEqual(await h.coordinator.admitPendingUnderLease(), []);
  assert.equal(h.store.getCommit(preview.commitId)?.state, 'PENDING_APPROVAL');
  assert.equal(h.backend.committed.length, 0);
});

test('both runtimes drive the commit driver on the same pass as the mutation one', async () => {
  // A source assertion, and labelled as one: it pins the *wiring*, not the behaviour. The driver's
  // behaviour is covered by the three tests above; what this catches is the failure that actually
  // happened — a coordinator with a working `admitByPolicy` that no pass ever called, so a
  // configured lease admitted mutations and silently never admitted commits.
  //
  // Neither runtime's interval is reachable from a unit test today (both are created inside a live
  // bootstrap), so this is the cheapest guard that fails if the call is removed.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const file of ['src/browser-operator-runtime.ts', 'src/repository-engineering-runtime.ts']) {
    const source = await readFile(`${root}${file}`, 'utf8');
    const interval = /setInterval\(\(\) => \{([\s\S]*?)\}, LEASE_ADMISSION_INTERVAL_MS\)/.exec(source);
    assert.ok(interval, `${file} must drive lease admission on an interval`);
    const body = interval[1] ?? '';
    assert.match(body, /mutation|coordinator/, `${file}: the pass must drive mutations`);
    assert.match(body, /commit(Coordinator)?\??\.admitPendingUnderLease/,
      `${file}: the pass must drive commits too, or a leased git.commit waits for a human forever`);
  }
});
