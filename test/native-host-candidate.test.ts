import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_HOST_CANDIDATE_SCHEMA_VERSION,
  NATIVE_HOST_BUILD_INPUTS,
  parseNativeHostUnsignedCandidateReceipt,
  parseNativeHostSignedCandidateReceipt,
  parseNativeHostSignatureInspection,
  isNativeHostBuildInput,
  assertNoNativeHostBuildInputChanges,
} from '../src/browser-adapter/native-host-candidate.js';

// ── Shared test fixtures ────────────────────────────────────────────────────

const sha40 = 'a'.repeat(40);
const hashA = 'b'.repeat(64); // pre-sign flat sha256 AND authenticode sha256 (same for test)
const hashB = 'c'.repeat(64); // post-sign flat sha256 (must differ from hashA)
const thumbprint = 'd'.repeat(40); // lowercase 40 hex
const tsThumbprint = 'e'.repeat(40);

function validUnsigned() {
  return {
    schemaVersion: NATIVE_HOST_CANDIDATE_SCHEMA_VERSION,
    repository: 'ShenJun93/web-agent-gateway',
    sourceSha: sha40,
    nodeVersion: '24.20.0',
    packageLockSha256: hashA,
    builderScript: 'scripts/build-native-host.ts',
    executableFilename: 'wag-native-host.exe',
    preSignSha256: hashA,
    authenticodeSha256: hashA,
  };
}

function validSignatureFacts(): {
  status: 'Valid';
  signerSubject: string;
  signerThumbprint: string;
  publicKeyAlgorithmOid: '1.2.840.113549.1.1.1';
  codeSigningEkuOid: '1.3.6.1.5.5.7.3.3';
  certificateSignatureAlgorithmOid: string;
  timestamp: null | { signerSubject: string; signerThumbprint: string };
} {
  return {
    status: 'Valid',
    signerSubject: 'CN=Test Signer',
    signerThumbprint: thumbprint,
    publicKeyAlgorithmOid: '1.2.840.113549.1.1.1',
    codeSigningEkuOid: '1.3.6.1.5.5.7.3.3',
    certificateSignatureAlgorithmOid: '1.2.840.113549.1.1.11',
    timestamp: null,
  };
}

function validSigned() {
  return {
    ...validUnsigned(),
    artifact: { filename: 'wag-native-host.exe' as const, sha256: hashB },
    // authenticodeSha256 inherited from unsigned (same value)
    signature: validSignatureFacts(),
    signingDigest: { algorithm: 'SHA256' as const, evidence: 'SIGNER_INVOCATION' as const },
    executionProbe: 'STARTED' as const,
    verifiedAt: '2026-09-17T15:52:38.000Z',
  };
}

// ── Schema version ──────────────────────────────────────────────────────────

test('native host candidate schema version is 1', () => {
  assert.equal(NATIVE_HOST_CANDIDATE_SCHEMA_VERSION, 1);
});

// ── Build inputs constant ───────────────────────────────────────────────────

test('NATIVE_HOST_BUILD_INPUTS contains required roots', () => {
  const entries = [...NATIVE_HOST_BUILD_INPUTS] as string[];
  assert.ok(entries.includes('src/'));
  assert.ok(entries.includes('browser/native-host/'));
  assert.ok(entries.includes('scripts/build-native-host.ts'));
  assert.ok(entries.includes('scripts/native-host-pe-metadata.ts'));
  assert.ok(entries.includes('package.json'));
  assert.ok(entries.includes('package-lock.json'));
  assert.ok(entries.includes('tsconfig.json'));
  assert.ok(entries.includes('tsconfig.build.json'));
});

// ── Unsigned receipt: valid acceptance ──────────────────────────────────────

test('parseNativeHostUnsignedCandidateReceipt accepts a canonical unsigned receipt', () => {
  const v = validUnsigned();
  const result = parseNativeHostUnsignedCandidateReceipt(v);
  assert.deepEqual(result, v);
});

// ── Unsigned receipt: rejection cases ──────────────────────────────────────

