import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkProductUpdate,
  type ProductUpdateCheck,
} from '../src/product-update-discovery.js';
import type { ReleaseManifest } from '../src/product-release.js';

const NOW = new Date('2026-09-30T09:30:00.000Z');

interface Fixture {
  root: string;
  sourcePath: string;
  privateKey: KeyObject;
  feedUrl: string;
}

function manifest(
  releaseId: string,
  version: string,
  overrides: Partial<ReleaseManifest> = {},
): ReleaseManifest {
  return {
    schema: 'WAG_LOCAL_RELEASE_V1',
    releaseId,
    version,
    channel: 'stable',
    sourceProvenance: 'git:' + 'a'.repeat(40),
    payloadSha256: 'b'.repeat(64),
    compatibility: { nodeMinMajor: 22, nodeMaxMajor: 26 },
    migrationVersion: 1,
    rollbackTarget: 'previous-active',
    ...overrides,
  };
}

async function fixture(t: test.TestContext, currentVersion = '1.0.0'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'wag-update-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'state'), { recursive: true });
  await mkdir(join(root, 'runtime', 'release-1'), { recursive: true });

  await writeFile(join(root, 'state', 'release-state.json'), JSON.stringify({
    schema: 'WAG_LOCAL_RELEASE_STATE_V1',
    activeReleaseId: 'release-1',
    previousReleaseId: null,
    channel: 'stable',
    migrationVersion: 1,
    updatedAtUtc: '2026-09-30T08:00:00.000Z',
  }, null, 2), 'utf8');

  if (currentVersion) {
    await writeFile(
      join(root, 'runtime', 'release-1', 'RELEASE.json'),
      JSON.stringify(manifest('release-1', currentVersion), null, 2),
      'utf8',
    );
  }

  const keys = generateKeyPairSync('ed25519');
  const publicDer = keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const feedUrl = 'https://updates.example.test/wag/feed.json';
  const sourcePath = join(root, 'config', 'update-source.json');
  await writeFile(sourcePath, JSON.stringify({
    schema: 'WAG_LOCAL_UPDATE_SOURCE_V1',
    feedUrl,
    ed25519PublicKeySpkiDerBase64: publicDer.toString('base64'),
    timeoutMs: 1000,
    maxBytes: 128 * 1024,
  }, null, 2), 'utf8');

  return { root, sourcePath, privateKey: keys.privateKey, feedUrl };
}

function feedPayload(rows: ReleaseManifest[], overrides: Record<string, unknown> = {}) {
  return {
    schema: 'WAG_LOCAL_UPDATE_FEED_V1',
    generatedAtUtc: '2026-09-30T09:00:00.000Z',
    expiresAtUtc: '2026-09-30T12:00:00.000Z',
    channels: {
      stable: rows.map((row, index) => ({
        manifest: row,
        packageUrl: `https://downloads.example.test/wag/${row.releaseId}.tgz`,
        packageSha256: String(index + 1).padStart(64, 'c').slice(0, 64),
        packageSizeBytes: 350_000 + index,
        publishedAtUtc: `2026-09-30T09:0${index}:00.000Z`,
      })),
      beta: [],
      development: [],
    },
    ...overrides,
  };
}

function signedResponse(privateKey: Fixture['privateKey'], payload: object, mutateSignature = false): Response {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, bytes, privateKey);
  if (mutateSignature) signature[0] = signature[0]! ^ 0xff;
  const body = JSON.stringify({
    schema: 'WAG_LOCAL_UPDATE_ENVELOPE_V1',
    payloadBase64: bytes.toString('base64'),
    signatureBase64: signature.toString('base64'),
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
  });
}

function fetchOnce(response: Response, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));
    return response;
  }) as typeof fetch;
}

test('signed discovery selects the newest compatible release and never mutates runtime state', async (t) => {
  const f = await fixture(t);
  const beforeState = await readFile(join(f.root, 'state', 'release-state.json'), 'utf8');
  const calls: string[] = [];
  const payload = feedPayload([
    manifest('release-1.1', '1.1.0'),
    manifest('release-2-incompatible', '2.0.0', {
      compatibility: { nodeMinMajor: 99, nodeMaxMajor: 100 },
    }),
    manifest('release-1.2', '1.2.0'),
  ]);

  const result = await checkProductUpdate({
    installRoot: f.root,
    fetchImpl: fetchOnce(signedResponse(f.privateKey, payload), calls),
    now: () => NOW,
    nodeMajor: 22,
  });

  assert.equal(result.status, 'UPDATE_AVAILABLE');
  assert.equal(result.available, true);
  assert.equal(result.candidate?.release_id, 'release-1.2');
  assert.equal(result.candidate?.version, '1.2.0');
  assert.equal(result.current?.release_id, 'release-1');
  assert.equal(result.current?.version, '1.0.0');
  assert.deepEqual(calls, [f.feedUrl]);
  assert.equal(await readFile(join(f.root, 'state', 'release-state.json'), 'utf8'), beforeState);
});

