import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { sanitizeDevspaceEnvironment } from '../src/environment-policy.js';
import { createGateway } from '../src/server.js';
import { startPinnedDevspace } from './devspace-fixture.js';

test('DevSpace supervisor environment allowlists runtime variables', () => {
  const sanitized = sanitizeDevspaceEnvironment({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'secret', WAG_TEST_SECRET: 'sentinel' }, {
    DEVSPACE_CONFIG_DIR: 'C:\\config', DEVSPACE_OAUTH_OWNER_TOKEN: 'owner',
  });
  assert.equal(sanitized.Path, 'C:\\bin');
  assert.equal(sanitized.SystemRoot, 'C:\\Windows');
  assert.equal(sanitized.OPENAI_API_KEY, undefined);
  assert.equal(sanitized.WAG_TEST_SECRET, undefined);
  assert.equal(sanitized.DEVSPACE_OAUTH_OWNER_TOKEN, 'owner');
  assert.equal(sanitized.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(sanitized.GIT_CONFIG_COUNT, '1');
  assert.equal(sanitized.GIT_CONFIG_KEY_0, 'core.fsmonitor');
  assert.equal(sanitized.GIT_CONFIG_VALUE_0, 'false');
});

test('verify.run does not expose parent secrets or the DevSpace owner token to repository code', async (t) => {
  const previous = process.env.WAG_TEST_SECRET;
  process.env.WAG_TEST_SECRET = 'sentinel-secret';
  t.after(() => { if (previous === undefined) delete process.env.WAG_TEST_SECRET; else process.env.WAG_TEST_SECRET = previous; });
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'env.mjs'), [
    "console.log(process.env.WAG_TEST_SECRET ?? 'absent')",
    "console.log(process.env.DEVSPACE_OAUTH_OWNER_TOKEN ?? 'absent')",
  ].join('\n'));

  const gateway = createGateway({ executor: new DevspaceExecutor(fixture), allowedRoots: [fixture.workspaceRoot], verifyProfiles: { env: { argv: ['node', 'env.mjs'] } } });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);
  const result = await gateway.verifyRun(workspaceId, 'env');
  assert.equal(result.output.replace(/\r/g, ''), 'absent\nabsent');
});
