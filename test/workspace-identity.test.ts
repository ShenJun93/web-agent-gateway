import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  WorkspaceIdentityRegistry,
  workspaceIdentityFingerprint,
  type WorkspaceIdentityObservation,
} from '../src/workspace-identity.js';

const ROOT = 'E:/fixture/repo';
const NOW = 1_000_000;
const OBSERVATION: WorkspaceIdentityObservation = {
  canonicalRoot: ROOT,
  backendKind: 'devspace',
  fsDevice: '123',
  fsInode: '456',
  gitTopLevel: ROOT,
  gitDir: 'E:/fixture/repo/.git/worktrees/lane-a',
  gitCommonDir: 'E:/fixture/repo/.git',
};
const FINGERPRINT = workspaceIdentityFingerprint(OBSERVATION);

test('workspace identity fingerprint binds filesystem and git worktree identity but not mutable HEAD', () => {
  assert.equal(workspaceIdentityFingerprint(OBSERVATION), FINGERPRINT);
  assert.notEqual(
    workspaceIdentityFingerprint({ ...OBSERVATION, fsInode: '457' }),
    FINGERPRINT,
  );
  assert.notEqual(
    workspaceIdentityFingerprint({ ...OBSERVATION, gitDir: 'E:/fixture/repo/.git/worktrees/lane-b' }),
    FINGERPRINT,
  );
});

test('workspace identity registry is durable and refuses identity drift for one workspace id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-workspace-identity-'));
  const statePath = join(dir, 'state.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));

  let registry = new WorkspaceIdentityRegistry(statePath);
  const first = registry.record('ws_identity-a', OBSERVATION, NOW);
  assert.equal(first.fingerprint, FINGERPRINT);
  registry.close();

  registry = new WorkspaceIdentityRegistry(statePath);
  assert.equal(registry.fingerprint('ws_identity-a'), FINGERPRINT);
  assert.throws(
    () => registry.record('ws_identity-a', { ...OBSERVATION, fsInode: '999' }, NOW + 1),
    /workspace identity drift/i,
  );
  registry.close();
});
