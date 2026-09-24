import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import type { CdpCommand, CdpTransport } from '../src/browser-harness/cdp-protocol.js';
import { createOwnedEdgeCdpBackend } from '../src/browser-harness/owned-edge-cdp-backend.js';
import type { OwnedEdgeLaunch, OwnedEdgeLauncher } from '../src/browser-harness/owned-edge-launcher.js';

const OWNER: GatewayAuthority = { ownerId: 'owner', sessionId: 'session', adapterId: 'private.stdio.v1' };
const profile = { profileId: 'notebook99', owner: OWNER, userDataDir: 'E:\\AI-BROWSER\\profiles\\notebook99' };

function launchFixture() {
  const stops: string[] = [];
  const launch: OwnedEdgeLaunch = {
    plan: {
      executablePath: 'C:\\Edge\\msedge.exe',
      argv: [],
      endpointUrl: 'http://127.0.0.1:9333',
      profileId: 'notebook99',
      userDataDir: profile.userDataDir,
      debugPort: 9333,
    },
    process: {
      processId: 'process_00000000-0000-4000-8000-000000000031',
      owner: OWNER,
      pid: 3131,
      state: 'RUNNING',
      createdAt: 1,
      updatedAt: 1,
    },
  };
  const launcher: OwnedEdgeLauncher = {
    async launch() { return launch; },
    async stop(_owner, item) {
      stops.push(item.process.processId);
      return { ...item.process, state: 'STOPPED' };
    },
  };
  return { launcher, launch, stops };
}

function cdpTransport(options: { failAttach?: boolean } = {}) {
  const commands: CdpCommand[] = [];
  let closed = false;
  const transport: CdpTransport = {
    async send(command) {
      commands.push(command);
      if (command.method === 'Target.getTargets') {
        return { id: command.id, result: { targetInfos: [{ targetId: 'page_1', type: 'page', url: 'about:blank', title: '' }] } };
      }
      if (command.method === 'Target.attachToTarget') {
        if (options.failAttach) return { id: command.id, error: { code: -1, message: 'attach failed' } };
        return { id: command.id, result: { sessionId: 'session_page_1' } };
      }
      if (command.method === 'Target.closeTarget') return { id: command.id, result: { success: true } };
      throw new Error(`unexpected CDP method ${command.method}`);
    },
    async close() { closed = true; },
  };
  return { transport, commands, closed: () => closed };
}

test('owned Edge CDP backend composes launch, attach and exact process cleanup', async () => {
  const f = launchFixture();
  const cdp = cdpTransport();
  const endpoints: string[] = [];
  const backend = createOwnedEdgeCdpBackend({
    launcher: f.launcher,
    connect: async (endpoint) => { endpoints.push(endpoint); return cdp.transport; },
  });
  const session = await backend.open(profile);
  assert.equal(session.targetId, 'page_1');
  assert.deepEqual(endpoints, ['http://127.0.0.1:9333']);
  await session.close();
  assert.equal(cdp.closed(), true);
  assert.deepEqual(f.stops, ['process_00000000-0000-4000-8000-000000000031']);
});

test('owned Edge CDP backend reaps the process when CDP attachment fails', async () => {
  const f = launchFixture();
  const cdp = cdpTransport({ failAttach: true });
  const backend = createOwnedEdgeCdpBackend({
    launcher: f.launcher,
    connect: async () => cdp.transport,
  });
  await assert.rejects(() => backend.open(profile), /attach failed/);
  assert.equal(cdp.closed(), true);
  assert.deepEqual(f.stops, ['process_00000000-0000-4000-8000-000000000031']);
});
