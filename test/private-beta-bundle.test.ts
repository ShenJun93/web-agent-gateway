import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  privateBetaReleaseId,
  validatePrivateBetaBundleManifest,
  type PrivateBetaBundleManifest,
} from '../scripts/package-private-beta-bundle.js';

const SOURCE_SHA = 'a'.repeat(40);
const VERSION = '0.1.0';
const RELEASE_ID = privateBetaReleaseId(VERSION, SOURCE_SHA);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function extensionTree(files: readonly { path: string; bytes: Uint8Array }[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function validManifest(): PrivateBetaBundleManifest {
  return {
    schema: 'WAG_PRIVATE_BETA_BUNDLE_V1',
    sourceSha: SOURCE_SHA,
    releaseId: RELEASE_ID,
    version: VERSION,
    channel: 'beta',
    signing: {
      state: 'UNSIGNED_PRIVATE_BETA',
      authenticodeTrusted: false,
    },
    package: {
      path: 'package/web-agent-gateway-0.1.0.tgz',
      sha256: 'b'.repeat(64),
      sizeBytes: 123,
      payloadSha256: 'c'.repeat(64),
    },
    extension: {
      path: 'browser-extension',
      sourceHead: SOURCE_SHA,
      treeSha256: 'd'.repeat(64),
      files: [
        { path: 'manifest.json', sha256: 'e'.repeat(64), sizeBytes: 12 },
      ],
    },
    privacy: {
      automaticUpload: false,
      receiptConsentRequired: true,
    },
  };
}

test('private beta release id is exact-source and rejects invalid identity inputs', () => {
  assert.equal(RELEASE_ID, '0.1.0-beta-' + SOURCE_SHA.slice(0, 12));
  assert.throws(() => privateBetaReleaseId('beta', SOURCE_SHA), /version/i);
  assert.throws(() => privateBetaReleaseId(VERSION, 'A'.repeat(40)), /source SHA/i);
});

test('private beta manifest validator accepts the bounded unsigned beta contract and rejects authority/privacy drift', () => {
  const manifest = validManifest();
  assert.equal(validatePrivateBetaBundleManifest(manifest), manifest);

  assert.throws(
    () => validatePrivateBetaBundleManifest({
      ...manifest,
      signing: { ...manifest.signing, authenticodeTrusted: true },
    }),
    /manifest is invalid/i,
  );
  assert.throws(
    () => validatePrivateBetaBundleManifest({
      ...manifest,
      privacy: { ...manifest.privacy, automaticUpload: true },
    }),
    /manifest is invalid/i,
  );
  assert.throws(
    () => validatePrivateBetaBundleManifest({
      ...manifest,
      package: { ...manifest.package, path: '../escape.tgz' },
    }),
    /manifest is invalid/i,
  );
});

test('private beta installer VerifyOnly validates package bytes, extension files, and extension tree hash', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows private beta installer');

  const root = await mkdtemp(join(tmpdir(), 'wag-private-beta-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundleRoot = join(root, 'bundle');
  const packageRoot = join(bundleRoot, 'package');
  const extensionRoot = join(bundleRoot, 'browser-extension');
  await mkdir(packageRoot, { recursive: true });
  await mkdir(extensionRoot, { recursive: true });
  await copyFile(
    join(import.meta.dirname, '..', 'scripts', 'wag-private-beta-install.ps1'),
    join(bundleRoot, 'INSTALL-WAG-BETA.ps1'),
  );

  const packageBytes = Buffer.from('synthetic private beta package\n', 'utf8');
  const extensionFiles = [
    {
      path: 'manifest.json',
      bytes: Buffer.from('{"manifest_version":3}\n', 'utf8'),
    },
    {
      path: 'release-identity.js',
      bytes: Buffer.from(
        "export const EXTENSION_RELEASE_IDENTITY = Object.freeze({ schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1', sourceHead: '" + SOURCE_SHA + "' });\n",
        'utf8',
      ),
    },
  ] as const;
  const packageName = 'web-agent-gateway-0.1.0.tgz';
  await writeFile(join(packageRoot, packageName), packageBytes);
  for (const file of extensionFiles) {
    await writeFile(join(extensionRoot, file.path), file.bytes);
  }

  const manifest: PrivateBetaBundleManifest = {
    schema: 'WAG_PRIVATE_BETA_BUNDLE_V1',
    sourceSha: SOURCE_SHA,
    releaseId: RELEASE_ID,
    version: VERSION,
    channel: 'beta',
    signing: {
      state: 'UNSIGNED_PRIVATE_BETA',
      authenticodeTrusted: false,
    },
    package: {
      path: 'package/' + packageName,
      sha256: sha256(packageBytes),
      sizeBytes: packageBytes.length,
      payloadSha256: 'f'.repeat(64),
    },
    extension: {
      path: 'browser-extension',
      sourceHead: SOURCE_SHA,
      treeSha256: extensionTree(extensionFiles),
      files: extensionFiles.map((file) => ({
        path: file.path,
        sha256: sha256(file.bytes),
        sizeBytes: file.bytes.length,
      })),
    },
    privacy: {
      automaticUpload: false,
      receiptConsentRequired: true,
    },
  };
  const manifestPath = join(bundleRoot, 'PRIVATE_BETA_BUNDLE.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const runVerify = () => spawnSync('pwsh.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(bundleRoot, 'INSTALL-WAG-BETA.ps1'),
    '-VerifyOnly',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: join(root, 'localappdata') },
    timeout: 20_000,
  });

  const ok = runVerify();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /WAG_BETA_VERIFY=PASS/);
  assert.match(ok.stdout, new RegExp('WAG_BETA_EXTENSION_SHA256=' + manifest.extension.treeSha256));

  await writeFile(manifestPath, JSON.stringify({
    ...manifest,
    extension: { ...manifest.extension, treeSha256: '0'.repeat(64) },
  }, null, 2) + '\n', 'utf8');
  const wrongTree = runVerify();
  assert.notEqual(wrongTree.status, 0);
  assert.match(wrongTree.stderr + wrongTree.stdout, /extension tree SHA-256 mismatch/i);

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await writeFile(join(extensionRoot, 'manifest.json'), Buffer.from('tampered\n', 'utf8'));
  const tamperedFile = runVerify();
  assert.notEqual(tamperedFile.status, 0);
  assert.match(tamperedFile.stderr + tamperedFile.stdout, /extension (?:size|SHA-256) mismatch/i);

  assert.equal((await readFile(join(bundleRoot, 'INSTALL-WAG-BETA.ps1'), 'utf8')).includes('Disable'), false);
});
