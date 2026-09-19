import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { BROWSER_VERIFY_ADAPTER_ID } from '../src/adapter-admission.js';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { createBrowserVerifyAdmittedMcpServer } from '../src/server.js';

const caller = createGatewayCallerContext({
  ownerId: 'owner-v3', sessionId: 'session-v3', adapterId: BROWSER_VERIFY_ADAPTER_ID,
});

async function connected() {
  const calls: unknown[] = [];
  const gateway = { health: async () => ({ status: 'ok' as const, executor: 'devspace' as const, protocolVersion: '2026-07-28', toolCount: 6 }) };
  const workspaces = {
    open: async (received: unknown, path: string) => { calls.push(['open', received, path]); return { workspaceId: 'ws_v3' }; },
    read: async (received: unknown, workspaceId: string, path: string) => { calls.push(['read', received, workspaceId, path]); return { content: 'alpha' }; },
    search: async () => ({ matches: [], truncated: false }),
    snapshot: async () => ({ branch: 'main', head: '1234', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false }),
  };
  const verify = {
    preview: (received: unknown, workspaceId: string, profile: string) => {
      calls.push(['preview', received, workspaceId, profile]);
      return { status: 'approval_required' as const, request_id: 'verifyreq_12345678-1234-1234-1234-123456789abc', profile, fingerprint: 'a'.repeat(64), expires_at: 61_000 };
    },
    result: (received: unknown, requestId: string) => {
      calls.push(['result', received, requestId]);
      return { request_id: requestId, profile: 'unit', state: 'PENDING_APPROVAL' as const, expires_at: 61_000 };
    },
  };
  const server = createBrowserVerifyAdmittedMcpServer(gateway, { callerContext: caller, workspaces, verify });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-v3-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { calls, client, server };
}

test('v3 admitted MCP has exact seven-tool surface and side-effect annotations', async (t) => {
  const c = await connected();
  t.after(async () => { await c.client.close(); await c.server.close(); });
  const tools = await c.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read', 'verify.preview', 'verify.result',
  ]);
  const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('workspace.open')?.annotations?.readOnlyHint, false);
  assert.equal(byName.get('verify.preview')?.annotations?.readOnlyHint, false);
  assert.equal(byName.get('verify.result')?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.every((tool) => tool.annotations?.destructiveHint === false), true);
  assert.equal(tools.tools.every((tool) => tool.annotations?.openWorldHint === false), true);
});

test('v3 verify proposal/result receive fixed caller and expose no direct execution controls', async (t) => {
  const c = await connected();
  t.after(async () => { await c.client.close(); await c.server.close(); });
  const preview = await c.client.callTool({
    name: 'verify.preview', arguments: { workspace_id: 'ws_v3', profile: 'unit' },
  });
  const requestId = (preview.structuredContent as { request_id?: string }).request_id!;
  assert.match(requestId, /^verifyreq_/);
  const result = await c.client.callTool({ name: 'verify.result', arguments: { request_id: requestId } });
  assert.equal((result.structuredContent as { state?: string }).state, 'PENDING_APPROVAL');
  assert.deepEqual(c.calls.slice(-2), [
    ['preview', caller, 'ws_v3', 'unit'],
    ['result', caller, requestId],
  ]);

  const schemas = JSON.stringify((await c.client.listTools()).tools.map((tool) => tool.inputSchema));
  for (const forbidden of ['argv', 'env', 'job_id', 'owner_id', 'session_id', 'adapter_id', 'approval', 'dispatch']) {
    assert.doesNotMatch(schemas, new RegExp(`"${forbidden}"`, 'i'));
  }
  for (const name of ['verify.run', 'job.get', 'mutation.preview', 'terminal.exec']) {
    await assert.rejects(c.client.callTool({ name, arguments: {} }), /not found/i);
  }
});