test('bad signature fails closed before release selection', async (t) => {
  const f = await fixture(t);
  const result = await checkProductUpdate({
    installRoot: f.root,
    fetchImpl: fetchOnce(
      signedResponse(f.privateKey, feedPayload([manifest('release-1.1', '1.1.0')]), true),
      [],
    ),
    now: () => NOW,
    nodeMajor: 22,
  });
  assert.equal(result.status, 'INVALID_METADATA');
  assert.equal(result.available, null);
  assert.equal(result.candidate, null);
  assert.equal(result.failure_code, 'WAG_UPDATE_METADATA_INVALID');
});

test('expired signed metadata is deterministic and does not expose a candidate', async (t) => {
  const f = await fixture(t);
  const payload = feedPayload([manifest('release-1.1', '1.1.0')], {
    expiresAtUtc: '2026-09-30T09:10:00.000Z',
  });
  const result = await checkProductUpdate({
    installRoot: f.root,
    fetchImpl: fetchOnce(signedResponse(f.privateKey, payload), []),
    now: () => NOW,
    nodeMajor: 22,
  });
  assert.equal(result.status, 'EXPIRED');
  assert.equal(result.available, null);
  assert.equal(result.candidate, null);
});

test('offline feed reports a stable read-only status', async (t) => {
  const f = await fixture(t);
  const result = await checkProductUpdate({
    installRoot: f.root,
    fetchImpl: (async () => { throw new Error('network details must not escape'); }) as typeof fetch,
    now: () => NOW,
    nodeMajor: 22,
  });
  assert.equal(result.status, 'OFFLINE');
  assert.equal(result.failure_code, 'WAG_UPDATE_FEED_UNREACHABLE');
  assert.equal(JSON.stringify(result).includes('network details must not escape'), false);
});

test('disabled automatic checks perform zero network calls', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'config', 'product-settings.json'), JSON.stringify({
    schema: 'WAG_LOCAL_PRODUCT_SETTINGS_V1',
    updateChannel: 'stable',
    autoCheckUpdates: false,
  }, null, 2), 'utf8');

  let calls = 0;
  const result = await checkProductUpdate({
    installRoot: f.root,
    fetchImpl: (async () => {
      calls += 1;
      throw new Error('must not be called');
    }) as typeof fetch,
    now: () => NOW,
    nodeMajor: 22,
    respectAutoCheck: true,
  });

  assert.equal(result.status, 'DISABLED');
  assert.equal(result.auto_check_updates, false);
  assert.equal(calls, 0);
});

test('incompatible signed releases are ignored rather than treated as invalid metadata', async (t) => {
  const f = await fixture(t);
  const payload = feedPayload([
    manifest('release-node99', '9.0.0', {
      compatibility: { nodeMinMajor: 99, nodeMaxMajor: 100 },
    }),
  ]);
  const result = await checkProductUpdate({
    installRoot: f.root,
    fetchImpl: fetchOnce(signedResponse(f.privateKey, payload), []),
    now: () => NOW,
    nodeMajor: 22,
  });
  assert.equal(result.status, 'NO_COMPATIBLE_RELEASE');
  assert.equal(result.available, false);
  assert.equal(result.candidate, null);
});

test('same active release is current and a legacy version is never guessed', async (t) => {
  const current = await fixture(t);
  const currentResult = await checkProductUpdate({
    installRoot: current.root,
    fetchImpl: fetchOnce(
      signedResponse(current.privateKey, feedPayload([manifest('release-1', '1.0.0')])),
      [],
    ),
    now: () => NOW,
    nodeMajor: 22,
  });
  assert.equal(currentResult.status, 'CURRENT');
  assert.equal(currentResult.available, false);

  const legacy = await fixture(t, '');
  const legacyResult = await checkProductUpdate({
    installRoot: legacy.root,
    fetchImpl: fetchOnce(
      signedResponse(legacy.privateKey, feedPayload([manifest('release-1.1', '1.1.0')])),
      [],
    ),
    now: () => NOW,
    nodeMajor: 22,
  });
  assert.equal(legacyResult.status, 'CURRENT_VERSION_UNKNOWN');
  assert.equal(legacyResult.available, null);
  assert.equal(legacyResult.candidate?.release_id, 'release-1.1');
});
