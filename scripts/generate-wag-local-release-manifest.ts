import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReleaseManifest,
  hashReleasePayload,
  type ReleaseChannel,
} from '../src/product-release.js';

interface Args {
  packageRoot: string;
  output: string;
  releaseId?: string;
  version?: string;
  channel?: ReleaseChannel;
  sourceProvenance?: string;
  rollbackTarget?: string | 'previous-active' | null;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: string[]): Args {
  let packageRoot = repoRoot;
  let output = '';
  let releaseId: string | undefined;
  let version: string | undefined;
  let channel: ReleaseChannel | undefined;
  let sourceProvenance: string | undefined;
  let rollbackTarget: string | 'previous-active' | null | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value after ${arg}`);
      index += 1;
      return value;
    };
    if (arg === '--package-root') { packageRoot = resolve(next()); continue; }
    if (arg === '--output') { output = resolve(next()); continue; }
    if (arg === '--release-id') { releaseId = next(); continue; }
    if (arg === '--version') { version = next(); continue; }
    if (arg === '--channel') {
      const value = next();
      if (!['stable', 'beta', 'development'].includes(value)) throw new Error('Invalid release channel');
      channel = value as ReleaseChannel;
      continue;
    }
    if (arg === '--source-provenance') { sourceProvenance = next(); continue; }
    if (arg === '--rollback-target') {
      const value = next();
      rollbackTarget = value === 'none' ? null : value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!output) output = join(packageRoot, 'RELEASE.json');
  if (!isAbsolute(packageRoot) || !isAbsolute(output)) throw new Error('Paths must be absolute');
  return {
    packageRoot,
    output,
    ...(releaseId ? { releaseId } : {}),
    ...(version ? { version } : {}),
    ...(channel ? { channel } : {}),
    ...(sourceProvenance ? { sourceProvenance } : {}),
    ...(rollbackTarget !== undefined ? { rollbackTarget } : {}),
  };
}

function gitIdentity(packageRoot: string): { head: string; dirty: boolean } | null {
  try {
    const top = execFileSync('git.exe', ['-C', packageRoot, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (resolve(top) !== resolve(packageRoot)) return null;

    const head = execFileSync('git.exe', ['-C', packageRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[a-f0-9]{40}$/.test(head)) return null;

    const status = execFileSync('git.exe', ['-C', packageRoot, 'status', '--porcelain', '--untracked-files=normal'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { head, dirty: status.length > 0 };
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
const packageJsonPath = join(args.packageRoot, 'package.json');
if (!existsSync(packageJsonPath)) throw new Error('package.json missing from package root');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  name?: unknown;
  version?: unknown;
};
const version = args.version
  ?? (typeof packageJson.version === 'string' ? packageJson.version : '');
if (!version) throw new Error('Package version unavailable');

const channel = args.channel
  ?? (['stable', 'beta', 'development'].includes(String(process.env.WAG_RELEASE_CHANNEL))
    ? String(process.env.WAG_RELEASE_CHANNEL) as ReleaseChannel
    : 'development');

const payloadDigest = hashReleasePayload(args.packageRoot);
const identity = gitIdentity(args.packageRoot);
const explicitProvenance = args.sourceProvenance ?? process.env.WAG_RELEASE_SOURCE_PROVENANCE;
if (!explicitProvenance && identity?.dirty && channel !== 'development') {
  throw new Error('Refusing stable/beta release manifest from a dirty source tree');
}

const provenance = explicitProvenance
  ?? (identity
    ? identity.dirty
      ? `git:${identity.head}+dirty:${payloadDigest.slice(0, 12)}`
      : `git:${identity.head}`
    : `package:${typeof packageJson.name === 'string' ? packageJson.name : 'web-agent-gateway'}@${version}`);

const rollbackTarget = args.rollbackTarget
  ?? process.env.WAG_RELEASE_ROLLBACK_TARGET
  ?? 'previous-active';

const cleanGit = provenance.match(/^git:([a-f0-9]{40})$/);
const dirtyGit = provenance.match(/^git:([a-f0-9]{40})\+dirty:([a-f0-9]{12})$/);
const releaseId = args.releaseId
  ?? process.env.WAG_RELEASE_ID
  ?? (channel === 'stable'
    ? version
    : channel === 'beta'
      ? `${version}-beta`
      : cleanGit
        ? `${version}-dev-${cleanGit[1]!.slice(0, 12)}`
        : dirtyGit
          ? `${version}-dev-${dirtyGit[1]!.slice(0, 12)}-dirty-${dirtyGit[2]}`
          : `${version}-development-${payloadDigest.slice(0, 12)}`);

const manifest = createReleaseManifest(args.packageRoot, {
  releaseId,
  version,
  channel,
  sourceProvenance: provenance,
  compatibility: { nodeMinMajor: 22, nodeMaxMajor: 26 },
  migrationVersion: 1,
  rollbackTarget: rollbackTarget === 'none' ? null : rollbackTarget,
});

writeFileSync(args.output, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
process.stdout.write(`WAG_RELEASE_MANIFEST=${args.output}\n`);
process.stdout.write(`WAG_RELEASE_ID=${manifest.releaseId}\n`);
process.stdout.write(`WAG_RELEASE_PAYLOAD_SHA256=${manifest.payloadSha256}\n`);
