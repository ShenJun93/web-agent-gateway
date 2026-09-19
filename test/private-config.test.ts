import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test from 'node:test';
import { loadPrivateGatewayConfig } from '../src/private-config.js';

async function writeConfig(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

function validConfig(allowedRoot: string) {
  return {
    allowedRoots: [allowedRoot],
    devspace: {
      baseUrl: 'http://127.0.0.1:7676',
      resourceUrl: 'http://127.0.0.1:7676/mcp',
    },
    verifyProfiles: {
      version: { argv: ['node', '--version'], timeoutMs: 5_000, maxOutputTokens: 1_000 },
    },
  };
}
test('private config is strict, absolute, loopback-only, and canonicalizes allowed roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-private-config-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });

  await assert.rejects(() => loadPrivateGatewayConfig('relative.json'), /absolute/i);

  const nonLoopback = validConfig(root);
  nonLoopback.devspace.baseUrl = 'http://192.0.2.10:7676';
  nonLoopback.devspace.resourceUrl = 'http://192.0.2.10:7676/mcp';
  await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'non-loopback.json', nonLoopback)), /loopback/i);

  const mismatchedResource = validConfig(root);
  mismatchedResource.devspace.resourceUrl = 'http://127.0.0.1:9999/mcp';
  await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'resource.json', mismatchedResource)), /resource|mcp/i);

  const unknown = { ...validConfig(root), unexpected: true };
  await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'unknown.json', unknown)), /unrecognized|unknown/i);

  const withEnv = validConfig(root) as ReturnType<typeof validConfig> & { verifyProfiles: { version: ReturnType<typeof validConfig>['verifyProfiles']['version'] & { env: Record<string, string> } } };
  withEnv.verifyProfiles.version.env = { SAFE: 'value' };
  await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'env.json', withEnv)), /unrecognized|unknown/i);
  const tooLong = validConfig(root);
  tooLong.verifyProfiles.version.timeoutMs = 30_001;
  await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'timeout.json', tooLong)), /30000|too_big|less than or equal/i);

  if (process.platform === 'win32') {
    const driveRoot = parse(root).root;
    const broad = validConfig(driveRoot);
    await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'drive-root.json', broad)), /drive-root|workspace/i);
  }

  const loaded = await loadPrivateGatewayConfig(await writeConfig(root, 'valid.json', validConfig(root)));
  assert.deepEqual(loaded.allowedRoots, [root]);
  assert.deepEqual(loaded.verifyProfiles.version.argv, ['node', '--version']);
  assert.equal(loaded.verifyProfiles.version.timeoutMs, 5_000);
  assert.equal(loaded.verifyProfiles.version.maxOutputTokens, 1_000);
  assert.equal(loaded.devspace.baseUrl, 'http://127.0.0.1:7676');
  assert.equal(loaded.devspace.resourceUrl, 'http://127.0.0.1:7676/mcp');
  assert.deepEqual(loaded.browserVerifyProfiles, []);
});

test('private config browser verify allowlist defaults empty and rejects duplicate or unknown profiles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-private-config-browser-verify-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });

  const allowed = { ...validConfig(root), browserVerifyProfiles: ['version'] };
  const loaded = await loadPrivateGatewayConfig(await writeConfig(root, 'allowed.json', allowed));
  assert.deepEqual(loaded.browserVerifyProfiles, ['version']);
  assert.deepEqual(loaded.verifyProfiles.version.argv, ['node', '--version']);

  const duplicate = { ...validConfig(root), browserVerifyProfiles: ['version', 'version'] };
  await assert.rejects(
    async () => loadPrivateGatewayConfig(await writeConfig(root, 'duplicate.json', duplicate)),
    /must be unique/i,
  );

  const unknown = { ...validConfig(root), browserVerifyProfiles: ['missing'] };
  await assert.rejects(
    async () => loadPrivateGatewayConfig(await writeConfig(root, 'unknown-browser-profile.json', unknown)),
    /not configured/i,
  );
});
