import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BROWSER_ADAPTER_EXTENSION_ID,
  NATIVE_HOST_APPLICATION_NAME,
  NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION,
  NATIVE_HOST_LEGACY_DISTRIBUTION_SCHEMA_VERSION,
  NATIVE_HOST_FILENAME,
  NATIVE_HOST_LEGACY_REQUIRED_GATES,
  NATIVE_HOST_REQUIRED_GATES,
  parseNativeHostBuildReceipt,
  sha256File,
} from '../src/browser-adapter/native-host-distribution.js';

const sha40 = 'a'.repeat(40);
const hashA = 'b'.repeat(64);
const hashB = 'c'.repeat(64);

function validReceipt() {
  return {
    schemaVersion: NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION,
    repository: 'ShenJun93/web-agent-gateway',
    sourceSha: sha40,
    sourceRef: 'refs/heads/main',
    workflowRunId: '1234567890',
    runAttempt: 1,
    runner: {
      os: 'Windows',
      arch: 'X64',
      imageOS: 'win25',
      imageVersion: '20260907.255.1',
    },
    nodeVersion: '24.20.0',
    packageLockSha256: hashA,
    artifact: { filename: NATIVE_HOST_FILENAME, sha256: hashB },
    nativeApplicationName: NATIVE_HOST_APPLICATION_NAME,
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
    verificationGates: [...NATIVE_HOST_REQUIRED_GATES],
  };
}

test('native host distribution receipt accepts one strict canonical current identity', () => {
  const receipt = validReceipt();
  assert.deepEqual(parseNativeHostBuildReceipt(receipt), receipt);
  assert.equal(NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION, 2);
  assert.equal(NATIVE_HOST_FILENAME, 'wag-native-host.exe');
  assert.equal(NATIVE_HOST_APPLICATION_NAME, 'com.openai.web_agent_gateway');
  assert.equal(BROWSER_ADAPTER_EXTENSION_ID, 'nnhhhppkpogkedpjnijeagcbfjaoogec');
});

test('native host distribution parser preserves exact legacy v1 receipts', () => {
  const legacy = {
    ...validReceipt(),
    schemaVersion: NATIVE_HOST_LEGACY_DISTRIBUTION_SCHEMA_VERSION,
    verificationGates: [...NATIVE_HOST_LEGACY_REQUIRED_GATES],
  };
  assert.deepEqual(parseNativeHostBuildReceipt(legacy), legacy);
});

test('native host distribution receipt rejects malformed or widened identity', () => {
  const cases: unknown[] = [
    { ...validReceipt(), extra: true },
    { ...validReceipt(), repository: 'not-a-repository' },
    { ...validReceipt(), sourceSha: 'a'.repeat(39) },
    { ...validReceipt(), workflowRunId: '0' },
    { ...validReceipt(), runAttempt: 0 },
    { ...validReceipt(), nodeVersion: '24.20.1' },
    { ...validReceipt(), packageLockSha256: 'b'.repeat(63) },
    { ...validReceipt(), artifact: { filename: 'other.exe', sha256: hashB } },
    { ...validReceipt(), nativeApplicationName: 'com.example.other' },
    { ...validReceipt(), extensionId: 'a'.repeat(32) },
    { ...validReceipt(), verificationGates: [...NATIVE_HOST_REQUIRED_GATES].reverse() },
    { ...validReceipt(), schemaVersion: NATIVE_HOST_LEGACY_DISTRIBUTION_SCHEMA_VERSION },
  ];

  for (const value of cases) {
    assert.throws(() => parseNativeHostBuildReceipt(value));
  }
});

test('sha256File hashes exact file bytes', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-native-distribution-hash-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'payload.bin');
  const bytes = Buffer.from('native-host-distribution\u0000bytes', 'utf8');
  await writeFile(path, bytes);

  assert.equal(await sha256File(path), createHash('sha256').update(bytes).digest('hex'));
});
