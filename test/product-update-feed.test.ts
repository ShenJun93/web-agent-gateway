import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseBetaFeedArgs } from '../scripts/generate-wag-beta-feed.js';
import {
  checkProductUpdate,
} from '../src/product-update-discovery.js';
import {
  createSignedBetaFeed,
} from '../src/product-update-feed.js';
import type { ReleaseManifest } from '../src/product-release.js';

const GENERATED_AT = new Date('2026-10-03T03:00:00.000Z');
const PUBLISHED_AT = new Date('2026-10-03T02:59:00.000Z');

function releaseManifest(
  channel: ReleaseManifest['channel'] = 'beta',
): ReleaseManifest {
  return {
    schema: 'WAG_LOCAL_RELEASE_V1',
    releaseId: channel === 'beta' ? '1.1.0-beta.1' : '1.1.0',
    version: channel === 'beta' ? '1.1.0-beta.1' : '1.1.0',
    channel,
    sourceProvenance: 'git:' + 'a'.repeat(40),
    payloadSha256: 'b'.repeat(64),
    compatibility: { nodeMinMajor: 22, nodeMaxMajor: 26 },
    migrationVersion: 1,
    rollbackTarget: 'previous-active',
  };
}

async function writeCandidate(root: string, manifest: ReleaseManifest): Promise<{
  manifestPath: string;
  packagePath: string;
}> {
  const manifestPath = join(root, 'RELEASE.json');
  const packagePath = join(root, 'web-agent-gateway-beta.tgz');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await writeFile(packagePath, Buffer.from('signed-beta-package\n', 'utf8'));
  return { manifestPath, packagePath };
}

async function installFixture(
  root: string,
  sourceConfig: object,
): Promise<void> {
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'state'), { recursive: true });
  await mkdir(join(root, 'runtime', 'release-current'), { recursive: true });
  await writeFile(join(root, 'config', 'update-source.json'), JSON.stringify(sourceConfig, null, 2), 'utf8');
  await writeFile(join(root, 'config', 'product-settings.json'), JSON.stringify({
    schema: 'WAG_LOCAL_PRODUCT_SETTINGS_V1',
    updateChannel: 'beta',
    autoCheckUpdates: true,
  }, null, 2), 'utf8');
  await writeFile(join(root, 'state', 'release-state.json'), JSON.stringify({
    schema: 'WAG_LOCAL_RELEASE_STATE_V1',
    activeReleaseId: 'release-current',
    previousReleaseId: null,
    channel: 'stable',
    migrationVersion: 1,
    updatedAtUtc: '2026-10-03T01:00:00.000Z',
  }, null, 2), 'utf8');
  await writeFile(join(root, 'runtime', 'release-current', 'RELEASE.json'), JSON.stringify({
    ...releaseManifest('stable'),
    releaseId: 'release-current',
    version: '1.0.0',
  }, null, 2), 'utf8');
}

