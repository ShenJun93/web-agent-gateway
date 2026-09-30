import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  readReleaseState,
  validateReleaseManifest,
  type ReleaseChannel,
  type ReleaseManifest,
} from './product-release.js';

export type ProductUpdateStatus =
  | 'UNCONFIGURED'
  | 'DISABLED'
  | 'OFFLINE'
  | 'INVALID_CONFIG'
  | 'INVALID_METADATA'
  | 'EXPIRED'
  | 'NO_COMPATIBLE_RELEASE'
  | 'CURRENT_VERSION_UNKNOWN'
  | 'CURRENT'
  | 'UPDATE_AVAILABLE';

export interface ProductUpdateCandidate {
  release_id: string;
  version: string;
  channel: ReleaseChannel;
  source_provenance: string;
  payload_sha256: string;
  package_url: string;
  package_sha256: string;
  package_size_bytes: number;
  published_at_utc: string;
}

export interface ProductUpdateCheck {
  schema: 'WAG_LOCAL_UPDATE_CHECK_V1';
  checked_at_utc: string;
  status: ProductUpdateStatus;
  configured: boolean;
  channel: ReleaseChannel;
  auto_check_updates: boolean;
  available: boolean | null;
  current: {
    release_id: string;
    version: string | null;
    channel: ReleaseChannel;
    migration_version: number;
  } | null;
  candidate: ProductUpdateCandidate | null;
  feed: {
    generated_at_utc: string;
    expires_at_utc: string;
  } | null;
  failure_code: string | null;
}

export interface ProductUpdateDiscoveryOptions {
  installRoot: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  nodeMajor?: number;
  respectAutoCheck?: boolean;
}

const SOURCE_FILE = 'update-source.json';
const SETTINGS_FILE = 'product-settings.json';
const MAX_FEED_BYTES = 512 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60_000;

const releaseManifestSchema = z.object({
  schema: z.literal('WAG_LOCAL_RELEASE_V1'),
  releaseId: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  channel: z.enum(['stable', 'beta', 'development']),
  sourceProvenance: z.string().min(1).max(512),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  compatibility: z.object({
    nodeMinMajor: z.number().int().min(1).max(1_000),
    nodeMaxMajor: z.number().int().min(1).max(1_000),
  }).strict(),
  migrationVersion: z.number().int().min(0).max(1_000),
  rollbackTarget: z.union([
    z.literal('previous-active'),
    z.string().min(1).max(128),
    z.null(),
  ]),
}).strict();

const feedReleaseSchema = z.object({
  manifest: releaseManifestSchema,
  packageUrl: z.string().url().max(4096),
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  packageSizeBytes: z.number().int().min(1).max(MAX_PACKAGE_BYTES),
  publishedAtUtc: z.string().min(1).max(64),
}).strict();

const feedPayloadSchema = z.object({
  schema: z.literal('WAG_LOCAL_UPDATE_FEED_V1'),
  generatedAtUtc: z.string().min(1).max(64),
  expiresAtUtc: z.string().min(1).max(64),
  channels: z.object({
    stable: z.array(feedReleaseSchema).max(128),
    beta: z.array(feedReleaseSchema).max(128),
    development: z.array(feedReleaseSchema).max(128),
  }).strict(),
}).strict();

const sourceSchema = z.object({
  schema: z.literal('WAG_LOCAL_UPDATE_SOURCE_V1'),
  feedUrl: z.string().url().max(4096),
  ed25519PublicKeySpkiDerBase64: z.string().min(16).max(4096),
  timeoutMs: z.number().int().min(500).max(15_000).default(5_000),
  maxBytes: z.number().int().min(1024).max(MAX_FEED_BYTES).default(256 * 1024),
}).strict();

const envelopeSchema = z.object({
  schema: z.literal('WAG_LOCAL_UPDATE_ENVELOPE_V1'),
  payloadBase64: z.string().min(4).max(2 * MAX_FEED_BYTES),
  signatureBase64: z.string().min(16).max(1024),
}).strict();

