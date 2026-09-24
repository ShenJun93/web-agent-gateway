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

const NOW = 2_000_000;
const BRANCH = 'feat/identity-effect';
const HEAD = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function caller() {
  return createGatewayCallerContext({
    ownerId: 'owner_workspace_identity_effect',
    sessionId: 'session_workspace_identity_effect',
    adapterId: 'adapter.workspace-identity-effect',
  });
}

class RecordingFileBackend implements FileMutationBackend {
  readonly kind = 'identity-effect-fs';
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

function recordingGitBackend() {
  const commits: GitCommitResult[] = [];
  const backend: GitCommitBackend = {
    kind: 'identity-effect-git',
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
        commit: 'e'.repeat(40),
        tree: request.expectedTree,
        previousHead: request.expectedOldHead,
        changes: request.paths.map((path) => ({ status: 'M', path })),
      };
      commits.push(result);
      return result;
    },
  };
  return { backend, commits };
}

test('autonomous mutation re-observes workspace identity immediately before filesystem effect', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-identity-effect-mutation-'));
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
    backendKind: 'identity-effect-fs',
    createdAt: NOW,
  });

  let liveCalls = 0;
  const backend = new RecordingFileBackend();
  const coordinator = new DurableMutationCoordinator({
    store,
    backends: [backend],
    now: () => NOW,
    autonomous: { killSwitch: () => false },
    effectBoundary: {
      async revalidateWorkspace(workspaceId, canonicalRoot) {
        liveCalls += 1;
        assert.equal(workspaceId, workspace.workspaceId);
        assert.equal(canonicalRoot, root);
        throw new Error('Workspace identity drift for existing workspace id');
      },
    },
  });

  const preview = await coordinator.preview(c, workspace.workspaceId, {
    path: 'note.txt',
    baseSha256: sha256('one\n'),
    before: 'one',
    after: 'two',
  });

  assert.deepEqual(await coordinator.admitByPolicy(preview.mutationId), { admitted: true });
  assert.equal(liveCalls, 1);
  assert.equal(backend.writes, 0);
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'one\n');
  assert.equal(store.getMutation(preview.mutationId)?.state, 'FAILED');
});

test('autonomous commit re-observes workspace identity immediately before ref-moving backend call', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-identity-effect-commit-'));
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
    backendKind: 'identity-effect-git',
    createdAt: NOW,
  });

  let liveCalls = 0;
  const { backend, commits } = recordingGitBackend();
  const coordinator = new DurableCommitCoordinator({
    store,
    backend,
    protectedBranches: ['main'],
    now: () => NOW,
    autonomous: { killSwitch: () => false },
    effectBoundary: {
      async revalidateWorkspace(workspaceId, canonicalRoot) {
        liveCalls += 1;
        assert.equal(workspaceId, workspace.workspaceId);
        assert.equal(canonicalRoot, root);
        throw new Error('Workspace identity drift for existing workspace id');
      },
    },
  });

  const preview = await coordinator.preview(c, workspace.workspaceId, {
    paths: ['src/a.ts'],
    message: 'identity effect boundary',
  });

  assert.deepEqual(await coordinator.admitByPolicy(preview.commitId), { admitted: true });
  assert.equal(liveCalls, 1);
  assert.equal(commits.length, 0);
  assert.equal(store.getCommit(preview.commitId)?.state, 'FAILED');
});
