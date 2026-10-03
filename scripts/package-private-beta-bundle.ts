import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ReleaseManifest } from '../src/product-release.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const zipHelper = join(repoRoot, 'scripts', 'write-deterministic-zip.ps1');
const sourceExtensionRoot = join(repoRoot, 'browser', 'extension');

const staticBundleFiles = [
  ['INSTALL-WAG-BETA.ps1', 'scripts/wag-private-beta-install.ps1'],
  ['LICENSE', 'LICENSE'],
  ['SECURITY.md', 'SECURITY.md'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['docs/policies/privacy.md', 'docs/policies/privacy.md'],
  ['docs/private-beta/operator-runbook.md', 'docs/private-beta/operator-runbook.md'],
  ['docs/private-beta/windows-private-beta.md', 'docs/private-beta/windows-private-beta.md'],
] as const;

export interface PrivateBetaExtensionFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface PrivateBetaBundleManifest {
  schema: 'WAG_PRIVATE_BETA_BUNDLE_V1';
  sourceSha: string;
  releaseId: string;
  version: string;
  channel: 'beta';
  signing: {
    state: 'UNSIGNED_PRIVATE_BETA';
    authenticodeTrusted: false;
  };
  package: {
    path: string;
    sha256: string;
    sizeBytes: number;
    payloadSha256: string;
  };
  extension: {
    path: 'browser-extension';
    sourceHead: string;
    treeSha256: string;
    files: readonly PrivateBetaExtensionFile[];
  };
  privacy: {
    automaticUpload: false;
    receiptConsentRequired: true;
  };
}

interface ZipEntry {
  archivePath: string;
  sourcePath: string;
  sha256: string;
  size: number;
}

function windowsPowerShellChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

function spawnWindowsCommandShim(
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
  },
) {
  return spawnSync('pwsh.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    '$argv = @(ConvertFrom-Json -InputObject $env:WAG_BETA_BUNDLE_ARGS); & $env:WAG_BETA_BUNDLE_COMMAND @argv; exit $LASTEXITCODE',
  ], {
    cwd: options.cwd,
    env: {
      ...options.env,
      WAG_BETA_BUNDLE_COMMAND: file,
      WAG_BETA_BUNDLE_ARGS: JSON.stringify(args),
    },
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
  });
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function outputMustNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Private beta bundle output already exists');
}

async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Private beta bundle source must be a regular file');
  }
}

function archivePath(value: string): string {
  return value.split(sep).join('/');
}

export function privateBetaReleaseId(version: string, sourceSha: string): string {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Private beta package version is invalid');
  }
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error('Private beta source SHA is invalid');
  }
  return version + '-beta-' + sourceSha.slice(0, 12);
}

async function collectExtensionFiles(root: string): Promise<PrivateBetaExtensionFile[]> {
  const files: Array<{ relative: string; absolute: string }> = [];
  async function visit(directory: string): Promise<void> {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const child of children) {
      const absolute = join(directory, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('Private beta extension must not contain symlinks');
      if (info.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!info.isFile()) throw new Error('Private beta extension contains an unsupported entry');
      files.push({ relative: archivePath(relative(root, absolute)), absolute });
    }
  }
  await visit(root);

  const result: PrivateBetaExtensionFile[] = [];
  for (const file of files.sort((a, b) => a.relative.localeCompare(b.relative, 'en'))) {
    const info = await stat(file.absolute);
    result.push({
      path: file.relative,
      sha256: await sha256File(file.absolute),
      sizeBytes: info.size,
    });
  }
  return result;
}

