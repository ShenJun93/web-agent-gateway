import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserAdmissionRegistry, BROWSER_INSPECT_ADAPTER_ID } from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { startBrowserAdmissionHttpServer } from '../src/http-server.js';
import type { GatewayApi } from '../src/server.js';
import { createBrowserAdmittedMcpServer } from '../src/server.js';
import { McpLocalAdapterLink, parseAdapterDiscovery, type AdapterDiscovery } from '../src/browser-adapter/local-link.js';
import { BROWSER_ADAPTER_PROTOCOL_VERSION } from '../src/browser-adapter/protocol.js';

const bootstrapToken = 'bootstrap-0123456789abcdef0123456789abcdef';
const sid = 'session_12345678';

function fakeGateway(): GatewayApi {
  return {
    health: async () => ({ status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 4 }),
    openWorkspace: async () => ({ workspaceId: 'legacy' }),
    readFile: async () => ({ content: 'legacy' }),
    verifyRun: async () => ({ profile: 'none', exitCode: 0, output: '' }),
    repoSnapshot: async () => ({ branch: '', head: '', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false }),
    repoSearch: async () => ({ matches: [], truncated: false }),
  };
}
async function admissionFixture(t: test.TestContext) {
  const store = new SqliteDurableStore(':memory:');
  const admission = new BrowserAdmissionRegistry(BROWSER_INSPECT_ADAPTER_ID, store, () => 1_000);
  const gateway = fakeGateway();
  const workspaces = {
    open: async (_caller: unknown, path: string) => ({ workspaceId: `ws_${path.length}` }),
    read: async (_caller: unknown, _workspaceId: string, path: string) => {
      if (path === 'fail.txt') throw new Error(`do-not-leak ${bootstrapToken} http://127.0.0.1:9999/mcp`);
      return { content: `content:${path}` };
    },
    search: async () => ({ matches: [], truncated: false }),
    snapshot: async () => ({ branch: '', head: '', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false }),
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
  return { http, discovery: { admissionUrl: http.admissionUrl!, bootstrapToken, protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: BROWSER_INSPECT_ADAPTER_ID } satisfies AdapterDiscovery };
}

test('parseAdapterDiscovery validates strict v2 records', () => {
  const valid = { admissionUrl: 'http://127.0.0.1:9/adapter/admit', bootstrapToken, protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: BROWSER_INSPECT_ADAPTER_ID };
  assert.deepEqual(parseAdapterDiscovery(valid as any), valid);

  const invalid = [
    { admissionUrl: 'http://127.0.0.1:9/mcp', bootstrapToken, protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: BROWSER_INSPECT_ADAPTER_ID },
    { admissionUrl: 'http://example.com/adapter/admit', bootstrapToken, protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: BROWSER_INSPECT_ADAPTER_ID },
    { admissionUrl: 'http://127.0.0.1:9/adapter/admit', bootstrapToken: 'short', protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: BROWSER_INSPECT_ADAPTER_ID },
    { admissionUrl: 'http://127.0.0.1:9/adapter/admit', bootstrapToken, protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: BROWSER_INSPECT_ADAPTER_ID, extra: 'forbidden' },
    { admissionUrl: 'http://127.0.0.1:9/adapter/admit', bootstrapToken }, // v1 missing fields
    { admissionUrl: 'http://127.0.0.1:9/adapter/admit', bootstrapToken, protocolVersion: 1, adapterId: BROWSER_INSPECT_ADAPTER_ID },
    { admissionUrl: 'http://127.0.0.1:9/adapter/admit', bootstrapToken, protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: 'browser.chatgpt.native.v1' },
  ];
  for (const value of invalid) {
    assert.throws(() => parseAdapterDiscovery(value as any), /Invalid browser adapter discovery/);
  }
});

test('local adapter link admits correlation before exposing exact browser tools', async (t) => {
  const { discovery } = await admissionFixture(t);
  const link = await McpLocalAdapterLink.admit(discovery, sid);
  t.after(() => link.close());

  assert.deepEqual(await link.listTools(), ['health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read']);
  const opened = await link.call({
    version: 2, type: 'tool.call', requestId: 'req_workspace_01', sessionId: sid,
    tool: 'workspace.open', arguments: { path: 'E:/fixture' },
  });
  assert.deepEqual(opened.type === 'result' ? opened.result : undefined, { workspaceId: 'ws_10' });

  const read = await link.call({
    version: 2, type: 'tool.call', requestId: 'req_read_0001', sessionId: sid,
    tool: 'file.read', arguments: { workspace_id: 'ws_10', path: 'note.txt' },
  });
  assert.deepEqual(read.type === 'result' ? read.result : undefined, { content: 'content:note.txt' });
});

test('local adapter link fails when exact tool match is not met', async (t) => {
  const { discovery } = await admissionFixture(t);
  const link = await McpLocalAdapterLink.admit(discovery, sid);
  t.after(() => link.close());

  (link as any).client.listTools = async () => ({ tools: [{ name: 'health' }] });
  await assert.rejects(() => link.listTools(), /browser tool profile mismatch/);

  (link as any).client.listTools = async () => ({ tools: [{ name: 'health' }, { name: 'workspace.open' }, { name: 'repo.search' }, { name: 'repo.snapshot' }, { name: 'file.read' }, { name: 'extra' }] });
  await assert.rejects(() => link.listTools(), /browser tool profile mismatch/);

  (link as any).client.listTools = async () => ({ tools: [{ name: 'file.read,health' }, { name: 'repo.search' }, { name: 'repo.snapshot' }, { name: 'workspace.open' }] });
  await assert.rejects(() => link.listTools(), /browser tool profile mismatch/);
});

test('local adapter link redacts admitted transport failures', async (t) => {
  const { discovery } = await admissionFixture(t);
  const link = await McpLocalAdapterLink.admit(discovery, sid);
  t.after(() => link.close());
  const failed = await link.call({
    version: 2, type: 'tool.call', requestId: 'req_read_fail', sessionId: sid,
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
    version: 2, type: 'tool.call', requestId: 'req_forged_01', sessionId: sid,
    tool: 'health', arguments: {}, bootstrapToken: 'attacker', admissionUrl: 'http://attacker',
    owner_id: 'attacker', session_id: 'attacker', adapter_id: 'attacker',
  };
  const { parseBrowserAdapterRequest } = await import('../src/browser-adapter/protocol.js');
  assert.throws(() => parseBrowserAdapterRequest(forged));
});
