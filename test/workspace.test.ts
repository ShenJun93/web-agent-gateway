import assert from 'node:assert/strict';
import test from 'node:test';
import { createGateway } from '../src/server.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startPinnedDevspace } from './devspace-fixture.js';

test('workspace.open returns an opaque id after DevSpace accepts the workspace', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const gateway = createGateway({ executor: new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken }) });

  const opened = await gateway.openWorkspace(fixture.workspaceRoot);
  assert.match(opened.workspaceId, /^ws_[a-f0-9-]{36}$/);
  assert.equal('path' in opened, false);
  assert.equal(JSON.stringify(opened).includes(fixture.workspaceRoot), false);
});
