import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayAuthority } from '../src/caller-context.js';
import { createAttachedExistingBrowserPort } from '../src/browser-harness/attached-existing-browser-port.js';
import type { ExistingBrowserControlClient } from '../src/browser-harness/existing-browser-control-client.js';
import type {
  BrowserTargetClaim,
  BrowserTargetClaimPort,
} from '../src/browser-harness/browser-target-claim-store.js';

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
  const claimCalls: unknown[][] = [];
  let attached = false;
  let claimState: BrowserTargetClaim['state'] = 'ACTIVE';
  const target = {
    targetId: 'tab_7', windowId: 'window_3', title: 'Existing',
    url: 'https://example.test/', origin: 'https://example.test',
    active: false, attachable: true, ownership: 'USER_EXISTING' as const,
  };
  const control: ExistingBrowserControlClient = {
    async watchContinuity(id) { calls.push(['watch', id]); return { targetId: id, baselineSequence: 0 }; },
    async resolveContinuity(rootId, currentId) { calls.push(['continuity', rootId, currentId]); return { sequence: 0, reason: 'NO_CHANGE', target: null }; },
    async listTargets() { return [{ ...target, attached }]; },
    async groupTarget(id, title) { calls.push(['group', id, title]); return { targetId: id, groupId: 'group_9', groupTitle: title, activeStable: true }; },
    async attach(id) { calls.push(['attach', id]); attached = true; return { ...target, attached }; },
    async describe(id) { calls.push(['describe', id]); return { ...target, attached }; },
    async exec(id, method, params) { calls.push(['exec', id, method, params]); return { ok: true }; },
    async screenshot(id) { calls.push(['screenshot', id]); return { mimeType: 'image/png', dataBase64: 'cG5n' }; },
    async release(id) { calls.push(['release', id]); const released = attached; attached = false; return { targetId: id, released }; },
  };
  const claim = (
    owner: GatewayAuthority,
    targetId: string,
    browserSessionId: string,
    state = claimState,
  ): BrowserTargetClaim => Object.freeze({
    targetId,
    owner: Object.freeze({ ...owner }),
    browserSessionId,
    claimEpoch: 1,
    claimedAt: 1,
    heartbeatAt: 2,
    expiresAt: 60_000,
    state,
  });
  const claims: BrowserTargetClaimPort = {
    claim(owner, targetId, browserSessionId) {
      claimState = 'ACTIVE';
      claimCalls.push(['claim', targetId, browserSessionId]);
      return claim(owner, targetId, browserSessionId);
    },
    recover(owner, targetId, browserSessionId, priorClaimEpoch) {
      claimCalls.push(['recover', targetId, browserSessionId, priorClaimEpoch]);
      return Object.freeze({
        ...claim(owner, targetId, browserSessionId),
        claimEpoch: priorClaimEpoch + 1,
      });
    },
    recoverMany(owner, browserSessionId, priorClaims) {
      claimCalls.push(['recoverMany', browserSessionId, [...priorClaims]]);
      return new Map([...priorClaims].map(([targetId, priorClaimEpoch]) => [
        targetId,
        Object.freeze({
          ...claim(owner, targetId, browserSessionId),
          claimEpoch: priorClaimEpoch + 1,
        }),
      ]));
    },
    heartbeat(owner, targetId, browserSessionId, claimEpoch) {
      claimCalls.push(['heartbeat', targetId, browserSessionId, claimEpoch]);
      return claim(owner, targetId, browserSessionId);
    },
    assertCurrent(owner, targetId, browserSessionId, claimEpoch) {
      claimCalls.push(['assert', targetId, browserSessionId, claimEpoch]);
      return claim(owner, targetId, browserSessionId);
    },
    release(owner, targetId, browserSessionId, claimEpoch) {
      claimState = 'RELEASED';
      claimCalls.push(['release', targetId, browserSessionId, claimEpoch]);
      return claim(owner, targetId, browserSessionId, 'RELEASED');
    },
    releaseMany(owner, browserSessionId, claimSet) {
      claimState = 'RELEASED';
      claimCalls.push(['releaseMany', browserSessionId, [...claimSet]]);
      return new Map([...claimSet].map(([targetId]) => [
        targetId,
        claim(owner, targetId, browserSessionId, 'RELEASED'),
      ]));
    },
  };
  return { control, claims, calls, claimCalls, isAttached: () => attached };
}

