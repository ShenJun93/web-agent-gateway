import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadPrivateGatewayConfig } from '../src/private-config.js';

async function write(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
  return path;
}

function base(root: string) {
  return {
    allowedRoots: [root],
    devspace: {
      baseUrl: 'http://127.0.0.1:7676',
      resourceUrl: 'http://127.0.0.1:7676/mcp',
    },
    verifyProfiles: {},
  };
}

test('private browser publication requires explicit absolute dedicated paths and private identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-private-browser-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'state.sqlite');
  const edgeExecutablePath = join(root, 'msedge.exe');
  const profileRoot = join(root, 'browser-profiles');

  const valid = {
    ...base(root),
    repositoryEngineering: {
      inspect: true,
      mutation: { statePath, ownerId: 'local.private.stdio' },
      browser: { edgeExecutablePath, profileRoot },
    },
  };
  const loaded = await loadPrivateGatewayConfig(await write(root, 'valid.json', valid));
  assert.deepEqual(loaded.repositoryEngineering?.browser, { edgeExecutablePath, profileRoot });

  const noIdentity = {
    ...base(root),
    repositoryEngineering: {
      inspect: true,
      browser: { edgeExecutablePath, profileRoot },
    },
  };
  await assert.rejects(
    async () => loadPrivateGatewayConfig(await write(root, 'no-identity.json', noIdentity)),
    /browser requires mutation identity/i,
  );
});

test('private browser publication refuses relative Edge or profile paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-private-browser-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseConfig = {
    ...base(root),
    repositoryEngineering: {
      inspect: true,
      mutation: { statePath: join(root, 'state.sqlite'), ownerId: 'local.private.stdio' },
      browser: {
        edgeExecutablePath: join(root, 'msedge.exe'),
        profileRoot: join(root, 'profiles'),
      },
    },
  };

  const relativeEdge = structuredClone(baseConfig);
  relativeEdge.repositoryEngineering.browser.edgeExecutablePath = 'msedge.exe';
  await assert.rejects(
    async () => loadPrivateGatewayConfig(await write(root, 'relative-edge.json', relativeEdge)),
    /browser paths must be absolute/i,
  );

  const relativeProfile = structuredClone(baseConfig);
  relativeProfile.repositoryEngineering.browser.profileRoot = 'profiles';
  await assert.rejects(
    async () => loadPrivateGatewayConfig(await write(root, 'relative-profile.json', relativeProfile)),
    /browser paths must be absolute/i,
  );
});
