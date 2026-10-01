import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { measureWorkspaceIdentity } from '../scripts/measure-workspace-identity.js';
import { workspaceIdentityFingerprint } from '../src/workspace-identity.js';

test('measureWorkspaceIdentity emits the exact runtime fingerprint tuple without authority state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-measure-workspace-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const expectedRoot = await realpath(dir);
  const measured = measureWorkspaceIdentity(expectedRoot);

  assert.equal(measured.version, 'wag.workspace-identity.measurement.v1');
  assert.equal(measured.observation.canonicalRoot, expectedRoot);
  assert.equal(measured.observation.backendKind, 'devspace');
  assert.match(measured.observation.fsDevice, /^\d+$/);
  assert.match(measured.observation.fsInode, /^\d+$/);
  assert.match(measured.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(measured.fingerprint, workspaceIdentityFingerprint(measured.observation));
  assert.deepEqual(measured.workspaceIdentity, {
    workspaceRoot: expectedRoot,
    fingerprint: measured.fingerprint,
  });
});