test('parseNativeHostUnsignedCandidateReceipt rejects invalid inputs', () => {
  const cases: unknown[] = [
    // Extra field → strict rejection
    { ...validUnsigned(), extra: true },
    // Wrong schema version
    { ...validUnsigned(), schemaVersion: 2 },
    // Invalid repository format
    { ...validUnsigned(), repository: 'not-a-repository' },
    // Source SHA too short
    { ...validUnsigned(), sourceSha: 'a'.repeat(39) },
    // Wrong node version
    { ...validUnsigned(), nodeVersion: '24.20.1' },
    // Package lock SHA too short
    { ...validUnsigned(), packageLockSha256: 'b'.repeat(63) },
    // Wrong builder script (must be exact literal)
    { ...validUnsigned(), builderScript: 'scripts/build-native-host.ts.bak' },
    // Wrong executable filename
    { ...validUnsigned(), executableFilename: 'other.exe' },
    // Pre-sign SHA too short
    { ...validUnsigned(), preSignSha256: 'b'.repeat(63) },
    // Authenticode SHA too short
    { ...validUnsigned(), authenticodeSha256: 'a'.repeat(63) },
    // Uppercase hex not allowed
    { ...validUnsigned(), authenticodeSha256: 'A'.repeat(64) },
    // Missing field
    (() => { const v = validUnsigned(); const { authenticodeSha256: _, ...rest } = v; return rest; })(),
  ];

  for (const value of cases) {
    assert.throws(() => parseNativeHostUnsignedCandidateReceipt(value), `should reject: ${JSON.stringify(value)}`);
  }
});

// ── Signed receipt: valid acceptance ────────────────────────────────────────

test('parseNativeHostSignedCandidateReceipt accepts a canonical signed receipt', () => {
  const v = validSigned();
  const result = parseNativeHostSignedCandidateReceipt(v);
  assert.deepEqual(result, v);
});

test('parseNativeHostSignedCandidateReceipt accepts signed receipt with timestamp', () => {
  const v = validSigned();
  v.signature = {
    ...validSignatureFacts(),
    timestamp: { signerSubject: 'CN=TSA', signerThumbprint: tsThumbprint },
  };
  assert.doesNotThrow(() => parseNativeHostSignedCandidateReceipt(v));
});

test('parseNativeHostSignedCandidateReceipt accepts authenticodeSha256 that differs from preSignSha256 (cross-document continuity is Task 4)', () => {
  // hashB !== hashA, so artifact.sha256 (hashB) !== preSignSha256 (hashA) — OK.
  // authenticodeSha256 set to a third independent valid hash; this parser does not
  // compare it against the unsigned receipt — that is Task 4's job.
  const hashC = 'f'.repeat(64);
  const v = { ...validSigned(), authenticodeSha256: hashC };
  assert.doesNotThrow(() => parseNativeHostSignedCandidateReceipt(v));
});

// ── Signed receipt: rejection cases ─────────────────────────────────────────

test('parseNativeHostSignedCandidateReceipt rejects invalid inputs', () => {
  const cases: [unknown, string][] = [
    // Extra field → strict rejection
    [{ ...validSigned(), extra: true }, 'extra field'],
    // ECC algorithm OID rejected (must be RSA OID 1.2.840.113549.1.1.1)
    [
      { ...validSigned(), signature: { ...validSignatureFacts(), publicKeyAlgorithmOid: '1.2.840.10045.2.1' } },
      'ECC oid rejected',
    ],
    // Non-SHA256 signing digest
    [
      { ...validSigned(), signingDigest: { algorithm: 'SHA1', evidence: 'SIGNER_INVOCATION' } },
      'SHA1 digest rejected',
    ],
    // Artifact filename mismatch
    [
      { ...validSigned(), artifact: { filename: 'other.exe', sha256: hashB } },
      'artifact filename mismatch',
    ],
    // Artifact sha256 equals preSignSha256 → must differ
    [
      { ...validSigned(), artifact: { filename: 'wag-native-host.exe', sha256: hashA } },
      'artifact sha256 equals preSignSha256',
    ],
    // NOTE: authenticodeSha256 continuity across unsigned→signed receipts is a
    // cross-document invariant enforced by Task 4, not by this single-document parser.
    // Changing authenticodeSha256 alone (to any valid 64-hex string) does NOT cause
    // parseNativeHostSignedCandidateReceipt to reject; that is intentional.
    // signingDigest evidence wrong
    [
      { ...validSigned(), signingDigest: { algorithm: 'SHA256', evidence: 'OTHER' } },
      'wrong evidence',
    ],
    // executionProbe not STARTED
    [{ ...validSigned(), executionProbe: 'NOT_STARTED' }, 'wrong executionProbe'],
    // verifiedAt not ISO format
    [{ ...validSigned(), verifiedAt: '17-09-2026' }, 'non-ISO verifiedAt'],
    // status not Valid
    [
      { ...validSigned(), signature: { ...validSignatureFacts(), status: 'Invalid' } },
      'status not Valid',
    ],
    // signerThumbprint uppercase
    [
      { ...validSigned(), signature: { ...validSignatureFacts(), signerThumbprint: 'D'.repeat(40) } },
      'thumbprint uppercase',
    ],
    // codeSigningEkuOid wrong
    [
      { ...validSigned(), signature: { ...validSignatureFacts(), codeSigningEkuOid: '1.2.3.4.5' } },
      'wrong eku oid',
    ],
  ];

  for (const [value, label] of cases) {
    assert.throws(() => parseNativeHostSignedCandidateReceipt(value), `should reject (${label})`);
  }
});

