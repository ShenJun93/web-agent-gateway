import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startGatewayHttpServer } from '../src/http-server.js';
import { createGateway } from '../src/server.js';

const TOKEN = 'benchmark-token-0123456789abcdef0123456789abcdef';

test('HTTP MCP boundary rejects anonymous callers and accepts bearer-authenticated MCP', async (t) => {
  const gateway = createGateway({
    executor: new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' }),
    allowedRoots: [process.cwd()],
    verifyProfiles: { test: { argv: ['node', '--version'] } },
  });
  const http = await startGatewayHttpServer({ gateway, bearerToken: TOKEN });
  t.after(() => http.close());

  const anonymous = await fetch(http.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer');

  const bad = await fetch(http.mcpUrl, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 401);

  const ping = await fetch(http.mcpUrl, {
    method: 'POST',
    headers: { authorization: ['Bearer', TOKEN].join(' '), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
  });
  assert.equal(ping.status, 200);
  assert.match(ping.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);

  const client = new Client({ name: 'http-test', version: '1.0.0' }, { capabilities: {} });
  const authValue = ['Bearer', TOKEN].join(' ');
  const transport = new StreamableHTTPClientTransport(new URL(http.mcpUrl), {
    requestInit: { headers: { authorization: authValue } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run',
  ]);
});

test('HTTP server refuses direct non-loopback bind in V0', async () => {
  const gateway = createGateway({ executor: new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' }), allowedRoots: [process.cwd()] });
  await assert.rejects(startGatewayHttpServer({ gateway, bearerToken: TOKEN, host: '0.0.0.0' }), /must bind loopback/);
});
