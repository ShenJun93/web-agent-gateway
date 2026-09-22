import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';
import { MAX_DELEGATION_WINDOW_MS } from '../src/goal-ui-delegation.js';
import { canonicalProposalFingerprint } from '../src/proposal-fingerprint.js';

/**
 * The durable state machine, on its own, with no policy in front of it.
 *
 * ```text
 *   STAGED --claim--> CLAIMED --dispatch--> DISPATCHED --result--> RESULTED
 *      |                  |
 *      |                  +--abandon (claim TTL)--> ABANDONED   [terminal]
 *      +--human run--> DISPATCHED --result--> RESULTED
 * ```
 *
 * This suite exists because of a measured hole in the plane-level one. Those tests called two
 * dispatches in sequence and described the result as a race — but sequential calls mean the
 * second one's *policy* read already sees the first one's commit, so the policy refused and the
 * transaction's own re-checks were never reached. Mutations deleting those re-checks survived the
 * entire plane suite. Every case here is the same shape instead: something was true when a
 * decision was made, and is no longer true a moment later when the effect is about to happen.
 */
const GOAL = 'goal_abc';
const CONTROLLER = 'claude.local.controller';
const ADAPTER = 'browser.chatgpt.native.operator.v4';
const SESSION = 'session_1';
const NOW = 1_000_000;

const bindings = (maxActions: number) => JSON.stringify({
  goalId: GOAL,
  controllerId: CONTROLLER,
  allowedOrigins: ['https://chatgpt.com'],
  allowedTools: ['repo.search'],
  workspaceId: 'ws_1',
  sessionId: SESSION,
  adapterId: ADAPTER,
  maxActions,
});

async function harness(t: { after(fn: () => void | Promise<void>): void }, maxActions = 2) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-state-'));
  const file = join(dir, 'store.sqlite');
  let store = new SqliteDurableStore(file);
  const opened = [store];
  t.after(async () => {
    for (const s of opened) { try { s.close(); } catch { /* already closed */ } }
    await rm(dir, { recursive: true, force: true });
  });

  const delegationId = 'uidel_state_fixture';
  store.insertUiDelegation({
    delegationId, goalId: GOAL, controllerId: CONTROLLER,
    createdAt: NOW - 1000, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
    bindings: bindings(maxActions),
  });

  let counter = 0;
  const stage = (query: string, over: { delegationId?: string | undefined } = {}) => {
    counter += 1;
    const proposalId = `prop_state_${counter}`;
    const args = { workspace_id: 'ws_1', query };
    const named = 'delegationId' in over ? over.delegationId : delegationId;
    const fingerprint = canonicalProposalFingerprint({
      tool: 'repo.search', workspaceId: 'ws_1', origin: 'https://chatgpt.com',
      sessionId: SESSION, adapterId: ADAPTER, arguments: args,
    });
    store.insertStagedProposal({
      proposalId,
      ...(named === undefined ? {} : { delegationId: named }),
      tool: 'repo.search', workspaceId: 'ws_1', origin: 'https://chatgpt.com',
      argumentsJson: JSON.stringify(args), sessionId: SESSION, adapterId: ADAPTER,
      stagedAt: NOW - 500, fingerprint,
    });
    return { proposalId, fingerprint };
  };

  return {
    get store() { return store; },
    file, delegationId, stage,
    restart: () => {
      store.close();
      store = new SqliteDurableStore(file);
      opened.push(store);
      return store;
    },
  };
}

type Proposal = { proposalId: string; fingerprint: string };

const claim = (store: SqliteDurableStore, delegationId: string, p: Proposal, now = NOW) =>
  store.claimDelegatedDispatch({
    delegationId, proposalId: p.proposalId, now,
    expectedFingerprint: p.fingerprint, maxWindowMs: MAX_DELEGATION_WINDOW_MS,
  });

const codeOf = (outcome: { ok: boolean }): string => {
  assert.equal(outcome.ok, false, 'expected the transaction to refuse');
  return (outcome as unknown as { code: string }).code;
};

