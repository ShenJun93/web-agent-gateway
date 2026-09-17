import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recordUnsignedNativeHostCandidate, type RecordUnsignedCandidateDependencies } from '../scripts/record-native-host-unsigned-candidate.js';

const execFile = promisify(execFileCb);
const root = process.cwd();
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const sourceSha = '1'.repeat(40);

async function makeBuildDir(base: string): Promise<string> {
  const buildDir = join(base, 'build');
  await mkdir(buildDir, { recursive: true });
  await writeFile(join(buildDir, 'wag-native-host.exe'), 'unsigned-exe');
  await writeFile(join(buildDir, 'sea-config.json'), '{}');
  return buildDir;
}

function fakeDeps(overrides: Partial<RecordUnsignedCandidateDependencies> = {}): RecordUnsignedCandidateDependencies {
  return {
    sourceCommitExists: async () => true,
    changedPathsSourceToHead: async () => [],
    changedPathsWorkingTree: async () => [],
    changedPathsIndex: async () => [],
    inspectUnsigned: async () => ({ status: 'NotSigned', authenticodeSha256: hashB }),
    sha256File: async (path) => path.endsWith('package-lock.json') ? hashA : hashB,
    nodeVersion: '24.20.0',
    ...overrides,
  };
}

async function setup(base: string) {
  const repoDir = join(base, 'repo');
  await mkdir(repoDir, { recursive: true });
  await writeFile(join(repoDir, 'package-lock.json'), '{}');
  const buildDir = await makeBuildDir(base);
  const output = join(base, 'receipt.json');
  return { repoDir, buildDir, output };
}

