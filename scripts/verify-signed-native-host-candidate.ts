import { execFile as execFileCb, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  assertNoNativeHostBuildInputChanges,
  parseNativeHostSignatureInspection,
  parseNativeHostSignedCandidateReceipt,
  parseNativeHostUnsignedCandidateReceipt,
  type NativeHostSignatureInspection,
  type NativeHostSignedCandidateReceipt,
} from '../src/browser-adapter/native-host-candidate.js';
import { productionRecordUnsignedCandidateDependencies } from './record-native-host-unsigned-candidate.js';

const execFile = promisify(execFileCb);

export interface VerifySignedCandidateInput {
  repoDir: string;
  buildDir: string;
  unsignedReceipt: string;
  output: string;
  signingDigest: string;
}

export interface VerifySignedCandidateDependencies {
  sourceCommitExists(repoDir: string, sourceSha: string): Promise<boolean>;
  changedPathsSourceToHead(repoDir: string, sourceSha: string): Promise<string[]>;
  changedPathsWorkingTree(repoDir: string): Promise<string[]>;
  changedPathsIndex(repoDir: string): Promise<string[]>;
  inspectValid(executablePath: string): Promise<NativeHostSignatureInspection>;
  sha256File(path: string): Promise<string>;
  probeStart(executablePath: string): Promise<'STARTED'>;
  now(): string;
}

async function inspectValid(executablePath: string): Promise<NativeHostSignatureInspection> {
  const script = fileURLToPath(new URL('./inspect-native-host-signature.ps1', import.meta.url));
  const { stdout } = await execFile('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
    '-ExecutablePath', executablePath, '-ExpectedState', 'Valid',
  ], { windowsHide: true });
  return parseNativeHostSignatureInspection(JSON.parse(stdout.trim()));
}

export function probeNativeHostStart(executablePath: string): Promise<'STARTED'> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executablePath, [], {
        cwd: dirname(executablePath),
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      reject(error);
      return;
    }
    let spawned = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve('STARTED');
    };
    child.once('spawn', () => { spawned = true; });
    child.once('error', (error) => finish(error));
    child.once('exit', () => {
      if (!spawned) finish(new Error('Candidate exited before process creation was confirmed'));
      else finish();
    });
    const timer = setTimeout(() => {
      if (!spawned) {
        try { child.kill(); } catch { /* best effort on owned child only */ }
        finish(new Error('Candidate process creation timed out'));
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      try {
        if (!child.kill()) {
          finish(new Error('Candidate process could not be terminated after start probe'));
          return;
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Candidate process could not be terminated after start probe'));
        return;
      }
      finish();
    }, 5_000);
  });
}

export const productionVerifySignedCandidateDependencies: VerifySignedCandidateDependencies = {
  sourceCommitExists: productionRecordUnsignedCandidateDependencies.sourceCommitExists,
  changedPathsSourceToHead: productionRecordUnsignedCandidateDependencies.changedPathsSourceToHead,
  changedPathsWorkingTree: productionRecordUnsignedCandidateDependencies.changedPathsWorkingTree,
  changedPathsIndex: productionRecordUnsignedCandidateDependencies.changedPathsIndex,
  inspectValid,
  sha256File: productionRecordUnsignedCandidateDependencies.sha256File,
  probeStart: probeNativeHostStart,
  now: () => new Date().toISOString(),
};

async function requireRegularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Candidate input must be a regular file');
}

function signatureIdentity(value: Extract<NativeHostSignatureInspection, { status: 'Valid' }>): string {
  return JSON.stringify({
    signerSubject: value.signerSubject,
    signerThumbprint: value.signerThumbprint,
    publicKeyAlgorithmOid: value.publicKeyAlgorithmOid,
    codeSigningEkuOid: value.codeSigningEkuOid,
    certificateSignatureAlgorithmOid: value.certificateSignatureAlgorithmOid,
    timestamp: value.timestamp,
    authenticodeSha256: value.authenticodeSha256,
  });
}

