import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import * as ResEdit from 'resedit';

export const NATIVE_HOST_PRODUCT_NAME = 'Web Agent Gateway' as const;
export const NATIVE_HOST_FILE_DESCRIPTION = 'Web Agent Gateway Native Host' as const;
export const NATIVE_HOST_INTERNAL_NAME = 'wag-native-host' as const;
export const NATIVE_HOST_ORIGINAL_FILENAME = 'wag-native-host.exe' as const;

const VERSION_KEYS = new Set([
  'FileDescription',
  'FileVersion',
  'InternalName',
  'OriginalFilename',
  'ProductName',
  'ProductVersion',
]);

export function windowsFileVersion(packageVersion: string): string {
  const match = packageVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error('Native-host release version must be numeric SemVer X.Y.Z');
  const parts = match.slice(1).map(Number);
  if (parts.some((value) => !Number.isInteger(value) || value < 0 || value > 65535)) {
    throw new Error('Native-host release version components must be between 0 and 65535');
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

export async function normalizeNativeHostPeMetadata(
  executablePath: string,
  packageVersion: string,
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('PE metadata normalization requires Windows');
  const version = windowsFileVersion(packageVersion);
  const source = await readFile(executablePath);
  const executable = ResEdit.NtExecutable.from(source);
  const resources = ResEdit.NtExecutableResource.from(executable);
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  if (versions.length !== 1) throw new Error(`Expected exactly one VERSIONINFO resource; got ${versions.length}`);

  const info = versions[0];
  const existingLanguages = info.getAllLanguagesForStringValues();
  const languages = existingLanguages.length > 0
    ? existingLanguages
    : [{ lang: 1033, codepage: 1200 }];
  const primaryLang = typeof languages[0].lang === 'number' ? languages[0].lang : 1033;

  info.setFileVersion(version, primaryLang);
  info.setProductVersion(version, primaryLang);
  for (const language of languages) {
    const existing = info.getStringValues(language);
    for (const key of Object.keys(existing)) {
      if (!VERSION_KEYS.has(key)) info.removeStringValue(language, key, false);
    }
    info.setStringValues(language, {
      FileDescription: NATIVE_HOST_FILE_DESCRIPTION,
      FileVersion: version,
      InternalName: NATIVE_HOST_INTERNAL_NAME,
      OriginalFilename: NATIVE_HOST_ORIGINAL_FILENAME,
      ProductName: NATIVE_HOST_PRODUCT_NAME,
      ProductVersion: version,
    });
  }

  info.outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  const generated = Buffer.from(executable.generate());
  const tempPath = `${executablePath}.metadata.tmp`;
  await rm(tempPath, { force: true });
  try {
    await writeFile(tempPath, generated);
    await copyFile(tempPath, executablePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}
