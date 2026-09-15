import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { createBrowserAdmittedMcpServer } from '../src/server.js';

const caller = createGatewayCallerContext({
  ownerId: 'owner_browser',
  sessionId: 'session_browser',
  adapterId: 'browser.chatgpt.native.v1',
});

async function connectedBrowserServer() {
  const calls: unknown[] = [];
  const gateway = {
    health: async () => ({
      status: 'ok' as const,
      executor: 'devspace' as const,
      protocolVersion: '2026-07-28',
      toolCount: 6,
    }),
  };
  const workspaces = {
    open: async (receivedCaller: unknown, path: string) => {
      calls.push(['open', receivedCaller, path]);
      return { workspaceId: 'ws_browser' };
    },
    read: async (receivedCaller: unknown, workspaceId: string, path: string) => {
      calls.push(['read', receivedCaller, workspaceId, path]);
      return { content: 'alpha' };
    },
  };
  const server = createBrowserAdmittedMcpServer(gateway, { callerContext: caller, workspaces });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-admitted-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { calls, client, server };
}

test('browser-admitted MCP exposes exactly three read-only tools', async (t) => {
  const connected = await connectedBrowserServer();
  t.after(async () => { await connected.client.close(); await connected.server.close(); });

  const tools = await connected.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'file.read',
  ]);
  assert.equal(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
});

test('browser workspace calls receive the fixed caller context internally', async (t) => {
  const connected = await connectedBrowserServer();
  t.after(async () => { await connected.client.close(); await connected.server.close(); });

  const opened = await connected.client.callTool({
    name: 'workspace.open', arguments: { path: 'E:/fixture' },
  });
  assert.equal((opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId, 'ws_browser');

  const read = await connected.client.callTool({
    name: 'file.read', arguments: { workspace_id: 'ws_browser', path: 'note.txt' },
  });
  assert.equal((read.structuredContent as { content?: string } | undefined)?.content, 'alpha');
  assert.deepEqual(connected.calls, [
    ['open', caller, 'E:/fixture'],
    ['read', caller, 'ws_browser', 'note.txt'],
  ]);
});

test('browser-admitted schemas expose no authority or adapter controls', async (t) => {
  const connected = await connectedBrowserServer();
  t.after(async () => { await connected.client.close(); await connected.server.close(); });
  const tools = await connected.client.listTools();
  const schemas = JSON.stringify(tools.tools.map((tool) => tool.inputSchema));
  for (const forbidden of [
    'owner_id', 'session_id', 'adapter_id', 'ownerId', 'sessionId', 'adapterId',
    'correlation_id', 'bearer', 'adapter', 'provider', 'tab',
  ]) {
    assert.doesNotMatch(schemas, new RegExp(`"${forbidden}"`, 'i'));
  }
});

test('broader default tools are unavailable on browser-admitted MCP', async (t) => {
  const connected = await connectedBrowserServer();
  t.after(async () => { await connected.client.close(); await connected.server.close(); });

  const snapshot = await connected.client.callTool({
    name: 'repo.snapshot', arguments: { workspace_id: 'ws_browser' },
  });
  const verify = await connected.client.callTool({
    name: 'verify.run', arguments: { workspace_id: 'ws_browser', profile: 'test' },
  });
  assert.equal(snapshot.isError, true);
  assert.equal(verify.isError, true);
  assert.match(JSON.stringify(snapshot.content), /Tool repo\.snapshot not found/);
  assert.match(JSON.stringify(verify.content), /Tool verify\.run not found/);
});
