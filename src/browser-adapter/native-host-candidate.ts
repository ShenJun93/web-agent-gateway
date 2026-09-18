import { z } from 'zod';
import { NATIVE_HOST_FILENAME } from './native-host-distribution.js';

// Re-export sha256File for consumers that need it from this module
export { sha256File } from './native-host-distribution.js';

// ── Schema version ────────────────────────────────────────────────────────────

export const NATIVE_HOST_CANDIDATE_SCHEMA_VERSION = 1 as const;

// ── Build inputs ──────────────────────────────────────────────────────────────

export const NATIVE_HOST_BUILD_INPUTS = [
  'src/',
  'browser/native-host/',
  'scripts/build-native-host.ts',
  'scripts/native-host-pe-metadata.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
] as const;

// ── Shared primitives ─────────────────────────────────────────────────────────

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const boundedText = z.string().min(1).max(256);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
const isoTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

// ── NativeHostSignatureFacts ──────────────────────────────────────────────────

const signatureFactsSchema = z.object({
  status: z.literal('Valid'),
  signerSubject: boundedText,
  signerThumbprint: sha40,
  publicKeyAlgorithmOid: z.literal('1.2.840.113549.1.1.1'),
  codeSigningEkuOid: z.literal('1.3.6.1.5.5.7.3.3'),
  certificateSignatureAlgorithmOid: boundedText,
  timestamp: z.union([
    z.null(),
    z.object({
      signerSubject: boundedText,
      signerThumbprint: sha40,
    }).strict(),
  ]),
}).strict();

export type NativeHostSignatureFacts = z.infer<typeof signatureFactsSchema>;

// ── NativeHostSignatureInspection ─────────────────────────────────────────────

const notSignedSchema = z.object({
  status: z.literal('NotSigned'),
  authenticodeSha256: sha256,
}).strict();

const signedInspectionSchema = signatureFactsSchema.extend({
  authenticodeSha256: sha256,
}).strict();

const signatureInspectionSchema = z.union([notSignedSchema, signedInspectionSchema]);

export type NativeHostSignatureInspection = z.infer<typeof signatureInspectionSchema>;

export function parseNativeHostSignatureInspection(value: unknown): NativeHostSignatureInspection {
  return signatureInspectionSchema.parse(value);
}

// ── NativeHostUnsignedCandidateReceipt ────────────────────────────────────────

const unsignedReceiptSchema = z.object({
  schemaVersion: z.literal(NATIVE_HOST_CANDIDATE_SCHEMA_VERSION),
  repository,
  sourceSha: sha40,
  nodeVersion: z.literal('24.20.0'),
  packageLockSha256: sha256,
  builderScript: z.literal('scripts/build-native-host.ts'),
  executableFilename: z.literal(NATIVE_HOST_FILENAME),
  preSignSha256: sha256,
  authenticodeSha256: sha256,
}).strict();

export type NativeHostUnsignedCandidateReceipt = z.infer<typeof unsignedReceiptSchema>;

export function parseNativeHostUnsignedCandidateReceipt(value: unknown): NativeHostUnsignedCandidateReceipt {
  return unsignedReceiptSchema.parse(value);
}

// ── NativeHostSignedCandidateReceipt ─────────────────────────────────────────

/**
 * The signed receipt extends unsigned provenance.
 *
 * Cross-field invariant enforced by superRefine (single-document):
 *   - artifact.sha256 !== preSignSha256  (signing must change the flat bytes)
 *
 * Cross-document invariant NOT enforced here:
 *   - authenticodeSha256 continuity (signed receipt == unsigned receipt value)
 *     is verified by Task 4, which holds both documents.
 */
const signedReceiptBaseSchema = unsignedReceiptSchema.extend({
  artifact: z.object({
    filename: z.literal(NATIVE_HOST_FILENAME),
    sha256,
  }).strict(),
  signature: signatureFactsSchema,
  signingDigest: z.object({
    algorithm: z.literal('SHA256'),
    evidence: z.literal('SIGNER_INVOCATION'),
  }).strict(),
  executionProbe: z.literal('STARTED'),
  verifiedAt: isoTimestamp,
}).strict();

const signedReceiptSchema = signedReceiptBaseSchema.superRefine((data, ctx) => {
  if (data.artifact.sha256 === data.preSignSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'artifact.sha256 must differ from preSignSha256 after signing',
      path: ['artifact', 'sha256'],
    });
  }
  // Cross-document Authenticode continuity (authenticodeSha256 === unsigned receipt's
  // authenticodeSha256) cannot be verified within a single signed-receipt parse.
  // That invariant is delegated to Task 4, which holds both documents.
});

export type NativeHostSignedCandidateReceipt = z.infer<typeof signedReceiptBaseSchema>;

export function parseNativeHostSignedCandidateReceipt(value: unknown): NativeHostSignedCandidateReceipt {
  return signedReceiptSchema.parse(value);
}

// ── Path classifier ───────────────────────────────────────────────────────────

const NUL_CR_LF = /[\x00\r\n]/;

/**
 * Normalise a candidate path (forward/back slashes → forward slash) and check
 * it matches at least one NATIVE_HOST_BUILD_INPUTS entry.
 *
 * Rejects: empty string, absolute paths (leading `/` or drive-letter prefix
 * like `C:`), any segment equal to `..`, and any character in {NUL, CR, LF}.
 */
export function isNativeHostBuildInput(path: string): boolean {
  if (!path) return false;
  if (NUL_CR_LF.test(path)) return false;

  // Normalise separators
  const normalised = path.replaceAll('\\', '/');

  // Reject absolute unix path
  if (normalised.startsWith('/')) return false;

  // Reject Windows drive-letter prefix (e.g. C:/ or C:\)
  if (/^[A-Za-z]:/.test(normalised)) return false;

  // Reject traversal segments
  const segments = normalised.split('/');
  if (segments.some((seg) => seg === '..')) return false;

  // Check against build input entries
  for (const entry of NATIVE_HOST_BUILD_INPUTS) {
    if (entry.endsWith('/')) {
      // Directory prefix: normalised path must start with this prefix
      if (normalised.startsWith(entry)) return true;
    } else {
      // Exact file match
      if (normalised === entry) return true;
    }
  }

  return false;
}

/**
 * Assert that none of the provided paths are native-host build inputs.
 * Throws a bounded generic error (no file paths echoed) if any match.
 */
export function assertNoNativeHostBuildInputChanges(paths: readonly string[]): void {
  const count = paths.filter((p) => isNativeHostBuildInput(p)).length;
  if (count > 0) {
    throw new Error(
      `Native-host build inputs have changed; rebuild and re-sign the candidate before proceeding.`,
    );
  }
}