// ── Signature inspection parser ──────────────────────────────────────────────

test('parseNativeHostSignatureInspection accepts NotSigned variant', () => {
  const notSigned = { status: 'NotSigned', authenticodeSha256: hashA };
  const result = parseNativeHostSignatureInspection(notSigned);
  assert.deepEqual(result, notSigned);
});

test('parseNativeHostSignatureInspection accepts Valid (signed) variant', () => {
  const signed = { ...validSignatureFacts(), authenticodeSha256: hashA };
  const result = parseNativeHostSignatureInspection(signed);
  assert.deepEqual(result, signed);
});

test('parseNativeHostSignatureInspection rejects unknown status', () => {
  assert.throws(() => parseNativeHostSignatureInspection({ status: 'SomethingElse', authenticodeSha256: hashA }));
});

test('parseNativeHostSignatureInspection rejects missing authenticodeSha256', () => {
  assert.throws(() => parseNativeHostSignatureInspection({ status: 'NotSigned' }));
});

test('parseNativeHostSignatureInspection rejects extra keys on Valid branch', () => {
  // signedInspectionSchema must be strict; extra keys must be rejected
  assert.throws(() =>
    parseNativeHostSignatureInspection({ ...validSignatureFacts(), authenticodeSha256: hashA, extra: true }),
  );
});

// ── isNativeHostBuildInput: positives ────────────────────────────────────────

test('isNativeHostBuildInput positives', () => {
  assert.equal(isNativeHostBuildInput('src/a.ts'), true);
  assert.equal(isNativeHostBuildInput('src/browser-adapter/foo.ts'), true);
  assert.equal(isNativeHostBuildInput('browser/native-host/sea-config.json'), true);
  assert.equal(isNativeHostBuildInput('scripts/build-native-host.ts'), true);
  assert.equal(isNativeHostBuildInput('scripts/native-host-pe-metadata.ts'), true);
  assert.equal(isNativeHostBuildInput('package.json'), true);
  assert.equal(isNativeHostBuildInput('package-lock.json'), true);
  assert.equal(isNativeHostBuildInput('tsconfig.json'), true);
  assert.equal(isNativeHostBuildInput('tsconfig.build.json'), true);
  // Windows backslash separator treated as path separator
  assert.equal(isNativeHostBuildInput('src\\browser-adapter\\foo.ts'), true);
  assert.equal(isNativeHostBuildInput('browser\\native-host\\sea-config.json'), true);
});

// ── isNativeHostBuildInput: negatives ───────────────────────────────────────

test('isNativeHostBuildInput negatives', () => {
  // Outside build input roots
  assert.equal(isNativeHostBuildInput('test/a.test.ts'), false);
  assert.equal(isNativeHostBuildInput('docs/x.md'), false);
  // Extension does not match exact entry
  assert.equal(isNativeHostBuildInput('scripts/build-native-host.ts.bak'), false);
  // Directory prefix must be exact — 'src' without slash does not match 'src/'
  assert.equal(isNativeHostBuildInput('srcother/foo.ts'), false);
  // Absolute paths rejected
  assert.equal(isNativeHostBuildInput('/src/a.ts'), false);
  assert.equal(isNativeHostBuildInput('C:/src/a.ts'), false);
  // Traversal rejected
  assert.equal(isNativeHostBuildInput('../src/a.ts'), false);
  assert.equal(isNativeHostBuildInput('src/../package.json'), false);
  // Empty path rejected
  assert.equal(isNativeHostBuildInput(''), false);
});

// ── assertNoNativeHostBuildInputChanges ──────────────────────────────────────

test('assertNoNativeHostBuildInputChanges does not throw when no build inputs changed', () => {
  // Only non-build-input files changed → should not throw
  assert.doesNotThrow(() => assertNoNativeHostBuildInputChanges(['test/a.test.ts', 'docs/x.md']));
});

test('assertNoNativeHostBuildInputChanges does not throw for empty list', () => {
  assert.doesNotThrow(() => assertNoNativeHostBuildInputChanges([]));
});

test('assertNoNativeHostBuildInputChanges throws a bounded generic error when build inputs changed', () => {
  // Must throw — but must NOT echo the file path contents in error message
  assert.throws(
    () => assertNoNativeHostBuildInputChanges(['src/a.ts']),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'should be an Error');
      // Error message must not contain the actual file path (no local path leakage)
      assert.ok(!err.message.includes('src/a.ts'), 'error must not echo file path');
      return true;
    },
  );
});

test('assertNoNativeHostBuildInputChanges throws on multiple build inputs', () => {
  assert.throws(() => assertNoNativeHostBuildInputChanges(['package.json', 'tsconfig.json']));
});
