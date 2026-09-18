import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  NATIVE_HOST_FILENAME,
  writeNativeHostDistributionBundle,
} from '../src/browser-adapter/native-host-distribution.js';
import { packageNativeHostRelease } from '../scripts/package-native-host-release.js';

const repository = 'ShenJun93/web-agent-gateway';
const sourceSha = 'a'.repeat(40);
const repoRoot = join(import.meta.dirname, '..');

async function createDistribution(root: string): Promise<string> {
  const executablePath = join(root, NATIVE_HOST_FILENAME);
  const distributionDirectory = join(root, 'distribution');
  await writeFile(executablePath, Buffer.from('MZ synthetic WAG native host release packaging fixture\n'));
  await writeNativeHostDistributionBundle({
    executablePath,
    packageLockPath: join(repoRoot, 'package-lock.json'),
    outputDir: distributionDirectory,
    metadata: {
      repository,
      sourceSha,
      sourceRef: 'refs/heads/main',
      workflowRunId: '123',
      runAttempt: 1,
      runner: { os: 'Windows', arch: 'X64', imageOS: 'win25', imageVersion: 'test' },
    },
  });
  return distributionDirectory;
}

test('native host outer release ZIP is deterministic and preserves exact inner distribution paths', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows deterministic ZIP implementation');
  const root = await mkdtemp(join(tmpdir(), 'wag-release-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const distributionDirectory = await createDistribution(root);
  const first = await packageNativeHostRelease({
    distributionDirectory,
    outputZip: join(root, 'first.zip'),
    expectedRepository: repository,
    expectedSourceSha: sourceSha,
  });
  const second = await packageNativeHostRelease({
    distributionDirectory,
    outputZip: join(root, 'second.zip'),
    expectedRepository: repository,
    expectedSourceSha: sourceSha,
  });

  assert.equal(first.sha256, second.sha256);
  assert.equal(first.entryCount, second.entryCount);
  const names = first.entries.map((entry) => entry.archivePath);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(
    names.filter((name) => name.startsWith('native-host/')),
    [
      'native-host/build-receipt.json',
      'native-host/wag-native-host.exe',
      'native-host/wag-native-host.exe.sha256',
    ],
  );
  for (const required of [
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
    'docs/native-host-installation.md',
    'docs/policies/code-signing-policy.md',
    'docs/policies/privacy.md',
    'third_party/native-host/NODE-v24.20.0-LICENSE',
  ]) assert.ok(names.includes(required), `missing ${required}`);
});

test('native host outer release packaging fails closed on distribution drift and existing output', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows deterministic ZIP implementation');
  const root = await mkdtemp(join(tmpdir(), 'wag-release-package-negative-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const distributionDirectory = await createDistribution(root);
  const outputZip = join(root, 'release.zip');
  await writeFile(outputZip, 'do not overwrite');
  await assert.rejects(
    packageNativeHostRelease({
      distributionDirectory,
      outputZip,
      expectedRepository: repository,
      expectedSourceSha: sourceSha,
    }),
    /already exists/,
  );

  await rm(outputZip);
  await writeFile(join(distributionDirectory, NATIVE_HOST_FILENAME), 'tampered');
  await assert.rejects(
    packageNativeHostRelease({
      distributionDirectory,
      outputZip,
      expectedRepository: repository,
      expectedSourceSha: sourceSha,
    }),
    /hash mismatch/,
  );
});
