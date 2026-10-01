import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PrivateGatewayConfig } from '../src/private-config.js';
import { startRepositoryEngineeringRuntime } from '../src/repository-engineering-runtime.js';

test('desktop opt-in assembles private native DesktopPort without allocating a desktop target', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-private-desktop-runtime-'));
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
      desktop: { enabled: true },
    },
  };

  const runtime = await startRepositoryEngineeringRuntime(config);
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(runtime.profile.desktop, true);
  assert.ok(runtime.desktopContext, 'desktop config must assemble the private DesktopPort context');
  assert.equal(runtime.operator, undefined, 'assembly alone must not bind the operator review server');
});