const stateOf = (store: SqliteDurableStore, proposalId: string) =>
  store.getStagedProposalRow(proposalId)?.state;

// ---------------------------------------------------------------------------------------------
// The happy path, and what each transition writes
// ---------------------------------------------------------------------------------------------

test('STAGED -> CLAIMED -> DISPATCHED -> RESULTED, with the audit written at dispatch', async (t) => {
  const h = await harness(t);
  const p = h.stage('needle');
  assert.equal(stateOf(h.store, p.proposalId), 'STAGED');

  const claimed = claim(h.store, h.delegationId, p);
  assert.equal(claimed.ok, true);
  assert.equal((claimed as { goalId: string }).goalId, GOAL, 'read from the row, never passed in');
  assert.equal((claimed as { controllerId: string }).controllerId, CONTROLLER);
  assert.equal(stateOf(h.store, p.proposalId), 'CLAIMED');
  assert.equal(h.store.countDelegationClaims(h.delegationId), 1, 'the claim is what spends the slot');
  assert.equal(h.store.getRunAuthority(p.proposalId), undefined, 'and a claim is not yet a Run');

  assert.deepEqual(h.store.markDelegatedDispatched({ proposalId: p.proposalId, now: NOW + 1 }), { ok: true });
  assert.equal(stateOf(h.store, p.proposalId), 'DISPATCHED');
  assert.equal(h.store.getRunAuthority(p.proposalId)?.authority, 'DELEGATED_RUN');

  assert.equal(h.store.attachRunResult(p.proposalId, 'res_1', NOW + 2), true);
  assert.equal(stateOf(h.store, p.proposalId), 'RESULTED');
  assert.equal(h.store.getRunAuthority(p.proposalId)?.resultId, 'res_1');
  assert.equal(h.store.attachRunResult(p.proposalId, 'res_2', NOW + 3), false, 'a result is not re-pointed');
});

test('the human path is STAGED -> DISPATCHED and spends no slot', async (t) => {
  const h = await harness(t);
  const p = h.stage('needle', { delegationId: undefined });
  assert.deepEqual(h.store.recordHumanRun({ proposalId: p.proposalId, now: NOW }), { ok: true });
  assert.equal(stateOf(h.store, p.proposalId), 'DISPATCHED');
  assert.equal(h.store.getRunAuthority(p.proposalId)?.authority, 'HUMAN_RUN');
  assert.equal(h.store.countDelegationClaims(h.delegationId), 0);
});

test('a delegated proposal cannot be run as a human Run', async (t) => {
  // Measured hole: the browser-reachable plane could run delegated work while spending no slot
  // and writing an audit row saying nothing delegated it — true of the row, false of the work.
  const h = await harness(t);
  const p = h.stage('needle');
  const outcome = h.store.recordHumanRun({ proposalId: p.proposalId, now: NOW });
  assert.equal(codeOf(outcome), 'PROPOSAL_IS_DELEGATED');
  assert.equal(stateOf(h.store, p.proposalId), 'STAGED', 'and nothing moved');
  assert.equal(h.store.getRunAuthority(p.proposalId), undefined);
});

// ---------------------------------------------------------------------------------------------
// Every transition is single-assignment
// ---------------------------------------------------------------------------------------------

test('no transition can be taken twice', async (t) => {
  const h = await harness(t);
  const p = h.stage('needle');
  assert.equal(claim(h.store, h.delegationId, p).ok, true);
  assert.equal(codeOf(claim(h.store, h.delegationId, p)), 'PROPOSAL_NOT_STAGED');
  assert.equal(h.store.countDelegationClaims(h.delegationId), 1, 'no second slot was spent');

  assert.deepEqual(h.store.markDelegatedDispatched({ proposalId: p.proposalId, now: NOW }), { ok: true });
  assert.equal(codeOf(h.store.markDelegatedDispatched({ proposalId: p.proposalId, now: NOW })),
    'PROPOSAL_NOT_CLAIMED');
  assert.equal(h.store.listDelegationClaims(h.delegationId).length, 1);
});

