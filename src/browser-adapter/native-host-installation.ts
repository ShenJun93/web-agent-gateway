import { isDeepStrictEqual } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { z } from 'zod';
import {
  BROWSER_ADAPTER_EXTENSION_ID,
  NATIVE_HOST_APPLICATION_NAME,
  NATIVE_HOST_FILENAME,
  parseNativeHostBuildReceipt,
  sha256File,
  verifyNativeHostDistributionDirectory,
  type NativeHostBuildReceipt,
} from './native-host-distribution.js';
import { createNativeHostManifest } from './native-host-manifest.js';

export const NATIVE_HOST_INSTALLATION_SCHEMA_VERSION = 1 as const;
export const NATIVE_HOST_ACCEPTED_REPOSITORY = 'ShenJun93/web-agent-gateway' as const;
export const NATIVE_HOST_ACCEPTED_SOURCE_SHA = '4dcabd0a33de9b2a0685512fd3ab982e657edb0e' as const;
export const NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256 =
  '62af695a2d8bd219b940c207b4edb7d18f1bc0c3c3cd7f549f35ace407aaf138' as const;
export const NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID = '35088504189' as const;
export const NATIVE_HOST_ACCEPTED_RUN_ATTEMPT = 1 as const;

const MANIFEST_FILENAME = `${NATIVE_HOST_APPLICATION_NAME}.json` as const;
const RECEIPT_FILENAME = 'install-receipt.json' as const;
const REGISTRATION_ARTIFACT_FILENAME = 'register-native-host.reg' as const;
const REGISTRATION_SUBKEY =
  `SOFTWARE\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_APPLICATION_NAME}` as const;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\\/;
const SHA256 = /^[0-9a-f]{64}$/;
const INSTALLATION_FILES = [
  MANIFEST_FILENAME,
  RECEIPT_FILENAME,
  REGISTRATION_ARTIFACT_FILENAME,
  NATIVE_HOST_FILENAME,
].sort();
const MAX_INSTALL_RECEIPT_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_REGISTRATION_ARTIFACT_BYTES = 64 * 1024;

function isWindowsDriveAbsolute(path: string): boolean {
  return win32.isAbsolute(path) && WINDOWS_DRIVE_ABSOLUTE.test(path);
}

function requireWindowsDriveAbsolute(path: string, label: string): void {
  if (!isWindowsDriveAbsolute(path)) throw new Error(`${label} must be a Windows absolute path`);
}

export interface NativeHostInstallPaths {
  root: string;
  executable: string;
  manifest: string;
  receipt: string;
  registrationArtifact: string;
}

export function buildNativeHostInstallPaths(localAppData: string, sourceSha: string): NativeHostInstallPaths {
  requireWindowsDriveAbsolute(localAppData, 'Local app data');
  if (sourceSha !== NATIVE_HOST_ACCEPTED_SOURCE_SHA) throw new Error('Native host source SHA is not accepted');

  const root = win32.join(localAppData, 'WebAgentGateway', 'native-host', sourceSha);
  return {
    root,
    executable: win32.join(root, NATIVE_HOST_FILENAME),
    manifest: win32.join(root, MANIFEST_FILENAME),
    receipt: win32.join(root, RECEIPT_FILENAME),
    registrationArtifact: win32.join(root, REGISTRATION_ARTIFACT_FILENAME),
  };
}

const windowsAbsolutePath = z.string().refine(isWindowsDriveAbsolute, 'Path must be Windows absolute');
const executablePath = windowsAbsolutePath.refine(
  (path) => win32.basename(path) === NATIVE_HOST_FILENAME,
  `Executable path must end with ${NATIVE_HOST_FILENAME}`,
);
const manifestPath = windowsAbsolutePath.refine(
  (path) => win32.basename(path) === MANIFEST_FILENAME,
  `Manifest path must end with ${MANIFEST_FILENAME}`,
);

const registrationDescriptorSchema = z.object({
  hive: z.literal('HKCU'),
  view: z.literal('64-bit'),
  subkey: z.literal(REGISTRATION_SUBKEY),
  defaultValue: manifestPath,
}).strict();

