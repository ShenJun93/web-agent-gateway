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

  const runtime = await startRepositoryEngineeringRuntime(config);
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
