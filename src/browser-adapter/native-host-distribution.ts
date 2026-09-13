import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

export const NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION = 1 as const;
export const NATIVE_HOST_FILENAME = 'wag-native-host.exe' as const;
export const NATIVE_HOST_APPLICATION_NAME = 'com.openai.web_agent_gateway' as const;
export const BROWSER_ADAPTER_EXTENSION_ID = 'nnhhhppkpogkedpjnijeagcbfjaoogec' as const;
export const NATIVE_HOST_REQUIRED_GATES = [
  'typecheck',
  'build',
  'browser-adapter-protocol',
  'native-messaging-framing',
  'native-host-protocol',
  'native-host-manifest',
  'browser-extension-identity',
  'native-host-artifact',
] as const;

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const boundedText = z.string().min(1).max(256);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
const receiptSchema = z.object({
  schemaVersion: z.literal(NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION),
  repository,
  sourceSha: sha40,
  sourceRef: z.string().regex(/^refs\/[A-Za-z0-9._\/-]{1,240}$/),
  workflowRunId: z.string().regex(/^[1-9][0-9]{0,39}$/),
  runAttempt: z.number().int().positive().max(1_000_000),
  runner: z.object({
    os: z.literal('Windows'),
    arch: z.literal('X64'),
    imageOS: boundedText.optional(),
    imageVersion: boundedText.optional(),
  }).strict(),
  nodeVersion: z.literal('24.20.0'),
  packageLockSha256: sha256,
  artifact: z.object({
    filename: z.literal(NATIVE_HOST_FILENAME),
    sha256,
  }).strict(),
  nativeApplicationName: z.literal(NATIVE_HOST_APPLICATION_NAME),
  extensionId: z.literal(BROWSER_ADAPTER_EXTENSION_ID),
  verificationGates: z.tuple(NATIVE_HOST_REQUIRED_GATES.map((gate) => z.literal(gate)) as [
    z.ZodLiteral<string>,
    ...z.ZodLiteral<string>[],
  ]),
}).strict();

export type NativeHostBuildReceipt = z.infer<typeof receiptSchema>;

export function parseNativeHostBuildReceipt(value: unknown): NativeHostBuildReceipt {
  return receiptSchema.parse(value);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

const CHECKSUM_FILENAME = `${NATIVE_HOST_FILENAME}.sha256` as const;
const RECEIPT_FILENAME = 'build-receipt.json' as const;
const EXPECTED_FILES = [RECEIPT_FILENAME, NATIVE_HOST_FILENAME, CHECKSUM_FILENAME].sort();
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_CHECKSUM_BYTES = 256;

export interface NativeHostDistributionMetadata {
  repository: string;
  sourceSha: string;
  sourceRef: string;
  workflowRunId: string;
  runAttempt: number;
  runner: {
    os: 'Windows';
    arch: 'X64';
    imageOS?: string;
    imageVersion?: string;
  };
}

export interface NativeHostDistributionBundleInput {
  executablePath: string;
  packageLockPath: string;
  outputDir: string;
  metadata: NativeHostDistributionMetadata;
}

function requireAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
}

async function ensureDestinationAvailable(outputDir: string): Promise<void> {
  try {
    const info = await stat(outputDir);
    if (!info.isDirectory()) throw new Error('Distribution output already exists');
    if ((await readdir(outputDir)).length !== 0) throw new Error('Distribution output must be empty');
    await rm(outputDir, { recursive: true, force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

async function readBoundedUtf8(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Distribution metadata is not bounded');
  return readFile(path, 'utf8');
}

function createReceipt(
  metadata: NativeHostDistributionMetadata,
  packageLockSha256: string,
  executableSha256: string,
): NativeHostBuildReceipt {
  return parseNativeHostBuildReceipt({
    schemaVersion: NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION,
    ...metadata,
    nodeVersion: '24.20.0',
    packageLockSha256,
    artifact: { filename: NATIVE_HOST_FILENAME, sha256: executableSha256 },
    nativeApplicationName: NATIVE_HOST_APPLICATION_NAME,
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
    verificationGates: [...NATIVE_HOST_REQUIRED_GATES],
  });
}

export async function writeNativeHostDistributionBundle(
  input: NativeHostDistributionBundleInput,
): Promise<NativeHostBuildReceipt> {
  requireAbsolutePath(input.executablePath, 'Executable path');
  requireAbsolutePath(input.packageLockPath, 'Package lock path');
  requireAbsolutePath(input.outputDir, 'Distribution output');
  await ensureDestinationAvailable(input.outputDir);

  const executableInfo = await stat(input.executablePath);
  const lockInfo = await stat(input.packageLockPath);
  if (!executableInfo.isFile() || !lockInfo.isFile()) throw new Error('Distribution inputs must be files');

  const executableSha256 = await sha256File(input.executablePath);
  const packageLockSha256 = await sha256File(input.packageLockPath);
  const receipt = createReceipt(input.metadata, packageLockSha256, executableSha256);
  const tempDir = await mkdtemp(join(dirname(input.outputDir), `.${basename(input.outputDir)}-`));

  try {
    await copyFile(input.executablePath, join(tempDir, NATIVE_HOST_FILENAME));
    await writeFile(join(tempDir, CHECKSUM_FILENAME), `${executableSha256}  ${NATIVE_HOST_FILENAME}\n`, 'utf8');
    await writeFile(join(tempDir, RECEIPT_FILENAME), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await verifyNativeHostDistributionDirectory({
      directory: tempDir,
      expectedRepository: receipt.repository,
      expectedSourceSha: receipt.sourceSha,
    });
    await rename(tempDir, input.outputDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  return receipt;
}

export async function verifyNativeHostDistributionDirectory(input: {
  directory: string;
  expectedRepository: string;
  expectedSourceSha: string;
}): Promise<NativeHostBuildReceipt> {
  requireAbsolutePath(input.directory, 'Distribution directory');
  const files = (await readdir(input.directory)).sort();
  if (files.length !== EXPECTED_FILES.length || files.some((file, index) => file !== EXPECTED_FILES[index])) {
    throw new Error('Distribution payload must contain exactly the expected files');
  }

  const receiptText = await readBoundedUtf8(join(input.directory, RECEIPT_FILENAME), MAX_RECEIPT_BYTES);
  let receiptValue: unknown;
  try {
    receiptValue = JSON.parse(receiptText);
  } catch {
    throw new Error('Distribution receipt is not valid JSON');
  }
  const receipt = parseNativeHostBuildReceipt(receiptValue);
  if (receipt.repository !== input.expectedRepository) throw new Error('Distribution repository identity mismatch');
  if (receipt.sourceSha !== input.expectedSourceSha) throw new Error('Distribution source identity mismatch');

  const checksumText = await readBoundedUtf8(join(input.directory, CHECKSUM_FILENAME), MAX_CHECKSUM_BYTES);
  const checksumMatch = checksumText.match(/^([0-9a-f]{64})  wag-native-host\.exe\n$/);
  if (!checksumMatch) throw new Error('Distribution checksum file is malformed');
  const executableSha256 = await sha256File(join(input.directory, NATIVE_HOST_FILENAME));
  if (checksumMatch[1] !== executableSha256 || receipt.artifact.sha256 !== executableSha256) {
    throw new Error('Distribution executable hash mismatch');
  }
  return receipt;
}