test('unsigned candidate records strict provenance with dependency-injected Git/signature facts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-candidate-unit-'));
  try {
    const { repoDir, buildDir, output } = await setup(temp);
    const receipt = await recordUnsignedNativeHostCandidate({
      repoDir, buildDir, output, repository: 'owner/repo', sourceSha,
    }, fakeDeps());
    assert.equal(receipt.repository, 'owner/repo');
    assert.equal(receipt.sourceSha, sourceSha);
    assert.equal(receipt.nodeVersion, '24.20.0');
    assert.equal(receipt.packageLockSha256, hashA);
    assert.equal(receipt.builderScript, 'scripts/build-native-host.ts');
    assert.equal(receipt.executableFilename, 'wag-native-host.exe');
    assert.equal(receipt.preSignSha256, hashB);
    assert.equal(receipt.authenticodeSha256, hashB);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), receipt);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('unsigned candidate fails closed on paths, missing build files, source and build-input drift', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-candidate-fail-'));
  try {
    const { repoDir, buildDir, output } = await setup(temp);
    const base = { repoDir, buildDir, output, repository: 'owner/repo', sourceSha };
    await assert.rejects(() => recordUnsignedNativeHostCandidate({ ...base, buildDir: 'relative' }, fakeDeps()));
    await assert.rejects(() => recordUnsignedNativeHostCandidate({ ...base, output: 'relative.json' }, fakeDeps()));
    await assert.rejects(() => recordUnsignedNativeHostCandidate(base, fakeDeps({ sourceCommitExists: async () => false })));
    await assert.rejects(() => recordUnsignedNativeHostCandidate(base, fakeDeps({ changedPathsWorkingTree: async () => ['src/a.ts'] })));
    await assert.rejects(() => recordUnsignedNativeHostCandidate(base, fakeDeps({ changedPathsIndex: async () => ['package.json'] })));
    await assert.rejects(() => recordUnsignedNativeHostCandidate(base, fakeDeps({ changedPathsSourceToHead: async () => ['browser/native-host/a.ts'] })));
    await rm(join(buildDir, 'wag-native-host.exe'));
    await writeFile(join(buildDir, 'other.exe'), 'wrong-name');
    await assert.rejects(() => recordUnsignedNativeHostCandidate(base, fakeDeps()));
    await writeFile(join(buildDir, 'wag-native-host.exe'), 'unsigned-exe');
    await rm(join(buildDir, 'sea-config.json'));
    await assert.rejects(() => recordUnsignedNativeHostCandidate(base, fakeDeps()));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('unsigned candidate allows docs/test-only later commits and rejects signed input or existing receipt', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-candidate-policy-'));
  try {
    const { repoDir, buildDir, output } = await setup(temp);
    const base = { repoDir, buildDir, output, repository: 'owner/repo', sourceSha };
    await recordUnsignedNativeHostCandidate(base, fakeDeps({ changedPathsSourceToHead: async () => ['docs/x.md', 'test/a.test.ts'] }));
    await assert.rejects(() => recordUnsignedNativeHostCandidate(base, fakeDeps()));
    const output2 = join(temp, 'receipt-2.json');
    await assert.rejects(() => recordUnsignedNativeHostCandidate({ ...base, output: output2 }, fakeDeps({
      inspectUnsigned: async () => ({
        status: 'Valid', signerSubject: 'CN=x', signerThumbprint: 'c'.repeat(40),
        publicKeyAlgorithmOid: '1.2.840.113549.1.1.1', codeSigningEkuOid: '1.3.6.1.5.5.7.3.3',
        certificateSignatureAlgorithmOid: '1.2.840.113549.1.1.11', timestamp: null, authenticodeSha256: hashB,
      }),
    })));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('unsigned candidate production CLI records a real unsigned WAG SEA from the clean repository', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows native-host candidate');
  const temp = await mkdtemp(join(tmpdir(), 'wag-candidate-e2e-'));
  try {
    const buildDir = join(temp, 'build');
    const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
    const build = await execFile(process.execPath, [tsxCli, 'scripts/build-native-host.ts', '--output', buildDir], { cwd: root });
    assert.equal(build.stderr, '');
    const repoDir = join(temp, 'repo');
    await mkdir(repoDir, { recursive: true });
    await copyFile(join(root, 'package-lock.json'), join(repoDir, 'package-lock.json'));
    await execFile('git', ['init'], { cwd: repoDir });
    await execFile('git', ['config', 'user.email', 'candidate-test@example.invalid'], { cwd: repoDir });
    await execFile('git', ['config', 'user.name', 'Candidate Test'], { cwd: repoDir });
    await execFile('git', ['add', 'package-lock.json'], { cwd: repoDir });
    await execFile('git', ['commit', '-m', 'fixture'], { cwd: repoDir });
    const head = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
    const output = join(temp, 'unsigned-receipt.json');
    const recorder = join(root, 'scripts', 'record-native-host-unsigned-candidate.ts');
    const child = spawn(process.execPath, [tsxCli, recorder, '--build-dir', buildDir, '--source-sha', head, '--repository', 'owner/repo', '--output', output], {
      cwd: repoDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on('data', (c) => stdout.push(Buffer.from(c))); child.stderr.on('data', (c) => stderr.push(Buffer.from(c)));
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
    assert.equal(Buffer.concat(stderr).toString('utf8'), '');
    const summary = JSON.parse(Buffer.concat(stdout).toString('utf8').trim());
    assert.deepEqual(Object.keys(summary).sort(), ['preSignSha256', 'sourceSha', 'status']);
    assert.equal(summary.status, 'recorded');
    assert.equal(summary.sourceSha, head);
    assert.match(summary.preSignSha256, /^[0-9a-f]{64}$/);
    const receipt = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(receipt.sourceSha, head);
    assert.equal(receipt.builderScript, 'scripts/build-native-host.ts');
    assert.equal(receipt.executableFilename, 'wag-native-host.exe');
    assert.equal(receipt.preSignSha256, summary.preSignSha256);
    assert.match(receipt.packageLockSha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.preSignSha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.authenticodeSha256, /^[0-9a-f]{64}$/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