test('a dispatch cannot skip the claim', async (t) => {
  const h = await harness(t);
  const p = h.stage('needle');
  assert.equal(codeOf(h.store.markDelegatedDispatched({ proposalId: p.proposalId, now: NOW })),
    'PROPOSAL_NOT_CLAIMED');
  assert.equal(stateOf(h.store, p.proposalId), 'STAGED');
  assert.equal(h.store.getRunAuthority(p.proposalId), undefined, 'and no audit row appeared');
});

// ---------------------------------------------------------------------------------------------
// The claim transaction re-reads what the policy saw a moment ago
// ---------------------------------------------------------------------------------------------

test('the action budget is enforced inside the claim, not only by the policy', async (t) => {
  const h = await harness(t, 2);
  const first = h.stage('one');
  const second = h.stage('two');
  const third = h.stage('three');
  assert.equal(claim(h.store, h.delegationId, first).ok, true);
  assert.equal(claim(h.store, h.delegationId, second).ok, true);
  // A distinct proposal, so single-assignment cannot be what stops it — only the count re-read.
  assert.equal(codeOf(claim(h.store, h.delegationId, third)), 'ACTION_LIMIT_REACHED');
  assert.equal(h.store.countDelegationClaims(h.delegationId), 2);
  assert.equal(stateOf(h.store, third.proposalId), 'STAGED');
});

test('revocation, supersession and expiry between decision and claim are all caught', async (t) => {
  const h = await harness(t);

  const revoked = h.stage('one');
  assert.equal(h.store.revokeUiDelegation(h.delegationId, NOW - 1), true);
  assert.equal(codeOf(claim(h.store, h.delegationId, revoked)), 'DELEGATION_REVOKED');
  assert.equal(h.store.countDelegationClaims(h.delegationId), 0);

  // A fresh store for the supersession and window cases, since revocation is one-way.
  const h2 = await harness(t);
  h2.store.insertUiDelegation({
    delegationId: 'uidel_successor', goalId: GOAL, controllerId: CONTROLLER,
    createdAt: NOW, notBefore: NOW, expiresAt: NOW + 60_000, bindings: bindings(2),
  });
  assert.equal(
    h2.store.renewUiDelegation({
      predecessorId: h2.delegationId,
      successor: {
        delegationId: 'uidel_successor_2', goalId: GOAL, controllerId: CONTROLLER,
        createdAt: NOW, notBefore: NOW, expiresAt: NOW + 60_000, bindings: bindings(2),
      },
      now: NOW,
    }).ok,
    true,
  );
  const superseded = h2.stage('two');
  assert.equal(codeOf(claim(h2.store, h2.delegationId, superseded)), 'DELEGATION_REVOKED',
    'renewal revokes as well as supersedes, and revocation is checked first');

  const h3 = await harness(t);
  const expiring = h3.stage('three');
  assert.equal(codeOf(claim(h3.store, h3.delegationId, expiring, NOW + 60_000)), 'DELEGATION_EXPIRED');
  assert.equal(codeOf(claim(h3.store, h3.delegationId, expiring, NOW - 2000)), 'DELEGATION_NOT_YET_VALID');
  assert.equal(h3.store.countDelegationClaims(h3.delegationId), 0);
});

test('a window past the ceiling is refused inside the claim too', async (t) => {
  // The control plane checks the ceiling at issue. A row inserted by any other route never passed
  // that check, so the claim re-checks it rather than trusting the row.
  const h = await harness(t);
  h.store.insertUiDelegation({
    delegationId: 'uidel_too_long', goalId: GOAL, controllerId: CONTROLLER,
    createdAt: NOW, notBefore: NOW, expiresAt: NOW + MAX_DELEGATION_WINDOW_MS + 1,
    bindings: bindings(2),
  });
  const p = h.stage('needle', { delegationId: 'uidel_too_long' });
  assert.equal(codeOf(claim(h.store, 'uidel_too_long', p)), 'DELEGATION_MALFORMED');
  assert.equal(h.store.countDelegationClaims('uidel_too_long'), 0);
});

