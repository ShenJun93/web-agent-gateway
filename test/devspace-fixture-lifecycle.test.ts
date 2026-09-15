import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVSPACE_DEFAULT_STARTUP_TIMEOUT_MS, startPinnedDevspace } from './devspace-fixture.js';

test('DevSpace fixture default startup timeout tolerates slow pinned startup', () => {
  assert.equal(DEVSPACE_DEFAULT_STARTUP_TIMEOUT_MS, 30_000);
});

test('DevSpace fixture cleans up the child when readiness times out', async (t) => {
  let spawnedPid: number | undefined;
  let resolvedFixture: Awaited<ReturnType<typeof startPinnedDevspace>> | undefined;
  let failure: unknown;

  try {
    resolvedFixture = await startPinnedDevspace({
      startupTimeoutMs: 0,
      onSpawn: (pid: number) => { spawnedPid = pid; },
    });
  } catch (error) {
    failure = error;
  }
  if (resolvedFixture) t.after(() => resolvedFixture?.stop());

  assert.equal(resolvedFixture, undefined, 'forced readiness timeout must reject');
  assert.match(String(failure), /Timed out waiting for DevSpace/);
  assert.ok(spawnedPid, 'test must observe the spawned DevSpace pid');
  assert.equal(await waitUntilProcessGone(spawnedPid), true, 'failed startup must not leak DevSpace');
});

async function waitUntilProcessGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
