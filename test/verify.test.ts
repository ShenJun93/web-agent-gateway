import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway } from '../src/server.js';
import { startPinnedDevspace } from './devspace-fixture.js';

test('verify.run executes only a configured local profile', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'verify.mjs'), 'console.log("verified")\n');
  const gateway = createGateway({
    executor: new DevspaceExecutor(fixture),
    allowedRoots: [fixture.workspaceRoot],
    verifyProfiles: { test: { argv: ['node', 'verify.mjs'], timeoutMs: 2_000, maxOutputTokens: 1_000 } },
  });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);
  const result = await gateway.verifyRun(workspaceId, 'test');
  assert.deepEqual(result, { profile: 'test', exitCode: 0, output: 'verified' });
  await assert.rejects(gateway.verifyRun(workspaceId, 'anything-else'), /Gateway denied verify profile/);
});

test('verify.run interrupts a profile that exceeds its bounded timeout', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'slow.mjs'), 'setInterval(() => {}, 1000)\n');
  const gateway = createGateway({
    executor: new DevspaceExecutor(fixture),
    allowedRoots: [fixture.workspaceRoot],
    verifyProfiles: { slow: { argv: ['node', 'slow.mjs'], timeoutMs: 100, maxOutputTokens: 500 } },
  });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  await assert.rejects(gateway.verifyRun(workspaceId, 'slow'), /Gateway verification timed out/);
});
