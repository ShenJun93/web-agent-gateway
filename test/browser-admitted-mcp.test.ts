import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext } from '../src/caller-context.js';
import { createBrowserAdmittedMcpServer } from '../src/server.js';

import { BROWSER_INSPECT_ADAPTER_ID } from '../src/adapter-admission.js';

const caller = createGatewayCallerContext({
  ownerId: 'owner_browser',
  sessionId: 'session_browser',
  adapterId: BROWSER_INSPECT_ADAPTER_ID,
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
    search: async (receivedCaller: unknown, workspaceId: string, query: string, options: unknown) => {
      calls.push(['search', receivedCaller, workspaceId, query, options]);
      return { matches: [], truncated: false };
    },
    snapshot: async (receivedCaller: unknown, workspaceId: string, options: unknown) => {
      calls.push(['snapshot', receivedCaller, workspaceId, options]);
      return { branch: 'main', head: '1234', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false };
    },
  };
  const server = createBrowserAdmittedMcpServer(gateway, { callerContext: caller, workspaces });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-admitted-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { calls, client, server };
}

test('browser-admitted MCP exposes exactly five read-only tools', async (t) => {
  const connected = await connectedBrowserServer();
  t.after(async () => { await connected.client.close(); await connected.server.close(); });

  const tools = await connected.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read',
  ]);
  assert.equal(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
  assert.equal(tools.tools.every((tool) => tool.annotations?.destructiveHint === false), true);
  assert.equal(tools.tools.every((tool) => tool.annotations?.openWorldHint === false), true);
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

  const search = await connected.client.callTool({
    name: 'repo.search', arguments: { workspace_id: 'ws_browser', query: 'foo', ignore_case: true, max_results: 10, context_lines: 2 },
  });
  assert.deepEqual(search.structuredContent, { matches: [], truncated: false });

  const snapshot = await connected.client.callTool({
    name: 'repo.snapshot', arguments: { workspace_id: 'ws_browser', max_files: 50 },
  });
  assert.equal((snapshot.structuredContent as { branch?: string } | undefined)?.branch, 'main');

  assert.deepEqual(connected.calls, [
    ['open', caller, 'E:/fixture'],
    ['read', caller, 'ws_browser', 'note.txt'],
    ['search', caller, 'ws_browser', 'foo', { ignoreCase: true, maxResults: 10, contextLines: 2 }],
    ['snapshot', caller, 'ws_browser', { maxFiles: 50 }],
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

test('browser schemas reject invalid search queries and out of range parameters', async (t) => {
  const connected = await connectedBrowserServer();
  t.after(async () => { await connected.client.close(); await connected.server.close(); });

  const invalidSearches = [
    { query: 'foo\0bar' },
    { query: 'foo\rbar' },
    { query: 'foo\nbar' },
    { query: 'a'.repeat(257) },
    { query: 'foo', extra_field: true },
    { query: 'foo', max_results: 51 },
    { query: 'foo', max_results: 0 },
    { query: 'foo', context_lines: 3 },
    { query: 'foo', context_lines: -1 },
  ];
  for (const args of invalidSearches) {
    let failed = false;
    try {
      const result = await connected.client.callTool({
        name: 'repo.search', arguments: { workspace_id: 'ws_browser', ...args },
      });
      if (result.isError) {
        failed = true;
      } else {
        console.log('Result for args', args, result);
      }
    } catch {
      failed = true;
    }
    if (!failed) assert.fail(`Expected rejection for search args: ${JSON.stringify(args)}`);
  }

  const invalidSnapshots = [
    { max_files: 201 },
    { max_files: 0 },
    { extra_field: true },
  ];
  for (const args of invalidSnapshots) {
    let failed = false;
    try {
      const result = await connected.client.callTool({
        name: 'repo.snapshot', arguments: { workspace_id: 'ws_browser', ...args },
      });
      if (result.isError) {
        failed = true;
      }
    } catch {
      failed = true;
    }
    if (!failed) assert.fail(`Expected rejection for snapshot args: ${JSON.stringify(args)}`);
  }
});

test('broader default tools are unavailable on browser-admitted MCP', async (t) => {
  const connected = await connectedBrowserServer();
  t.after(async () => { await connected.client.close(); await connected.server.close(); });

  for (const request of [
    { name: 'verify.run', arguments: { workspace_id: 'ws_browser', profile: 'test' } },
    { name: 'mutation.preview', arguments: { workspace_id: 'ws_browser' } },
    { name: 'mutation.result', arguments: { mutation_id: 'mut' } },
    { name: 'job.get', arguments: { job_id: 'job' } },
    { name: 'some.arbitrary.tool', arguments: {} },
  ]) {
    await assert.rejects(connected.client.callTool(request), (error: unknown) =>
      error instanceof Error
      && (error as Error & { code?: number }).code === -32602
      && error.message === `Tool ${request.name} not found`);
  }
});
