import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';

test('public MCP exposes only the five V0 semantic tools', async (t) => {
  const executor = new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' });
  const gateway = createGateway({ executor, allowedRoots: [process.cwd()], verifyProfiles: { test: { argv: ['node', '--version'] } } });
  const server = createGatewayMcpServer(gateway);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'gateway-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run',
  ]);
  const verify = tools.tools.find((tool) => tool.name === 'verify.run');
  assert.equal(verify?.annotations?.readOnlyHint, false, 'verify.run may execute scripts and must not claim read-only');
  assert.equal(verify?.execution?.taskSupport, undefined, 'v2 core must expose no retired Tasks execution metadata');
});


test('legacy file.patch opt-in cannot resurrect a removed tool', async (t) => {
  const executor = new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' });
  const gateway = createGateway({ executor, allowedRoots: [process.cwd()], verifyProfiles: {} });
  const server = createGatewayMcpServer(gateway, { enableFilePatch: true } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'gateway-legacy-mutation-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run',
  ]);
});
test('opt-in durable mutation MCP exposes preview/result without remote approval fields', async (t) => {
  const { createHash } = await import('node:crypto');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { SqliteDurableStore } = await import('../src/durable-store.js');
  const { DurableMutationCoordinator } = await import('../src/durable-mutation.js');
  const root = await mkdtemp(join(tmpdir(), 'wag-mcp-mutation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = 'alpha\nbeta\n';
  await writeFile(join(root, 'note.txt'), original);
  const callerContext = createGatewayCallerContext({
    ownerId: 'owner_test', sessionId: 'session_test', adapterId: 'adapter_test',
    correlation: { provider: 'chatgpt', clientId: 'test-client' },
  });
  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());
  const workspace = store.openWorkspaceRecord({
    ownerId: callerContext.ownerId, sessionId: callerContext.sessionId, adapterId: callerContext.adapterId,
    canonicalRoot: root, backendKind: 'fake', createdAt: 1,
  });
  const backend = { kind: 'fake', readExact: async () => original, readExactIfPresent: async () => original, createNew: async () => undefined, updateExisting: async () => undefined };
  const coordinator = new DurableMutationCoordinator({ store, backends: [backend] });
  const executor = new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' });
  const gateway = createGateway({ executor, allowedRoots: [root] });
  const server = createGatewayMcpServer(gateway, { mutationContext: { callerContext, coordinator } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'durable-mutation-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run',
    'mutation.preview', 'file.create', 'mutation.result',
  ]);
  const previewTool = tools.tools.find((tool) => tool.name === 'mutation.preview');
  const resultTool = tools.tools.find((tool) => tool.name === 'mutation.result');
  assert.deepEqual(previewTool?.annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
  });
  assert.equal(resultTool?.annotations?.readOnlyHint, true);
  const schemas = JSON.stringify([previewTool?.inputSchema, resultTool?.inputSchema]);
  for (const forbidden of [
    'approval_id', 'phase', 'patch', 'canonical_root',
    'owner_id', 'session_id', 'adapter_id', 'ownerId', 'sessionId', 'adapterId',
    'provider', 'client_id', 'clientId', 'conversation_ref', 'conversationRef',
  ]) {
    assert.doesNotMatch(schemas, new RegExp(`"${forbidden}"`), `durable mutation schema must omit ${forbidden}`);
  }

  const baseSha256 = createHash('sha256').update(original, 'utf8').digest('hex');
  const injectedIdentity = await client.callTool({
    name: 'mutation.preview',
    arguments: {
      workspace_id: workspace.workspaceId, path: 'note.txt', base_sha256: baseSha256,
      before: 'beta', after: 'BETA', owner_id: 'attacker-selected-owner',
    },
  });
  assert.equal(injectedIdentity.isError, true);
  assert.match(JSON.stringify(injectedIdentity.content), /Invalid arguments for tool mutation\.preview/);
  const preview = await client.callTool({ name: 'mutation.preview', arguments: {
    workspace_id: workspace.workspaceId, path: 'note.txt', base_sha256: baseSha256, before: 'beta', after: 'BETA',
  } });
  const mutationId = (preview.structuredContent as { mutationId?: string } | undefined)?.mutationId;
  assert.match(mutationId ?? '', /^mut_/);
  const result = await client.callTool({ name: 'mutation.result', arguments: { mutation_id: mutationId } });
  assert.equal((result.structuredContent as { state?: string } | undefined)?.state, 'PENDING_APPROVAL');
});
