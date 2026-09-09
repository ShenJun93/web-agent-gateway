import assert from 'node:assert/strict';
import test from 'node:test';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const EXPECTED_CODEX_TOOLS = [
  'open_workspace',
  'read',
  'apply_patch',
  'exec_command',
  'write_stdin',
  'show_changes',
];

test('exact pinned DevSpace exposes the expected Codex MCP tool contract', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });

  const tools = await executor.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED_CODEX_TOOLS);
  for (const tool of tools) assert.equal(typeof tool.inputSchema, 'object', `${tool.name} must expose inputSchema`);
});
