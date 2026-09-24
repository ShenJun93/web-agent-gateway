import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import type { ProcessHandle, ProcessPort } from '../src/process-harness/process-port.js';
import { createOwnedEdgeLauncher } from '../src/browser-harness/owned-edge-launcher.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_edge', sessionId: 'session_edge', adapterId: 'private.stdio.v1' };
const profile = {
  profileId: 'notebook99',
  owner: OWNER,
  userDataDir: 'E:\\AI-BROWSER\\profiles\\notebook99',
};

function handle(processId: string): ProcessHandle {
  return {
    processId,
    owner: OWNER,
    pid: 5151,
    state: 'RUNNING',
    createdAt: 1,
    updatedAt: 1,
  };
}

function fakeProcessPort() {
  const starts: Array<{ argv: readonly string[]; cwd?: string }> = [];
  const stops: string[] = [];
  const port: ProcessPort = {
    async start(_owner, spec) { starts.push(spec); return handle('process_00000000-0000-4000-8000-000000000021'); },
    async describe() { return handle('process_00000000-0000-4000-8000-000000000021'); },
    async list() { return []; },
    async read() { throw new Error('not used'); },
    async write() { throw new Error('not used'); },
    async closeStdin() { throw new Error('not used'); },
    async wait() { throw new Error('not used'); },
    async stop(_owner, processId) {
      stops.push(processId);
      return { ...handle(processId), state: 'STOPPED' };
    },
  };
  return { port, starts, stops };
}

test('owned Edge launcher starts the exact launch plan and waits for loopback CDP readiness', async () => {
  const f = fakeProcessPort();
  const probes: Array<{ endpoint: string; timeout: number }> = [];
  const launcher = createOwnedEdgeLauncher({
    processPort: f.port,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    allocateDebugPort: async () => 9333,
    initialUrl: 'https://notebooklm.google.com/',
    waitUntilReady: async (endpoint, timeout) => { probes.push({ endpoint, timeout }); },
  });
  const launched = await launcher.launch(OWNER, profile);
  assert.equal(launched.plan.endpointUrl, 'http://127.0.0.1:9333');
  assert.deepEqual(f.starts, [{
    argv: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      '--user-data-dir=E:\\AI-BROWSER\\profiles\\notebook99',
      '--remote-debugging-port=9333',
      '--no-first-run',
      '--no-default-browser-check',
      'https://notebooklm.google.com/',
    ],
    cwd: 'E:\\AI-BROWSER\\profiles\\notebook99',
  }]);
  assert.deepEqual(probes, [{ endpoint: 'http://127.0.0.1:9333', timeout: 15000 }]);
  assert.deepEqual(f.stops, []);
});

test('owned Edge launcher reaps the exact process when CDP readiness fails', async () => {
  const f = fakeProcessPort();
  const launcher = createOwnedEdgeLauncher({
    processPort: f.port,
    executablePath: 'C:\\Edge\\msedge.exe',
    allocateDebugPort: async () => 9444,
    waitUntilReady: async () => { throw new Error('CDP readiness timeout'); },
  });
  await assert.rejects(() => launcher.launch(OWNER, profile), /CDP readiness timeout/);
  assert.deepEqual(f.stops, ['process_00000000-0000-4000-8000-000000000021']);
});
