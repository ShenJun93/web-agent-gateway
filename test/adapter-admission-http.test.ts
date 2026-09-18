import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { BrowserAdmissionRegistry, BROWSER_ADAPTER_V1_ID } from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import * as httpServerModule from '../src/http-server.js';
import { startBrowserAdmissionHttpServer, type BrowserAdmissionHttpServerOptions } from '../src/http-server.js';
import { createBrowserAdmittedMcpServer, createGateway } from '../src/server.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';

const BOOTSTRAP = 'bootstrap-0123456789abcdef0123456789abcdef';
test('HTTP module exposes browser admission mode only', () => {
  assert.equal('startGatewayHttpServer' in httpServerModule, false);
});
type HttpServerExports = typeof import('../src/http-server.js');
if (false) {
  // @ts-expect-error generic bearer HTTP starter must not remain exported.
  const retiredGenericStarter: keyof HttpServerExports = 'startGatewayHttpServer';
  void retiredGenericStarter;
}
if (false) {
  const browserOnly: BrowserAdmissionHttpServerOptions = { gateway: null as never, browserAdmission: null as never };
  void browserOnly;
  const browserWithBearer: BrowserAdmissionHttpServerOptions = {
    gateway: null as never,
    browserAdmission: null as never,
    // @ts-expect-error browser-admission mode must not accept the generic MCP bearer.
    bearerToken: 'forbidden',
  };
  void browserWithBearer;
  const browserWithMutation: BrowserAdmissionHttpServerOptions = {
    gateway: null as never,
    browserAdmission: null as never,
    // @ts-expect-error browser-admission mode must not accept generic mutation projection knobs.
    enableFilePatch: true,
  };
  void browserWithMutation;
}

async function fixture(t: test.TestContext) {
  const store = new SqliteDurableStore(':memory:');
  const admission = new BrowserAdmissionRegistry(BROWSER_ADAPTER_V1_ID, store, () => 1_000);
  const gateway = createGateway({ executor: new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' }), allowedRoots: [process.cwd()] });
  const workspaces = {
    open: async () => ({ workspaceId: 'ws_test' }),
    read: async () => ({ content: 'ok' }),
    search: async () => ({ matches: [], truncated: false }),
    snapshot: async () => ({ branch: 'main', head: '1234', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false }),
  };
  const http = await startBrowserAdmissionHttpServer({
    gateway,
    browserAdmission: { bootstrapToken: BOOTSTRAP, admission, browserMcp: (caller) => createBrowserAdmittedMcpServer(gateway, { callerContext: caller, workspaces }) },
  });
  t.after(async () => { admission.close(); store.close(); await http.close(); });
  return { http, admission };
}
async function raw(urlText: string, options: { method?: string; headers?: Record<string, string>; body?: string; setHost?: boolean } = {}) {
  const url = new URL(urlText);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: options.method ?? 'POST',
      headers: options.headers,
      setHost: options.setHost,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.end(options.body); else req.end();
  });
}

