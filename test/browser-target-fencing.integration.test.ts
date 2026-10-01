import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { GatewayAuthority } from '../src/caller-context.js';
import { createAttachedExistingBrowserPort } from '../src/browser-harness/attached-existing-browser-port.js';
import {
  BrowserTargetClaimError,
  BrowserTargetClaimStore,
} from '../src/browser-harness/browser-target-claim-store.js';
import type { ExistingBrowserControlClient } from '../src/browser-harness/existing-browser-control-client.js';

const A: GatewayAuthority = {
  ownerId: 'owner',
  sessionId: 'session_fence_a',
  adapterId: 'private.stdio.v1',
};
const B: GatewayAuthority = {
  ownerId: 'owner',
  sessionId: 'session_fence_b',
  adapterId: 'private.stdio.v1',
};

test('successor epoch fences stale exec and stale close before browser transport dispatch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-fencing-'));
  const path = join(root, 'claims.sqlite');
  let now = 50_000;
  const clock = () => now;

  const claimsA = new BrowserTargetClaimStore(path, { now: clock, leaseMs: 5_000 });
  const claimsB = new BrowserTargetClaimStore(path, { now: clock, leaseMs: 5_000 });
  const calls: unknown[][] = [];
  const attached = new Set<string>();

  const target = (id: string) => ({
    targetId: id,
    windowId: 'window_1',
    title: id,
    url: 'https://example.test/',
    origin: 'https://example.test',
    active: false,
    attachable: true,
    ownership: 'USER_EXISTING' as const,
    attached: attached.has(id),
  });

  const control: ExistingBrowserControlClient = {
    async watchContinuity(id) { calls.push(['watch', id]); return { targetId: id, baselineSequence: 0 }; },
    async resolveContinuity(rootId, currentId) { calls.push(['continuity', rootId, currentId]); return { sequence: 0, reason: 'NO_CHANGE', target: null }; },
    async listTargets() { return [target('tab_7'), target('tab_8')]; },
    async groupTarget(id, title) {
      calls.push(['group', id, title]);
      return { targetId: id, groupId: 'group_1', groupTitle: title, activeStable: true };
    },
    async attach(id) {
      calls.push(['attach', id]);
      attached.add(id);
      return target(id);
    },
    async describe(id) {
      calls.push(['describe', id]);
      return target(id);
    },
    async exec(id, method, params) {
      calls.push(['exec', id, method, params]);
      return { ok: true };
    },
    async screenshot(id) {
      calls.push(['screenshot', id]);
      return { mimeType: 'image/png', dataBase64: 'cG5n' };
    },
    async release(id) {
      calls.push(['release', id]);
      const released = attached.delete(id);
      return { targetId: id, released };
    },
  };

  const idsA = ['00000000-0000-4000-8000-000000000101'];
  const idsB = [
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000203',
  ];
  const portA = createAttachedExistingBrowserPort({
    control,
    claims: claimsA,
    now: clock,
    randomUUID: () => idsA.shift()!,
    heartbeatIntervalMs: 60_000,
  });
  const portB = createAttachedExistingBrowserPort({
    control,
    claims: claimsB,
    now: clock,
    randomUUID: () => idsB.shift()!,
    heartbeatIntervalMs: 60_000,
  });

  t.after(async () => {
    portA.shutdown();
    portB.shutdown();
    claimsA.close();
    claimsB.close();
    await rm(root, { recursive: true, force: true });
  });

  const a7 = await portA.open({
    profileId: 'a7',
    owner: A,
    mode: 'ATTACH_EXISTING',
    targetId: 'tab_7',
  });
  const b8 = await portB.open({
    profileId: 'b8',
    owner: B,
    mode: 'ATTACH_EXISTING',
    targetId: 'tab_8',
  });

  assert.equal(a7.claimEpoch, 1);
  assert.equal(b8.claimEpoch, 1);

  const tab7AttachCount = () => calls.filter(
    (row) => row[0] === 'attach' && row[1] === 'tab_7',
  ).length;

  const beforeConflict = tab7AttachCount();
  await assert.rejects(
    () => portB.open({
      profileId: 'conflict',
      owner: B,
      mode: 'ATTACH_EXISTING',
      targetId: 'tab_7',
    }),
    (error: unknown) => error instanceof BrowserTargetClaimError
      && error.code === 'TARGET_OWNED_BY_OTHER_SESSION',
  );
  assert.equal(tab7AttachCount(), beforeConflict,
    'conflicting claimant must be rejected before debugger attach');

  now += 4_000;
  await portB.describe(B, b8.browserSessionId);
  now += 1_001;
  const b7 = await portB.open({
    profileId: 'successor',
    owner: B,
    mode: 'ATTACH_EXISTING',
    targetId: 'tab_7',
  });
  assert.equal(b7.claimEpoch, 2);

  const execBefore = calls.filter((row) => row[0] === 'exec' && row[1] === 'tab_7').length;
  await assert.rejects(
    () => portA.exec(A, a7.browserSessionId, { method: 'DOM.focus', params: { backendNodeId: 1 } }),
    (error: unknown) => error instanceof BrowserTargetClaimError
      && error.code === 'TARGET_FENCED',
  );
  assert.equal(
    calls.filter((row) => row[0] === 'exec' && row[1] === 'tab_7').length,
    execBefore,
    'stale owner must be fenced before browser exec dispatch',
  );

  const releaseBefore = calls.filter((row) => row[0] === 'release' && row[1] === 'tab_7').length;
  await assert.rejects(
    () => portA.close(A, a7.browserSessionId),
    (error: unknown) => error instanceof BrowserTargetClaimError
      && error.code === 'TARGET_FENCED',
  );
  assert.equal(
    calls.filter((row) => row[0] === 'release' && row[1] === 'tab_7').length,
    releaseBefore,
    'stale owner must not detach successor target',
  );
  assert.equal(attached.has('tab_7'), true);

  assert.deepEqual(
    await portB.exec(B, b7.browserSessionId, {
      method: 'DOM.focus',
      params: { backendNodeId: 2 },
    }),
    { ok: true },
  );

  await portB.close(B, b7.browserSessionId);
  await portB.close(B, b8.browserSessionId);
  assert.equal(attached.has('tab_7'), false);
  assert.equal(attached.has('tab_8'), false);
});
