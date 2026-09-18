import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION,
  NATIVE_HOST_FILENAME,
  sha256File,
  verifyNativeHostDistributionDirectory,
} from '../src/browser-adapter/native-host-distribution.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ZIP_HELPER = join(repoRoot, 'scripts', 'write-deterministic-zip.ps1');
const DISTRIBUTION_FILES = [
  'build-receipt.json',
  NATIVE_HOST_FILENAME,
  `${NATIVE_HOST_FILENAME}.sha256`,
] as const;
const STATIC_RELEASE_FILES = [
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/native-host-installation.md',
  'docs/policies/code-signing-policy.md',
  'docs/policies/privacy.md',
] as const;

export interface NativeHostReleaseEntry {
  archivePath: string;
  sourcePath: string;
  sha256: string;
  size: number;
}

export interface PackageNativeHostReleaseOptions {
  distributionDirectory: string;
  outputZip: string;
  expectedRepository: string;
  expectedSourceSha: string;
}

function toArchivePath(value: string): string {
  return value.split(sep).join('/');
}

async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Release package source must be a regular file');
}

async function collectFiles(root: string, archivePrefix: string): Promise<Array<{ archivePath: string; sourcePath: string }>> {
  const output: Array<{ archivePath: string; sourcePath: string }> = [];
  async function visit(directory: string): Promise<void> {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const child of children) {
      const childPath = join(directory, child.name);
      const childInfo = await lstat(childPath);
      if (childInfo.isSymbolicLink()) throw new Error('Release package tree must not contain symlinks');
      if (childInfo.isDirectory()) {
        await visit(childPath);
        continue;
      }
      if (!childInfo.isFile()) throw new Error('Release package tree contains an unsupported entry');
      const rel = toArchivePath(relative(root, childPath));
      output.push({ archivePath: `${archivePrefix}/${rel}`, sourcePath: childPath });
    }
  }
  await visit(root);
  return output;
}

async function releaseEntries(distributionDirectory: string): Promise<NativeHostReleaseEntry[]> {
  const sources: Array<{ archivePath: string; sourcePath: string }> = [];

  for (const filename of DISTRIBUTION_FILES) {
    sources.push({
      archivePath: `native-host/${filename}`,
      sourcePath: join(distributionDirectory, filename),
    });
  }

  for (const relativePath of STATIC_RELEASE_FILES) {
    sources.push({
      archivePath: toArchivePath(relativePath),
      sourcePath: join(repoRoot, relativePath),
    });
  }

  sources.push(...await collectFiles(
    join(repoRoot, 'third_party', 'native-host'),
    'third_party/native-host',
  ));

  sources.sort((a, b) => a.archivePath < b.archivePath ? -1 : a.archivePath > b.archivePath ? 1 : 0);

  const entries: NativeHostReleaseEntry[] = [];
  for (const source of sources) {
    await assertRegularFile(source.sourcePath);
    const fileStat = await stat(source.sourcePath);
    entries.push({
      archivePath: source.archivePath,
      sourcePath: source.sourcePath,
      sha256: await sha256File(source.sourcePath),
      size: fileStat.size,
    });
  }
  return entries;
}

async function outputMustNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Release output already exists');
}

export async function packageNativeHostRelease(
  options: PackageNativeHostReleaseOptions,
): Promise<{ sourceSha: string; sha256: string; entryCount: number; entries: readonly NativeHostReleaseEntry[] }> {
  if (process.platform !== 'win32') throw new Error('Native-host release packaging requires Windows');
  if (!isAbsolute(options.distributionDirectory) || !isAbsolute(options.outputZip)) {
    throw new Error('Release paths must be absolute');
  }
  if (basename(options.outputZip).toLowerCase().endsWith('.zip') === false) {
    throw new Error('Release output must be a .zip file');
  }
  await outputMustNotExist(options.outputZip);

  const receipt = await verifyNativeHostDistributionDirectory({
    directory: options.distributionDirectory,
    expectedRepository: options.expectedRepository,
    expectedSourceSha: options.expectedSourceSha,
  });
  if (receipt.schemaVersion !== NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION) {
    throw new Error('Official release packaging requires the current distribution schema');
  }

  const entries = await releaseEntries(options.distributionDirectory);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'wag-native-host-release-'));
  try {
    const manifestPath = join(temporaryDirectory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      entries,
    }), 'utf8');

    const helper = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      ZIP_HELPER,
      '-ManifestPath',
      manifestPath,
      '-OutputPath',
      options.outputZip,
    ], {
      cwd: repoRoot,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
    if (helper.error || helper.status !== 0) throw new Error('ZIP helper failed');
  } catch {
    await rm(options.outputZip, { force: true });
    throw new Error('Native-host release packaging failed');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  return {
    sourceSha: receipt.sourceSha,
    sha256: await sha256File(options.outputZip),
    entryCount: entries.length,
    entries,
  };
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await packageNativeHostRelease({
    distributionDirectory: option(args, '--distribution'),
    outputZip: option(args, '--output'),
    expectedRepository: option(args, '--repository'),
    expectedSourceSha: option(args, '--source-sha'),
  });
  process.stdout.write(`${JSON.stringify({
    status: 'packaged',
    sourceSha: result.sourceSha,
    sha256: result.sha256,
    entryCount: result.entryCount,
  })}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`wag-native-host-release-package: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
