import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { DesktopMcpContext, DesktopMcpEffect } from '../src/desktop-harness/desktop-mcp-runtime.js';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import { createGatewayMcpServer, type GatewayApi } from '../src/server.js';
import { projectedTools } from '../scripts/prepare-direct-mcp-tunnel.js';

const DESKTOP_TOOLS = [
  'desktop.open',
  'desktop.describe',
  'desktop.snapshot',
  'desktop.exec',
  'desktop.effect.get',
  'desktop.screenshot',
  'desktop.close',
] as const;

function config(withBrowser = true): PrivateGatewayConfig {
  const root = process.cwd();
  return {
    allowedRoots: [root],
    devspace: { baseUrl: 'http://127.0.0.1:7676', resourceUrl: 'http://127.0.0.1:7676/mcp' },
    verifyProfiles: { unit: { argv: ['node', '--version'] } },
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath: join(root, '.wag-desktop-mcp-test.sqlite'),
        ownerId: 'local.private.stdio',
      },
      gitCommit: {},
      desktop: { enabled: true },
      ...(withBrowser ? {
        browser: {
          edgeExecutablePath: join(root, 'fake-msedge.exe'),
          profileRoot: join(root, '.wag-browser-profiles'),
        },
      } : {}),
    },
  };
}

test('desktop opt-in projects exactly seven semantic DesktopPort tools and composes with BrowserPort', async () => {
  const desktopOnly = await projectedTools(config(false));
  assert.equal(desktopOnly.missing.length, 0);
  assert.equal(desktopOnly.tools.length, 50);
  for (const name of DESKTOP_TOOLS) assert.ok(desktopOnly.tools.includes(name), name);

  const full = await projectedTools(config(true));
  assert.equal(full.missing.length, 0);
  assert.equal(full.tools.length, 57);
  for (const name of DESKTOP_TOOLS) assert.ok(full.tools.includes(name), name);
  assert.equal(full.tools.some((name) => name.includes('uia') || name.includes('sendinput')), false);
});

test('desktop MCP schema exposes exact-once semantic actions and rejects raw coordinate input', async (t) => {
  const calls: unknown[][] = [];
  const effect: DesktopMcpEffect = {
    effectId: 'effect_00000000-0000-4000-8000-000000000031',
    kind: 'desktop.invoke',
    resourceId: 'desktop_00000000-0000-4000-8000-000000000032',
    planFingerprint: 'effectfp_desktop',
    state: 'SUCCEEDED',
    createdAt: 1,
    updatedAt: 2,
    attemptId: 'attempt_00000000-0000-4000-8000-000000000033',
    resultDigest: 'sha256_desktop',
  };
  const desktopContext: DesktopMcpContext = {
    async open(workspaceId, processId) {
      calls.push(['open', workspaceId, processId]);
      return {
        desktopSessionId: 'desktop_00000000-0000-4000-8000-000000000032',
        processId,
        pid: 123,
        executablePath: 'C:\\fixture.exe',
        nativeWindowId: 'hwnd:1',
        title: 'Fixture',
        createdAt: 1,
        lastSeenAt: 1,
        state: 'ACTIVE',
      };
    },
    async describe() { throw new Error('unused'); },
    async snapshot() { throw new Error('unused'); },
    async exec(sessionId, key, action) {
      calls.push(['exec', sessionId, key, action]);
      return effect;
    },
    async effect() { return effect; },
    async screenshot() { return { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }; },
    async close(sessionId) {
      return {
        desktopSessionId: sessionId,
        processId: 'proc_00000000-0000-4000-8000-000000000035',
        pid: 123,
        executablePath: 'C:\\fixture.exe',
        nativeWindowId: 'hwnd:1',
        title: 'Fixture',
        createdAt: 1,
        lastSeenAt: 2,
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
  const server = createGatewayMcpServer(gateway, { desktopContext });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'desktop-mcp-test', version: '1' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });

  const tools = (await client.listTools()).tools;
  for (const name of DESKTOP_TOOLS) assert.ok(tools.some((tool) => tool.name === name), name);

  const sessionId = 'desktop_00000000-0000-4000-8000-000000000032';
  const ref = 'desktop_node_00000000-0000-4000-8000-000000000034_0';
  const executed = await client.callTool({
    name: 'desktop.exec',
    arguments: {
      desktop_session_id: sessionId,
      idempotency_key: 'desktop.invoke.1',
      action: { type: 'invoke', ref },
    },
  });
  assert.equal(executed.isError === true, false);
  assert.deepEqual(calls.at(-1), ['exec', sessionId, 'desktop.invoke.1', { type: 'invoke', ref }]);

  const raw = await client.callTool({
    name: 'desktop.exec',
    arguments: {
      desktop_session_id: sessionId,
      idempotency_key: 'desktop.raw.1',
      action: { type: 'click', x: 10, y: 20 },
    },
  });
  assert.equal(raw.isError, true, 'raw screen-coordinate action must be rejected');

  const external = await client.callTool({
    name: 'desktop.open',
    arguments: {
      workspace_id: 'ws_00000000-0000-4000-8000-000000000036',
      process_id: 'obs_00000000-0000-4000-8000-000000000037',
    },
  });
  assert.equal(external.isError, true, 'desktop.open must require a WAG-owned proc_ handle');
});
