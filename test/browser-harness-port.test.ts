import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import { createBrowserPort, type BrowserBackend, type BrowserBackendSession } from '../src/browser-harness/browser-port.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_a', sessionId: 'session_a', adapterId: 'private.stdio.v1' };
const OTHER: GatewayAuthority = { ownerId: 'owner_a', sessionId: 'session_b', adapterId: 'private.stdio.v1' };

function backendFixture() {
  const calls: Array<{ profileId?: string; method?: string }> = [];
  let closed = false;
  const backendSession: BrowserBackendSession = {
    targetId: 'target_1',
    async describe() { return { url: 'https://example.test/', title: 'Example' }; },
    async exec(request) { calls.push({ method: request.method }); return { ok: true }; },
    async screenshot() { return { mimeType: 'image/png', dataBase64: 'cG5n' }; },
    async close() { closed = true; },
  };
  const backend: BrowserBackend = {
    async open(profileId) { calls.push({ profileId }); return backendSession; },
  };
  return { backend, calls, closed: () => closed };
}

test('browser port owns one profile and one session by exact authority tuple', async () => {
  const f = backendFixture();
  let tick = 1000;
  const port = createBrowserPort({
    backend: f.backend,
    now: () => tick++,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  });
  const opened = await port.open({ profileId: 'notebook99', owner: OWNER });
  assert.equal(opened.browserSessionId, 'browser_00000000-0000-4000-8000-000000000001');
  assert.equal(opened.profileId, 'notebook99');
  assert.equal(opened.state, 'ACTIVE');
  await assert.rejects(() => port.open({ profileId: 'notebook99', owner: OTHER }), /already owned/);
  await assert.rejects(() => port.describe(OTHER, opened.browserSessionId), /another authority/);
  assert.equal((await port.describe(OWNER, opened.browserSessionId)).state, 'ACTIVE');
});

test('browser port snapshots, executes and screenshots through the owned backend', async () => {
  const f = backendFixture();
  const port = createBrowserPort({
    backend: f.backend,
    randomUUID: () => '00000000-0000-4000-8000-000000000002',
  });
  const opened = await port.open({ profileId: 'p2', owner: OWNER });
  const snapshot = await port.snapshot(OWNER, opened.browserSessionId);
  assert.equal(snapshot.url, 'https://example.test/');
  assert.equal(snapshot.title, 'Example');
  assert.equal(snapshot.targetId, 'target_1');
  assert.deepEqual(await port.exec(OWNER, opened.browserSessionId, { method: 'Runtime.evaluate', params: { expression: '1+1' } }), { ok: true });
  assert.deepEqual(await port.screenshot(OWNER, opened.browserSessionId), { mimeType: 'image/png', dataBase64: 'cG5n' });
  assert.deepEqual(f.calls.map((call) => call.method).filter(Boolean), ['Runtime.evaluate']);
});

test('browser close releases the profile but never lets a foreign authority close it', async () => {
  const f = backendFixture();
  let n = 2;
  const port = createBrowserPort({
    backend: f.backend,
    randomUUID: () => `00000000-0000-4000-8000-00000000000${n++}`,
  });
  const opened = await port.open({ profileId: 'shared', owner: OWNER });
  await assert.rejects(() => port.close(OTHER, opened.browserSessionId), /another authority/);
  assert.equal(f.closed(), false);
  assert.equal((await port.close(OWNER, opened.browserSessionId)).state, 'CLOSED');
  assert.equal(f.closed(), true);
  const reopened = await port.open({ profileId: 'shared', owner: OTHER });
  assert.equal(reopened.state, 'ACTIVE');
});

test('browser exec accepts CDP-style domain methods only', async () => {
  const f = backendFixture();
  const port = createBrowserPort({
    backend: f.backend,
    randomUUID: () => '00000000-0000-4000-8000-000000000004',
  });
  const opened = await port.open({ profileId: 'p4', owner: OWNER });
  await assert.rejects(() => port.exec(OWNER, opened.browserSessionId, { method: 'powershell.exe -Command whoami' }), /method is invalid/);
  assert.deepEqual(f.calls, [{ profileId: 'p4' }]);
});
