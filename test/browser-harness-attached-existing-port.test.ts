import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayAuthority } from '../src/caller-context.js';
import { createAttachedExistingBrowserPort } from '../src/browser-harness/attached-existing-browser-port.js';
import type { ExistingBrowserControlClient } from '../src/browser-harness/existing-browser-control-client.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_attached',
  sessionId: 'session_attached',
  adapterId: 'private.stdio.v1',
};
const OTHER: GatewayAuthority = {
  ownerId: 'other',
  sessionId: 'other',
  adapterId: 'private.stdio.v1',
};

function fixture() {
  const calls: unknown[][] = [];
  let attached = false;
  const target = {
    targetId: 'tab_7', windowId: 'window_3', title: 'Existing',
    url: 'https://example.test/', origin: 'https://example.test',
    active: false, attachable: true, ownership: 'USER_EXISTING' as const,
  };
  const control: ExistingBrowserControlClient = {
    async listTargets() { return [{ ...target, attached }]; },
    async groupTarget(id, title) { calls.push(['group', id, title]); return { targetId: id, groupId: 'group_9', groupTitle: title, activeStable: true }; },
    async attach(id) { calls.push(['attach', id]); attached = true; return { ...target, attached }; },
    async describe(id) { calls.push(['describe', id]); return { ...target, attached }; },
    async exec(id, method, params) { calls.push(['exec', id, method, params]); return { ok: true }; },
    async screenshot(id) { calls.push(['screenshot', id]); return { mimeType: 'image/png', dataBase64: 'cG5n' }; },
    async release(id) { calls.push(['release', id]); const released = attached; attached = false; return { targetId: id, released }; },
  };
  return { control, calls, isAttached: () => attached };
}

test('attached existing BrowserPort binds exact target and release does not close browser', async () => {
  const f = fixture();
  const port = createAttachedExistingBrowserPort({
    control: f.control,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    now: (() => { let n = 1; return () => n++; })(),
  });
  const opened = await port.open({
    profileId: 'existing',
    owner: OWNER,
    mode: 'ATTACH_EXISTING',
    targetId: 'tab_7',
  });
  assert.equal(opened.executionMode, 'ATTACH_EXISTING');
  assert.equal(opened.ownershipMode, 'ATTACHED_EXISTING');
  assert.equal(f.isAttached(), true);

  const snap = await port.snapshot(OWNER, opened.browserSessionId);
  assert.equal(snap.targetId, 'tab_7');
  assert.equal(snap.url, 'https://example.test/');
  assert.deepEqual(await port.exec(OWNER, opened.browserSessionId, { method: 'DOM.focus', params: { backendNodeId: 1 } }), { ok: true });
  assert.equal((await port.screenshot(OWNER, opened.browserSessionId)).dataBase64, 'cG5n');

  await assert.rejects(() => port.snapshot(OTHER, opened.browserSessionId), /another authority/);
  const closed = await port.close(OWNER, opened.browserSessionId);
  assert.equal(closed.state, 'CLOSED');
  assert.equal(f.isAttached(), false);
  assert.deepEqual(f.calls.at(-1), ['release', 'tab_7']);
  assert.equal(f.calls.some((row) => row[0] === 'close-browser'), false);
});

test('attached existing BrowserPort rejects implicit or malformed target selection', async () => {
  const f = fixture();
  const port = createAttachedExistingBrowserPort({ control: f.control });
  await assert.rejects(
    () => port.open({ profileId: 'existing', owner: OWNER, mode: 'ATTACH_EXISTING' }),
    /exact target id/,
  );
  await assert.rejects(
    () => port.open({ profileId: 'existing', owner: OWNER, mode: 'ATTACH_EXISTING', targetId: '7' }),
    /exact target id/,
  );
});

test('AI_TAB_GROUP groups before attach, preserves group metadata, and still only detaches on close', async () => {
  const f = fixture();
  const port = createAttachedExistingBrowserPort({
    control: f.control,
    randomUUID: () => '00000000-0000-4000-8000-000000000002',
  });

  const opened = await port.open({
    profileId: 'acceptance',
    owner: OWNER,
    mode: 'AI_TAB_GROUP',
    targetId: 'tab_7',
    groupTitle: 'WAG • Acceptance',
  });

  assert.equal(opened.executionMode, 'AI_TAB_GROUP');
  assert.equal(opened.groupId, 'group_9');
  assert.equal(opened.groupTitle, 'WAG • Acceptance');
  assert.deepEqual(f.calls.slice(0, 2), [
    ['group', 'tab_7', 'WAG • Acceptance'],
    ['attach', 'tab_7'],
  ]);

  await port.close(OWNER, opened.browserSessionId);
  assert.deepEqual(f.calls.at(-1), ['release', 'tab_7']);
  assert.equal(f.calls.some((row) => row[0] === 'close-browser'), false);
});

test('AI_TAB_GROUP fails closed if grouping changes the user active tab', async () => {
  const f = fixture();
  f.control.groupTarget = async (id, title) => ({
    targetId: id,
    groupId: 'group_9',
    groupTitle: title,
    activeStable: false,
  });
  const port = createAttachedExistingBrowserPort({ control: f.control });

  await assert.rejects(
    () => port.open({
      profileId: 'acceptance',
      owner: OWNER,
      mode: 'AI_TAB_GROUP',
      targetId: 'tab_7',
      groupTitle: 'WAG • Acceptance',
    }),
    /changed the active browser tab/,
  );
  assert.equal(f.isAttached(), false);
});
