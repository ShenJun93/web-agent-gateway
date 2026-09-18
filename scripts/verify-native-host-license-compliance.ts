import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = join(repoRoot, 'browser', 'native-host', 'third-party-components.json');

interface PackageEntry {
  name: string;
  version: string;
  license: string;
  packageLicenseFile: string;
}

interface ComplianceManifest {
  schemaVersion: 1;
  projectLicense: {
    spdx: string;
    trackedFile: string;
    trackedLicenseSha256: string;
  };
  node: {
    version: string;
    license: string;
    trackedLicenseFile: string;
    trackedLicenseSha256: string;
  };
  bundledNpmPackages: PackageEntry[];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function packageNameFromInput(input: string): string | undefined {
  const normalized = input.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const rest = normalized.slice(markerIndex + marker.length);
  const parts = rest.split('/');
  if (!parts[0]) return undefined;
  if (parts[0].startsWith('@')) {
    if (!parts[1]) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function assertSameSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSorted = [...new Set(actual)].sort();
  const expectedSorted = [...new Set(expected)].sort();
  if (
    actualSorted.length !== expectedSorted.length
    || actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    throw new Error(`${label} mismatch: actual=${actualSorted.join(',')} expected=${expectedSorted.join(',')}`);
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function parseManifest(value: unknown): ComplianceManifest {
  if (!value || typeof value !== 'object') throw new Error('License compliance manifest must be an object');
  const manifest = value as Partial<ComplianceManifest>;
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported license compliance manifest version');
  if (!manifest.projectLicense || !manifest.node || !Array.isArray(manifest.bundledNpmPackages)) {
    throw new Error('License compliance manifest is incomplete');
  }
  return manifest as ComplianceManifest;
}

async function verifyTrackedHash(path: string, expectedSha256: string, label: string): Promise<void> {
  const bytes = await readFile(path);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) throw new Error(`${label} hash mismatch: ${actual}`);
}

export async function verifyNativeHostLicenseCompliance(): Promise<void> {
  const manifest = parseManifest(await readJson(manifestPath));
  const rootPackage = await readJson(join(repoRoot, 'package.json')) as { license?: unknown };
  if (rootPackage.license !== manifest.projectLicense.spdx) {
    throw new Error('Project package license metadata does not match compliance manifest');
  }

  await verifyTrackedHash(
    join(repoRoot, manifest.projectLicense.trackedFile),
    manifest.projectLicense.trackedLicenseSha256,
    'Project license',
  );
  await verifyTrackedHash(
    join(repoRoot, manifest.node.trackedLicenseFile),
    manifest.node.trackedLicenseSha256,
    'Node license',
  );

  if (process.versions.node !== manifest.node.version) {
    throw new Error(`Native-host license gate requires Node ${manifest.node.version}; got ${process.versions.node}`);
  }

  const bundle = await build({
    entryPoints: [join(repoRoot, 'src', 'browser-adapter', 'native-host-main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    write: false,
    metafile: true,
    sourcemap: false,
    minify: false,
    logLevel: 'silent',
  });

  const actualPackages = Object.keys(bundle.metafile?.inputs ?? {})
    .map(packageNameFromInput)
    .filter((name): name is string => name !== undefined);
  assertSameSet(
    actualPackages,
    manifest.bundledNpmPackages.map((entry) => entry.name),
    'Bundled npm package set',
  );

  for (const entry of manifest.bundledNpmPackages) {
    const packageRoot = join(repoRoot, 'node_modules', ...entry.name.split('/'));
    const packageJson = await readJson(join(packageRoot, 'package.json')) as {
      name?: unknown;
      version?: unknown;
      license?: unknown;
    };
    if (
      packageJson.name !== entry.name
      || packageJson.version !== entry.version
      || packageJson.license !== entry.license
    ) {
      throw new Error(`Bundled package metadata mismatch for ${entry.name}`);
    }
    const installedLicense = await readFile(join(packageRoot, entry.packageLicenseFile));
    const trackedLicense = await readFile(
      join(repoRoot, 'third_party', 'native-host', 'npm', ...entry.name.split('/'), entry.packageLicenseFile),
    );
    if (!installedLicense.equals(trackedLicense)) {
      throw new Error(`Tracked license bytes are stale for ${entry.name}`);
    }
  }
}

async function main(): Promise<void> {
  await verifyNativeHostLicenseCompliance();
  process.stdout.write('native-host-license-compliance: PASS\n');
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`native-host-license-compliance: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