test('a fingerprint that changed since the decision is caught inside the claim', async (t) => {
  const h = await harness(t);
  const p = h.stage('needle');
  assert.equal(
    codeOf(h.store.claimDelegatedDispatch({
      delegationId: h.delegationId, proposalId: p.proposalId, now: NOW,
      expectedFingerprint: 'fp_what_the_policy_saw', maxWindowMs: MAX_DELEGATION_WINDOW_MS,
    })),
    'PROPOSAL_INCONSISTENT',
  );
  assert.equal(h.store.countDelegationClaims(h.delegationId), 0);
});

test('a proposal belonging to another delegation, or to none, cannot be claimed', async (t) => {
  const h = await harness(t);
  const orphan = h.stage('needle', { delegationId: undefined });
  assert.equal(codeOf(claim(h.store, h.delegationId, orphan)), 'PROPOSAL_NOT_FOR_THIS_DELEGATION');

  h.store.insertUiDelegation({
    delegationId: 'uidel_second_goal', goalId: 'goal_second', controllerId: CONTROLLER,
    createdAt: NOW - 1000, notBefore: NOW - 1000, expiresAt: NOW + 60_000, bindings: bindings(2),
  });
  const mine = h.stage('needle');
  assert.equal(codeOf(claim(h.store, 'uidel_second_goal', mine)), 'PROPOSAL_NOT_FOR_THIS_DELEGATION');
  assert.equal(h.store.countDelegationClaims('uidel_second_goal'), 0);
});

test('unparseable bindings and a bad maxActions deny inside the claim', async (t) => {
  const h = await harness(t);
  for (const [id, value] of [
    ['uidel_broken', '{not json'],
    ['uidel_zero', '{"maxActions": 0}'],
    ['uidel_negative', '{"maxActions": -1}'],
    ['uidel_fractional', '{"maxActions": 1.5}'],
    ['uidel_string', '{"maxActions": "3"}'],
    ['uidel_null', '{"maxActions": null}'],
  ] as Array<[string, string]>) {
    h.store.insertUiDelegation({
      delegationId: id, goalId: GOAL, controllerId: CONTROLLER,
      createdAt: NOW - 1000, notBefore: NOW - 1000, expiresAt: NOW + 60_000, bindings: value,
    });
    const p = h.stage('needle', { delegationId: id });
    assert.equal(codeOf(claim(h.store, id, p)), 'DELEGATION_MALFORMED', value);
    assert.equal(h.store.countDelegationClaims(id), 0);
  }
});

// ---------------------------------------------------------------------------------------------
// Crash recovery: restart after CLAIMED and after DISPATCHED
// ---------------------------------------------------------------------------------------------

test('restart after CLAIMED cannot silently double-run or resurrect authority', async (t) => {
  const h = await harness(t);
  const p = h.stage('needle');
  assert.equal(claim(h.store, h.delegationId, p).ok, true);

  // The process dies between the claim and the dispatch. Nothing downstream ran, and WAG cannot
  // know whether an in-flight dispatch reached anything.
  const reopened = h.restart();
  assert.equal(stateOf(reopened, p.proposalId), 'CLAIMED', 'the claim survived');
  assert.equal(reopened.countDelegationClaims(h.delegationId), 1, 'and the slot is still spent');
  assert.equal(reopened.getRunAuthority(p.proposalId), undefined, 'but no Run was recorded');

  // Redelivery of the same claim is refused: it is no longer STAGED.
  assert.equal(codeOf(claim(reopened, h.delegationId, p)), 'PROPOSAL_NOT_STAGED');

  // Recovery retires it. It is never dispatched, and the slot is not returned — the only honest
  // reading of a crash at this point, because resurrecting it is the silent double-run.
  assert.equal(reopened.abandonExpiredClaims(NOW + 120_000, 60_000), 1);
  assert.equal(stateOf(reopened, p.proposalId), 'ABANDONED');
  assert.equal(reopened.countDelegationClaims(h.delegationId), 1, 'abandonment releases no budget');
  assert.equal(codeOf(reopened.markDelegatedDispatched({ proposalId: p.proposalId, now: NOW + 130_000 })),
    'PROPOSAL_NOT_CLAIMED', 'and an abandoned claim can never be dispatched');
  assert.equal(reopened.getRunAuthority(p.proposalId), undefined);
});

