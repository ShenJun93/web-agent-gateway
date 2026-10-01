import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayAuthority } from '../src/caller-context.js';
import {
  BrowserBrokerError,
  createBrowserBroker,
} from '../src/browser-harness/browser-broker.js';
import type {
  BrowserExecutionMode,
  BrowserPort,
  BrowserSessionHandle,
} from '../src/browser-harness/browser-port.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_broker',
  sessionId: 'session_broker',
  adapterId: 'private.stdio.v1',
};

function portFixture(mode: BrowserExecutionMode, suffix: string) {
  const calls: string[] = [];
  const handles = new Map<string, BrowserSessionHandle>();
  let counter = 0;
  const port: BrowserPort = {
    async open(request) {
      counter += 1;
      calls.push('open:' + String(request.mode));
      const browserSessionId = `browser_00000000-0000-4000-8000-0000000000${suffix}${counter}`;
      const handle: BrowserSessionHandle = {
        browserSessionId,
        profileId: request.profileId,
        owner: request.owner,
        backend: 'cdp',
        executionMode: mode,
        ownershipMode: mode === 'ATTACH_EXISTING' ? 'ATTACHED_EXISTING' : 'WAG_OWNED',
        controlState: 'RUNNING',
        createdAt: 1,
        lastSeenAt: 1,
        state: 'ACTIVE',
      };
      handles.set(browserSessionId, handle);
      return handle;
    },
    async describe(_owner, id) {
      calls.push('describe');
      return handles.get(id)!;
    },
    async snapshot(_owner, id) {
      calls.push('snapshot');
      return {
        browserSessionId: id,
        url: 'https://example.test/',
        title: mode,
        targetId: 'target_' + suffix,
        observedAt: 1,
      };
    },
    async exec() { calls.push('exec'); return { ok: true }; },
    async screenshot() {
      calls.push('screenshot');
      return { mimeType: 'image/png', dataBase64: 'cG5n' };
    },
    async close(_owner, id) {
      calls.push('close');
      return { ...handles.get(id)!, state: 'CLOSED', controlState: 'STOPPED' };
    },
  };
  return { port, calls };
}

test('BrowserBroker AUTO preserves current headless default and explicit visible routes separately', async () => {
  const headless = portFixture('WAG_HEADLESS', '1');
  const visible = portFixture('WAG_VISIBLE', '2');
  const broker = createBrowserBroker({ headless: headless.port, visible: visible.port });

  const automatic = await broker.open({ profileId: 'auto', owner: OWNER, mode: 'AUTO' });
  assert.equal(automatic.executionMode, 'WAG_HEADLESS');
  assert.equal(automatic.ownershipMode, 'WAG_OWNED');
  assert.equal(automatic.controlState, 'RUNNING');

  const observed = await broker.open({ profileId: 'visible', owner: OWNER, mode: 'WAG_VISIBLE' });
  assert.equal(observed.executionMode, 'WAG_VISIBLE');
  assert.deepEqual(headless.calls, ['open:WAG_HEADLESS']);
  assert.deepEqual(visible.calls, ['open:WAG_VISIBLE']);
});

test('BrowserBroker keeps one logical session routed despite mode-specific transports', async () => {
  const headless = portFixture('WAG_HEADLESS', '3');
  const visible = portFixture('WAG_VISIBLE', '4');
  const broker = createBrowserBroker({ headless: headless.port, visible: visible.port });
  const opened = await broker.open({ profileId: 'visible', owner: OWNER, mode: 'WAG_VISIBLE' });

  assert.equal((await broker.snapshot(OWNER, opened.browserSessionId)).browserSessionId, opened.browserSessionId);
  assert.deepEqual(await broker.exec(OWNER, opened.browserSessionId, { method: 'Page.navigate' }), { ok: true });
  assert.deepEqual(await broker.screenshot(OWNER, opened.browserSessionId), {
    mimeType: 'image/png',
    dataBase64: 'cG5n',
  });
  assert.equal((await broker.close(OWNER, opened.browserSessionId)).browserSessionId, opened.browserSessionId);
});

test('visible Pause -> Take Control blocks effects until Resume revalidates target', async () => {
  const headless = portFixture('WAG_HEADLESS', '5');
  const visible = portFixture('WAG_VISIBLE', '6');
  const broker = createBrowserBroker({ headless: headless.port, visible: visible.port });
  const opened = await broker.open({ profileId: 'takeover', owner: OWNER, mode: 'WAG_VISIBLE' });

  assert.equal((await broker.pauseForUser(OWNER, opened.browserSessionId)).controlState, 'PAUSED_FOR_USER');
  await assert.rejects(
    () => broker.exec(OWNER, opened.browserSessionId, { method: 'Runtime.evaluate' }),
    (error: unknown) => error instanceof BrowserBrokerError && error.code === 'BROWSER_AUTOMATION_PAUSED',
  );
  assert.equal((await broker.takeUserControl(OWNER, opened.browserSessionId)).controlState, 'USER_CONTROL');
  assert.equal((await broker.resumeAutomation(OWNER, opened.browserSessionId)).controlState, 'RUNNING');
  assert.equal(visible.calls.filter((row) => row === 'snapshot').length, 1, 'resume must revalidate target');
  assert.deepEqual(await broker.exec(OWNER, opened.browserSessionId, { method: 'Runtime.evaluate' }), { ok: true });
});

test('takeover is rejected for headless and ATTACH_EXISTING fails closed until runtime bridge lands', async () => {
  const headless = portFixture('WAG_HEADLESS', '7');
  const visible = portFixture('WAG_VISIBLE', '8');
  const broker = createBrowserBroker({ headless: headless.port, visible: visible.port });
  const opened = await broker.open({ profileId: 'headless', owner: OWNER, mode: 'WAG_HEADLESS' });

  await assert.rejects(
    () => broker.pauseForUser(OWNER, opened.browserSessionId),
    (error: unknown) => error instanceof BrowserBrokerError && error.code === 'BROWSER_MODE_UNAVAILABLE',
  );
  await assert.rejects(
    () => broker.open({ profileId: 'existing', owner: OWNER, mode: 'ATTACH_EXISTING' }),
    (error: unknown) => error instanceof BrowserBrokerError
      && error.code === 'ATTACH_EXISTING_NOT_CONFIGURED',
  );
});
