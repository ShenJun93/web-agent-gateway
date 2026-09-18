import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recordUnsignedNativeHostCandidate, type RecordUnsignedCandidateDependencies } from '../scripts/record-native-host-unsigned-candidate.js';
import { probeNativeHostStart, productionVerifySignedCandidateDependencies, settleOwnedProbeChildAtDeadline, verifySignedNativeHostCandidate, type VerifySignedCandidateDependencies } from '../scripts/verify-signed-native-host-candidate.js';

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
  const temp = await mkdtemp(join(root, '.wag-candidate-e2e-'));
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
const preSignHash = 'd'.repeat(64);
const authHash = 'e'.repeat(64);
const postSignHash = 'f'.repeat(64);
const otherPostHash = '9'.repeat(64);

function validSignature(authenticodeSha256 = authHash) {
  return {
    status: 'Valid' as const,
    signerSubject: 'CN=Candidate Signer',
    signerThumbprint: 'c'.repeat(40),
    publicKeyAlgorithmOid: '1.2.840.113549.1.1.1' as const,
    codeSigningEkuOid: '1.3.6.1.5.5.7.3.3' as const,
    certificateSignatureAlgorithmOid: '1.2.840.113549.1.1.11',
    timestamp: null,
    authenticodeSha256,
  };
}

async function setupSignedVerification(base: string) {
  const repoDir = join(base, 'repo');
  const buildDir = join(base, 'signed-build');
  await mkdir(repoDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });
  await writeFile(join(repoDir, 'package-lock.json'), '{}');
  await writeFile(join(buildDir, 'wag-native-host.exe'), 'signed-exe');
  await writeFile(join(buildDir, 'sea-config.json'), '{}');
  const unsignedReceipt = join(base, 'unsigned-receipt.json');
  await writeFile(unsignedReceipt, JSON.stringify({
    schemaVersion: 1,
    repository: 'owner/repo',
    sourceSha,
    nodeVersion: '24.20.0',
    packageLockSha256: hashA,
    builderScript: 'scripts/build-native-host.ts',
    executableFilename: 'wag-native-host.exe',
    preSignSha256: preSignHash,
    authenticodeSha256: authHash,
  }));
  return { repoDir, buildDir, unsignedReceipt, output: join(base, 'signed-receipt.json') };
}

