import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BROWSER_ADAPTER_EXTENSION_ID,
  NATIVE_HOST_FILENAME,
  parseNativeHostBuildReceipt,
  verifyNativeHostDistributionDirectory,
  writeNativeHostDistributionBundle,
} from '../src/browser-adapter/native-host-distribution.js';

const execFileAsync = promisify(execFile);
const sourceSha = 'd'.repeat(40);

function metadata() {
  return {
    repository: 'ShenJun93/web-agent-gateway',
    sourceSha,
    sourceRef: 'refs/heads/main',
    workflowRunId: '987654321',
    runAttempt: 2,
    runner: { os: 'Windows' as const, arch: 'X64' as const, imageOS: 'win25', imageVersion: '20260907.255.1' },
  };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wag-native-dist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, 'input.exe');
  const packageLockPath = join(root, 'package-lock.json');
  const outputDir = join(root, 'bundle');
  await writeFile(executablePath, Buffer.from('native-host-executable\u0000fixture'));
  await writeFile(packageLockPath, '{"lockfileVersion":3}\n', 'utf8');
  return { root, executablePath, packageLockPath, outputDir };
}

test('distribution bundle contains exactly binary checksum and strict receipt', async (t) => {
  const f = await fixture(t);
  const receipt = await writeNativeHostDistributionBundle({ ...f, metadata: metadata() });
  assert.deepEqual((await readdir(f.outputDir)).sort(), [
    'build-receipt.json', NATIVE_HOST_FILENAME, `${NATIVE_HOST_FILENAME}.sha256`,
  ]);
  const checksum = await readFile(join(f.outputDir, `${NATIVE_HOST_FILENAME}.sha256`), 'utf8');
  assert.match(checksum, /^[0-9a-f]{64}  wag-native-host\.exe\n$/);
  assert.deepEqual(parseNativeHostBuildReceipt(JSON.parse(await readFile(join(f.outputDir, 'build-receipt.json'), 'utf8'))), receipt);
  assert.equal((await verifyNativeHostDistributionDirectory({
    directory: f.outputDir,
    expectedRepository: metadata().repository,
    expectedSourceSha: sourceSha,
  })).artifact.sha256, receipt.artifact.sha256);
});
test('distribution verifier fails closed on payload or identity tampering', async (t) => {
  const make = async () => {
    const f = await fixture(t);
    await writeNativeHostDistributionBundle({ ...f, metadata: metadata() });
    return f;
  };

  let f = await make();
  await writeFile(join(f.outputDir, 'extra.txt'), 'unexpected', 'utf8');
  await assert.rejects(() => verifyNativeHostDistributionDirectory({ directory: f.outputDir, expectedRepository: metadata().repository, expectedSourceSha: sourceSha }));

  f = await make();
  await writeFile(join(f.outputDir, NATIVE_HOST_FILENAME), 'tampered', 'utf8');
  await assert.rejects(() => verifyNativeHostDistributionDirectory({ directory: f.outputDir, expectedRepository: metadata().repository, expectedSourceSha: sourceSha }));

  f = await make();
  await writeFile(join(f.outputDir, `${NATIVE_HOST_FILENAME}.sha256`), 'not-a-checksum\n', 'utf8');
  await assert.rejects(() => verifyNativeHostDistributionDirectory({ directory: f.outputDir, expectedRepository: metadata().repository, expectedSourceSha: sourceSha }));

  f = await make();
  await assert.rejects(() => verifyNativeHostDistributionDirectory({ directory: f.outputDir, expectedRepository: 'other/repository', expectedSourceSha: sourceSha }));
  await assert.rejects(() => verifyNativeHostDistributionDirectory({ directory: f.outputDir, expectedRepository: metadata().repository, expectedSourceSha: 'e'.repeat(40) }));
});
test('distribution verifier rejects tampered strict receipt metadata', async (t) => {
  const f = await fixture(t);
  await writeNativeHostDistributionBundle({ ...f, metadata: metadata() });
  const receiptPath = join(f.outputDir, 'build-receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
  receipt.extensionId = 'a'.repeat(32);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await assert.rejects(() => verifyNativeHostDistributionDirectory({
    directory: f.outputDir,
    expectedRepository: metadata().repository,
    expectedSourceSha: sourceSha,
  }));
  assert.notEqual(receipt.extensionId, BROWSER_ADAPTER_EXTENSION_ID);
});

test('distribution packager rejects a pre-existing non-empty destination', async (t) => {
  const f = await fixture(t);
  await writeFile(f.outputDir, 'occupied', 'utf8');
  await assert.rejects(() => writeNativeHostDistributionBundle({ ...f, metadata: metadata() }));
});
test('distribution CLIs expose bounded status without paths or environment secrets', async (t) => {
  const f = await fixture(t);
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: metadata().repository,
    GITHUB_SHA: sourceSha,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '987654321',
    GITHUB_RUN_ATTEMPT: '2',
    RUNNER_OS: 'Windows',
    RUNNER_ARCH: 'X64',
    ImageOS: 'win25',
    ImageVersion: '20260907.255.1',
    WAG_TEST_SECRET: 'do-not-print-this-value',
  };
  const packaged = await execFileAsync(process.execPath, [tsxCli, 'scripts/package-native-host-distribution.ts',
    '--executable', f.executablePath, '--package-lock', f.packageLockPath, '--output', f.outputDir,
  ], { cwd: process.cwd(), env });
  assert.doesNotMatch(packaged.stdout, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(packaged.stdout, /do-not-print-this-value/);
  assert.match(packaged.stdout, /"status":"packaged"/);
  const verified = await execFileAsync(process.execPath, [tsxCli, 'scripts/verify-native-host-distribution.ts',
    '--directory', f.outputDir,
    '--repository', metadata().repository,
    '--source-sha', sourceSha,
  ], { cwd: process.cwd(), env });
  assert.doesNotMatch(verified.stdout, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(verified.stdout, /do-not-print-this-value/);
  assert.match(verified.stdout, /"status":"verified"/);
});
