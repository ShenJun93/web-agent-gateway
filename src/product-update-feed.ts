import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  validateReleaseManifest,
  type ReleaseManifest,
} from './product-release.js';

const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 7 * 24;

export interface SignedBetaFeedOptions {
  releaseManifestPath: string;
  packagePath: string;
  packageUrl: string;
  feedUrl: string;
  privateKeyPem: string;
  generatedAt?: Date;
  publishedAt?: Date;
  ttlHours?: number;
}

export interface SignedBetaFeedResult {
  envelope: {
    schema: 'WAG_LOCAL_UPDATE_ENVELOPE_V1';
    payloadBase64: string;
    signatureBase64: string;
  };
  sourceConfig: {
    schema: 'WAG_LOCAL_UPDATE_SOURCE_V1';
    feedUrl: string;
    ed25519PublicKeySpkiDerBase64: string;
    timeoutMs: number;
    maxBytes: number;
  };
  releaseId: string;
  packageSha256: string;
  packageSizeBytes: number;
  publicKeyFingerprintSha256: string;
  payload: {
    schema: 'WAG_LOCAL_UPDATE_FEED_V1';
    generatedAtUtc: string;
    expiresAtUtc: string;
    channels: {
      stable: readonly [];
      beta: readonly [{
        manifest: ReleaseManifest;
        packageUrl: string;
        packageSha256: string;
        packageSizeBytes: number;
        publishedAtUtc: string;
      }];
      development: readonly [];
    };
  };
}

function assertHttpsUrl(value: string, code: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(code);
  }
  return url.toString();
}

function nodeMajor(): number {
  const value = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(value)) throw new Error('WAG_BETA_FEED_NODE_VERSION_INVALID');
  return value;
}

function currentReleaseForValidation(manifest: ReleaseManifest): string | null {
  if (manifest.rollbackTarget === null) return null;
  if (manifest.rollbackTarget === 'previous-active') return '__current__';
  return manifest.rollbackTarget;
}

function readBetaManifest(path: string): ReleaseManifest {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    throw new Error('WAG_BETA_FEED_RELEASE_MANIFEST_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WAG_BETA_FEED_RELEASE_MANIFEST_INVALID');
  }
  const manifest = parsed as ReleaseManifest;
  try {
    validateReleaseManifest(
      manifest,
      currentReleaseForValidation(manifest),
      nodeMajor(),
    );
  } catch {
    throw new Error('WAG_BETA_FEED_RELEASE_MANIFEST_INVALID');
  }
  if (manifest.channel !== 'beta') {
    throw new Error('WAG_BETA_FEED_CHANNEL_MUST_BE_BETA');
  }
  return manifest;
}

function readPackage(path: string): Buffer {
  const absolute = resolve(path);
  let info;
  try {
    info = statSync(absolute);
  } catch {
    throw new Error('WAG_BETA_FEED_PACKAGE_MISSING');
  }
  if (!info.isFile() || info.size < 1 || info.size > MAX_PACKAGE_BYTES) {
    throw new Error('WAG_BETA_FEED_PACKAGE_INVALID');
  }
  return readFileSync(absolute);
}

function readPrivateKey(pem: string): KeyObject {
  if (typeof pem !== 'string' || pem.length < 32 || pem.length > 64 * 1024) {
    throw new Error('WAG_BETA_FEED_SIGNING_KEY_INVALID');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('WAG_BETA_FEED_SIGNING_KEY_INVALID');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('WAG_BETA_FEED_SIGNING_KEY_INVALID');
  }
  return key;
}

function assertDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(code);
  return value;
}

export function createSignedBetaFeed(options: SignedBetaFeedOptions): SignedBetaFeedResult {
  const manifest = readBetaManifest(options.releaseManifestPath);
  const packageBytes = readPackage(options.packagePath);
  const packageUrl = assertHttpsUrl(options.packageUrl, 'WAG_BETA_FEED_PACKAGE_URL_INVALID');
  const feedUrl = assertHttpsUrl(options.feedUrl, 'WAG_BETA_FEED_URL_INVALID');
  const privateKey = readPrivateKey(options.privateKeyPem);

  const generatedAt = assertDate(options.generatedAt ?? new Date(), 'WAG_BETA_FEED_GENERATED_AT_INVALID');
  const publishedAt = assertDate(options.publishedAt ?? generatedAt, 'WAG_BETA_FEED_PUBLISHED_AT_INVALID');
  if (publishedAt.getTime() > generatedAt.getTime()) {
    throw new Error('WAG_BETA_FEED_PUBLISHED_AT_INVALID');
  }
  const ttlHours = options.ttlHours ?? 72;
  if (!Number.isInteger(ttlHours) || ttlHours < MIN_TTL_HOURS || ttlHours > MAX_TTL_HOURS) {
    throw new Error('WAG_BETA_FEED_TTL_INVALID');
  }
  const expiresAt = new Date(generatedAt.getTime() + ttlHours * 60 * 60 * 1000);

  const packageSha256 = createHash('sha256').update(packageBytes).digest('hex');
  const payload = {
    schema: 'WAG_LOCAL_UPDATE_FEED_V1' as const,
    generatedAtUtc: generatedAt.toISOString(),
    expiresAtUtc: expiresAt.toISOString(),
    channels: {
      stable: [] as const,
      beta: [{
        manifest,
        packageUrl,
        packageSha256,
        packageSizeBytes: packageBytes.length,
        publishedAtUtc: publishedAt.toISOString(),
      }] as const,
      development: [] as const,
    },
  };

  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, payloadBytes, privateKey);
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyFingerprintSha256 = createHash('sha256').update(publicDer).digest('hex');

  const envelope = {
    schema: 'WAG_LOCAL_UPDATE_ENVELOPE_V1' as const,
    payloadBase64: payloadBytes.toString('base64'),
    signatureBase64: signature.toString('base64'),
  };
  const sourceConfig = {
    schema: 'WAG_LOCAL_UPDATE_SOURCE_V1' as const,
    feedUrl,
    ed25519PublicKeySpkiDerBase64: publicDer.toString('base64'),
    timeoutMs: 5_000,
    maxBytes: 256 * 1024,
  };

  return {
    envelope,
    sourceConfig,
    releaseId: manifest.releaseId,
    packageSha256,
    packageSizeBytes: packageBytes.length,
    publicKeyFingerprintSha256,
    payload,
  };
}
