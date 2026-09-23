import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import type { GitCommitBackend, GitCommitPlan, GitCommitResult } from '../src/git-commit-backend.js';
import {
  evaluateGoalLease,
  rolloverCommitBindingHeads,
  validateBindings,
  type GoalLeaseBindings,
  type GoalLeaseRecord,
  type LeaseRequest,
} from '../src/goal-lease.js';

const ROOT_A = 'E:/worktrees/a';
const ROOT_B = 'E:/worktrees/b';
const ROOT_C = 'E:/worktrees/c';
const NOW = 1_000_000;

const BINDINGS: GoalLeaseBindings = {
  workspaceRoots: [ROOT_A, ROOT_B, ROOT_C],
  allowedTools: ['mutation.preview', 'command.run', 'git.commit'],
  pathPatterns: ['src/**'],
  maxFiles: 20,
  maxBytes: 100_000,
  maxDiffBytes: 20_000,
  admittedSessions: ['session_multi'],
  admittedAdapters: ['private.stdio.v1'],
  commitSemantics: 'commit-to-bound-branch',
  commitBindings: [
    { workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'aaa111' },
    { workspaceRoot: ROOT_B, branch: 'feat/b', headSha: 'bbb222' },
  ],
};

const LEASE: GoalLeaseRecord = {
  leaseId: 'lease_multi_workspace',
  createdAt: NOW - 1_000,
  notBefore: NOW - 1_000,
  expiresAt: NOW + 60_000,
  bindings: BINDINGS,
};

const request = (over: Partial<LeaseRequest>): LeaseRequest => ({
  tool: 'git.commit',
  sessionId: 'session_multi',
  adapterId: 'private.stdio.v1',
  workspaceRoot: ROOT_A,
  path: 'src/index.ts',
  diffBytes: 0,
  wantsCommit: true,
  branch: 'feat/a',
  headSha: 'aaa111',
  ...over,
});

const decide = (over: Partial<LeaseRequest>) => evaluateGoalLease({
  lease: LEASE,
  now: NOW,
  request: request(over),
  spend: { filesChanged: 0, bytesWritten: 0 },
  killSwitch: false,
});

test('one lease can bind independent branch and HEAD CAS values for multiple workspaces', () => {
  assert.equal(validateBindings(BINDINGS), undefined);

  assert.deepEqual(decide({}), { admitted: true });
  assert.deepEqual(decide({
    workspaceRoot: ROOT_B,
    branch: 'feat/b',
    headSha: 'bbb222',
  }), { admitted: true });

  assert.equal(
    (decide({ workspaceRoot: ROOT_A, branch: 'feat/b', headSha: 'aaa111' }) as { code: string }).code,
    'BRANCH_NOT_GRANTED',
  );
  assert.equal(
    (decide({ workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'bbb222' }) as { code: string }).code,
    'HEAD_MOVED',
  );
  assert.equal(
    (decide({ workspaceRoot: ROOT_B, branch: 'feat/a', headSha: 'bbb222' }) as { code: string }).code,
    'BRANCH_NOT_GRANTED',
  );
});

test('a workspace omitted from commitBindings may still edit or run commands but cannot commit', () => {
  const noCommit = decide({
    workspaceRoot: ROOT_C,
    branch: 'feat/c',
    headSha: 'ccc333',
  });
  assert.equal((noCommit as { code: string }).code, 'COMMIT_NOT_GRANTED');

  const mutation = evaluateGoalLease({
    lease: LEASE,
    now: NOW,
    request: request({
      workspaceRoot: ROOT_C,
      tool: 'mutation.preview',
      path: 'src/c.ts',
      diffBytes: 10,
      wantsCommit: false,
      branch: undefined,
      headSha: undefined,
    }),
    spend: { filesChanged: 0, bytesWritten: 0 },
    killSwitch: false,
  });
  assert.deepEqual(mutation, { admitted: true });

  const command = evaluateGoalLease({
    lease: LEASE,
    now: NOW,
    request: request({
      workspaceRoot: ROOT_C,
      tool: 'command.run',
      path: '.',
      diffBytes: 0,
      wantsCommit: false,
      branch: undefined,
      headSha: undefined,
    }),
    spend: { filesChanged: BINDINGS.maxFiles, bytesWritten: BINDINGS.maxBytes },
    killSwitch: false,
  });
  assert.deepEqual(command, { admitted: true });
});