test('attached existing BrowserPort binds exact target and release does not close browser', async () => {
  const f = fixture();
  const port = createAttachedExistingBrowserPort({
    control: f.control,
    claims: f.claims,
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
  const port = createAttachedExistingBrowserPort({ control: f.control, claims: f.claims });
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
    claims: f.claims,
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
  const port = createAttachedExistingBrowserPort({ control: f.control, claims: f.claims });

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

test('AI_TAB_GROUP follows an OAuth successor while keeping one logical browser session', async () => {
  const f = fixture();
  let successor = false;
  const attached = new Set<string>();

  const target = (id: string) => ({
    targetId: id,
    windowId: id === 'tab_7' ? 'window_3' : 'window_4',
    title: id === 'tab_7' ? 'App' : 'OAuth successor',
    url: id === 'tab_7' ? 'https://app.example.test/' : 'https://auth.example.test/callback',
    origin: id === 'tab_7' ? 'https://app.example.test' : 'https://auth.example.test',
    active: false,
    attachable: true,
    ownership: 'USER_EXISTING' as const,
    attached: attached.has(id),
  });

  f.control.watchContinuity = async (id) => {
    f.calls.push(['watch', id]);
    return { targetId: id, baselineSequence: 0 };
  };
  f.control.resolveContinuity = async (rootId, currentId) => {
    f.calls.push(['continuity', rootId, currentId]);
    return successor
      ? { sequence: 1, reason: 'SUCCESSOR', target: target('tab_8') }
      : { sequence: 0, reason: 'NO_CHANGE', target: null };
  };
  f.control.groupTarget = async (id, title) => {
    f.calls.push(['group', id, title]);
    return {
      targetId: id,
      groupId: id === 'tab_7' ? 'group_9' : 'group_10',
      groupTitle: title,
      activeStable: true,
    };
  };
  f.control.attach = async (id) => {
    f.calls.push(['attach', id]);
    attached.add(id);
    return target(id);
  };
  f.control.describe = async (id) => {
    f.calls.push(['describe', id]);
    return target(id);
  };
  f.control.exec = async (id, method, params) => {
    f.calls.push(['exec', id, method, params]);
    return { ok: true };
  };
  f.control.release = async (id) => {
    f.calls.push(['release', id]);
    const released = attached.delete(id);
    return { targetId: id, released };
  };

  const port = createAttachedExistingBrowserPort({
    control: f.control,
    claims: f.claims,
    randomUUID: () => '00000000-0000-4000-8000-000000000003',
  });

  const opened = await port.open({
    profileId: 'oauth',
    owner: OWNER,
    mode: 'AI_TAB_GROUP',
    targetId: 'tab_7',
    groupTitle: 'WAG • OAuth',
  });
  assert.equal(opened.targetId, 'tab_7');
  assert.equal(opened.targetGeneration, 0);
  successor = true;

  const snap = await port.snapshot(OWNER, opened.browserSessionId);
  assert.equal(snap.browserSessionId, opened.browserSessionId);
  assert.equal(snap.targetId, 'tab_8');

  const after = await port.describe(OWNER, opened.browserSessionId);
  assert.equal(after.browserSessionId, opened.browserSessionId);
  assert.equal(after.rootTargetId, 'tab_7');
  assert.equal(after.targetId, 'tab_8');
  assert.equal(after.targetGeneration, 1);
  assert.equal(after.groupTitle, 'WAG • OAuth');

  assert.equal(
    f.calls.some((row) => row[0] === 'group' && row[1] === 'tab_8'),
    true,
    'OAuth successor should join the visible AI tab group',
  );
  assert.equal(
    f.calls.some((row) => row[0] === 'release' && row[1] === 'tab_7'),
    true,
    'previous debugger target should detach after successor attach succeeds',
  );

  await port.exec(OWNER, opened.browserSessionId, {
    method: 'DOM.focus',
    params: { backendNodeId: 2 },
  });
  assert.equal(
    f.calls.some((row) => row[0] === 'exec' && row[1] === 'tab_8'),
    true,
    'post-OAuth effects must target the successor',
  );

  await port.close(OWNER, opened.browserSessionId);
  assert.equal(attached.size, 0);
  const released = f.claimCalls.find((row) => row[0] === 'releaseMany');
  assert.ok(released, 'close must release retained OAuth claims atomically');
  const releasedClaims = (released?.[2] as Array<[string, number]>).map(([targetId]) => targetId);
  assert.deepEqual(new Set(releasedClaims), new Set(['tab_7', 'tab_8']));
  port.shutdown();
});


test('attached close keeps claims retryable when debugger detach times out', async () => {
  const f = fixture();
  const originalRelease = f.control.release.bind(f.control);
  let releaseAttempts = 0;
  f.control.release = async (targetId) => {
    releaseAttempts += 1;
    if (releaseAttempts === 1) throw new Error('Browser control request timed out');
    return originalRelease(targetId);
  };

  const port = createAttachedExistingBrowserPort({
    control: f.control,
    claims: f.claims,
    randomUUID: () => '00000000-0000-4000-8000-000000000091',
    now: (() => { let n = 1; return () => n++; })(),
  });
  const opened = await port.open({
    profileId: 'detach-retry',
    owner: OWNER,
    mode: 'ATTACH_EXISTING',
    targetId: 'tab_7',
  });

  await assert.rejects(
    () => port.close(OWNER, opened.browserSessionId),
    /timed out/i,
  );
  assert.equal(f.isAttached(), true, 'unknown detach outcome must not release ownership claims');
  assert.equal(f.claimCalls.some((row) => row[0] === 'releaseMany'), false);

  const closed = await port.close(OWNER, opened.browserSessionId);
  assert.equal(closed.state, 'CLOSED');
  assert.equal(f.isAttached(), false);
  assert.equal(releaseAttempts, 2);
  assert.equal(f.claimCalls.filter((row) => row[0] === 'releaseMany').length, 1);
  port.shutdown();
});

test('attached close retries atomic claim cleanup after debugger detach succeeded', async () => {
  const f = fixture();
  const originalReleaseMany = f.claims.releaseMany.bind(f.claims);
  let claimReleaseAttempts = 0;
  f.claims.releaseMany = (owner, browserSessionId, claimSet) => {
    claimReleaseAttempts += 1;
    if (claimReleaseAttempts === 1) throw new Error('claim cleanup interrupted');
    return originalReleaseMany(owner, browserSessionId, claimSet);
  };

  const port = createAttachedExistingBrowserPort({
    control: f.control,
    claims: f.claims,
    randomUUID: () => '00000000-0000-4000-8000-000000000092',
    now: (() => { let n = 1; return () => n++; })(),
  });
  const opened = await port.open({
    profileId: 'claim-retry',
    owner: OWNER,
    mode: 'ATTACH_EXISTING',
    targetId: 'tab_7',
  });

  await assert.rejects(
    () => port.close(OWNER, opened.browserSessionId),
    /claim cleanup interrupted/i,
  );
  assert.equal(f.isAttached(), false, 'debugger detach may complete before claim cleanup retry');

  const closed = await port.close(OWNER, opened.browserSessionId);
  assert.equal(closed.state, 'CLOSED');
  assert.equal(claimReleaseAttempts, 2);
  assert.equal(f.isAttached(), false);
  port.shutdown();
});
