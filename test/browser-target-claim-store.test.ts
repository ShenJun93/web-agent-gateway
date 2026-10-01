import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { GatewayAuthority } from '../src/caller-context.js';
import {
  BrowserTargetClaimError,
  BrowserTargetClaimStore,
} from '../src/browser-harness/browser-target-claim-store.js';

const A: GatewayAuthority = {
  ownerId: 'owner',
  sessionId: 'session_a',
  adapterId: 'private.stdio.v1',
};
const B: GatewayAuthority = {
  ownerId: 'owner',
  sessionId: 'session_b',
  adapterId: 'private.stdio.v1',
};
const A_BROWSER = 'browser_00000000-0000-4000-8000-000000000001';
const B_BROWSER = 'browser_00000000-0000-4000-8000-000000000002';
const B_BROWSER_2 = 'browser_00000000-0000-4000-8000-000000000003';

async function stores(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-target-claims-'));
  const path = join(root, 'claims.sqlite');
  let now = 10_000;
  const clock = () => now;
  const first = new BrowserTargetClaimStore(path, { now: clock, leaseMs: 5_000 });
  const second = new BrowserTargetClaimStore(path, { now: clock, leaseMs: 5_000 });
  t.after(async () => {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    path,
    first,
    second,
    now: () => now,
    advance(ms: number) { now += ms; },
  };
}

test('different sessions can own different targets while one target rejects conflicting ownership', async (t) => {
  const f = await stores(t);

  const tabA = f.first.claim(A, 'tab_11', A_BROWSER);
  const tabB = f.second.claim(B, 'tab_12', B_BROWSER);

  assert.equal(tabA.claimEpoch, 1);
  assert.equal(tabB.claimEpoch, 1);
  assert.equal(tabA.owner.sessionId, A.sessionId);
  assert.equal(tabB.owner.sessionId, B.sessionId);

  assert.throws(
    () => f.second.claim(B, 'tab_11', B_BROWSER),
    (error: unknown) => error instanceof BrowserTargetClaimError
      && error.code === 'TARGET_OWNED_BY_OTHER_SESSION',
  );

  assert.equal(
    f.first.assertCurrent(A, 'tab_11', A_BROWSER, tabA.claimEpoch).claimEpoch,
    1,
  );
  assert.equal(
    f.second.assertCurrent(B, 'tab_12', B_BROWSER, tabB.claimEpoch).claimEpoch,
    1,
  );
});

test('expired target can be reclaimed at a higher epoch and stale owner is fenced', async (t) => {
  const f = await stores(t);
  const original = f.first.claim(A, 'tab_21', A_BROWSER);
  assert.equal(original.claimEpoch, 1);

  f.advance(5_001);

  assert.throws(
    () => f.first.assertCurrent(A, 'tab_21', A_BROWSER, original.claimEpoch),
    (error: unknown) => error instanceof BrowserTargetClaimError
      && error.code === 'TARGET_STALE',
  );

  const successor = f.second.claim(B, 'tab_21', B_BROWSER);
  assert.equal(successor.claimEpoch, 2);
  assert.equal(successor.owner.sessionId, B.sessionId);

  assert.throws(
    () => f.first.assertCurrent(A, 'tab_21', A_BROWSER, original.claimEpoch),
    (error: unknown) => error instanceof BrowserTargetClaimError
      && error.code === 'TARGET_FENCED',
  );
  assert.throws(
    () => f.first.release(A, 'tab_21', A_BROWSER, original.claimEpoch),
    (error: unknown) => error instanceof BrowserTargetClaimError
      && error.code === 'TARGET_FENCED',
  );

  const renewed = f.second.heartbeat(B, 'tab_21', B_BROWSER, successor.claimEpoch);
  assert.equal(renewed.claimEpoch, 2);
  assert.equal(renewed.expiresAt, f.now() + 5_000);
});

test('release never resets epoch and a successor claim remains monotonic across reopen', async (t) => {
  const f = await stores(t);
  const firstClaim = f.first.claim(A, 'tab_31', A_BROWSER);
  const released = f.first.release(A, 'tab_31', A_BROWSER, firstClaim.claimEpoch);
  assert.equal(released.state, 'RELEASED');
  assert.equal(released.claimEpoch, 1);

  const next = f.second.claim(B, 'tab_31', B_BROWSER);
  assert.equal(next.claimEpoch, 2);
  f.second.release(B, 'tab_31', B_BROWSER, next.claimEpoch);

  const reopened = new BrowserTargetClaimStore(f.path, {
    now: f.now,
    leaseMs: 5_000,
  });
  try {
    const third = reopened.claim(A, 'tab_31', B_BROWSER_2);
    assert.equal(third.claimEpoch, 3);
    assert.equal(third.owner.sessionId, A.sessionId);
  } finally {
    reopened.close();
  }
});

test('same exact claimant heartbeat keeps epoch stable instead of creating a successor', async (t) => {
  const f = await stores(t);
  const first = f.first.claim(A, 'tab_41', A_BROWSER);
  f.advance(1_000);
  const renewed = f.second.claim(A, 'tab_41', A_BROWSER);

  assert.equal(renewed.claimEpoch, first.claimEpoch);
  assert.equal(renewed.claimedAt, first.claimedAt);
  assert.equal(renewed.heartbeatAt, f.now());
  assert.equal(renewed.expiresAt, f.now() + 5_000);
});
