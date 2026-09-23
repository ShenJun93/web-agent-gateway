import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test from 'node:test';
import { canonicalWorkspace } from '../src/path-policy.js';
import { loadPrivateGatewayConfig } from '../src/private-config.js';

test('a Windows drive root may be trusted without becoming a workspace', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows drive-root trust regression');
    return;
  }

  const temp = await mkdtemp(join(tmpdir(), 'wag-drive-root-config-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const driveRoot = await realpath(parse(temp).root);
  const configPath = join(temp, 'private.json');
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [driveRoot],
    devspace: {
      baseUrl: 'http://127.0.0.1:7677',
      resourceUrl: 'http://127.0.0.1:7677/mcp',
    },
    verifyProfiles: {},
  }), 'utf8');

  const loaded = await loadPrivateGatewayConfig(configPath);
  assert.deepEqual(loaded.allowedRoots, [driveRoot]);

  await assert.rejects(
    () => canonicalWorkspace(driveRoot, loaded.allowedRoots),
    /drive-root workspace/,
    'trusting a drive root must not make the drive root itself an admissible workspace',
  );
});
