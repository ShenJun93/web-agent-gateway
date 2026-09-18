import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = join(import.meta.dirname, '..');
const sourceSha = 'c1eb195f54864dee1a8997c9baeb0475ce627da6';
const tag = 'v0.1.0-preview.1';
const zipFilename = 'web-agent-gateway-native-host-windows-x64-0.1.0-preview.1-UNSIGNED.zip';
const zipSha256 = '3f31ebe7258803aaf44194c05c4ae0ce241f7f2849507f7c0f153b129264e733';
const exeSha256 = '3a07d599b5ee06d9eaa90a83e9b81f58386f55f383d0d04f5fa04038d02ac8e2';
const authenticodeSha256 = '73de2fbbfe7569478b75ce4ecffdc39503107b47145c792e53ada5cf61ea525d';

test('v0.1.0 preview preparation freezes exact unsigned release facts without placeholders', async () => {
  const manifestText = await readFile(join(repoRoot, 'docs', 'releases', 'v0.1.0-preview.1.json'), 'utf8');
  const notes = await readFile(join(repoRoot, 'docs', 'releases', 'v0.1.0-preview.1.md'), 'utf8');
  const manifest = JSON.parse(manifestText) as any;

  assert.doesNotMatch(manifestText, /<[A-Z0-9_]+>/);
  assert.doesNotMatch(notes, /<[A-Z0-9_]+>/);
  assert.equal(manifest.releaseClass, 'unsigned-preview');
  assert.equal(manifest.productVersion, '0.1.0');
  assert.equal(manifest.windowsVersion, '0.1.0.0');
  assert.equal(manifest.tag, tag);
  assert.equal(manifest.tagTargetSha, sourceSha);
  assert.equal(manifest.sourceSha, sourceSha);
  assert.equal(manifest.tagCreated, false);
  assert.equal(manifest.releaseCreated, false);
  assert.equal(manifest.prerelease, true);
  assert.equal(manifest.workflowRunId, '35345822405');
  assert.equal(manifest.workflowRunAttempt, 1);
  assert.equal(manifest.outerZip.filename, zipFilename);
  assert.equal(manifest.outerZip.sha256, zipSha256);
  assert.equal(manifest.outerZip.sizeBytes, 35173661);
  assert.equal(manifest.outerZip.entryCount, 18);
  assert.equal(manifest.outerZip.entries.length, 18);
  assert.equal(manifest.nativeHost.flatSha256, exeSha256);
  assert.equal(manifest.nativeHost.preSignSha256, exeSha256);
  assert.equal(manifest.nativeHost.authenticodeSha256, authenticodeSha256);
  assert.equal(manifest.nativeHost.signatureState, 'NotSigned');

  for (const value of [tag, sourceSha, zipFilename, zipSha256, exeSha256, authenticodeSha256, '0.1.0.0']) {
    assert.ok(notes.includes(value), `release notes missing ${value}`);
  }
  assert.match(notes, /UNSIGNED PREVIEW - NOT AUTHENTICODE TRUSTED/);
  assert.match(notes, /SignPath Foundation acceptance: \*\*not claimed by this release\*\*/);
  assert.match(notes, /GitHub Actions artifacts are build evidence and are not supported user downloads/);
  assert.doesNotMatch(notes, /\bis Smart App Control-ready\b/i);
});