async function extensionTreeSha256(root: string, files: readonly PrivateBetaExtensionFile[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(await readFile(join(root, ...file.path.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function materializeExtension(targetRoot: string, sourceSha: string): Promise<{
  files: readonly PrivateBetaExtensionFile[];
  treeSha256: string;
}> {
  const sourceFiles = await collectExtensionFiles(sourceExtensionRoot);
  await mkdir(targetRoot, { recursive: true });
  for (const file of sourceFiles) {
    const source = join(sourceExtensionRoot, ...file.path.split('/'));
    const target = join(targetRoot, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await writeFile(
    join(targetRoot, 'release-identity.js'),
    [
      'export const EXTENSION_RELEASE_IDENTITY = Object.freeze({',
      "  schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1',",
      "  sourceHead: '" + sourceSha + "',",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  const files = await collectExtensionFiles(targetRoot);
  return { files, treeSha256: await extensionTreeSha256(targetRoot, files) };
}

function validateReleaseForBundle(
  manifest: ReleaseManifest,
  version: string,
  releaseId: string,
  sourceSha: string,
): void {
  if (manifest.schema !== 'WAG_LOCAL_RELEASE_V1'
      || manifest.version !== version
      || manifest.releaseId !== releaseId
      || manifest.channel !== 'beta'
      || manifest.sourceProvenance !== 'git:' + sourceSha
      || !/^[a-f0-9]{64}$/.test(manifest.payloadSha256)) {
    throw new Error('Packed WAG release manifest does not match the private beta identity');
  }
}

export function validatePrivateBetaBundleManifest(value: unknown): PrivateBetaBundleManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Private beta bundle manifest is invalid');
  }
  const row = value as Record<string, unknown>;
  const signing = row.signing as Record<string, unknown> | undefined;
  const pkg = row.package as Record<string, unknown> | undefined;
  const extension = row.extension as Record<string, unknown> | undefined;
  const privacy = row.privacy as Record<string, unknown> | undefined;
  if (row.schema !== 'WAG_PRIVATE_BETA_BUNDLE_V1'
      || typeof row.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(row.sourceSha)
      || typeof row.releaseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.releaseId)
      || typeof row.version !== 'string'
      || row.channel !== 'beta'
      || signing?.state !== 'UNSIGNED_PRIVATE_BETA'
      || signing?.authenticodeTrusted !== false
      || typeof pkg?.path !== 'string' || !/^package\/[A-Za-z0-9._-]+[.]tgz$/.test(pkg.path)
      || typeof pkg?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pkg.sha256)
      || !Number.isSafeInteger(pkg?.sizeBytes) || Number(pkg?.sizeBytes) < 1
      || typeof pkg?.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pkg.payloadSha256)
      || extension?.path !== 'browser-extension'
      || extension?.sourceHead !== row.sourceSha
      || typeof extension?.treeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(extension.treeSha256)
      || !Array.isArray(extension?.files) || extension.files.length < 1 || extension.files.length > 128
      || privacy?.automaticUpload !== false
      || privacy?.receiptConsentRequired !== true) {
    throw new Error('Private beta bundle manifest is invalid');
  }
  for (const item of extension.files as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Private beta extension file manifest is invalid');
    }
    const file = item as Record<string, unknown>;
    if (typeof file.path !== 'string'
        || !/^[A-Za-z0-9._@+/-]+$/.test(file.path)
        || file.path.startsWith('/') || file.path.includes('..') || file.path.includes('\\')
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.sizeBytes) || Number(file.sizeBytes) < 0) {
      throw new Error('Private beta extension file manifest is invalid');
    }
  }
  return value as PrivateBetaBundleManifest;
}

async function zipEntry(path: string, archive: string): Promise<ZipEntry> {
  await assertRegularFile(path);
  const info = await stat(path);
  return {
    archivePath: archive,
    sourcePath: resolve(path),
    sha256: await sha256File(path),
    size: info.size,
  };
}

async function runDeterministicZip(entries: readonly ZipEntry[], outputZip: string, tempRoot: string): Promise<void> {
  const manifestPath = join(tempRoot, 'zip-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, entries }, null, 2), 'utf8');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    zipHelper,
    '-ManifestPath',
    manifestPath,
    '-OutputPath',
    outputZip,
  ], {
    cwd: repoRoot,
    env: windowsPowerShellChildEnv(),
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 128 * 1024,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Private beta deterministic ZIP helper failed');
  }
}

function git(args: readonly string[]): string {
  const result = spawnSync('git.exe', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw new Error('Private beta Git identity check failed');
  return result.stdout.trim();
}

export async function packagePrivateBetaBundle(options: {
  sourceSha: string;
  outputZip: string;
}): Promise<{
  sourceSha: string;
  releaseId: string;
  sha256: string;
  packageSha256: string;
  extensionSha256: string;
  entryCount: number;
}> {
  if (process.platform !== 'win32') throw new Error('Private beta bundle packaging requires Windows');
  if (!/^[a-f0-9]{40}$/.test(options.sourceSha)) throw new Error('Private beta source SHA is invalid');
  if (!isAbsolute(options.outputZip) || !options.outputZip.toLowerCase().endsWith('.zip')) {
    throw new Error('Private beta output must be an absolute .zip path');
  }
  await outputMustNotExist(options.outputZip);
  if (git(['rev-parse', 'HEAD']) !== options.sourceSha) {
    throw new Error('Private beta source SHA must equal current committed HEAD');
  }
  if (git(['status', '--porcelain', '--untracked-files=normal']) !== '') {
    throw new Error('Private beta bundle requires a clean worktree');
  }

  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  const version = typeof packageJson.version === 'string' ? packageJson.version : '';
  const releaseId = privateBetaReleaseId(version, options.sourceSha);
  const tempRoot = await mkdtemp(join(tmpdir(), 'wag-private-beta-bundle-'));
  const releaseManifestPath = join(repoRoot, 'RELEASE.json');

  try {
    const packRoot = join(tempRoot, 'pack');
    await mkdir(packRoot, { recursive: true });
    const pack = spawnWindowsCommandShim(
      'npm.cmd',
      ['pack', '--silent', '--pack-destination', packRoot],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          WAG_RELEASE_CHANNEL: 'beta',
          WAG_RELEASE_ID: releaseId,
          WAG_RELEASE_SOURCE_PROVENANCE: 'git:' + options.sourceSha,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    if (pack.error || pack.status !== 0) throw new Error('npm pack failed for private beta bundle');

    const tarballs = (await readdir(packRoot)).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error('Private beta npm pack did not produce exactly one tarball');
    const tarball = join(packRoot, tarballs[0]!);
    await assertRegularFile(tarball);

    const releaseManifest = JSON.parse(await readFile(releaseManifestPath, 'utf8')) as ReleaseManifest;
    validateReleaseForBundle(releaseManifest, version, releaseId, options.sourceSha);

    const extensionRoot = join(tempRoot, 'browser-extension');
    const extension = await materializeExtension(extensionRoot, options.sourceSha);
    const packageInfo = await stat(tarball);
    const packageSha256 = await sha256File(tarball);
    const bundleManifest: PrivateBetaBundleManifest = {
      schema: 'WAG_PRIVATE_BETA_BUNDLE_V1',
      sourceSha: options.sourceSha,
      releaseId,
      version,
      channel: 'beta',
      signing: {
        state: 'UNSIGNED_PRIVATE_BETA',
        authenticodeTrusted: false,
      },
      package: {
        path: 'package/' + basename(tarball),
        sha256: packageSha256,
        sizeBytes: packageInfo.size,
        payloadSha256: releaseManifest.payloadSha256,
      },
      extension: {
        path: 'browser-extension',
        sourceHead: options.sourceSha,
        treeSha256: extension.treeSha256,
        files: extension.files,
      },
      privacy: {
        automaticUpload: false,
        receiptConsentRequired: true,
      },
    };
    validatePrivateBetaBundleManifest(bundleManifest);

    const bundleManifestPath = join(tempRoot, 'PRIVATE_BETA_BUNDLE.json');
    await writeFile(bundleManifestPath, JSON.stringify(bundleManifest, null, 2) + '\n', 'utf8');

    const entries: ZipEntry[] = [
      await zipEntry(bundleManifestPath, 'PRIVATE_BETA_BUNDLE.json'),
      await zipEntry(tarball, bundleManifest.package.path),
      await zipEntry(releaseManifestPath, 'release/RELEASE.json'),
    ];
    for (const [archive, relativeSource] of staticBundleFiles) {
      entries.push(await zipEntry(join(repoRoot, ...relativeSource.split('/')), archive));
    }
    for (const file of extension.files) {
      entries.push(await zipEntry(
        join(extensionRoot, ...file.path.split('/')),
        'browser-extension/' + file.path,
      ));
    }
    entries.sort((a, b) => a.archivePath.localeCompare(b.archivePath, 'en'));
    if (entries.length > 256) throw new Error('Private beta bundle has too many entries');
    if (entries.some((entry) => /(?:^|\/)(?:tunnel-client|secrets?)(?:$|\/)/i.test(entry.archivePath))) {
      throw new Error('Private beta bundle attempted to include a credential or tunnel-client payload');
    }

    await mkdir(dirname(options.outputZip), { recursive: true });
    await runDeterministicZip(entries, options.outputZip, tempRoot);
    return {
      sourceSha: options.sourceSha,
      releaseId,
      sha256: await sha256File(options.outputZip),
      packageSha256,
      extensionSha256: extension.treeSha256,
      entryCount: entries.length,
    };
  } finally {
    await rm(releaseManifestPath, { force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error('Missing ' + name);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await packagePrivateBetaBundle({
    sourceSha: option(args, '--source-sha'),
    outputZip: resolve(option(args, '--output')),
  });
  process.stdout.write(JSON.stringify({
    status: 'packaged',
    ...result,
  }) + '\n');
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write('wag-private-beta-bundle: ' + (error instanceof Error ? error.message : 'failed') + '\n');
    process.exitCode = 1;
  });
}
