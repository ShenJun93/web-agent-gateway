import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);
const EXPECTED_CODEX_TOOLS = [
  'open_workspace', 'read', 'apply_patch',
  'exec_command', 'write_stdin', 'show_changes',
] as const;
const REQUIRED_INPUT_PROPERTIES: Record<(typeof EXPECTED_CODEX_TOOLS)[number], string[]> = {
  open_workspace: ['path'],
  read: ['workspaceId', 'path'],
  apply_patch: ['workspaceId', 'patch'],
  exec_command: ['workspaceId', 'cmd'],
  write_stdin: ['workspaceId', 'sessionId'],
  show_changes: ['workspaceId'],
};

test('exact pinned DevSpace exposes the expected Codex MCP tool contract', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const executor = new DevspaceExecutor(fixture);
  const tools = await executor.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED_CODEX_TOOLS);
  for (const tool of tools) {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> };
    assert.ok(schema && typeof schema === 'object' && schema.properties, `${tool.name} must expose object properties`);
    for (const property of REQUIRED_INPUT_PROPERTIES[tool.name as keyof typeof REQUIRED_INPUT_PROPERTIES]) {
      assert.ok(property in schema.properties, `${tool.name} must expose ${property}`);
    }
  }
});


test('typed applyPatch wrapper returns structured update metadata', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), 'alpha\nbeta\ngamma\n');
  const executor = new DevspaceExecutor(fixture);
  const workspaceId = await executor.openWorkspace(fixture.workspaceRoot);
  const patch = '*** Begin Patch\n*** Update File: note.txt\n@@\n-alpha\n-beta\n+alpha\n+BETA\n gamma\n*** End Patch';

  const result = await executor.applyPatch(workspaceId, patch);
  assert.equal(result.result, 'Applied patch to 1 file(s): note.txt');
  assert.equal(result.additions, 1);
  assert.equal(result.removals, 1);
  assert.deepEqual(result.files, [{ path: 'note.txt', operation: 'update' }]);
  assert.equal(await executor.readFile(workspaceId, 'note.txt'), 'alpha\nBETA\ngamma\n');
});
test('pinned DevSpace process listens only on Windows loopback', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows listener assertion');
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  assert.ok(fixture.pid, 'fixture must expose DevSpace pid');
  const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP']);
  const rows = stdout.split(/\r?\n/).filter((line) => line.trim().endsWith(String(fixture.pid)) && /LISTENING/i.test(line));
  assert.ok(rows.length > 0, `expected listener for DevSpace pid ${fixture.pid}`);
  assert.ok(rows.every((line) => /\s127\.0\.0\.1:\d+\s/.test(line)), `DevSpace must be loopback-only:\n${rows.join('\n')}`);
});