test('multi-workspace commit bindings fail closed when malformed or ambiguous', () => {
  assert.match(
    validateBindings({
      ...BINDINGS,
      commitBindings: [
        { workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'aaa111' },
        { workspaceRoot: ROOT_A, branch: 'feat/a2', headSha: 'aaa222' },
      ],
    }) ?? '',
    /at most once/,
  );

  assert.match(
    validateBindings({
      ...BINDINGS,
      commitBindings: [
        { workspaceRoot: 'E:/outside', branch: 'feat/outside', headSha: 'outside' },
      ],
    }) ?? '',
    /workspaceRoots/,
  );

  assert.match(
    validateBindings({
      ...BINDINGS,
      branch: 'legacy',
      headSha: 'legacy-head',
    }) ?? '',
    /either branch\/headSha or commitBindings/,
  );

  assert.match(
    validateBindings({
      ...BINDINGS,
      commitSemantics: 'none',
    }) ?? '',
    /require commit-to-bound-branch/,
  );
});

test('the real commit coordinator executes two workspaces under their own CAS bindings', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'wag-multi-workspace-commit-'));
  const rootA = join(parent, 'a');
  const rootB = join(parent, 'b');
  await mkdir(join(rootA, 'src'), { recursive: true });
  await mkdir(join(rootB, 'src'), { recursive: true });
  await writeFile(join(rootA, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(rootB, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');

  const store = new SqliteDurableStore(join(parent, 'state.sqlite'));
  t.after(async () => {
    store.close();
    await rm(parent, { recursive: true, force: true });
  });

  const caller = createGatewayCallerContext({
    ownerId: 'owner_multi',
    sessionId: 'session_multi',
    adapterId: 'private.stdio.v1',
  });
  const workspaceA = store.openWorkspaceRecord({
    ...caller,
    canonicalRoot: rootA,
    backendKind: 'multi-stub-git',
    createdAt: NOW,
  });
  const workspaceB = store.openWorkspaceRecord({
    ...caller,
    canonicalRoot: rootB,
    backendKind: 'multi-stub-git',
    createdAt: NOW,
  });

  const plans = new Map<string, { branch: string; head: string; tree: string }>([
    [rootA, { branch: 'feat/a', head: 'a'.repeat(40), tree: '1'.repeat(40) }],
    [rootB, { branch: 'feat/b', head: 'b'.repeat(40), tree: '2'.repeat(40) }],
  ]);
  const committed: Array<{ root: string; branch: string; head: string }> = [];

  const backend: GitCommitBackend = {
    kind: 'multi-stub-git',
    async plan(root, paths): Promise<GitCommitPlan> {
      const p = plans.get(root);
      assert.ok(p, `unexpected root ${root}`);
      return {
        branch: p.branch,
        ref: `refs/heads/${p.branch}`,
        head: p.head,
        tree: p.tree,
        changes: paths.map((path) => ({ status: 'M', path })),
        author: 'WAG Test <wag@example.invalid>',
        committer: 'WAG Test <wag@example.invalid>',
        gitDir: join(root, '.git'),
        commonDir: join(root, '.git'),
        eolNormalized: [],
      };
    },
    async commit(root, request): Promise<GitCommitResult> {
      committed.push({
        root,
        branch: request.expectedBranch,
        head: request.expectedOldHead,
      });
      return {
        branch: request.expectedBranch,
        commit: root === rootA ? 'c'.repeat(40) : 'd'.repeat(40),
        tree: request.expectedTree,
        previousHead: request.expectedOldHead,
        changes: request.paths.map((path) => ({ status: 'M', path })),
      };
    },
  };

  const createdAt = Date.now();
  const leaseId = 'lease_multi_workspace_commit';
  store.insertGoalLease({
    leaseId,
    createdAt,
    notBefore: createdAt - 1_000,
    expiresAt: createdAt + 60_000,
    bindings: JSON.stringify({
      workspaceRoots: [rootA, rootB],
      allowedTools: ['git.commit'],
      pathPatterns: ['src/**'],
      maxFiles: 10,
      maxBytes: 1_000_000,
      maxDiffBytes: 100_000,
      admittedSessions: [caller.sessionId],
      admittedAdapters: [caller.adapterId],
      commitSemantics: 'commit-to-bound-branch',
      commitBindings: [
        { workspaceRoot: rootA, branch: 'feat/a', headSha: 'a'.repeat(40) },
        { workspaceRoot: rootB, branch: 'feat/b', headSha: 'b'.repeat(40) },
      ],
    } satisfies GoalLeaseBindings),
  });

  const coordinator = new DurableCommitCoordinator({
    store,
    backend,
    protectedBranches: ['main', 'master'],
    goalLease: { leaseId, killSwitch: () => false },
  });

  const previewA = await coordinator.preview(caller, workspaceA.workspaceId, {
    paths: ['src/a.ts'],
    message: 'commit lane a',
  });
  const previewB = await coordinator.preview(caller, workspaceB.workspaceId, {
    paths: ['src/b.ts'],
    message: 'commit lane b',
  });

  const admitted = await coordinator.admitPendingUnderLease();
  assert.deepEqual([...admitted].sort(), [previewA.commitId, previewB.commitId].sort());
  assert.equal(store.getCommit(previewA.commitId)?.state, 'SUCCEEDED');
  assert.equal(store.getCommit(previewB.commitId)?.state, 'SUCCEEDED');
  assert.deepEqual(committed, [
    { root: rootA, branch: 'feat/a', head: 'a'.repeat(40) },
    { root: rootB, branch: 'feat/b', head: 'b'.repeat(40) },
  ]);
});

test('rollover changes only commit HEAD CAS values, carries residual budget and admits successor heads', () => {
  const priorSpend = { filesChanged: 3, bytesWritten: 12_500 };
  const successor = rolloverCommitBindingHeads(BINDINGS, [
    { workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'aaa999' },
    { workspaceRoot: ROOT_B, branch: 'feat/b', headSha: 'bbb999' },
  ], priorSpend);

  const withoutMovingParts = (value: GoalLeaseBindings) => {
    const { maxFiles: _files, maxBytes: _bytes, commitBindings: _commits, ...fixed } = value;
    return fixed;
  };
  assert.deepEqual(
    withoutMovingParts(successor),
    withoutMovingParts(BINDINGS),
    'rollover must not widen or rewrite roots, tools, paths, sessions, adapters or commit semantics',
  );
  assert.equal(successor.maxFiles, BINDINGS.maxFiles - priorSpend.filesChanged);
  assert.equal(successor.maxBytes, BINDINGS.maxBytes - priorSpend.bytesWritten);
  assert.deepEqual(successor.commitBindings, [
    { workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'aaa999' },
    { workspaceRoot: ROOT_B, branch: 'feat/b', headSha: 'bbb999' },
  ]);

  const successorLease: GoalLeaseRecord = { ...LEASE, bindings: successor };
  const next = (over: Partial<LeaseRequest>) => evaluateGoalLease({
    lease: successorLease,
    now: NOW,
    request: request(over),
    // A successor lease has a fresh durable id. Residual ceilings above carry the predecessor's
    // spend forward without mutating the predecessor or resetting effective authority.
    spend: { filesChanged: 0, bytesWritten: 0 },
    killSwitch: false,
  });

  assert.deepEqual(next({ headSha: 'aaa999' }), { admitted: true });
  assert.equal((next({ headSha: 'aaa111' }) as { code: string }).code, 'HEAD_MOVED');
  assert.deepEqual(next({
    workspaceRoot: ROOT_B,
    branch: 'feat/b',
    headSha: 'bbb999',
  }), { admitted: true });
});

test('rollover refuses missing, extra, duplicate, branch-drift or exhausted-budget observations', () => {
  const noSpend = { filesChanged: 0, bytesWritten: 0 };
  const observations = [
    { workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'aaa999' },
    { workspaceRoot: ROOT_B, branch: 'feat/b', headSha: 'bbb999' },
  ];
  assert.throws(
    () => rolloverCommitBindingHeads(BINDINGS, [
      { workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'aaa999' },
    ], noSpend),
    /every commit-bound workspace/,
  );
  assert.throws(
    () => rolloverCommitBindingHeads(BINDINGS, [
      { workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'aaa999' },
      { workspaceRoot: ROOT_C, branch: 'feat/c', headSha: 'ccc999' },
    ], noSpend),
    /unbound workspaceRoot/,
  );
  assert.throws(
    () => rolloverCommitBindingHeads(BINDINGS, [
      { workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'aaa999' },
      { workspaceRoot: ROOT_A, branch: 'feat/a', headSha: 'aaa998' },
    ], noSpend),
    /repeats workspaceRoot/,
  );
  assert.throws(
    () => rolloverCommitBindingHeads(BINDINGS, [
      { workspaceRoot: ROOT_A, branch: 'feat/not-a', headSha: 'aaa999' },
      { workspaceRoot: ROOT_B, branch: 'feat/b', headSha: 'bbb999' },
    ], noSpend),
    /branch changed/,
  );
  assert.throws(
    () => rolloverCommitBindingHeads(BINDINGS, observations, {
      filesChanged: BINDINGS.maxFiles,
      bytesWritten: 0,
    }),
    /remaining mutation budget/,
  );
  assert.throws(
    () => rolloverCommitBindingHeads(BINDINGS, observations, {
      filesChanged: 0,
      bytesWritten: BINDINGS.maxBytes,
    }),
    /remaining mutation budget/,
  );
});
