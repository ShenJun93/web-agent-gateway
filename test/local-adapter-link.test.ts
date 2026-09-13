import assert from 'node:assert/strict';
import test from 'node:test';
import { startGatewayHttpServer } from '../src/http-server.js';
import type { GatewayApi } from '../src/server.js';
import {
  McpLocalAdapterLink,
  type AdapterDiscovery,
} from '../src/browser-adapter/local-link.js';

const bearerToken = 'a'.repeat(48);
const sid = 'session_12345678';

function fakeGateway(): GatewayApi {
  return {
    health: async () => ({ status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 4 }),
    openWorkspace: async (path: string) => ({ workspaceId: `ws_${path.length}` }),
    readFile: async (_workspaceId: string, path: string) => {
      if (path === 'fail.txt') throw new Error(`do-not-leak ${bearerToken} http://127.0.0.1:9999/mcp`);
      return { content: `content:${path}` };
    },
    verifyRun: async () => ({ profile: 'none', exitCode: 0, output: '' }),
    filePatchPreview: async () => { throw new Error('disabled'); },
    filePatchApply: async () => { throw new Error('disabled'); },
    repoSnapshot: async () => ({ branch: '', head: '', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false }),
  };
}

test('local adapter link exposes only the three browser tools and maps calls', async (t) => {
  const http = await startGatewayHttpServer({ gateway: fakeGateway(), bearerToken });
  t.after(() => http.close());
  const discovery: AdapterDiscovery = { mcpUrl: http.mcpUrl, bearerToken };
  const link = await McpLocalAdapterLink.connect(discovery);
  t.after(() => link.close());

  assert.deepEqual(await link.listTools(), ['health', 'workspace.open', 'file.read']);

  const health = await link.call({
    version: 1, type: 'tool.call', requestId: 'req_health_01', sessionId: sid,
    tool: 'health', arguments: {},
  });
  assert.equal(health.type, 'result');

  const opened = await link.call({
    version: 1, type: 'tool.call', requestId: 'req_workspace_01', sessionId: sid,
    tool: 'workspace.open', arguments: { path: 'E:/fixture' },
  });
  assert.deepEqual(opened.type === 'result' ? opened.result : undefined, { workspaceId: 'ws_10' });

  const read = await link.call({
    version: 1, type: 'tool.call', requestId: 'req_read_0001', sessionId: sid,
    tool: 'file.read', arguments: { workspace_id: 'ws_10', path: 'note.txt' },
  });
  assert.deepEqual(read.type === 'result' ? read.result : undefined, { content: 'content:note.txt' });
});

test('local adapter link rejects non-call envelopes and redacts transport details', async (t) => {
  const http = await startGatewayHttpServer({ gateway: fakeGateway(), bearerToken });
  t.after(() => http.close());
  const link = await McpLocalAdapterLink.connect({ mcpUrl: http.mcpUrl, bearerToken });
  t.after(() => link.close());

  await assert.rejects(() => link.call({
    version: 1, type: 'ping', requestId: 'req_ping_0001', sessionId: sid,
  }), /tool\.call/i);

  const failed = await link.call({
    version: 1, type: 'tool.call', requestId: 'req_read_fail', sessionId: sid,
    tool: 'file.read', arguments: { workspace_id: 'ws_10', path: 'fail.txt' },
  });
  assert.equal(failed.type, 'error');
  const rendered = JSON.stringify(failed);
  assert.doesNotMatch(rendered, /do-not-leak/);
  assert.doesNotMatch(rendered, new RegExp(bearerToken));
  assert.doesNotMatch(rendered, /127\.0\.0\.1:9999/);
});

test('browser request shape cannot override local discovery or caller identity', async () => {
  const forged = {
    version: 1, type: 'tool.call', requestId: 'req_forged_01', sessionId: sid,
    tool: 'health', arguments: {}, bearerToken: 'attacker', mcpUrl: 'http://attacker',
    owner_id: 'attacker', session_id: 'attacker', adapter_id: 'attacker',
  };
  const { parseBrowserAdapterRequest } = await import('../src/browser-adapter/protocol.js');
  assert.throws(() => parseBrowserAdapterRequest(forged));
});
