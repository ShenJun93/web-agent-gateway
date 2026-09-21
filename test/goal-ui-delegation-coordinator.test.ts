import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';
import { mintDispatchNonce, UiDelegationCoordinator } from '../src/goal-ui-delegation-coordinator.js';
import type { UiDelegationBindings } from '../src/goal-ui-delegation.js';

/**
 * The coordinator is where the pure policy meets durable state, so these tests are about the two
 * things a pure function cannot establish: that identities come from the connection rather than
 * from the message, and that a nonce is consumed rather than merely checked.
 */
const GOAL = 'goal_abc';
const CONTROLLER = 'claude.local.controller';
const CONNECTION = { sessionId: 'session_1', adapterId: 'browser.chatgpt.native.operator.v4' };

const BINDINGS: UiDelegationBindings = {
  goalId: GOAL,
  controllerId: CONTROLLER,
  allowedOrigins: ['https://chatgpt.com'],
  allowedTools: ['repo.search', 'file.read'],
  workspaceId: 'ws_1',
  sessionId: CONNECTION.sessionId,
  adapterId: CONNECTION.adapterId,
  maxActions: 3,
};

async function harness(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-uidel-'));
  const store = new SqliteDurableStore(join(dir, 'store.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  let clock = 1_000_000;
  let killSwitch = false;
  const coordinator = new UiDelegationCoordinator({
    store, now: () => clock, killSwitch: () => killSwitch,
  });
  return {
    store, coordinator,
    advance: (ms: number) => { clock += ms; },
    setKillSwitch: (v: boolean) => { killSwitch = v; },
    grant: (over: Partial<UiDelegationBindings> = {}, ttlMs = 60_000) => coordinator.grant({
      goalId: GOAL, controllerId: CONTROLLER, ttlMs, bindings: { ...BINDINGS, ...over },
    }).delegationId,
    ask: (delegationId: string, over: Record<string, unknown> = {}) => coordinator.authorizeRun({
      connection: CONNECTION,
      request: {
        goalId: GOAL,
        controllerId: CONTROLLER,
        delegationId,
        nonce: mintDispatchNonce(),
        tool: 'repo.search',
        workspaceId: 'ws_1',
        origin: 'https://chatgpt.com',
        proposalFingerprint: 'fp_1',
        expectedProposalFingerprint: 'fp_1',
        ...over,
      } as never,
    }),
  };
}

const codeOf = (outcome: { decision: { admitted: boolean } }): string => {
  assert.equal(outcome.decision.admitted, false, 'expected a denial');
  return (outcome.decision as unknown as { code: string }).code;
};

test('an admitted dispatch is authorised once and recorded', async (t) => {
  const h = await harness(t);
  const id = h.grant();
  const outcome = h.ask(id);
  assert.equal(outcome.decision.admitted, true);
  assert.equal(outcome.authorization?.delegationId, id);
  assert.equal(outcome.authorization?.goalId, GOAL);
  assert.equal(outcome.authorization?.tool, 'repo.search');

  const runs = h.store.listDelegatedRuns(id);
  assert.equal(runs.length, 1, 'the dispatch is durably recorded');
  assert.equal(runs[0]?.tool, 'repo.search');
});

test('a refusal carries no authorization, so it cannot be acted on by ignoring the decision', async (t) => {
  const h = await harness(t);
  const id = h.grant();
  const outcome = h.ask(id, { tool: 'git.commit' });
  assert.equal(codeOf(outcome), 'TOOL_NOT_DELEGATED');
  assert.equal(outcome.authorization, undefined);
  assert.equal(h.store.listDelegatedRuns(id).length, 0, 'and it consumed nothing');
});

test('the session comes from the connection, not from the request', async (t) => {
  // The message cannot supply its own identity. A request claiming another session is compared
  // against the session this connection actually holds, so it cannot borrow a delegation.
  const h = await harness(t);
  const id = h.grant();
  const outcome = h.coordinator.authorizeRun({
    connection: { sessionId: 'session_SOMEONE_ELSE', adapterId: CONNECTION.adapterId },
    request: {
      goalId: GOAL, controllerId: CONTROLLER, delegationId: id, nonce: mintDispatchNonce(),
      tool: 'repo.search', workspaceId: 'ws_1', origin: 'https://chatgpt.com',
      proposalFingerprint: 'fp_1', expectedProposalFingerprint: 'fp_1',
    } as never,
  });
  assert.equal(codeOf(outcome), 'SESSION_MISMATCH');
  assert.equal(h.store.listDelegatedRuns(id).length, 0);
});

test('a replayed nonce is refused by the database, not merely by a check', async (t) => {
  const h = await harness(t);
  const id = h.grant();
  const nonce = mintDispatchNonce();
  assert.equal(h.ask(id, { nonce }).decision.admitted, true);
  // The same nonce again: the primary key is what refuses it, so two callers that both passed
  // the spend read cannot both insert.
  assert.equal(codeOf(h.ask(id, { nonce })), 'NONCE_REPLAYED');
  assert.equal(h.store.listDelegatedRuns(id).length, 1, 'exactly one dispatch was consumed');
});

test('the action limit is enforced across the delegation and survives a store reopen', async (t) => {
  const h = await harness(t);
  const id = h.grant({}, 60_000);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(h.ask(id).decision.admitted, true, `dispatch ${i + 1} of 3`);
  }
  assert.equal(codeOf(h.ask(id)), 'ACTION_LIMIT_REACHED');
  assert.equal(h.store.listDelegatedRuns(id).length, 3);
});

test('revocation is immediate and one-way', async (t) => {
  const h = await harness(t);
  const id = h.grant();
  assert.equal(h.ask(id).decision.admitted, true);
  assert.equal(h.coordinator.revoke(id), true);
  assert.equal(h.coordinator.revoke(id), false, 'revoking twice is idempotent, not a toggle');
  assert.equal(codeOf(h.ask(id)), 'DELEGATION_REVOKED');
});

test('expiry is enforced from durable state', async (t) => {
  const h = await harness(t);
  const id = h.grant({}, 5_000);
  assert.equal(h.ask(id).decision.admitted, true);
  h.advance(5_001);
  assert.equal(codeOf(h.ask(id)), 'DELEGATION_EXPIRED');
});

test('the kill switch stops every dispatch without touching the delegation', async (t) => {
  const h = await harness(t);
  const id = h.grant();
  h.setKillSwitch(true);
  assert.equal(codeOf(h.ask(id)), 'KILL_SWITCH_ENGAGED');
  assert.equal(h.store.listDelegatedRuns(id).length, 0);
  h.setKillSwitch(false);
  assert.equal(h.ask(id).decision.admitted, true, 'it pauses; it does not revoke');
});

test('an unknown delegation id is refused rather than treated as unrestricted', async (t) => {
  const h = await harness(t);
  assert.equal(codeOf(h.ask('uidel_does_not_exist')), 'NO_DELEGATION');
});

test('malformed stored bindings deny rather than throw', async (t) => {
  const h = await harness(t);
  const id = h.grant();
  // Corrupt the row behind the coordinator's back, as a same-user edit would.
  const raw = h.store.getUiDelegationRow(id);
  assert.ok(raw);
  h.store.insertUiDelegation({
    delegationId: 'uidel_broken', goalId: GOAL, controllerId: CONTROLLER,
    createdAt: raw.createdAt, notBefore: raw.notBefore, expiresAt: raw.expiresAt,
    bindings: 'not json at all',
  });
  assert.equal(codeOf(h.ask('uidel_broken')), 'DELEGATION_MALFORMED');
});

test('granting refuses bindings that disagree with the grant', async (t) => {
  const h = await harness(t);
  assert.throws(
    () => h.coordinator.grant({
      goalId: GOAL, controllerId: CONTROLLER, ttlMs: 60_000,
      bindings: { ...BINDINGS, goalId: 'goal_different' },
    }),
    /bound to the goal/,
    'a delegation whose bindings name another goal is not a delegation for this one',
  );
  assert.throws(
    () => h.coordinator.grant({
      goalId: GOAL, controllerId: CONTROLLER, ttlMs: 60_000,
      bindings: { ...BINDINGS, controllerId: 'someone.else' },
    }),
    /bound to the controller/,
  );
  assert.throws(
    () => h.coordinator.grant({
      goalId: GOAL, controllerId: CONTROLLER, ttlMs: 60_000,
      bindings: { ...BINDINGS, allowedTools: [] },
    }),
    /malformed/,
  );
});

test('a minted nonce is well formed and never repeats', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const nonce = mintDispatchNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{16,128}$/);
    assert.equal(seen.has(nonce), false, 'a repeated nonce would be a replay by accident');
    seen.add(nonce);
  }
});
