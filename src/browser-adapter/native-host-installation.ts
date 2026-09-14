import { win32 } from 'node:path';
import { z } from 'zod';
import {
  BROWSER_ADAPTER_EXTENSION_ID,
  NATIVE_HOST_APPLICATION_NAME,
  NATIVE_HOST_FILENAME,
} from './native-host-distribution.js';

export const NATIVE_HOST_INSTALLATION_SCHEMA_VERSION = 1 as const;
export const NATIVE_HOST_ACCEPTED_REPOSITORY = 'ShenJun93/web-agent-gateway' as const;
export const NATIVE_HOST_ACCEPTED_SOURCE_SHA = 'fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d' as const;
export const NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256 =
  '0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf' as const;
export const NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID = '34757274244' as const;
export const NATIVE_HOST_ACCEPTED_RUN_ATTEMPT = 1 as const;

const MANIFEST_FILENAME = `${NATIVE_HOST_APPLICATION_NAME}.json` as const;
const RECEIPT_FILENAME = 'install-receipt.json' as const;
const REGISTRATION_ARTIFACT_FILENAME = 'register-native-host.reg' as const;
const REGISTRATION_SUBKEY =
  `SOFTWARE\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_APPLICATION_NAME}` as const;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\\/;
const SHA256 = /^[0-9a-f]{64}$/;

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