function bearer(token: string) { return { authorization: `Bearer ${token}` }; }
test('browser admission enforces exact Host and rejects every present Origin', async (t) => {
  const { http } = await fixture(t);
  const admissionUrl = (http as { admissionUrl?: string }).admissionUrl ?? '';
  assert.match(admissionUrl, /^http:\/\/127\.0\.0\.1:\d+\/adapter\/admit$/);
  const exactHost = `127.0.0.1:${http.port}`;
  const body = JSON.stringify({ correlation_id: 'session_http_A' });
  const accepted = await raw(admissionUrl, { headers: { ...bearer(BOOTSTRAP), host: exactHost, 'content-type': 'application/json' }, body });
  assert.equal(accepted.status, 200);

  const denied = [
    { name: 'alternate host', headers: { ...bearer(BOOTSTRAP), host: `localhost:${http.port}`, 'content-type': 'application/json' } },
    { name: 'missing host', headers: { ...bearer(BOOTSTRAP), 'content-type': 'application/json' }, setHost: false },
    { name: 'web origin', headers: { ...bearer(BOOTSTRAP), host: exactHost, origin: 'https://chatgpt.com', 'content-type': 'application/json' } },
    { name: 'null origin', headers: { ...bearer(BOOTSTRAP), host: exactHost, origin: 'null', 'content-type': 'application/json' } },
  ];
  for (const item of denied) {
    assert.equal((await raw(admissionUrl, { headers: item.headers, body, setHost: item.setHost })).status, 403, item.name);
  }
});
test('browser admission rejects malformed bootstrap requests before session creation', async (t) => {
  const { http } = await fixture(t);
  const admissionUrl = (http as { admissionUrl?: string }).admissionUrl ?? '';
  const exactHost = `127.0.0.1:${http.port}`;
  const goodHeaders = { ...bearer(BOOTSTRAP), host: exactHost, 'content-type': 'application/json' };
  const cases = [
    { name: 'wrong method', method: 'GET', headers: goodHeaders },
    { name: 'wrong content type', headers: { ...bearer(BOOTSTRAP), host: exactHost, 'content-type': 'text/plain' } },
    { name: 'wrong bootstrap', headers: { ...bearer('wrong'), host: exactHost, 'content-type': 'application/json' } },
    { name: 'malformed json', headers: goodHeaders, body: '{' },
    { name: 'short correlation', headers: goodHeaders, body: JSON.stringify({ correlation_id: 'short' }) },
    { name: 'extra field', headers: goodHeaders, body: JSON.stringify({ correlation_id: 'session_http_A', owner_id: 'attacker' }) },
    { name: 'oversized body', headers: goodHeaders, body: JSON.stringify({ correlation_id: 'x'.repeat(5000) }) },
  ];
  for (const item of cases) {
    let response;
    try { response = await raw(admissionUrl, item); }
    catch (error) { throw new Error(`${item.name}: ${error instanceof Error ? error.message : String(error)}`); }
    assert.notEqual(response.status, 200, item.name);
    assert.doesNotMatch(response.body, /owner_|session_|adapter_|bootstrap-|Bearer|correlationSha/i, item.name);
  }
});
test('bootstrap and admitted MCP credentials are class-separated', async (t) => {
  const { http } = await fixture(t);
  const admissionUrl = (http as { admissionUrl?: string }).admissionUrl ?? '';
  const exactHost = `127.0.0.1:${http.port}`;
  const admitted = await raw(admissionUrl, {
    headers: { ...bearer(BOOTSTRAP), host: exactHost, 'content-type': 'application/json' },
    body: JSON.stringify({ correlation_id: 'session_http_class_A' }),
  });
  assert.equal(admitted.status, 200);
  const value = JSON.parse(admitted.body) as { mcp_url?: string; bearer_token?: string; ownerId?: string; sessionId?: string; adapterId?: string };
  assert.equal(value.mcp_url, http.mcpUrl);
  assert.match(value.bearer_token ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(value.ownerId, undefined);
  assert.equal(value.sessionId, undefined);
  assert.equal(value.adapterId, undefined);

  assert.equal((await raw(http.mcpUrl, { headers: { ...bearer(BOOTSTRAP), host: exactHost, 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await raw(admissionUrl, { headers: { ...bearer(value.bearer_token!), host: exactHost, 'content-type': 'application/json' }, body: JSON.stringify({ correlation_id: 'session_http_class_A' }) })).status, 401);
});
test('admitted MCP bearer exposes only browser tools and release revokes it', async (t) => {
  const { http } = await fixture(t);
  const admissionUrl = (http as { admissionUrl?: string }).admissionUrl ?? '';
  const exactHost = `127.0.0.1:${http.port}`;
  const admitted = await raw(admissionUrl, {
    headers: { ...bearer(BOOTSTRAP), host: exactHost, 'content-type': 'application/json' },
    body: JSON.stringify({ correlation_id: 'session_http_tools_A' }),
  });
  const { mcp_url: mcpUrl, bearer_token: token } = JSON.parse(admitted.body) as { mcp_url: string; bearer_token: string };

  const client = new Client({ name: 'admitted-http-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: bearer(token) } });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read']);
  await client.close();

  const released = await raw(`http://127.0.0.1:${http.port}/adapter/release`, { headers: { ...bearer(token), host: exactHost } });
  assert.equal(released.status, 200);
  assert.deepEqual(JSON.parse(released.body), { released: true });
  const stale = await raw(mcpUrl, { headers: { ...bearer(token), host: exactHost, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(stale.status, 401);
});