export type NativeHostRegistrationDescriptor = z.infer<typeof registrationDescriptorSchema>;

const receiptSchema = z.object({
  schemaVersion: z.literal(NATIVE_HOST_INSTALLATION_SCHEMA_VERSION),
  repository: z.literal(NATIVE_HOST_ACCEPTED_REPOSITORY),
  sourceSha: z.literal(NATIVE_HOST_ACCEPTED_SOURCE_SHA),
  workflowRunId: z.literal(NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID),
  runAttempt: z.literal(NATIVE_HOST_ACCEPTED_RUN_ATTEMPT),
  executableSha256: z.literal(NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256),
  nativeApplicationName: z.literal(NATIVE_HOST_APPLICATION_NAME),
  extensionId: z.literal(BROWSER_ADAPTER_EXTENSION_ID),
  executablePath,
  manifestPath,
  manifestSha256: z.string().regex(SHA256),
  registration: registrationDescriptorSchema,
  preparedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((receipt, context) => {
  const executableRoot = win32.dirname(receipt.executablePath);
  const nativeHostRoot = win32.dirname(executableRoot);
  const applicationRoot = win32.dirname(nativeHostRoot);
  if (win32.dirname(receipt.manifestPath) !== executableRoot) {
    context.addIssue({ code: 'custom', message: 'Installed executable and manifest must share one root' });
  }
  if (
    win32.basename(executableRoot) !== receipt.sourceSha
    || win32.basename(nativeHostRoot) !== 'native-host'
    || win32.basename(applicationRoot) !== 'WebAgentGateway'
  ) {
    context.addIssue({ code: 'custom', message: 'Installation paths must use the accepted source-SHA layout' });
  }
  if (receipt.registration.defaultValue !== receipt.manifestPath) {
    context.addIssue({ code: 'custom', message: 'Registration default value must equal the installed manifest path' });
  }
});

export type NativeHostInstallReceipt = z.infer<typeof receiptSchema>;

export function parseNativeHostInstallReceipt(value: unknown): NativeHostInstallReceipt {
  return receiptSchema.parse(value);
}

export function createNativeHostRegistrationDescriptor(
  installedManifestPath: string,
): NativeHostRegistrationDescriptor {
  requireWindowsDriveAbsolute(installedManifestPath, 'Native host manifest path');
  return registrationDescriptorSchema.parse({
    hive: 'HKCU',
    view: '64-bit',
    subkey: REGISTRATION_SUBKEY,
    defaultValue: installedManifestPath,
  });
}

export type NativeHostRegistrationClassification = 'ABSENT' | 'MATCH' | 'DRIFT';

export function classifyNativeHostRegistration(
  observedValue: string | null | undefined,
  receiptValue: NativeHostInstallReceipt,
): NativeHostRegistrationClassification {
  const receipt = parseNativeHostInstallReceipt(receiptValue);
  if (observedValue === null || observedValue === undefined) return 'ABSENT';
  return observedValue === receipt.registration.defaultValue ? 'MATCH' : 'DRIFT';
}

export type NativeHostOwnedCleanupDecision =
  | 'BLOCK_DRIFT'
  | 'FILES_ONLY'
  | 'REGISTRATION_THEN_FILES';

export function decideNativeHostOwnedCleanup(
  observedValue: string | null | undefined,
  receipt: NativeHostInstallReceipt,
  ownedFilesMatch: boolean,
): NativeHostOwnedCleanupDecision {
  if (!ownedFilesMatch) return 'BLOCK_DRIFT';
  const registration = classifyNativeHostRegistration(observedValue, receipt);
  if (registration === 'DRIFT') return 'BLOCK_DRIFT';
  return registration === 'ABSENT' ? 'FILES_ONLY' : 'REGISTRATION_THEN_FILES';
}

export interface NativeHostInstallationInput {
  distributionDirectory: string;
  localAppData: string;
  repository: string;
}

export interface NativeHostInstallationDependencies {
  verifyDistribution: typeof verifyNativeHostDistributionDirectory;
  sha256File: typeof sha256File;
}

export const defaultNativeHostInstallationDependencies: NativeHostInstallationDependencies = {
  verifyDistribution: verifyNativeHostDistributionDirectory,
  sha256File,
};

function assertAcceptedDistribution(receiptValue: NativeHostBuildReceipt): NativeHostBuildReceipt {
  if (receiptValue.repository !== NATIVE_HOST_ACCEPTED_REPOSITORY) {
    throw new Error('Native host distribution repository identity mismatch');
  }
  if (receiptValue.sourceSha !== NATIVE_HOST_ACCEPTED_SOURCE_SHA) {
    throw new Error('Native host distribution source SHA identity mismatch');
  }
  if (receiptValue.workflowRunId !== NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID) {
    throw new Error('Native host distribution workflow run identity mismatch');
  }
  if (receiptValue.runAttempt !== NATIVE_HOST_ACCEPTED_RUN_ATTEMPT) {
    throw new Error('Native host distribution run attempt identity mismatch');
  }
  if (receiptValue.artifact.filename !== NATIVE_HOST_FILENAME) {
    throw new Error('Native host distribution artifact filename identity mismatch');
  }
  if (receiptValue.artifact.sha256 !== NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256) {
    throw new Error('Native host distribution executable hash identity mismatch');
  }
  if (receiptValue.nativeApplicationName !== NATIVE_HOST_APPLICATION_NAME) {
    throw new Error('Native host distribution application identity mismatch');
  }
  if (receiptValue.extensionId !== BROWSER_ADAPTER_EXTENSION_ID) {
    throw new Error('Native host distribution extension identity mismatch');
  }
  return parseNativeHostBuildReceipt(receiptValue);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createRegistrationArtifact(manifestPath: string): Buffer {
  const escapedManifestPath = manifestPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const body = 'Windows Registry Editor Version 5.00\r\n\r\n'
    + `[HKEY_CURRENT_USER\\${REGISTRATION_SUBKEY}]\r\n`
    + `@="${escapedManifestPath}"\r\n`;
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
}

async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`${label} is not a bounded file`);
  return readFile(path);
}

async function validatePreparedDirectory(
  storageRoot: string,
  paths: NativeHostInstallPaths,
  dependencies: NativeHostInstallationDependencies,
): Promise<NativeHostInstallReceipt> {
  const entries = await readdir(storageRoot, { withFileTypes: true });
  const files = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile())
    || files.length !== INSTALLATION_FILES.length
    || files.some((file, index) => file !== INSTALLATION_FILES[index])
  ) {
    throw new Error('Native host installation payload drift detected');
  }

  const receiptBytes = await readBoundedFile(
    win32.join(storageRoot, RECEIPT_FILENAME),
    MAX_INSTALL_RECEIPT_BYTES,
    'Native host installation receipt',
  );
  let receiptValue: unknown;
  try {
    receiptValue = JSON.parse(receiptBytes.toString('utf8'));
  } catch {
    throw new Error('Native host installation receipt is not valid JSON');
  }
  let receipt: NativeHostInstallReceipt;
  try {
    receipt = parseNativeHostInstallReceipt(receiptValue);
  } catch {
    throw new Error('Native host installation receipt validation failed');
  }
  if (receipt.executablePath !== paths.executable || receipt.manifestPath !== paths.manifest) {
    throw new Error('Native host installation receipt path drift detected');
  }
  if (!receiptBytes.equals(Buffer.from(serializeJson(receipt), 'utf8'))) {
    throw new Error('Native host installation receipt byte drift detected');
  }

  const installedExecutable = win32.join(storageRoot, NATIVE_HOST_FILENAME);
  const executableSha256 = await dependencies.sha256File(installedExecutable);
  if (
    executableSha256 !== NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256
    || executableSha256 !== receipt.executableSha256
  ) {
    throw new Error('Native host installed executable hash drift detected');
  }

  const manifestFile = win32.join(storageRoot, MANIFEST_FILENAME);
  const manifestBytes = await readBoundedFile(manifestFile, MAX_MANIFEST_BYTES, 'Native host manifest');
  const expectedManifest = createNativeHostManifest({
    executablePath: paths.executable,
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
  });
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Native host manifest is not valid JSON');
  }
  if (!isDeepStrictEqual(manifestValue, expectedManifest)) {
    throw new Error('Native host manifest identity drift detected');
  }
  if (!manifestBytes.equals(Buffer.from(serializeJson(expectedManifest), 'utf8'))) {
    throw new Error('Native host manifest byte drift detected');
  }
  const manifestSha256 = await dependencies.sha256File(manifestFile);
  if (manifestSha256 !== receipt.manifestSha256) {
    throw new Error('Native host manifest hash drift detected');
  }

  const registrationBytes = await readBoundedFile(
    win32.join(storageRoot, REGISTRATION_ARTIFACT_FILENAME),
    MAX_REGISTRATION_ARTIFACT_BYTES,
    'Native host registration artifact',
  );
  if (!registrationBytes.equals(createRegistrationArtifact(paths.manifest))) {
    throw new Error('Native host registration artifact drift detected');
  }
  return receipt;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function prepareNativeHostInstallation(
  input: NativeHostInstallationInput,
  dependencies: NativeHostInstallationDependencies = defaultNativeHostInstallationDependencies,
): Promise<NativeHostInstallReceipt> {
  requireWindowsDriveAbsolute(input.distributionDirectory, 'Distribution directory');
  requireWindowsDriveAbsolute(input.localAppData, 'Local app data');
  if (input.repository !== NATIVE_HOST_ACCEPTED_REPOSITORY) {
    throw new Error('Native host installation repository is not accepted');
  }

  const distributionReceipt = assertAcceptedDistribution(await dependencies.verifyDistribution({
    directory: input.distributionDirectory,
    expectedRepository: input.repository,
    expectedSourceSha: NATIVE_HOST_ACCEPTED_SOURCE_SHA,
  }));
  const paths = buildNativeHostInstallPaths(input.localAppData, distributionReceipt.sourceSha);
  const parent = win32.dirname(paths.root);
  await mkdir(parent, { recursive: true });

  if (await pathExists(paths.root)) {
    return validatePreparedDirectory(paths.root, paths, dependencies);
  }

  const tempRoot = await mkdtemp(win32.join(parent, `.${distributionReceipt.sourceSha}-`));
  try {
    await copyFile(
      win32.join(input.distributionDirectory, NATIVE_HOST_FILENAME),
      win32.join(tempRoot, NATIVE_HOST_FILENAME),
    );
    const executableSha256 = await dependencies.sha256File(win32.join(tempRoot, NATIVE_HOST_FILENAME));
    if (executableSha256 !== NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256) {
      throw new Error('Native host post-copy executable hash mismatch');
    }

    const manifest = createNativeHostManifest({
      executablePath: paths.executable,
      extensionId: BROWSER_ADAPTER_EXTENSION_ID,
    });
    const tempManifestPath = win32.join(tempRoot, MANIFEST_FILENAME);
    await writeFile(tempManifestPath, serializeJson(manifest), 'utf8');
    const manifestSha256 = await dependencies.sha256File(tempManifestPath);
    const receipt = parseNativeHostInstallReceipt({
      schemaVersion: NATIVE_HOST_INSTALLATION_SCHEMA_VERSION,
      repository: distributionReceipt.repository,
      sourceSha: distributionReceipt.sourceSha,
      workflowRunId: distributionReceipt.workflowRunId,
      runAttempt: distributionReceipt.runAttempt,
      executableSha256,
      nativeApplicationName: distributionReceipt.nativeApplicationName,
      extensionId: distributionReceipt.extensionId,
      executablePath: paths.executable,
      manifestPath: paths.manifest,
      manifestSha256,
      registration: createNativeHostRegistrationDescriptor(paths.manifest),
      preparedAt: new Date().toISOString(),
    });
    await writeFile(win32.join(tempRoot, RECEIPT_FILENAME), serializeJson(receipt), 'utf8');
    await writeFile(
      win32.join(tempRoot, REGISTRATION_ARTIFACT_FILENAME),
      createRegistrationArtifact(paths.manifest),
    );

    await validatePreparedDirectory(tempRoot, paths, dependencies);
    await rename(tempRoot, paths.root);
    return receipt;
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
