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

/**
 * The test above proves the DevSpace *supervisor* environment is sanitized — but only the test
 * fixture launches DevSpace that way. In production WAG connects to a backend it did not start,
 * so that sanitization never runs and the guarantee has to come from somewhere WAG controls.
 *
 * It now comes from the verify runner, which builds the child environment upwards from an
 * allowlist. The variables the execution backend adds to every child it spawns are the honest
 * probe: they are definitely in the backend's environment, and they must not reach the
 * verification.
 */
test('the verify child sees only the allowlisted environment, whatever the backend adds', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());

  // Set by the execution backend for every command it runs; none is in WAG's allowlist.
  const backendAdded = ['NO_COLOR', 'TERM', 'PAGER', 'GIT_PAGER', 'CODEX_CI', 'DEVSPACE_WORKSPACE_ID'];
  await writeFile(join(fixture.workspaceRoot, 'env.mjs'), [
    `const keys = ${JSON.stringify(backendAdded)};`,
    "for (const k of keys) console.log(k + '=' + (process.env[k] === undefined ? 'absent' : 'PRESENT'));",
    "console.log('NODE_OPTIONS=' + (process.env.NODE_OPTIONS === undefined ? 'absent' : 'PRESENT'));",
    "console.log('PATH=' + (process.env.PATH || process.env.Path ? 'present' : 'MISSING'));",
  ].join('\n'));

  const gateway = createGateway({
    executor: new DevspaceExecutor(fixture),
    allowedRoots: [fixture.workspaceRoot],
    verifyProfiles: { env: { argv: ['node', 'env.mjs'] } },
  });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);
  const result = await gateway.verifyRun(workspaceId, 'env');
  const lines = result.output.replace(/\r/g, '').trim().split('\n');

  for (const key of backendAdded) {
    assert.ok(lines.includes(`${key}=absent`), `${key} must not reach the verification: ${result.output}`);
  }
  assert.ok(lines.includes('NODE_OPTIONS=absent'), 'NODE_OPTIONS could inject --require into every run');
  assert.ok(lines.includes('PATH=present'), 'the verification must still be able to find its executable');
});