async function publishReceipt(path: string, receipt: NativeHostSignedCandidateReceipt): Promise<void> {
  const tempPath = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(tempPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tempPath, path);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

export async function verifySignedNativeHostCandidate(
  input: VerifySignedCandidateInput,
  dependencies: VerifySignedCandidateDependencies = productionVerifySignedCandidateDependencies,
): Promise<NativeHostSignedCandidateReceipt> {
  if (!isAbsolute(input.repoDir) || !isAbsolute(input.buildDir) || !isAbsolute(input.unsignedReceipt) || !isAbsolute(input.output)) {
    throw new Error('Candidate paths must be absolute');
  }
  if (input.signingDigest !== 'SHA256') throw new Error('Signing digest must be SHA256');

  await requireRegularFile(input.unsignedReceipt);
  const unsigned = parseNativeHostUnsignedCandidateReceipt(JSON.parse(await readFile(input.unsignedReceipt, 'utf8')));
  if (!(await dependencies.sourceCommitExists(input.repoDir, unsigned.sourceSha))) throw new Error('Source commit not found');
  const changed = [
    ...(await dependencies.changedPathsSourceToHead(input.repoDir, unsigned.sourceSha)),
    ...(await dependencies.changedPathsWorkingTree(input.repoDir)),
    ...(await dependencies.changedPathsIndex(input.repoDir)),
  ];
  assertNoNativeHostBuildInputChanges(changed);

  const packageLockPath = join(input.repoDir, 'package-lock.json');
  const executablePath = join(input.buildDir, 'wag-native-host.exe');
  const seaConfigPath = join(input.buildDir, 'sea-config.json');
  await requireRegularFile(packageLockPath);
  await requireRegularFile(executablePath);
  await requireRegularFile(seaConfigPath);
  if (await dependencies.sha256File(packageLockPath) !== unsigned.packageLockSha256) {
    throw new Error('Package-lock hash mismatch');
  }

  const initialInspection = parseNativeHostSignatureInspection(await dependencies.inspectValid(executablePath));
  if (initialInspection.status !== 'Valid') throw new Error('Candidate signature is not valid');
  if (initialInspection.authenticodeSha256 !== unsigned.authenticodeSha256) {
    throw new Error('Authenticode continuity mismatch');
  }
  const postSignSha256 = await dependencies.sha256File(executablePath);
  if (postSignSha256 === unsigned.preSignSha256) throw new Error('Signing did not change executable bytes');

  const executionProbe = await dependencies.probeStart(executablePath);
  if (executionProbe !== 'STARTED') throw new Error('Candidate did not start');

  const finalInspection = parseNativeHostSignatureInspection(await dependencies.inspectValid(executablePath));
  if (finalInspection.status !== 'Valid') throw new Error('Candidate signature changed during verification');
  if (finalInspection.authenticodeSha256 !== unsigned.authenticodeSha256 || signatureIdentity(finalInspection) !== signatureIdentity(initialInspection)) {
    throw new Error('Candidate signature changed during verification');
  }
  const finalSha256 = await dependencies.sha256File(executablePath);
  if (finalSha256 !== postSignSha256) throw new Error('Candidate bytes changed during verification');

  const { authenticodeSha256: _verifiedAuthenticodeHash, ...signature } = finalInspection;
  const receipt = parseNativeHostSignedCandidateReceipt({
    ...unsigned,
    artifact: { filename: 'wag-native-host.exe', sha256: finalSha256 },
    signature,
    signingDigest: { algorithm: 'SHA256', evidence: 'SIGNER_INVOCATION' },
    executionProbe: 'STARTED',
    verifiedAt: dependencies.now(),
  });
  await publishReceipt(input.output, receipt);
  return receipt;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const buildDir = option(args, '--build-dir');
  const unsignedReceipt = option(args, '--unsigned-receipt');
  const output = option(args, '--output');
  const signingDigest = option(args, '--signing-digest');
  const receipt = await verifySignedNativeHostCandidate({
    repoDir: process.cwd(), buildDir, unsignedReceipt, output, signingDigest,
  });
  process.stdout.write(`${JSON.stringify({
    status: 'verified', sourceSha: receipt.sourceSha, sha256: receipt.artifact.sha256,
    signature: 'Valid', executionProbe: 'STARTED',
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('wag-native-host-candidate-verify: failed\n');
    process.exitCode = 1;
  });
}
