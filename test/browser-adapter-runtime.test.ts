import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { McpLocalAdapterLink, type AdapterDiscovery } from '../src/browser-adapter/local-link.js';
import { startBrowserAdapterRuntime } from '../scripts/browser-adapter-runtime.js';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';

const correlationA = 'session_runtime_A';
const correlationB = 'session_runtime_B';

async function writeConfig(path: string, root: string, baseUrl: string, resourceUrl: string) {
  await writeFile(path, JSON.stringify({
    allowedRoots: [root],
    devspace: { baseUrl, resourceUrl },
    verifyProfiles: {},
  }), 'utf8');
}

async function rawAdmit(discovery: AdapterDiscovery, correlationId: string) {
  const response = await fetch(discovery.admissionUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${discovery.bootstrapToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ correlation_id: correlationId }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ mcp_url: string; bearer_token: string }>;
}

async function unauthorizedPing(mcpUrl: string, bearer: string) {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
  });
}

test('browser runtime rejects relative durable state path before startup', async () => {
  await assert.rejects(() => startBrowserAdapterRuntime({
    configPath: 'C:\\absolute-config.json',
    discoveryPath: 'C:\\absolute-discovery.json',
    statePath: 'relative-state.sqlite',
    env: {},
  }), /state path must be absolute/i);
});

test('browser runtime isolates sessions and recovers owned workspace across WAG restart', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), 'alpha\nbeta\n', 'utf8');
  const temp = await mkdtemp(join(tmpdir(), 'wag-browser-runtime-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'private.json');
  const discoveryPath = join(temp, 'local-state', 'browser-adapter.json');
  const statePath = join(temp, 'local-state', 'control-plane.sqlite');
  await writeConfig(configPath, fixture.workspaceRoot, fixture.baseUrl, fixture.resourceUrl);

  const runtimeA = await startBrowserAdapterRuntime({
    configPath, discoveryPath, statePath,
    env: { DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
  });  t.after(() => runtimeA.close());

  const discoveryA = JSON.parse(await readFile(discoveryPath, 'utf8')) as AdapterDiscovery;
  assert.deepEqual(Object.keys(discoveryA).sort(), ['admissionUrl', 'bootstrapToken']);
  assert.match(discoveryA.admissionUrl, /^http:\/\/127\.0\.0\.1:\d+\/adapter\/admit$/);
  assert.ok(Buffer.byteLength(discoveryA.bootstrapToken, 'utf8') >= 32);
  const renderedDiscovery = JSON.stringify(discoveryA);
  assert.equal(renderedDiscovery.includes(statePath), false);
  assert.equal(renderedDiscovery.includes(fixture.workspaceRoot), false);
  assert.doesNotMatch(renderedDiscovery, /owner_|adapter_|\/mcp"/);

  const linkA = await McpLocalAdapterLink.admit(discoveryA, correlationA);
  t.after(() => linkA.close());
  const linkB = await McpLocalAdapterLink.admit(discoveryA, correlationB);
  t.after(() => linkB.close());
  const openedA = await linkA.call({
    version: 1, type: 'tool.call', requestId: 'req_runtime_open_A', sessionId: correlationA,
    tool: 'workspace.open', arguments: { path: fixture.workspaceRoot },
  });
  assert.equal(openedA.type, 'result');
  const workspaceA = openedA.type === 'result' ? (openedA.result as { workspaceId?: string }).workspaceId : undefined;
  assert.match(workspaceA ?? '', /^ws_/);

  const openedB = await linkB.call({
    version: 1, type: 'tool.call', requestId: 'req_runtime_open_B', sessionId: correlationB,
    tool: 'workspace.open', arguments: { path: fixture.workspaceRoot },
  });
  assert.equal(openedB.type, 'result');
  const workspaceB = openedB.type === 'result' ? (openedB.result as { workspaceId?: string }).workspaceId : undefined;
  assert.match(workspaceB ?? '', /^ws_/);
  assert.notEqual(workspaceB, workspaceA);

  const crossRead = await linkB.call({
    version: 1, type: 'tool.call', requestId: 'req_runtime_cross', sessionId: correlationB,
    tool: 'file.read', arguments: { workspace_id: workspaceA!, path: 'note.txt' },
  });
  assert.equal(crossRead.type, 'error');

  await linkA.close();
  await linkB.close();
  const stale = await rawAdmit(discoveryA, correlationA);
  await runtimeA.close();

  const runtimeB = await startBrowserAdapterRuntime({
    configPath, discoveryPath, statePath,
    env: { DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
  });
  t.after(() => runtimeB.close());
  const discoveryB = JSON.parse(await readFile(discoveryPath, 'utf8')) as AdapterDiscovery;
  assert.notEqual(discoveryB.bootstrapToken, discoveryA.bootstrapToken);
  const runtimeBProbe = await rawAdmit(discoveryB, 'session_runtime_probe');
  assert.equal((await unauthorizedPing(runtimeBProbe.mcp_url, stale.bearer_token)).status, 401);

  const recovered = await McpLocalAdapterLink.admit(discoveryB, correlationA);
  t.after(() => recovered.close());
  const read = await recovered.call({
    version: 1, type: 'tool.call', requestId: 'req_runtime_recover', sessionId: correlationA,
    tool: 'file.read', arguments: { workspace_id: workspaceA!, path: 'note.txt' },
  });
  assert.equal(read.type, 'result');
  assert.equal(read.type === 'result' ? (read.result as { content?: string }).content : undefined, 'alpha\nbeta');
  await recovered.close();

  await runtimeB.close();
  await assert.rejects(() => readFile(discoveryPath, 'utf8'), /ENOENT/);
  const devspaceStillAlive = await fetch(`${fixture.baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(devspaceStillAlive.ok, true);
});