test('generated beta feed is accepted by product.update.check and selects the signed candidate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-beta-feed-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const keys = generateKeyPairSync('ed25519');
  const privateKeyPem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const manifest = releaseManifest('beta');
  const candidate = await writeCandidate(root, manifest);

  const generated = createSignedBetaFeed({
    releaseManifestPath: candidate.manifestPath,
    packagePath: candidate.packagePath,
    packageUrl: 'https://downloads.example.test/wag/1.1.0-beta.1.tgz',
    feedUrl: 'https://updates.example.test/wag/beta.json',
    privateKeyPem,
    generatedAt: GENERATED_AT,
    publishedAt: PUBLISHED_AT,
    ttlHours: 72,
  });

  assert.equal(generated.payload.channels.stable.length, 0);
  assert.equal(generated.payload.channels.beta.length, 1);
  assert.equal(generated.payload.channels.development.length, 0);
  assert.equal(generated.releaseId, manifest.releaseId);
  assert.match(generated.packageSha256, /^[a-f0-9]{64}$/);
  assert.match(generated.publicKeyFingerprintSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(generated).includes('PRIVATE KEY'), false);

  const installRoot = join(root, 'install');
  await installFixture(installRoot, generated.sourceConfig);
  const calls: string[] = [];
  const result = await checkProductUpdate({
    installRoot,
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      const body = JSON.stringify(generated.envelope);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
      });
    }) as typeof fetch,
    now: () => new Date('2026-10-03T04:00:00.000Z'),
    nodeMajor: 22,
  });

  assert.equal(result.status, 'UPDATE_AVAILABLE');
  assert.equal(result.available, true);
  assert.equal(result.channel, 'beta');
  assert.equal(result.candidate?.release_id, manifest.releaseId);
  assert.equal(result.candidate?.version, manifest.version);
  assert.equal(result.candidate?.package_sha256, generated.packageSha256);
  assert.equal(result.candidate?.package_size_bytes, generated.packageSizeBytes);
  assert.deepEqual(calls, ['https://updates.example.test/wag/beta.json']);
});

test('beta feed generator refuses stable manifests, non-Ed25519 keys, and non-HTTPS URLs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-beta-feed-deny-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const ed = generateKeyPairSync('ed25519');
  const edPem = ed.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const stable = await writeCandidate(root, releaseManifest('stable'));

  assert.throws(() => createSignedBetaFeed({
    releaseManifestPath: stable.manifestPath,
    packagePath: stable.packagePath,
    packageUrl: 'https://downloads.example.test/wag/1.1.0.tgz',
    feedUrl: 'https://updates.example.test/wag/beta.json',
    privateKeyPem: edPem,
    generatedAt: GENERATED_AT,
  }), /CHANNEL_MUST_BE_BETA/);

  const beta = await writeCandidate(root, releaseManifest('beta'));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPem = rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(() => createSignedBetaFeed({
    releaseManifestPath: beta.manifestPath,
    packagePath: beta.packagePath,
    packageUrl: 'https://downloads.example.test/wag/1.1.0-beta.1.tgz',
    feedUrl: 'https://updates.example.test/wag/beta.json',
    privateKeyPem: rsaPem,
    generatedAt: GENERATED_AT,
  }), /SIGNING_KEY_INVALID/);

  assert.throws(() => createSignedBetaFeed({
    releaseManifestPath: beta.manifestPath,
    packagePath: beta.packagePath,
    packageUrl: 'http://downloads.example.test/wag/1.1.0-beta.1.tgz',
    feedUrl: 'https://updates.example.test/wag/beta.json',
    privateKeyPem: edPem,
    generatedAt: GENERATED_AT,
  }), /PACKAGE_URL_INVALID/);
});

test('beta feed CLI accepts only the fixed signing-key environment reference', () => {
  const common = [
    '--release-manifest', 'RELEASE.json',
    '--package', 'package.tgz',
    '--package-url', 'https://downloads.example.test/wag/package.tgz',
    '--feed-url', 'https://updates.example.test/wag/beta.json',
    '--output', 'beta-feed.json',
    '--source-config-output', 'update-source.json',
  ];

  const parsed = parseBetaFeedArgs([
    ...common,
    '--signing-key-ref', 'env:WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM',
    '--ttl-hours', '48',
    '--generated-at-utc', '2026-10-03T03:00:00.000Z',
  ]);
  assert.equal(parsed.signingKeyRef, 'env:WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM');
  assert.equal(parsed.ttlHours, 48);

  assert.throws(() => parseBetaFeedArgs([
    ...common,
    '--signing-key-ref', 'raw-private-key-material',
  ]), /signing-key-ref must be env:WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM/);

  assert.throws(() => parseBetaFeedArgs([
    ...common,
    '--signing-key-ref', 'env:OTHER_SECRET',
  ]), /signing-key-ref must be env:WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM/);
});
