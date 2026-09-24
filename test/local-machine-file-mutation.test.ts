import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalMachineFileMutationBackend } from '../src/executor/local-machine-file-mutation.js';

test('local-machine file backend creates and CAS-replaces exact UTF-8 files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-local-file-backend-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = new LocalMachineFileMutationBackend();

  await backend.createNew(root, 'fresh.txt', 'one\n');
  assert.equal(await readFile(join(root, 'fresh.txt'), 'utf8'), 'one\n');

  await backend.updateExisting(root, 'fresh.txt', 'one\n', 'two\n');
  assert.equal(await backend.readExact(root, 'fresh.txt'), 'two\n');

  await writeFile(join(root, 'fresh.txt'), 'drift\n', 'utf8');
  await assert.rejects(
    () => backend.updateExisting(root, 'fresh.txt', 'two\n', 'three\n'),
    /stale target/,
  );
  assert.equal(await readFile(join(root, 'fresh.txt'), 'utf8'), 'drift\n');
});

test('local-machine file backend refuses creation over an existing path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-local-file-existing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'taken.txt'), 'original\n', 'utf8');
  const backend = new LocalMachineFileMutationBackend();

  await assert.rejects(() => backend.createNew(root, 'taken.txt', 'replacement\n'));
  assert.equal(await readFile(join(root, 'taken.txt'), 'utf8'), 'original\n');
});

test('local-machine file backend refuses a redacted full-content round-trip', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-local-file-redacted-roundtrip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = new LocalMachineFileMutationBackend();
  const original = 'API_KEY=fixture-secret-value\nmode=one\n';
  await writeFile(join(root, 'config.txt'), original, 'utf8');

  await assert.rejects(
    () => backend.updateExisting(
      root,
      'config.txt',
      original,
      'API_KEY=<REDACTED>\nmode=two\n',
    ),
    /redacted file\.replace round-trip/,
  );
  assert.equal(await readFile(join(root, 'config.txt'), 'utf8'), original);

  const exactServerSideCandidate = original.replace('mode=one', 'mode=two');
  await backend.updateExisting(root, 'config.txt', original, exactServerSideCandidate);
  assert.equal(await readFile(join(root, 'config.txt'), 'utf8'), exactServerSideCandidate);
});
