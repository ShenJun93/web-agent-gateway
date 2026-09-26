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
    devspace: { baseUrl: 'http://127.0.0.1:7676', resourceUrl: 'http://127.0.0.1:7676/mcp' },
    verifyProfiles: {},
  };
}

test('private desktop publication is explicit and requires stable private mutation identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-private-desktop-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const valid = {
    ...base(root),
    repositoryEngineering: {
      inspect: true,
      mutation: { statePath: join(root, 'state.sqlite'), ownerId: 'local.private.stdio' },
      desktop: { enabled: true },
    },
  };
  const loaded = await loadPrivateGatewayConfig(await write(root, 'valid.json', valid));
  assert.deepEqual(loaded.repositoryEngineering?.desktop, { enabled: true });

  const noIdentity = {
    ...base(root),
    repositoryEngineering: { inspect: true, desktop: { enabled: true } },
  };
  await assert.rejects(
    async () => loadPrivateGatewayConfig(await write(root, 'no-identity.json', noIdentity)),
    /desktop requires mutation identity/i,
  );

  const disabled = structuredClone(valid) as any;
  disabled.repositoryEngineering.desktop.enabled = false;
  await assert.rejects(
    async () => loadPrivateGatewayConfig(await write(root, 'disabled.json', disabled)),
  );
});