function verifyDeps(overrides: Partial<VerifySignedCandidateDependencies> = {}): VerifySignedCandidateDependencies {
  return {
    sourceCommitExists: async () => true,
    changedPathsSourceToHead: async () => [],
    changedPathsWorkingTree: async () => [],
    changedPathsIndex: async () => [],
    inspectValid: async () => validSignature(),
    sha256File: async (path) => path.endsWith('package-lock.json') ? hashA : postSignHash,
    probeStart: async () => 'STARTED',
    now: () => '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

test('signed candidate verifies provenance, signature continuity, stable bytes and start before receipt creation', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-signed-candidate-unit-'));
  try {
    const paths = await setupSignedVerification(temp);
    const receipt = await verifySignedNativeHostCandidate({
      ...paths, signingDigest: 'SHA256',
    }, verifyDeps());
    assert.equal(receipt.sourceSha, sourceSha);
    assert.equal(receipt.artifact.filename, 'wag-native-host.exe');
    assert.equal(receipt.artifact.sha256, postSignHash);
    assert.equal(receipt.authenticodeSha256, authHash);
    assert.equal(receipt.signature.status, 'Valid');
    assert.deepEqual(receipt.signingDigest, { algorithm: 'SHA256', evidence: 'SIGNER_INVOCATION' });
    assert.equal(receipt.executionProbe, 'STARTED');
    assert.equal(receipt.verifiedAt, '2026-09-18T00:00:00.000Z');
    assert.deepEqual(JSON.parse(await readFile(paths.output, 'utf8')), receipt);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('signed candidate rejects digest, source/build-input drift, lock drift and malformed signature before receipt', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-signed-candidate-fail-'));
  try {
    const paths = await setupSignedVerification(temp);
    const cases: Array<[string, string, Partial<VerifySignedCandidateDependencies>]> = [
      ['bad-digest', 'SHA1', {}],
      ['missing-source', 'SHA256', { sourceCommitExists: async () => false }],
      ['source-drift', 'SHA256', { changedPathsSourceToHead: async () => ['src/a.ts'] }],
      ['working-drift', 'SHA256', { changedPathsWorkingTree: async () => ['package.json'] }],
      ['index-drift', 'SHA256', { changedPathsIndex: async () => ['browser/native-host/a.ts'] }],
      ['lock-drift', 'SHA256', { sha256File: async (path) => path.endsWith('package-lock.json') ? otherPostHash : postSignHash }],
      ['ecc-signature', 'SHA256', { inspectValid: async () => ({ ...validSignature(), publicKeyAlgorithmOid: '1.2.840.10045.2.1' } as never) }],
    ];
    for (const [name, signingDigest, overrides] of cases) {
      const output = join(temp, `${name}.json`);
      await assert.rejects(() => verifySignedNativeHostCandidate({ ...paths, output, signingDigest }, verifyDeps(overrides)));
      await assert.rejects(readFile(output, 'utf8'));
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('signed candidate rejects Authenticode mismatch, unchanged/tampered flat bytes and failed start with no receipt', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-signed-candidate-continuity-'));
  try {
    const paths = await setupSignedVerification(temp);
    const checks: Array<[string, Partial<VerifySignedCandidateDependencies>]> = [
      ['auth-mismatch', { inspectValid: async () => validSignature(otherPostHash) }],
      ['unchanged-flat', { sha256File: async (path) => path.endsWith('package-lock.json') ? hashA : preSignHash }],
      ['start-failed', { probeStart: async () => { throw new Error('spawn blocked'); } }],
    ];
    for (const [name, overrides] of checks) {
      const output = join(temp, `${name}.json`);
      await assert.rejects(() => verifySignedNativeHostCandidate({ ...paths, output, signingDigest: 'SHA256' }, verifyDeps(overrides)));
      await assert.rejects(readFile(output, 'utf8'));
    }

    let exeHashCalls = 0;
    const output = join(temp, 'tampered-during-probe.json');
    await assert.rejects(() => verifySignedNativeHostCandidate({ ...paths, output, signingDigest: 'SHA256' }, verifyDeps({
      sha256File: async (path) => {
        if (path.endsWith('package-lock.json')) return hashA;
        exeHashCalls += 1;
        return exeHashCalls === 1 ? postSignHash : otherPostHash;
      },
    })));
    await assert.rejects(readFile(output, 'utf8'));

    let inspectionCalls = 0;
    const signatureChangedOutput = join(temp, 'signature-changed-during-probe.json');
    await assert.rejects(() => verifySignedNativeHostCandidate({ ...paths, output: signatureChangedOutput, signingDigest: 'SHA256' }, verifyDeps({
      inspectValid: async () => {
        inspectionCalls += 1;
        return inspectionCalls === 1 ? validSignature() : { ...validSignature(), signerThumbprint: '7'.repeat(40) };
      },
    })));
    await assert.rejects(readFile(signatureChangedOutput, 'utf8'));

    const existingOutput = join(temp, 'existing-receipt.json');
    await writeFile(existingOutput, 'existing-evidence');
    await assert.rejects(() => verifySignedNativeHostCandidate({ ...paths, output: existingOutput, signingDigest: 'SHA256' }, verifyDeps()));
    assert.equal(await readFile(existingOutput, 'utf8'), 'existing-evidence');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('owned start-probe deadline tolerates exit/kill race and fails closed if the owned child remains live', async () => {
  const racedChild = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => {
      setImmediate(() => { racedChild.exitCode = 0; });
      return false;
    },
  };
  await settleOwnedProbeChildAtDeadline(racedChild);

  const stuckChild = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => false,
  };
  await assert.rejects(
    () => settleOwnedProbeChildAtDeadline(stuckChild),
    /could not be terminated after start probe/,
  );
});

test('signed candidate CLI rejects relative paths with bounded failure output', async () => {
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const verifier = join(root, 'scripts', 'verify-signed-native-host-candidate.ts');
  const child = spawn(process.execPath, [
    tsxCli, verifier,
    '--build-dir', 'relative-build',
    '--unsigned-receipt', 'relative-unsigned.json',
    '--output', 'relative-signed.json',
    '--signing-digest', 'SHA256',
  ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 1);
  assert.equal(Buffer.concat(stdout).toString('utf8'), '');
  assert.equal(Buffer.concat(stderr).toString('utf8'), 'wag-native-host-candidate-verify: failed\n');
});

test('signed candidate requires exact WAG filename and production Windows dependencies parse/start a trusted system executable', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-signed-candidate-system-'));
  try {
    const paths = await setupSignedVerification(temp);
    await rm(join(paths.buildDir, 'wag-native-host.exe'));
    await writeFile(join(paths.buildDir, 'notepad.exe'), 'not-the-candidate');
    await assert.rejects(() => verifySignedNativeHostCandidate({ ...paths, signingDigest: 'SHA256' }, verifyDeps()));

    if (process.platform !== 'win32') return t.skip('Windows Authenticode/start probe');
    await assert.rejects(() => probeNativeHostStart(join(temp, 'definitely-missing.exe')));
    const notepad = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'notepad.exe');
    const facts = await productionVerifySignedCandidateDependencies.inspectValid(notepad);
    assert.equal(facts.status, 'Valid');
    const started = await productionVerifySignedCandidateDependencies.probeStart(notepad);
    assert.equal(started, 'STARTED');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