test('a claim inside its TTL is not abandoned', async (t) => {
  const h = await harness(t);
  const p = h.stage('needle');
  assert.equal(claim(h.store, h.delegationId, p).ok, true);
  assert.equal(h.store.abandonExpiredClaims(NOW + 30_000, 60_000), 0, 'still within the TTL');
  assert.equal(stateOf(h.store, p.proposalId), 'CLAIMED');
  assert.deepEqual(h.store.markDelegatedDispatched({ proposalId: p.proposalId, now: NOW + 30_001 }), { ok: true });
});

test('restart after DISPATCHED cannot re-run or re-claim', async (t) => {
  const h = await harness(t);
  const p = h.stage('needle');
  assert.equal(claim(h.store, h.delegationId, p).ok, true);
  assert.deepEqual(h.store.markDelegatedDispatched({ proposalId: p.proposalId, now: NOW + 1 }), { ok: true });

  const reopened = h.restart();
  assert.equal(stateOf(reopened, p.proposalId), 'DISPATCHED');
  assert.equal(reopened.getRunAuthority(p.proposalId)?.authority, 'DELEGATED_RUN');
  assert.equal(codeOf(claim(reopened, h.delegationId, p)), 'PROPOSAL_NOT_STAGED');
  assert.equal(codeOf(reopened.markDelegatedDispatched({ proposalId: p.proposalId, now: NOW + 2 })),
    'PROPOSAL_NOT_CLAIMED');
  assert.equal(codeOf(reopened.recordHumanRun({ proposalId: p.proposalId, now: NOW + 2 })),
    'PROPOSAL_IS_DELEGATED');
  assert.equal(reopened.countDelegationClaims(h.delegationId), 1);
  // And abandonment does not touch something that already dispatched.
  assert.equal(reopened.abandonExpiredClaims(NOW + 999_999, 60_000), 0);
  assert.equal(stateOf(reopened, p.proposalId), 'DISPATCHED');
});

test('a refused claim leaves the store byte-identical to before it', async (t) => {
  const h = await harness(t, 1);
  const spent = h.stage('one');
  assert.equal(claim(h.store, h.delegationId, spent).ok, true);
  const before = {
    claims: h.store.listDelegationClaims(h.delegationId),
    staged: h.store.getStagedProposalRow(spent.proposalId),
    audit: h.store.getRunAuthority(spent.proposalId),
  };

  const overBudget = h.stage('two');
  assert.equal(codeOf(claim(h.store, h.delegationId, overBudget)), 'ACTION_LIMIT_REACHED');

  assert.deepEqual(h.store.listDelegationClaims(h.delegationId), before.claims);
  assert.deepEqual(h.store.getStagedProposalRow(spent.proposalId), before.staged);
  assert.deepEqual(h.store.getRunAuthority(spent.proposalId), before.audit);
  assert.equal(stateOf(h.store, overBudget.proposalId), 'STAGED');
  assert.equal(h.store.getRunAuthority(overBudget.proposalId), undefined);
});

