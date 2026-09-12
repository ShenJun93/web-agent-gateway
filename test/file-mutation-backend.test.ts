import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DevspaceExecutor, type DevspacePatchResult } from '../src/executor/devspace.js';
import { DevspaceFileMutationBackend } from '../src/executor/devspace-file-mutation.js';
import { startPinnedDevspace } from './devspace-fixture.js';

async function setup(t: test.TestContext, content: string) {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const target = join(fixture.workspaceRoot, 'note.txt');
  await writeFile(target, content);
  const executor = new DevspaceExecutor(fixture);
  const backend = new DevspaceFileMutationBackend(executor);
  return { fixture, target, backend };
}

test('devspace file backend reads exact text and updates one LF file', async (t) => {
  const original = 'alpha\nbeta\ngamma\n';
  const candidate = 'alpha\nBETA\ngamma\n';
  const { fixture, target, backend } = await setup(t, original);

  assert.equal(await backend.readExact(fixture.workspaceRoot, 'note.txt'), original);
  await backend.updateExisting(fixture.workspaceRoot, 'note.txt', original, candidate);
  assert.equal(await readFile(target, 'utf8'), candidate);
});

test('devspace file backend preserves CRLF bytes', async (t) => {
  const original = 'alpha\r\nbeta\r\ngamma\r\n';
  const candidate = 'alpha\r\nBETA\r\ngamma\r\n';
  const { fixture, target, backend } = await setup(t, original);

  await backend.updateExisting(fixture.workspaceRoot, 'note.txt', original, candidate);
  assert.equal(await readFile(target, 'utf8'), candidate);
});

test('devspace file backend rejects donor metadata for a different change', async () => {
  const executor = fakeExecutor({
    result: 'bad', additions: 1, removals: 1,
    files: [{ path: 'other.txt', operation: 'update' }],
  });
  const backend = new DevspaceFileMutationBackend(executor);

  await assert.rejects(
    backend.updateExisting('C:\\fixture', 'note.txt', 'beta', 'BETA'),
    /patch result/,
  );
});

test('devspace file backend rejects post-write mismatch', async () => {
  const executor = fakeExecutor({
    result: 'ok', additions: 1, removals: 1,
    files: [{ path: 'note.txt', operation: 'update' }],
  }, 'WRONG');
  const backend = new DevspaceFileMutationBackend(executor);

  await assert.rejects(
    backend.updateExisting('C:\\fixture', 'note.txt', 'beta', 'BETA'),
    /post-write mismatch/,
  );
});

function fakeExecutor(patchResult: DevspacePatchResult, postRead = 'BETA'): DevspaceExecutor {
  let reads = 0;
  return {
    openWorkspace: async () => 'dws_fake',
    readFile: async () => {
      reads += 1;
      return reads === 1 ? 'beta' : postRead;
    },
    applyPatch: async () => patchResult,
  } as unknown as DevspaceExecutor;
}
