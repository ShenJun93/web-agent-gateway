import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
  assert.equal(verify?.execution?.taskSupport, 'optional', 'verify.run must support recoverable MCP task execution');
});
