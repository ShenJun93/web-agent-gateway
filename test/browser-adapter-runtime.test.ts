import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { McpLocalAdapterLink, type AdapterDiscovery } from '../src/browser-adapter/local-link.js';
import { startBrowserAdapterRuntime } from '../scripts/browser-adapter-runtime.js';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';

const sessionId = 'session_runtime_01';

test('read-only browser runtime keeps WAG alive across native-link reconnects', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const temp = await mkdtemp(join(tmpdir(), 'wag-browser-runtime-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'private.json');
  const discoveryPath = join(temp, 'local-state', 'browser-adapter.json');
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [fixture.workspaceRoot],
    devspace: { baseUrl: fixture.baseUrl, resourceUrl: fixture.resourceUrl },
    verifyProfiles: {},
  }), 'utf8');

  const env = { DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN };
  const runtime = await startBrowserAdapterRuntime({ configPath, discoveryPath, env });
  t.after(() => runtime.close());
  assert.match(runtime.mcpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(env.DEVSPACE_OAUTH_OWNER_TOKEN, undefined);
  assert.equal(discoveryPath.startsWith(fixture.workspaceRoot), false);

  const discovery = JSON.parse(await readFile(discoveryPath, 'utf8')) as AdapterDiscovery;
  assert.equal(discovery.mcpUrl, runtime.mcpUrl);
  assert.ok(Buffer.byteLength(discovery.bearerToken, 'utf8') >= 32);
  assert.doesNotMatch(JSON.stringify(runtime), new RegExp(discovery.bearerToken));

  const first = await McpLocalAdapterLink.connect(discovery);
  assert.deepEqual(await first.listTools(), ['health', 'workspace.open', 'file.read']);
  await first.close();

  const second = await McpLocalAdapterLink.connect(discovery);
  const health = await second.call({
    version: 1, type: 'tool.call', requestId: 'req_runtime_health', sessionId,
    tool: 'health', arguments: {},
  });
  assert.equal(health.type, 'result');
  assert.equal((health.type === 'result' ? health.result as { status?: string } : {}).status, 'ok');
  await second.close();

  await runtime.close();
  await assert.rejects(() => readFile(discoveryPath, 'utf8'), /ENOENT/);
  const devspaceStillAlive = await fetch(`${fixture.baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(devspaceStillAlive.ok, true);
});
