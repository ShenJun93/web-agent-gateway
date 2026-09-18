import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const configPath = join(process.cwd(), '.signpath', 'artifact-configurations', 'native-host.xml');

async function configText(): Promise<string> {
  return readFile(configPath, 'utf8');
}

test('SignPath native-host artifact config signs exactly one WAG PE inside the GitHub artifact ZIP', async () => {
  const config = await configText();
  assert.match(config, /<artifact-configuration\s+xmlns="http:\/\/signpath\.io\/artifact-configuration\/v1">/);
  assert.match(config, /<zip-file>/);
  assert.match(config, /<pe-file\s+[\s\S]*?path="wag-native-host\.exe"/);
  assert.equal((config.match(/<pe-file\b/g) ?? []).length, 1);
  assert.doesNotMatch(config, /path="[^"]*[?*\[]/);
});

test('SignPath native-host artifact config restricts WAG-owned PE identity and SHA-256 Authenticode', async () => {
  const config = await configText();
  assert.match(config, /<parameter name="windowsVersion" required="true"\s*\/>/);
  assert.match(config, /product-name="Web Agent Gateway"/);
  assert.match(config, /product-version="\$\{windowsVersion\}"/);
  assert.match(config, /file-version="\$\{windowsVersion\}"/);
  assert.match(config, /original-filename="wag-native-host\.exe"/);
  assert.match(config, /<authenticode-sign hash-algorithm="sha256"\s*\/>/);
});

test('SignPath artifact config contains no provider credentials or premature organization/policy binding', async () => {
  const config = await configText();
  assert.doesNotMatch(config, /api[-_]?token|secret|organization-id|project-slug|signing-policy-slug/i);
  assert.doesNotMatch(config, /company-name|copyright/i);
});
