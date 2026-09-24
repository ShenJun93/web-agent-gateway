import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import type { ArtifactHandle } from '../src/artifact-harness/artifact-port.js';
import { createBrowserUploadController } from '../src/browser-harness/browser-upload.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_up', sessionId: 'session_up', adapterId: 'private.stdio.v1' };

test('browser upload resolves opaque artifact ids to internal paths before semantic file selection', async () => {
  const gets: string[] = [];
  const sets: Array<{ session: string; ref: string; paths: readonly string[] }> = [];
  const artifacts = new Map<string, ArtifactHandle>([
    ['artifact_a', {
      artifactId: 'artifact_a', owner: OWNER, filename: 'a.txt', sizeBytes: 1,
      sha256: 'a'.repeat(64), createdAt: 1, internalPath: 'E:\\WAG-Artifacts\\a\\a.txt',
    }],
    ['artifact_b', {
      artifactId: 'artifact_b', owner: OWNER, filename: 'b.txt', sizeBytes: 1,
      sha256: 'b'.repeat(64), createdAt: 1, internalPath: 'E:\\WAG-Artifacts\\b\\b.txt',
    }],
  ]);
  const controller = createBrowserUploadController({
    artifacts: {
      async get(_owner, id) {
        gets.push(id);
        const artifact = artifacts.get(id);
        if (!artifact) throw new Error('missing artifact');
        return artifact;
      },
    },
    semantic: {
      async setFiles(_owner, session, ref, paths) { sets.push({ session, ref, paths }); },
    },
  });

  const result = await controller.upload(OWNER, 'browser_session', 'node_ref', ['artifact_a', 'artifact_b']);
  assert.deepEqual(gets, ['artifact_a', 'artifact_b']);
  assert.deepEqual(sets, [{
    session: 'browser_session',
    ref: 'node_ref',
    paths: ['E:\\WAG-Artifacts\\a\\a.txt', 'E:\\WAG-Artifacts\\b\\b.txt'],
  }]);
  assert.deepEqual(result.map((item) => item.artifactId), ['artifact_a', 'artifact_b']);
});

test('browser upload rejects empty and oversized artifact sets before any lookup', async () => {
  let calls = 0;
  const controller = createBrowserUploadController({
    artifacts: { async get() { calls += 1; throw new Error('not used'); } },
    semantic: { async setFiles() { throw new Error('not used'); } },
  });
  await assert.rejects(() => controller.upload(OWNER, 'b', 'r', []), /artifact set is invalid/);
  await assert.rejects(
    () => controller.upload(OWNER, 'b', 'r', Array.from({ length: 21 }, (_, i) => `a${i}`)),
    /artifact set is invalid/,
  );
  assert.equal(calls, 0);
});
