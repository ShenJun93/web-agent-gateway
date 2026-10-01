import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { GatewayAuthority } from '../src/caller-context.js';
import {
  BrowserAttachedSessionStore,
  type DurableAttachedBrowserSession,
} from '../src/browser-harness/browser-attached-session-store.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_recovery',
  sessionId: 'session_recovery',
  adapterId: 'private.stdio.v1',
};
const OTHER: GatewayAuthority = {
  ownerId: 'owner_recovery',
  sessionId: 'session_other',
  adapterId: 'private.stdio.v1',
};
const SESSION = 'browser_00000000-0000-4000-8000-000000000701';

function record(state: DurableAttachedBrowserSession['state'] = 'ACTIVE'): DurableAttachedBrowserSession {
  return {
    browserSessionId: SESSION,
    profileId: 'oauth',
    owner: OWNER,
    executionMode: 'AI_TAB_GROUP',
    controlState: 'RUNNING',
    rootTargetId: 'tab_7',
    targetId: 'tab_8',
    targetGeneration: 1,
    claimEpoch: 2,
    claimExpiresAt: 20_000,
    groupId: 'group_9',
    groupTitle: 'WAG • OAuth',
    claims: new Map([['tab_7', 1], ['tab_8', 2]]),
    groupedTargets: new Set(['tab_7', 'tab_8']),
    createdAt: 1_000,
    lastSeenAt: 2_000,
    state,
  };
}

test('attached session store preserves logical target, claim and group continuity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-attached-session-store-'));
  const store = new BrowserAttachedSessionStore(join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const saved = store.save(record());
  assert.equal(saved.browserSessionId, SESSION);
  assert.equal(saved.rootTargetId, 'tab_7');
  assert.equal(saved.targetId, 'tab_8');
  assert.equal(saved.targetGeneration, 1);
  assert.equal(saved.claims.get('tab_7'), 1);
  assert.equal(saved.claims.get('tab_8'), 2);
  assert.equal(saved.groupedTargets.has('tab_8'), true);

  const found = store.findRecoverable(OWNER, 'oauth', 'AI_TAB_GROUP', 'tab_7');
  assert.equal(found?.browserSessionId, SESSION);
  assert.equal(found?.state, 'ACTIVE');

  assert.throws(() => store.get(OTHER, SESSION), /another authority/);
});

test('recoverable state survives reopen and closed sessions are excluded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-attached-session-reopen-'));
  const path = join(root, 'sessions.sqlite');
  const first = new BrowserAttachedSessionStore(path);
  first.save(record());
  first.markRecoverable(OWNER, SESSION, 3_000);
  first.close();

  const second = new BrowserAttachedSessionStore(path);
  t.after(async () => {
    second.close();
    await rm(root, { recursive: true, force: true });
  });
  const recovered = second.required(OWNER, SESSION);
  assert.equal(recovered.state, 'RECOVERABLE');
  assert.equal(recovered.lastSeenAt, 3_000);
  assert.equal(
    second.findRecoverable(OWNER, 'oauth', 'AI_TAB_GROUP', 'tab_7')?.browserSessionId,
    SESSION,
  );

  second.markClosed(OWNER, SESSION, 'CLOSED', 4_000);
  assert.equal(second.required(OWNER, SESSION).state, 'CLOSED');
  assert.equal(second.findRecoverable(OWNER, 'oauth', 'AI_TAB_GROUP', 'tab_7'), undefined);
});