interface UpdatePreferences {
  channel: ReleaseChannel;
  autoCheckUpdates: boolean;
}

interface FeedRelease {
  manifest: ReleaseManifest;
  packageUrl: string;
  packageSha256: string;
  packageSizeBytes: number;
  publishedAtUtc: string;
}

export function productUpdateSourcePath(installRoot: string): string {
  return join(resolve(installRoot), 'config', SOURCE_FILE);
}

export function isProductUpdateSourceConfigured(installRoot: string): boolean {
  return existsSync(productUpdateSourcePath(installRoot));
}

function parseUtc(value: string, code: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error(code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function validateHttpsUrl(value: string, code: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) {
    throw new Error(code);
  }
  return url.toString();
}

function decodeBase64Strict(value: string, code: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error(code);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw new Error(code);
  const canonical = bytes.toString('base64');
  if (canonical !== value) throw new Error(code);
  return bytes;
}

function readPreferences(installRoot: string): UpdatePreferences {
  const settingsPath = join(resolve(installRoot), 'config', SETTINGS_FILE);
  const state = readReleaseState(installRoot);
  const fallback: UpdatePreferences = {
    channel: state?.channel ?? 'stable',
    autoCheckUpdates: true,
  };
  if (!existsSync(settingsPath)) return fallback;

  const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
  const value = z.object({
    schema: z.literal('WAG_LOCAL_PRODUCT_SETTINGS_V1'),
    updateChannel: z.enum(['stable', 'beta', 'development']),
    autoCheckUpdates: z.boolean(),
  }).strict().parse(parsed);
  return {
    channel: value.updateChannel,
    autoCheckUpdates: value.autoCheckUpdates,
  };
}

function currentNodeMajor(): number {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(major)) throw new Error('WAG_UPDATE_NODE_VERSION_INVALID');
  return major;
}