test('a contended claim fails loudly and leaves nothing behind', async (t) => {
  const h = await harness(t);
  const p = h.stage('needle');

  // A second connection holds the write lock. `BEGIN IMMEDIATE` is refused outright in that
  // state — measured at about a millisecond, not a block — which is what stops two claims
  // interleaving at all. The dangerous failure would be a *quiet* one, so what this pins is that
  // contention raises rather than returning something that reads like a decision.
  const contender = new SqliteDurableStore(h.file);
  const exec = (sql: string) => (contender as unknown as { db: { exec(s: string): void } }).db.exec(sql);
  exec('BEGIN IMMEDIATE');

  assert.throws(() => claim(h.store, h.delegationId, p), /SQLITE|database is locked|busy/i);
  assert.equal(h.store.countDelegationClaims(h.delegationId), 0, 'nothing was written');
  assert.equal(stateOf(h.store, p.proposalId), 'STAGED');

  exec('ROLLBACK');
  contender.close();
  assert.equal(claim(h.store, h.delegationId, p).ok, true, 'contention delayed it rather than spending it');
});

// ---------------------------------------------------------------------------------------------
// Renewal, atomically
// ---------------------------------------------------------------------------------------------

test('renewal is one transaction, so a goal never has two live delegations', async (t) => {
  const h = await harness(t);
  const successor = {
    delegationId: 'uidel_successor', goalId: GOAL, controllerId: CONTROLLER,
    createdAt: NOW, notBefore: NOW, expiresAt: NOW + 60_000, bindings: bindings(2),
  };
  assert.deepEqual(h.store.renewUiDelegation({ predecessorId: h.delegationId, successor, now: NOW }), { ok: true });

  const predecessor = h.store.getUiDelegationRow(h.delegationId);
  assert.equal(predecessor?.supersededBy, 'uidel_successor');
  assert.ok(predecessor?.revokedAt, 'and it is revoked in the same transaction, not afterwards');
  assert.equal(h.store.getUiDelegationRow('uidel_successor')?.supersedes, h.delegationId);
});

test('a revoked or superseded delegation cannot be renewed back into life', async (t) => {
  const h = await harness(t);
  const mk = (id: string) => ({
    delegationId: id, goalId: GOAL, controllerId: CONTROLLER,
    createdAt: NOW, notBefore: NOW, expiresAt: NOW + 60_000, bindings: bindings(2),
  });
  assert.equal(h.store.revokeUiDelegation(h.delegationId, NOW), true);
  assert.equal(
    codeOf(h.store.renewUiDelegation({ predecessorId: h.delegationId, successor: mk('uidel_x'), now: NOW })),
    'DELEGATION_REVOKED',
    'renewing a revoked delegation would turn a deliberate stop into a fresh budget',
  );
  assert.equal(h.store.getUiDelegationRow('uidel_x'), undefined, 'and the successor was rolled back');

  const h2 = await harness(t);
  assert.equal(h2.store.renewUiDelegation({
    predecessorId: h2.delegationId, successor: mk('uidel_first'), now: NOW,
  }).ok, true);
  assert.equal(
    codeOf(h2.store.renewUiDelegation({
      predecessorId: h2.delegationId, successor: mk('uidel_second'), now: NOW,
    })),
    'DELEGATION_REVOKED',
  );
  assert.equal(h2.store.getUiDelegationRow('uidel_second'), undefined);
});

test('renewal refuses another controller or another goal', async (t) => {
  const h = await harness(t);
  assert.equal(codeOf(h.store.renewUiDelegation({
    predecessorId: h.delegationId,
    successor: {
      delegationId: 'uidel_x', goalId: GOAL, controllerId: 'someone.else',
      createdAt: NOW, notBefore: NOW, expiresAt: NOW + 60_000, bindings: bindings(2),
    },
    now: NOW,
  })), 'CONTROLLER_MISMATCH');
  assert.equal(codeOf(h.store.renewUiDelegation({
    predecessorId: h.delegationId,
    successor: {
      delegationId: 'uidel_y', goalId: 'goal_other', controllerId: CONTROLLER,
      createdAt: NOW, notBefore: NOW, expiresAt: NOW + 60_000, bindings: bindings(2),
    },
    now: NOW,
  })), 'GOAL_MISMATCH');
  assert.equal(h.store.getUiDelegationRow('uidel_x'), undefined);
  assert.equal(h.store.getUiDelegationRow('uidel_y'), undefined);
});

