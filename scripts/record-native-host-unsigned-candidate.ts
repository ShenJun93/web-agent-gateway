import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  assertNoNativeHostBuildInputChanges,
  parseNativeHostSignatureInspection,
  parseNativeHostUnsignedCandidateReceipt,
  sha256File,
  type NativeHostSignatureInspection,
  type NativeHostUnsignedCandidateReceipt,
} from '../src/browser-adapter/native-host-candidate.js';

const execFile = promisify(execFileCb);
const SOURCE_SHA = /^[0-9a-f]{40}$/;

export interface RecordUnsignedCandidateInput {
  repoDir: string;
  buildDir: string;
  output: string;
  repository: string;
  sourceSha: string;
}

export interface RecordUnsignedCandidateDependencies {
  sourceCommitExists(repoDir: string, sourceSha: string): Promise<boolean>;
  changedPathsSourceToHead(repoDir: string, sourceSha: string): Promise<string[]>;
  changedPathsWorkingTree(repoDir: string): Promise<string[]>;
  changedPathsIndex(repoDir: string): Promise<string[]>;
  inspectUnsigned(executablePath: string): Promise<NativeHostSignatureInspection>;
  sha256File(path: string): Promise<string>;
  nodeVersion: string;
}

async function gitLines(repoDir: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFile('git', args, { cwd: repoDir, windowsHide: true });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function sourceCommitExists(repoDir: string, sourceSha: string): Promise<boolean> {
  try {
    await execFile('git', ['cat-file', '-e', `${sourceSha}^{commit}`], { cwd: repoDir, windowsHide: true });
    return true;
  } catch { return false; }
}

async function inspectUnsigned(executablePath: string): Promise<NativeHostSignatureInspection> {
  const script = fileURLToPath(new URL('./inspect-native-host-signature.ps1', import.meta.url));
  const { stdout } = await execFile('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
    '-ExecutablePath', executablePath, '-ExpectedState', 'Unsigned',
  ], { cwd: process.cwd(), windowsHide: true });
  return parseNativeHostSignatureInspection(JSON.parse(stdout.trim()));
}

export const productionRecordUnsignedCandidateDependencies: RecordUnsignedCandidateDependencies = {
  sourceCommitExists,
  changedPathsSourceToHead: (repoDir, sourceSha) => gitLines(repoDir, ['diff', '--name-only', `${sourceSha}..HEAD`, '--']),
  changedPathsWorkingTree: (repoDir) => gitLines(repoDir, ['diff', '--name-only', 'HEAD', '--']),
  changedPathsIndex: (repoDir) => gitLines(repoDir, ['diff', '--cached', '--name-only', '--']),
  inspectUnsigned,
  sha256File,
  nodeVersion: process.versions.node,
};

async function requireRegularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Candidate input must be a regular file');
}

export async function recordUnsignedNativeHostCandidate(
  input: RecordUnsignedCandidateInput,
  dependencies: RecordUnsignedCandidateDependencies = productionRecordUnsignedCandidateDependencies,
): Promise<NativeHostUnsignedCandidateReceipt> {
  if (!isAbsolute(input.repoDir) || !isAbsolute(input.buildDir) || !isAbsolute(input.output)) {
    throw new Error('Candidate paths must be absolute');
  }
  if (!SOURCE_SHA.test(input.sourceSha)) throw new Error('Invalid source SHA');
  if (!(await dependencies.sourceCommitExists(input.repoDir, input.sourceSha))) throw new Error('Source commit not found');

  const changed = [
    ...(await dependencies.changedPathsSourceToHead(input.repoDir, input.sourceSha)),
    ...(await dependencies.changedPathsWorkingTree(input.repoDir)),
    ...(await dependencies.changedPathsIndex(input.repoDir)),
  ];
  assertNoNativeHostBuildInputChanges(changed);

  const executablePath = join(input.buildDir, 'wag-native-host.exe');
  const seaConfigPath = join(input.buildDir, 'sea-config.json');
  const packageLockPath = join(input.repoDir, 'package-lock.json');
  await requireRegularFile(executablePath);
  await requireRegularFile(seaConfigPath);
  await requireRegularFile(packageLockPath);

  const inspection = await dependencies.inspectUnsigned(executablePath);
  if (inspection.status !== 'NotSigned') throw new Error('Candidate must be unsigned');
  if (dependencies.nodeVersion !== '24.20.0') throw new Error('Unexpected Node version');

  const receipt = parseNativeHostUnsignedCandidateReceipt({
    schemaVersion: 1,
    repository: input.repository,
    sourceSha: input.sourceSha,
    nodeVersion: dependencies.nodeVersion,
    packageLockSha256: await dependencies.sha256File(packageLockPath),
    builderScript: 'scripts/build-native-host.ts',
    executableFilename: 'wag-native-host.exe',
    preSignSha256: await dependencies.sha256File(executablePath),
    authenticodeSha256: inspection.authenticodeSha256,
  });

  const tempPath = join(dirname(input.output), `.${randomUUID()}.tmp`);
  const handle = await open(tempPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tempPath, input.output);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
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
  const sourceSha = option(args, '--source-sha');
  const repository = option(args, '--repository');
  const output = option(args, '--output');
  if (!isAbsolute(buildDir) || !isAbsolute(output)) throw new Error('Candidate paths must be absolute');
  const receipt = await recordUnsignedNativeHostCandidate({
    repoDir: process.cwd(), buildDir, sourceSha, repository, output,
  });
  process.stdout.write(`${JSON.stringify({ status: 'recorded', sourceSha: receipt.sourceSha, preSignSha256: receipt.preSignSha256 })}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(`wag-native-host-candidate-record: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