function currentVersion(installRoot: string, releaseId: string): string | null {
  for (const name of ['RELEASE.json', 'RUNTIME.json']) {
    const path = join(resolve(installRoot), 'runtime', releaseId, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: unknown;
        packageVersion?: unknown;
      };
      const value = typeof parsed.version === 'string'
        ? parsed.version
        : typeof parsed.packageVersion === 'string'
          ? parsed.packageVersion
          : '';
      return parseSemver(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseSemver(value: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return {
    major,
    minor,
    patch,
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error('WAG_UPDATE_VERSION_INVALID');
  for (const [l, r] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const) {
    if (l !== r) return l < r ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = a.prerelease[index];
    const r = b.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const compared = compareIdentifier(l, r);
    if (compared !== 0) return compared;
  }
  return 0;
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error('WAG_UPDATE_METADATA_TOO_LARGE');
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const row = await reader.read();
      if (row.done) break;
      const chunk = Buffer.from(row.value);
      total += chunk.length;
      if (total > maxBytes) throw new Error('WAG_UPDATE_METADATA_TOO_LARGE');
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function safeFailure(
  now: Date,
  status: ProductUpdateStatus,
  preferences: UpdatePreferences,
  configured: boolean,
  failureCode: string | null,
  current: ProductUpdateCheck['current'] = null,
): ProductUpdateCheck {
  return {
    schema: 'WAG_LOCAL_UPDATE_CHECK_V1',
    checked_at_utc: now.toISOString(),
    status,
    configured,
    channel: preferences.channel,
    auto_check_updates: preferences.autoCheckUpdates,
    available: null,
    current,
    candidate: null,
    feed: null,
    failure_code: failureCode,
  };
}

function candidateView(entry: FeedRelease): ProductUpdateCandidate {
  return {
    release_id: entry.manifest.releaseId,
    version: entry.manifest.version,
    channel: entry.manifest.channel,
    source_provenance: entry.manifest.sourceProvenance,
    payload_sha256: entry.manifest.payloadSha256,
    package_url: entry.packageUrl,
    package_sha256: entry.packageSha256,
    package_size_bytes: entry.packageSizeBytes,
    published_at_utc: entry.publishedAtUtc,
  };
}

export async function checkProductUpdate(
  options: ProductUpdateDiscoveryOptions,
): Promise<ProductUpdateCheck> {
  const installRoot = resolve(options.installRoot);
  const now = options.now?.() ?? new Date();
  let preferences: UpdatePreferences;
  try {
    preferences = readPreferences(installRoot);
  } catch {
    return safeFailure(
      now,
      'INVALID_CONFIG',
      { channel: 'stable', autoCheckUpdates: true },
      isProductUpdateSourceConfigured(installRoot),
      'WAG_UPDATE_SETTINGS_INVALID',
    );
  }

  const sourcePath = productUpdateSourcePath(installRoot);
  if (!existsSync(sourcePath)) {
    return safeFailure(now, 'UNCONFIGURED', preferences, false, null);
  }

  if (options.respectAutoCheck === true && !preferences.autoCheckUpdates) {
    return safeFailure(now, 'DISABLED', preferences, true, null);
  }

  let source: z.infer<typeof sourceSchema>;
  let feedUrl: string;
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    source = sourceSchema.parse(JSON.parse(readFileSync(sourcePath, 'utf8')));
    feedUrl = validateHttpsUrl(source.feedUrl, 'WAG_UPDATE_FEED_URL_INVALID');
    const der = decodeBase64Strict(
      source.ed25519PublicKeySpkiDerBase64,
      'WAG_UPDATE_PUBLIC_KEY_INVALID',
      2048,
    );
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('WAG_UPDATE_PUBLIC_KEY_INVALID');
  } catch {
    return safeFailure(now, 'INVALID_CONFIG', preferences, true, 'WAG_UPDATE_SOURCE_INVALID');
  }

  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeoutMs);
  try {
    response = await (options.fetchImpl ?? fetch)(feedUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return safeFailure(now, 'OFFLINE', preferences, true, 'WAG_UPDATE_FEED_UNREACHABLE');
  }
  clearTimeout(timer);

  if (!response.ok) {
    return safeFailure(now, 'OFFLINE', preferences, true, 'WAG_UPDATE_FEED_HTTP_ERROR');
  }

  let payload: z.infer<typeof feedPayloadSchema>;
  try {
    const raw = await readResponseBody(response, source.maxBytes);
    const envelope = envelopeSchema.parse(JSON.parse(raw.toString('utf8')));
    const payloadBytes = decodeBase64Strict(
      envelope.payloadBase64,
      'WAG_UPDATE_METADATA_INVALID',
      source.maxBytes,
    );
    const signature = decodeBase64Strict(
      envelope.signatureBase64,
      'WAG_UPDATE_SIGNATURE_INVALID',
      512,
    );
    if (!verify(null, payloadBytes, publicKey, signature)) {
      throw new Error('WAG_UPDATE_SIGNATURE_INVALID');
    }
    payload = feedPayloadSchema.parse(JSON.parse(payloadBytes.toString('utf8')));
  } catch {
    return safeFailure(now, 'INVALID_METADATA', preferences, true, 'WAG_UPDATE_METADATA_INVALID');
  }

  let generatedAt: number;
  let expiresAt: number;
  try {
    generatedAt = parseUtc(payload.generatedAtUtc, 'WAG_UPDATE_GENERATED_AT_INVALID');
    expiresAt = parseUtc(payload.expiresAtUtc, 'WAG_UPDATE_EXPIRES_AT_INVALID');
    if (generatedAt > now.getTime() + CLOCK_SKEW_MS || expiresAt <= generatedAt) {
      throw new Error('WAG_UPDATE_METADATA_TIME_INVALID');
    }
  } catch {
    return safeFailure(now, 'INVALID_METADATA', preferences, true, 'WAG_UPDATE_METADATA_TIME_INVALID');
  }

  if (expiresAt <= now.getTime()) {
    return {
      ...safeFailure(now, 'EXPIRED', preferences, true, 'WAG_UPDATE_METADATA_EXPIRED'),
      feed: {
        generated_at_utc: payload.generatedAtUtc,
        expires_at_utc: payload.expiresAtUtc,
      },
    };
  }

  let state: ReturnType<typeof readReleaseState>;
  try {
    state = readReleaseState(installRoot);
  } catch {
    return safeFailure(now, 'INVALID_CONFIG', preferences, true, 'WAG_RELEASE_STATE_INVALID');
  }

  if (state === null) {
    return {
      ...safeFailure(
        now,
        'CURRENT_VERSION_UNKNOWN',
        preferences,
        true,
        'WAG_UPDATE_RELEASE_STATE_MISSING',
        null,
      ),
      feed: {
        generated_at_utc: payload.generatedAtUtc,
        expires_at_utc: payload.expiresAtUtc,
      },
    };
  }

  const current = {
    release_id: state.activeReleaseId,
    version: currentVersion(installRoot, state.activeReleaseId),
    channel: state.channel,
    migration_version: state.migrationVersion,
  } satisfies NonNullable<ProductUpdateCheck['current']>;

  const nodeMajor = options.nodeMajor ?? currentNodeMajor();
  const compatible: FeedRelease[] = [];
  for (const row of payload.channels[preferences.channel]) {
    try {
      if (row.manifest.channel !== preferences.channel) throw new Error('WAG_UPDATE_CHANNEL_MISMATCH');
      const packageUrl = validateHttpsUrl(row.packageUrl, 'WAG_UPDATE_PACKAGE_URL_INVALID');
      const publishedAt = parseUtc(row.publishedAtUtc, 'WAG_UPDATE_PUBLISHED_AT_INVALID');
      if (publishedAt > now.getTime() + CLOCK_SKEW_MS) throw new Error('WAG_UPDATE_PUBLISHED_AT_INVALID');
      validateReleaseManifest(row.manifest as ReleaseManifest, state.activeReleaseId, nodeMajor);
      compatible.push({
        manifest: row.manifest as ReleaseManifest,
        packageUrl,
        packageSha256: row.packageSha256,
        packageSizeBytes: row.packageSizeBytes,
        publishedAtUtc: row.publishedAtUtc,
      });
    } catch {
      // A feed can contain releases for newer runtimes. Compatibility filtering is expected and
      // does not make a correctly signed feed invalid.
    }
  }

  compatible.sort((left, right) => {
    const version = compareSemver(right.manifest.version, left.manifest.version);
    if (version !== 0) return version;
    const published = Date.parse(right.publishedAtUtc) - Date.parse(left.publishedAtUtc);
    if (published !== 0) return published;
    return right.manifest.releaseId.localeCompare(left.manifest.releaseId);
  });
  const candidate = compatible[0] ?? null;
  const feed = {
    generated_at_utc: payload.generatedAtUtc,
    expires_at_utc: payload.expiresAtUtc,
  };

  if (!candidate) {
    return {
      ...safeFailure(now, 'NO_COMPATIBLE_RELEASE', preferences, true, null, current),
      available: false,
      feed,
    };
  }

  const candidateSafe = candidateView(candidate);
  if (candidate.manifest.releaseId === state.activeReleaseId) {
    return {
      ...safeFailure(now, 'CURRENT', preferences, true, null, current),
      available: false,
      candidate: candidateSafe,
      feed,
    };
  }

  if (current.version === null) {
    return {
      ...safeFailure(
        now,
        'CURRENT_VERSION_UNKNOWN',
        preferences,
        true,
        'WAG_UPDATE_CURRENT_VERSION_UNKNOWN',
        current,
      ),
      candidate: candidateSafe,
      feed,
    };
  }

  const comparison = compareSemver(candidate.manifest.version, current.version);
  if (comparison < 0) {
    return {
      ...safeFailure(now, 'CURRENT', preferences, true, null, current),
      available: false,
      candidate: candidateSafe,
      feed,
    };
  }

  return {
    ...safeFailure(now, 'UPDATE_AVAILABLE', preferences, true, null, current),
    available: true,
    candidate: candidateSafe,
    feed,
  };
}
