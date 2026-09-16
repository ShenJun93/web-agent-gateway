import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserAdmissionRegistry } from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { startBrowserAdmissionHttpServer } from '../src/http-server.js';
import type { GatewayApi } from '../src/server.js';
import { createBrowserAdmittedMcpServer } from '../src/server.js';
import { McpLocalAdapterLink, type AdapterDiscovery } from '../src/browser-adapter/local-link.js';

const bootstrapToken = 'bootstrap-0123456789abcdef0123456789abcdef';
const sid = 'session_12345678';

function fakeGateway(): GatewayApi {
  return {
    health: async () => ({ status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 4 }),
    openWorkspace: async () => ({ workspaceId: 'legacy' }),
    readFile: async () => ({ content: 'legacy' }),
    verifyRun: async () => ({ profile: 'none', exitCode: 0, output: '' }),
    repoSnapshot: async () => ({ branch: '', head: '', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false }),
  };
}
async function admissionFixture(t: test.TestContext) {
  const store = new SqliteDurableStore(':memory:');
  const admission = new BrowserAdmissionRegistry(store, () => 1_000);
  const gateway = fakeGateway();
  const workspaces = {
    open: async (_caller: unknown, path: string) => ({ workspaceId: `ws_${path.length}` }),
    read: async (_caller: unknown, _workspaceId: string, path: string) => {
      if (path === 'fail.txt') throw new Error(`do-not-leak ${bootstrapToken} http://127.0.0.1:9999/mcp`);
      return { content: `content:${path}` };
    },
  };
  const http = await startBrowserAdmissionHttpServer({
    gateway,
    browserAdmission: {
      bootstrapToken,
      admission,
      browserMcp: (caller) => createBrowserAdmittedMcpServer(gateway, { callerContext: caller, workspaces }),
    },
  });
  t.after(async () => { admission.close(); store.close(); await http.close(); });
  return { http, discovery: { admissionUrl: http.admissionUrl!, bootstrapToken } satisfies AdapterDiscovery };
}
test('local adapter link admits correlation before exposing browser tools', async (t) => {
  const { discovery } = await admissionFixture(t);
  const link = await McpLocalAdapterLink.admit(discovery, sid);
  t.after(() => link.close());

  assert.deepEqual(await link.listTools(), ['health', 'workspace.open', 'file.read']);
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

test('local adapter link rejects invalid bootstrap discovery before connecting', async () => {
  const invalid = [
    { admissionUrl: 'http://127.0.0.1:9/mcp', bootstrapToken },
    { admissionUrl: 'http://example.com/adapter/admit', bootstrapToken },
    { admissionUrl: 'http://user:pass@127.0.0.1:9/adapter/admit', bootstrapToken },
    { admissionUrl: 'http://127.0.0.1:9/adapter/admit', bootstrapToken: 'short' },
    { admissionUrl: 'http://127.0.0.1:9/adapter/admit', bootstrapToken, extra: 'forbidden' },
  ];
  for (const value of invalid) {
    await assert.rejects(() => McpLocalAdapterLink.admit(value as AdapterDiscovery, sid), /Invalid browser adapter discovery/);
  }
});
test('local adapter link redacts admitted transport failures', async (t) => {
  const { discovery } = await admissionFixture(t);
  const link = await McpLocalAdapterLink.admit(discovery, sid);
  t.after(() => link.close());
  const failed = await link.call({
    version: 1, type: 'tool.call', requestId: 'req_read_fail', sessionId: sid,
    tool: 'file.read', arguments: { workspace_id: 'ws_10', path: 'fail.txt' },
  });
  assert.equal(failed.type, 'error');
  const rendered = JSON.stringify(failed);
  assert.doesNotMatch(rendered, /do-not-leak/);
  assert.doesNotMatch(rendered, new RegExp(bootstrapToken));
  assert.doesNotMatch(rendered, /127\.0\.0\.1:9999/);
});

test('browser request shape cannot override local discovery or caller identity', async () => {
  const forged = {
    version: 1, type: 'tool.call', requestId: 'req_forged_01', sessionId: sid,
    tool: 'health', arguments: {}, bootstrapToken: 'attacker', admissionUrl: 'http://attacker',
    owner_id: 'attacker', session_id: 'attacker', adapter_id: 'attacker',
  };
  const { parseBrowserAdapterRequest } = await import('../src/browser-adapter/protocol.js');
  assert.throws(() => parseBrowserAdapterRequest(forged));
});
