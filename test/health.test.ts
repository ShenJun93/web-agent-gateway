import assert from 'node:assert/strict';
import test from 'node:test';
import { createGateway } from '../src/server.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startPinnedDevspace } from './devspace-fixture.js';

test('health reaches the pinned DevSpace executor and verifies its contract', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot] });

  const health = await gateway.health();
  assert.equal(health.status, 'ok');
  assert.equal(health.executor, 'devspace');
  assert.equal(health.protocolVersion, '2026-07-28');
  assert.equal(health.toolCount, 6);
});
