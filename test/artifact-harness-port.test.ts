import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import { ArtifactPort } from '../src/artifact-harness/artifact-port.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_art', sessionId: 'session_art', adapterId: 'private.stdio.v1' };
const OTHER: GatewayAuthority = { ownerId: 'owner_art', sessionId: 'session_other', adapterId: 'private.stdio.v1' };

test('ArtifactPort imports only an authorized file and persists content-addressed ownership metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-artifacts-'));
  const source = join(dir, 'report.txt');
  const root = join(dir, 'store');
  await writeFile(source, 'alpha\n', 'utf8');
  const authorizations: string[] = [];
  const port = new ArtifactPort({
    root,
    authorizeSource: async (_owner, requested) => { authorizations.push(requested); return requested; },
    now: () => 1234,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const artifact = await port.importFile(OWNER, source);
  assert.equal(artifact.artifactId, 'artifact_00000000-0000-4000-8000-000000000001');
  assert.equal(artifact.filename, 'report.txt');
  assert.equal(artifact.sizeBytes, 6);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(authorizations, [source]);
  assert.equal(await readFile(artifact.internalPath, 'utf8'), 'alpha\n');

  const manifest = await readFile(join(root, artifact.artifactId, 'META.json'), 'utf8');
  assert.equal(manifest.includes(source), false);
  assert.match(manifest, /"ownerId": "owner_art"/);
  await assert.rejects(() => port.get(OTHER, artifact.artifactId), /another authority/);
});

test('ArtifactPort detects payload divergence instead of trusting stale metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-artifacts-'));
  const source = join(dir, 'input.bin');
  await writeFile(source, Buffer.from([1, 2, 3]));
  const port = new ArtifactPort({
    root: join(dir, 'store'),
    authorizeSource: async (_owner, requested) => requested,
    randomUUID: () => '00000000-0000-4000-8000-000000000002',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifact = await port.importFile(OWNER, source);
  await writeFile(artifact.internalPath, Buffer.from([9, 9, 9]));
  await assert.rejects(() => port.get(OWNER, artifact.artifactId), /content diverged/);
});

test('ArtifactPort survives a new instance and lists only caller-owned artifacts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-artifacts-'));
  const root = join(dir, 'store');
  const firstSource = join(dir, 'one.txt');
  const secondSource = join(dir, 'two.txt');
  await writeFile(firstSource, 'one', 'utf8');
  await writeFile(secondSource, 'two', 'utf8');
  let n = 3;
  const make = () => new ArtifactPort({
    root,
    authorizeSource: async (_owner, requested) => requested,
    randomUUID: () => `00000000-0000-4000-8000-00000000000${n++}`,
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = make();
  const a = await first.importFile(OWNER, firstSource);
  await first.importFile(OTHER, secondSource);
  const reopened = make();
  assert.equal((await reopened.get(OWNER, a.artifactId)).sha256, a.sha256);
  assert.deepEqual((await reopened.list(OWNER)).map((item) => item.artifactId), [a.artifactId]);
  await reopened.remove(OWNER, a.artifactId);
  await assert.rejects(() => reopened.get(OWNER, a.artifactId));
});
