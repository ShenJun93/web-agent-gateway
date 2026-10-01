import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import type { FileMutationBackend } from '../src/file-mutation-backend.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import type { GitCommitBackend, GitCommitPlan, GitCommitResult } from '../src/git-commit-backend.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const caller = createGatewayCallerContext({
  ownerId: 'owner_autonomous',
  sessionId: 'session_autonomous',
  adapterId: 'private.stdio.v1',
});

class FsBackend implements FileMutationBackend {
  readonly kind = 'autonomous-fs';

  async readExact(root: string, path: string): Promise<string> {
    return readFile(join(root, path), 'utf8');
  }

  async readExactIfPresent(root: string, path: string): Promise<string | undefined> {
    try {
      return await this.readExact(root, path);
    } catch {
      return undefined;
    }
  }

  async createNew(root: string, path: string, candidate: string): Promise<void> {
    await writeFile(join(root, path), candidate, { encoding: 'utf8', flag: 'wx' });
  }

  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    const target = join(root, path);
    assert.equal(await readFile(target, 'utf8'), original, 'backend CAS input drift');
    await writeFile(target, candidate, 'utf8');
  }
}

test('autonomous mutation executes with POLICY_APPROVED and no lease id', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-autonomous-mutation-'));
  const store = new SqliteDurableStore(join(root, 'state.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const backend = new FsBackend();
  const workspace = store.openWorkspaceRecord({
    ...caller,
    canonicalRoot: root,
    backendKind: backend.kind,
    createdAt: 1_000,
  });
  let killed = false;
  let now = 1_000;
  const coordinator = new DurableMutationCoordinator({
    store,
    backends: [backend],
    now: () => now,
    autonomous: { killSwitch: () => killed },
  });

  await writeFile(join(root, 'note.txt'), 'alpha\n', 'utf8');
  const preview = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt',
    baseSha256: sha256('alpha\n'),
    before: 'alpha',
    after: 'beta',
  });
  assert.deepEqual(await coordinator.admitByPolicy(preview.mutationId), { admitted: true });

  const authority = store.getMutationAuthority(preview.mutationId);
  assert.equal(authority?.authority, 'POLICY_APPROVED');
  assert.equal(authority?.retiredPolicyAuthority, undefined);
  assert.equal(coordinator.result(caller, preview.mutationId).state, 'SUCCEEDED');
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'beta\n');

  const blocked = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt',
    baseSha256: sha256('beta\n'),
    before: 'beta',
    after: 'gamma',
  });
  const queued = store.policyAdmitMutation({
    mutationId: blocked.mutationId,
    now,
    admissionTtlMs: 60_000,
  });
  assert.equal(queued?.state, 'QUEUED');
  killed = true;
  now += 1;
  await coordinator.reconcile();

  assert.equal(store.getMutation(blocked.mutationId)?.state, 'FAILED');
  assert.equal(store.getMutation(blocked.mutationId)?.errorClass, 'ExecutionPolicy_KILL_SWITCH_ENGAGED');
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'beta\n');
});

class StubGitBackend implements GitCommitBackend {
  readonly kind = 'autonomous-git';
  readonly committed: GitCommitResult[] = [];

  async plan(_root: string, paths: readonly string[]): Promise<GitCommitPlan> {
    return {
      branch: 'work',
      ref: 'refs/heads/work',
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      changes: paths.map((path) => ({ status: 'M' as const, path })),
      author: 'WAG Test <wag@example.invalid>',
      committer: 'WAG Test <wag@example.invalid>',
      gitDir: 'E:/fixture/.git',
      commonDir: 'E:/fixture/.git',
      eolNormalized: [],
    };
  }

  async commit(_root: string, request: {
    paths: readonly string[];
    message: string;
    expectedBranch: string;
    expectedOldHead: string;
    expectedTree: string;
    expectedAuthor: string;
    expectedCommitter: string;
    expectedGitDir: string;
    expectedCommonDir: string;
  }): Promise<GitCommitResult> {
    const result: GitCommitResult = {
      branch: request.expectedBranch,
      commit: 'c'.repeat(40),
      tree: request.expectedTree,
      previousHead: request.expectedOldHead,
      changes: request.paths.map((path) => ({ status: 'M' as const, path })),
    };
    this.committed.push(result);
    return result;
  }
}

test('autonomous commit executes with POLICY_APPROVED/no lease and kill switch revalidates before ref move', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-autonomous-commit-'));
  const store = new SqliteDurableStore(join(root, 'state.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  const workspace = store.openWorkspaceRecord({
    ...caller,
    canonicalRoot: root,
    backendKind: 'autonomous-git',
    createdAt: 1_000,
  });
  const backend = new StubGitBackend();
  let killed = false;
  let now = 1_000;
  const coordinator = new DurableCommitCoordinator({
    store,
    backend,
    now: () => now,
    autonomous: { killSwitch: () => killed },
  });

  const first = await coordinator.preview(caller, workspace.workspaceId, {
    paths: ['src/a.ts'],
    message: 'test: autonomous commit',
  });
  assert.deepEqual(await coordinator.admitByPolicy(first.commitId), { admitted: true });
  const authority = store.getCommitAuthority(first.commitId);
  assert.equal(authority?.authority, 'POLICY_APPROVED');
  assert.equal(authority?.retiredPolicyAuthority, undefined);
  assert.equal(coordinator.result(caller, first.commitId).state, 'SUCCEEDED');
  assert.equal(backend.committed.length, 1);

  const second = await coordinator.preview(caller, workspace.workspaceId, {
    paths: ['src/a.ts'],
    message: 'test: blocked autonomous commit',
  });
  const record = store.getCommit(second.commitId);
  assert.ok(record);
  store.recordCommitAuthority({
    commitId: second.commitId,
    authority: 'POLICY_APPROVED',
    admittedAt: now,
    fingerprint: record.fingerprint,
    workspaceId: record.workspaceId,
    branch: record.branch,
    oldHead: record.oldHead,
    pathCount: record.paths.length,
  });

  killed = true;
  now += 1;
  assert.equal(await coordinator.approveLocal(second.commitId), true);
  assert.equal(store.getCommit(second.commitId)?.state, 'FAILED');
  assert.equal(store.getCommit(second.commitId)?.errorClass, 'ExecutionPolicy_KILL_SWITCH_ENGAGED');
  assert.equal(backend.committed.length, 1, 'kill switch must stop the backend commit/ref move');
});