// ---------------------------------------------------------------------------------------------
// Refusal audit
// ---------------------------------------------------------------------------------------------

test('refusals are durable, carry their reason, and say whether a slot was spent', async (t) => {
  const h = await harness(t);
  h.store.recordDelegatedRunRefusal({
    requestedDelegationId: h.delegationId, requestedProposalId: 'prop_x',
    sessionId: SESSION, adapterId: ADAPTER, refusedAt: NOW,
    reasonCode: 'TOOL_NOT_DELEGATED', slotClaimed: false, maxRowsPerScope: 8,
  });
  h.store.recordDelegatedRunRefusal({
    requestedDelegationId: h.delegationId, requestedProposalId: 'prop_y', goalId: GOAL,
    sessionId: SESSION, adapterId: ADAPTER, refusedAt: NOW + 1,
    reasonCode: 'PROPOSAL_NOT_CLAIMED', slotClaimed: true, maxRowsPerScope: 8,
  });
  const rows = h.store.listDelegatedRunRefusals({ sessionId: SESSION, adapterId: ADAPTER });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.authority, 'DELEGATED_RUN_REFUSED');
  assert.equal(rows[0]?.reasonCode, 'TOOL_NOT_DELEGATED');
  assert.equal(rows[0]?.slotClaimed, false);
  assert.equal(rows[1]?.slotClaimed, true, 'a refusal after the claim is distinguishable');
  assert.equal(rows[1]?.goalId, GOAL);
});

test('the refusal log is bounded, because the browser can drive it', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 40; i += 1) {
    h.store.recordDelegatedRunRefusal({
      sessionId: SESSION, adapterId: ADAPTER, refusedAt: NOW + i,
      reasonCode: 'REQUEST_MALFORMED', slotClaimed: false, maxRowsPerScope: 8,
    });
  }
  const rows = h.store.listDelegatedRunRefusals({ sessionId: SESSION, adapterId: ADAPTER });
  assert.equal(rows.length, 8, 'the cap holds without a sweeper');
  assert.equal(rows[rows.length - 1]?.refusedAt, NOW + 39, 'and the newest are the ones kept');
  // Another browser context has its own budget, so one cannot evict another's audit.
  h.store.recordDelegatedRunRefusal({
    sessionId: 'session_other', adapterId: ADAPTER, refusedAt: NOW,
    reasonCode: 'REQUEST_MALFORMED', slotClaimed: false, maxRowsPerScope: 8,
  });
  assert.equal(h.store.listDelegatedRunRefusals({ sessionId: SESSION, adapterId: ADAPTER }).length, 8);
  assert.equal(h.store.listDelegatedRunRefusals({ sessionId: 'session_other', adapterId: ADAPTER }).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Schema shape
// ---------------------------------------------------------------------------------------------

test('a pre-acceptance store is refused at open rather than failing deep inside an insert', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-oldshape-'));
  const file = join(dir, 'old.sqlite');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // The shape this branch shipped two commits ago: `staged_proposals` without a `state` column.
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE staged_proposals (
    proposal_id TEXT PRIMARY KEY, delegation_id TEXT, tool TEXT, workspace_id TEXT,
    origin TEXT, arguments TEXT, session_id TEXT, adapter_id TEXT, staged_at INTEGER,
    fingerprint TEXT, dispatched_at INTEGER)`);
  old.close();

  assert.throws(
    () => new SqliteDurableStore(file),
    /pre-acceptance staged_proposals table \(missing state/,
    'CREATE TABLE IF NOT EXISTS is silent about a table with the wrong shape',
  );
});
