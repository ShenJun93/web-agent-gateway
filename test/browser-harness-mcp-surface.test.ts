import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { BrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import { createGatewayMcpServer, type GatewayApi } from '../src/server.js';
import { projectedTools } from '../scripts/prepare-direct-mcp-tunnel.js';

const BROWSER_TOOLS = [
  'browser.open',
  'browser.describe',
  'browser.snapshot',
  'browser.exec',
  'browser.screenshot',
  'browser.close',
] as const;

function fullBrowserConfig(): PrivateGatewayConfig {
  const root = process.cwd();
  return {
    allowedRoots: [root],
    devspace: {
      baseUrl: 'http://127.0.0.1:7676',
      resourceUrl: 'http://127.0.0.1:7676/mcp',
    },
    verifyProfiles: {
      unit: { argv: ['node', '--version'] },
    },
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath: join(root, '.wag-browser-mcp-test.sqlite'),
        ownerId: 'local.private.stdio',
      },
      gitCommit: {},
      browser: {
        edgeExecutablePath: join(root, 'fake-msedge.exe'),
        profileRoot: join(root, '.wag-browser-profiles'),
      },
    },
  };
}

test('browser opt-in projects exactly six BrowserPort tools on top of the 43-tool core surface', async () => {
  const projected = await projectedTools(fullBrowserConfig());
  assert.equal(projected.missing.length, 0);
  assert.equal(projected.tools.length, 49);
  for (const name of BROWSER_TOOLS) assert.ok(projected.tools.includes(name), name);
  assert.equal(projected.tools.some((name) => name.includes('cdp') || name.includes('playwright')), false,
    'raw transport implementation names must not become public MCP tools');
});

test('browser.exec accepts semantic exact-once actions and never accepts a raw CDP method', async (t) => {
  const calls: unknown[][] = [];
  const browserContext: BrowserMcpContext = {
    async open(profileId) {
      calls.push(['open', profileId]);
      return {
        browserSessionId: 'browser_00000000-0000-4000-8000-000000000001',
        profileId,
        backend: 'cdp',
        processId: 'process_00000000-0000-4000-8000-000000000002',
        pid: 1234,
        createdAt: 1,
        lastSeenAt: 1,
        state: 'ACTIVE',
      };
    },
    async describe(browserSessionId) {
      calls.push(['describe', browserSessionId]);
      return {
        browserSessionId,
        profileId: 'acceptance',
        backend: 'cdp',
        createdAt: 1,
        lastSeenAt: 2,
        state: 'ACTIVE',
      };
    },
    async snapshot(browserSessionId) {
      calls.push(['snapshot', browserSessionId]);
      return {
        snapshotId: 'snapshot_test',
        browserSessionId,
        url: 'https://example.test/',
        title: 'Example',
        nodes: [],
        truncated: false,
      };
    },
    async exec(browserSessionId, idempotencyKey, action) {
      calls.push(['exec', browserSessionId, idempotencyKey, action]);
      return {
        effectId: 'effect_00000000-0000-4000-8000-000000000003',
        ownerId: 'owner',
        sessionId: 'session',
        adapterId: 'private.stdio.v1',
        idempotencyKey,
        kind: `browser.${action.type}`,
        resourceId: browserSessionId,
        planFingerprint: 'effectfp_test',
        state: 'SUCCEEDED',
        createdAt: 1,
        updatedAt: 2,
        attemptId: 'attempt_00000000-0000-4000-8000-000000000004',
        resultDigest: 'sha256_test',
      };
    },
    async screenshot(browserSessionId) {
      calls.push(['screenshot', browserSessionId]);
      return { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
    },
    async close(browserSessionId) {
      calls.push(['close', browserSessionId]);
      return {
        browserSessionId,
        profileId: 'acceptance',
        backend: 'cdp',
        createdAt: 1,
        lastSeenAt: 3,
        state: 'CLOSED',
      };
    },
    async closeAll() {},
  };

  const gateway = {
    health: async () => ({
      status: 'ok' as const,
      executor: 'devspace' as const,
      protocolVersion: 'test',
      toolCount: 6,
    }),
  } as unknown as GatewayApi;
  const server = createGatewayMcpServer(gateway, { browserContext });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-mcp-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });

  const tools = (await client.listTools()).tools;
  for (const name of BROWSER_TOOLS) assert.ok(tools.some((tool) => tool.name === name), name);

  const sessionId = 'browser_00000000-0000-4000-8000-000000000001';
  const executed = await client.callTool({
    name: 'browser.exec',
    arguments: {
      browser_session_id: sessionId,
      idempotency_key: 'acceptance.click.1',
      action: { type: 'click', ref: 'node_00000000-0000-4000-8000-000000000010_0' },
    },
  });
  assert.equal(executed.isError === true, false);
  assert.deepEqual(calls.at(-1), [
    'exec',
    sessionId,
    'acceptance.click.1',
    { type: 'click', ref: 'node_00000000-0000-4000-8000-000000000010_0' },
  ]);

  const raw = await client.callTool({
    name: 'browser.exec',
    arguments: {
      browser_session_id: sessionId,
      idempotency_key: 'acceptance.raw.1',
      action: { type: 'cdp', method: 'Runtime.evaluate' },
    },
  });
  assert.equal(raw.isError, true, 'raw CDP action must be rejected by the public schema');

  const opened = await client.callTool({
    name: 'browser.open',
    arguments: { profile_id: 'acceptance' },
  });
  assert.equal(opened.isError === true, false);
  assert.equal(JSON.stringify(opened.structuredContent).includes('ownerId'), false);
  assert.equal(JSON.stringify(opened.structuredContent).includes('sessionId'), false);
  assert.equal((opened.structuredContent as { pid?: number } | undefined)?.pid, 1234);
});
