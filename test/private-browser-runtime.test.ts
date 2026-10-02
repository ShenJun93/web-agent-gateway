import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import { startRepositoryEngineeringRuntime } from '../src/repository-engineering-runtime.js';

test('browser opt-in assembles a private BrowserPort context without allocating a browser', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-private-browser-runtime-'));
  const config: PrivateGatewayConfig = {
    allowedRoots: [root],
    devspace: {
      baseUrl: 'http://127.0.0.1:7676',
      resourceUrl: 'http://127.0.0.1:7676/mcp',
    },
    verifyProfiles: {},
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath: join(root, 'state.sqlite'),
        ownerId: 'local.private.stdio',
      },
      browser: {
        edgeExecutablePath: join(root, 'msedge.exe'),
        profileRoot: join(root, 'profiles'),
      },
    },
  };

  const runtime = await startRepositoryEngineeringRuntime(config, {
    startBrowserControlWebSocketServer: async () => ({
      endpoint: 'ws://127.0.0.1:0/browser-control',
      pairingToken: 'fixture-pairing-token',
      client: {} as never,
      connected: () => false,
      releaseState: () => ({
        schema: 'WAG_BROWSER_EXTENSION_RELEASE_STATE_V1' as const,
        connected: false,
        observedSourceHead: null,
        expectedSourceHead: null,
        match: null,
        reloadRequested: false,
        reloadAccepted: false,
        lastError: null,
        updatedAtUtc: new Date().toISOString(),
      }),
      close: async () => {},
    }),
  });
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(runtime.profile.browser, true);
  assert.ok(runtime.browserContext, 'browser config must assemble the private BrowserPort context');
  assert.equal(runtime.operator, undefined, 'assembly alone must not bind the operator review server');

  const listed = await import('node:fs/promises').then(({ readdir }) => readdir(root));
  assert.equal(listed.some((name) => name === 'profiles'), false,
    'dedicated browser profile storage must remain lazy until browser.open');
});

test('health self-probe keeps browser tool context but skips the single-owner control server', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-private-browser-probe-'));
  const config: PrivateGatewayConfig = {
    allowedRoots: [root],
    devspace: {
      baseUrl: 'http://127.0.0.1:7676',
      resourceUrl: 'http://127.0.0.1:7676/mcp',
    },
    verifyProfiles: {},
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath: join(root, 'state.sqlite'),
        ownerId: 'local.private.stdio',
      },
      browser: {
        edgeExecutablePath: join(root, 'msedge.exe'),
        profileRoot: join(root, 'profiles'),
      },
    },
  };

  let controlStarts = 0;
  const runtime = await startRepositoryEngineeringRuntime(config, {
    skipBrowserControlServer: true,
    startBrowserControlWebSocketServer: async () => {
      controlStarts += 1;
      throw new Error('health self-probe must not bind browser control');
    },
  });
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(controlStarts, 0);
  assert.ok(runtime.browserContext, 'browser MCP tools must remain present in health self-probe mode');
  assert.equal(runtime.browserReleaseContext, undefined,
    'health self-probe must not claim live extension release ownership');
});
