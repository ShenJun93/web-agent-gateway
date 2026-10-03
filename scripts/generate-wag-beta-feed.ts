import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSignedBetaFeed } from '../src/product-update-feed.js';

interface Args {
  releaseManifestPath: string;
  packagePath: string;
  packageUrl: string;
  feedUrl: string;
  outputPath: string;
  sourceConfigOutputPath: string;
  signingKeyRef: string;
  ttlHours: number;
  generatedAt?: Date;
  publishedAt?: Date;
}

const SIGNING_KEY_REF = 'env:WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM';

function parseUtc(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error(label + ' must be an RFC3339 UTC timestamp');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(label + ' is invalid');
  return parsed;
}

export function parseBetaFeedArgs(argv: readonly string[]): Args {
  let releaseManifestPath = '';
  let packagePath = '';
  let packageUrl = '';
  let feedUrl = '';
  let outputPath = '';
  let sourceConfigOutputPath = '';
  let signingKeyRef = '';
  let ttlHours = 72;
  let generatedAt: Date | undefined;
  let publishedAt: Date | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value after ' + arg);
      index += 1;
      return value;
    };
    if (arg === '--release-manifest') { releaseManifestPath = resolve(next()); continue; }
    if (arg === '--package') { packagePath = resolve(next()); continue; }
    if (arg === '--package-url') { packageUrl = next(); continue; }
    if (arg === '--feed-url') { feedUrl = next(); continue; }
    if (arg === '--output') { outputPath = resolve(next()); continue; }
    if (arg === '--source-config-output') { sourceConfigOutputPath = resolve(next()); continue; }
    if (arg === '--signing-key-ref') { signingKeyRef = next(); continue; }
    if (arg === '--ttl-hours') {
      const value = Number(next());
      if (!Number.isInteger(value)) throw new Error('--ttl-hours must be an integer');
      ttlHours = value;
      continue;
    }
    if (arg === '--generated-at-utc') {
      generatedAt = parseUtc(next(), '--generated-at-utc');
      continue;
    }
    if (arg === '--published-at-utc') {
      publishedAt = parseUtc(next(), '--published-at-utc');
      continue;
    }
    throw new Error('Unknown argument: ' + arg);
  }

  for (const [name, value] of [
    ['--release-manifest', releaseManifestPath],
    ['--package', packagePath],
    ['--package-url', packageUrl],
    ['--feed-url', feedUrl],
    ['--output', outputPath],
    ['--source-config-output', sourceConfigOutputPath],
    ['--signing-key-ref', signingKeyRef],
  ] as const) {
    if (!value) throw new Error('Missing required argument: ' + name);
  }
  if (signingKeyRef !== SIGNING_KEY_REF) {
    throw new Error('--signing-key-ref must be ' + SIGNING_KEY_REF);
  }
  if (outputPath === sourceConfigOutputPath) {
    throw new Error('Feed output and source-config output must be different files');
  }

  return {
    releaseManifestPath,
    packagePath,
    packageUrl,
    feedUrl,
    outputPath,
    sourceConfigOutputPath,
    signingKeyRef,
    ttlHours,
    ...(generatedAt ? { generatedAt } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

export function runBetaFeedCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const args = parseBetaFeedArgs(argv);
  const privateKeyPem = env.WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM;
  if (!privateKeyPem) {
    throw new Error('WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM is not set');
  }
  if (existsSync(args.outputPath) || existsSync(args.sourceConfigOutputPath)) {
    throw new Error('Refusing to overwrite existing beta feed output');
  }

  const generated = createSignedBetaFeed({
    releaseManifestPath: args.releaseManifestPath,
    packagePath: args.packagePath,
    packageUrl: args.packageUrl,
    feedUrl: args.feedUrl,
    privateKeyPem,
    ttlHours: args.ttlHours,
    ...(args.generatedAt ? { generatedAt: args.generatedAt } : {}),
    ...(args.publishedAt ? { publishedAt: args.publishedAt } : {}),
  });

  mkdirSync(dirname(args.outputPath), { recursive: true });
  mkdirSync(dirname(args.sourceConfigOutputPath), { recursive: true });
  writeFileSync(args.outputPath, JSON.stringify(generated.envelope, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  writeFileSync(args.sourceConfigOutputPath, JSON.stringify(generated.sourceConfig, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });

  process.stdout.write('WAG_BETA_FEED=' + args.outputPath + '\n');
  process.stdout.write('WAG_BETA_UPDATE_SOURCE=' + args.sourceConfigOutputPath + '\n');
  process.stdout.write('WAG_BETA_RELEASE_ID=' + generated.releaseId + '\n');
  process.stdout.write('WAG_BETA_PACKAGE_SHA256=' + generated.packageSha256 + '\n');
  process.stdout.write('WAG_BETA_PUBLIC_KEY_FINGERPRINT_SHA256=' + generated.publicKeyFingerprintSha256 + '\n');
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = runBetaFeedCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown beta-feed failure';
    process.stderr.write(JSON.stringify({
      code: 'WAG_BETA_FEED_GENERATION_FAILED',
      message,
    }) + '\n');
    process.exitCode = 1;
  }
}
