import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  createControllerPlaneKey,
  UiDelegationControlPlane,
} from '../src/goal-ui-delegation-control.js';
import {
  createDelegationDispatchPort,
  DELEGATION_DISPATCH_PORT_METHODS,
  MAX_OPEN_STAGED_PER_SESSION,
  UiDelegationDispatchPlane,
} from '../src/goal-ui-delegation-dispatch.js';
import { createProposalRateLimit } from '../src/proposal-rate-limit.js';
import type { ConnectionIdentity, UiDelegationBindings } from '../src/goal-ui-delegation.js';

/**
 * The design gate, executed.
 *
 * Every case below is an attempt to obtain a Run that was not granted, and every one must end
 * with **zero effect**: no slot claimed, no state moved, no audit row saying a Run happened. The
 * assertions check the absence as well as the refusal, because a guard that refuses loudly and
 * still spends something has failed.
 */
const GOAL = 'goal_abc';
const CONTROLLER = 'claude.local.controller';
const ADAPTER = 'browser.chatgpt.native.operator.v4';
const CONNECTION: ConnectionIdentity = {
  ownerId: 'owner_1', sessionId: 'session_1', adapterId: ADAPTER,
};

const BINDINGS: UiDelegationBindings = {
  goalId: GOAL,
  controllerId: CONTROLLER,
  allowedOrigins: ['https://chatgpt.com'],
  allowedTools: ['repo.search', 'file.read'],
  workspaceId: 'ws_1',
  sessionId: CONNECTION.sessionId,
  adapterId: ADAPTER,
  maxActions: 3,
};

const ARGS = { workspace_id: 'ws_1', query: 'needle' };

async function harness(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-uidel-'));
  const file = join(dir, 'store.sqlite');
  let store = new SqliteDurableStore(file);
  let clock = 1_000_000;
  let killSwitch = false;
  let configured: string | undefined;
  const opened = [store];
  // One cleanup hook, in one order. Two hooks closing and removing separately is how this suite
  // previously produced EBUSY on Windows: the removal ran before the handle was released.
  t.after(async () => {
    for (const s of opened) { try { s.close(); } catch { /* already closed */ } }
    await rm(dir, { recursive: true, force: true });
  });

  const control = () => new UiDelegationControlPlane({
    store, key: createControllerPlaneKey(CONTROLLER), now: () => clock,
  });
  const dispatch = (over: { store?: SqliteDurableStore; configuredDelegationId?: string } = {}) =>
    new UiDelegationDispatchPlane({
      port: createDelegationDispatchPort(over.store ?? store),
      killSwitch: () => killSwitch,
      now: () => clock,
      ...('configuredDelegationId' in over
        ? (over.configuredDelegationId === undefined ? {} : { configuredDelegationId: over.configuredDelegationId })
        : (configured === undefined ? {} : { configuredDelegationId: configured })),
      // A generous limit by default: the rate limit has its own test and should not make every
      // other test in this file depend on how many proposals it happens to stage.
      rateLimit: createProposalRateLimit({ attempts: 10_000 }),
    });

  return {
    get store() { return store; },
    control, dispatch,
    advance: (ms: number) => { clock += ms; },
    setKillSwitch: (v: boolean) => { killSwitch = v; },
    secondConnection: () => {
      const other = new SqliteDurableStore(file);
      opened.push(other);
      return other;
    },
    restart: () => {
      store.close();
      store = new SqliteDurableStore(file);
      opened.push(store);
      return store;
    },
    /** Issue a delegation *and* name it in configuration, which is what makes it live. */
    issue: (over: Partial<UiDelegationBindings> = {}, ttlMs = 60_000) => {
      const id = control().issue({
        goalId: over.goalId ?? GOAL, ttlMs, bindings: { ...BINDINGS, ...over },
      }).delegationId;
      configured = id;
      return id;
    },
    /**
     * Issue without configuring it, to test that a row alone grants nothing.
     *
     * Its own goal by default, because `issue` now refuses a second live delegation for a goal.
     */
    issueUnconfigured: (over: Partial<UiDelegationBindings> = {}) => {
      const goalId = over.goalId ?? 'goal_unconfigured';
      return control().issue({
        goalId, ttlMs: 60_000, bindings: { ...BINDINGS, ...over, goalId },
      }).delegationId;
    },
    stage: (delegationId: string | undefined, over: Record<string, unknown> = {},
      connection: ConnectionIdentity = CONNECTION) => dispatch().stageProposal({
      connection,
      ...(delegationId === undefined ? {} : { delegationId }),
      tool: 'repo.search',
      workspaceId: 'ws_1',
      origin: 'https://chatgpt.com',
      arguments: ARGS,
      ...over,
    } as never),
  };
}

const stagedId = (outcome: { staged: boolean }): string => {
  assert.equal(outcome.staged, true, `expected staging to succeed: ${JSON.stringify(outcome)}`);
  return (outcome as unknown as { proposalId: string }).proposalId;
};

const denialCode = (outcome: { decision: { admitted: boolean } }): string => {
  assert.equal(outcome.decision.admitted, false, 'expected a denial');
  return (outcome.decision as unknown as { code: string }).code;
};

/** Everything a refused dispatch must not have touched. */
function assertNoEffect(store: SqliteDurableStore, delegationId: string, proposalId: string,
  expectedSlots = 0) {
  assert.equal(store.countDelegationClaims(delegationId), expectedSlots, 'slots claimed');
  assert.equal(store.getStagedProposalRow(proposalId)?.state, 'STAGED', 'proposal state moved');
  assert.equal(store.getRunAuthority(proposalId), undefined, 'audit row written');
}

// ---------------------------------------------------------------------------------------------
// The capability boundary, proved by calling it
// ---------------------------------------------------------------------------------------------

test('the dispatch port carries no issuance method, at runtime', async (t) => {
  const h = await harness(t);
  const port = createDelegationDispatchPort(h.store) as unknown as Record<string, unknown>;

  // The structural claim was not enough. An earlier draft handed the plane the whole store, so it
  // could have called `insertUiDelegation` directly — no import of the control module, no mention
  // of its class name, and every import-pinning test still green. So this calls the port.
  for (const forbidden of [
    'insertUiDelegation', 'revokeUiDelegation', 'renewUiDelegation', 'supersedeUiDelegation',
    'insertGoalLease', 'abandonExpiredClaims',
  ]) {
    assert.equal(port[forbidden], undefined, `${forbidden} must not be reachable from the port`);
    assert.throws(
      () => (port[forbidden] as () => void)(),
      TypeError,
      `${forbidden} must not be callable`,
    );
  }
  assert.deepEqual(
    Object.keys(port).sort(), [...DELEGATION_DISPATCH_PORT_METHODS].sort(),
    'the port surface is exactly the declared one',
  );
  assert.equal(Object.isFrozen(port), true, 'and nothing can add a method to it afterwards');
  assert.throws(() => { port.insertUiDelegation = () => undefined; }, TypeError);
});

test('the dispatch plane exposes no way to create, renew or revoke a delegation', async (t) => {
  const h = await harness(t);
  const plane = h.dispatch();
  const surface = new Set([
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(plane) as object),
    ...Object.getOwnPropertyNames(plane),
  ]);
  assert.deepEqual(
    [...surface].filter((name) => /issue|grant|renew|revoke|widen|extend|supersede/i.test(name)),
    [],
    'the browser-reachable plane must carry no issuance verb at all',
  );
  for (const method of ['stageProposal', 'authorizeDelegatedRun', 'recordHumanRun', 'attachResult']) {
    assert.equal(typeof (plane as unknown as Record<string, unknown>)[method], 'function', method);
  }
});

test('a control plane refuses a key it did not mint', async (t) => {
  const h = await harness(t);
  const forged = { controllerId: CONTROLLER } as ReturnType<typeof createControllerPlaneKey>;
  assert.throws(
    () => new UiDelegationControlPlane({ store: h.store, key: forged }),
    /refuses a key it did not mint/,
  );
  for (const bad of [null, undefined, 'a string', 42]) {
    assert.throws(
      () => new UiDelegationControlPlane({ store: h.store, key: bad as never }),
      /refuses a key it did not mint/,
      String(bad),
    );
  }
});

test('a delegation cannot be issued past the ceiling, for another controller, or for another goal', async (t) => {
  const h = await harness(t);
  const control = h.control();
  assert.throws(
    () => control.issue({ goalId: GOAL, ttlMs: 5 * 60 * 60 * 1000, bindings: BINDINGS }),
    /may not exceed/,
    'the ceiling is enforced at issue, not only refused at use',
  );
  assert.throws(
    () => control.issue({
      goalId: GOAL, ttlMs: 60_000, bindings: { ...BINDINGS, controllerId: 'someone.else' },
    }),
    /bound to the controller issuing it/,
  );
  assert.throws(
    () => control.issue({
      goalId: GOAL, ttlMs: 60_000, bindings: { ...BINDINGS, goalId: 'goal_other' },
    }),
    /bound to the goal it is issued for/,
  );
  for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => control.issue({ goalId: GOAL, ttlMs, bindings: BINDINGS }),
      /positive, finite lifetime|may not exceed/,
      String(ttlMs),
    );
  }
  assert.throws(
    () => control.issue({
      goalId: GOAL, ttlMs: 60_000, bindings: { ...BINDINGS, allowedTools: [] },
    }),
    /malformed/,
  );
});

test('a superseded delegation cannot be renewed, even if its revocation never landed', async (t) => {
  // A row that is superseded but not revoked cannot arise from `renewUiDelegation`, which does
  // both in one transaction. It could arise from a same-user edit or a future code path, so the
  // guard exists — and this constructs exactly that row so the guard is reached by a test rather
  // than merely present in the source.
  const h = await harness(t);
  const first = h.issue();
  // Staged while the delegation is still whole; staging under a superseded one is refused too.
  const proposalId = stagedId(h.stage(first));
  const supersede = () => (h.store as unknown as {
    db: { prepare(s: string): { run(...a: unknown[]): unknown } };
  }).db.prepare('UPDATE ui_delegations SET superseded_by = ? WHERE delegation_id = ?')
    .run('uidel_some_successor', first);
  supersede();

  const renewed = h.control().renew({
    delegationId: first, goalId: GOAL, bindings: BINDINGS, ttlMs: 60_000,
  });
  assert.equal(renewed.ok, false);
  assert.equal((renewed as { code: string }).code, 'DELEGATION_SUPERSEDED');

  // And such a delegation authorises nothing either.
  assert.equal(
    denialCode(h.dispatch().authorizeDelegatedRun({
      connection: CONNECTION, request: { delegationId: first, proposalId },
    })),
    'DELEGATION_SUPERSEDED',
  );
  assertNoEffect(h.store, first, proposalId);
});

test('a dispatch plane cannot be built without a kill switch', async (t) => {
  const h = await harness(t);
  // Optional and defaulted to "not engaged" was a measured hole: a construction site that forgot
  // it silently disabled the local stop for the whole delegated path.
  for (const bad of [undefined, null, false, 'yes']) {
    assert.throws(
      () => new UiDelegationDispatchPlane({
        port: createDelegationDispatchPort(h.store), killSwitch: bad as never,
      }),
      /requires a kill switch/,
      String(bad),
    );
  }
});

// ---------------------------------------------------------------------------------------------
// A delegation is inert unless a human named it in configuration
// ---------------------------------------------------------------------------------------------

test('a delegation that exists but is not configured authorises nothing', async (t) => {
  const h = await harness(t);
  const unconfigured = h.issueUnconfigured();
  // Staging under it is refused, so the proposal never even exists...
  const staging = h.stage(unconfigured);
  assert.equal(staging.staged, false);
  assert.equal((staging as { code: string }).code, 'DELEGATION_NOT_CONFIGURED');

  // ...and so is a dispatch naming it, even with a proposal manufactured directly in the store.
  h.store.insertStagedProposal({
    proposalId: `prop_${'a'.repeat(24)}`, delegationId: unconfigured, tool: 'repo.search',
    workspaceId: 'ws_1', origin: 'https://chatgpt.com', argumentsJson: JSON.stringify(ARGS),
    sessionId: CONNECTION.sessionId, adapterId: ADAPTER, stagedAt: 1_000_000, fingerprint: 'fp_x',
  });
  const outcome = h.dispatch({ configuredDelegationId: undefined }).authorizeDelegatedRun({
    connection: CONNECTION, request: { delegationId: unconfigured, proposalId: `prop_${'a'.repeat(24)}` },
  });
  assert.equal(denialCode(outcome), 'DELEGATION_NOT_CONFIGURED');
  assert.equal(h.store.countDelegationClaims(unconfigured), 0);
});

test('configuring one delegation does not make a different one live', async (t) => {
  const h = await harness(t);
  const configured = h.issue();
  const other = h.issueUnconfigured();
  const staging = h.dispatch({ configuredDelegationId: configured }).stageProposal({
    connection: CONNECTION, delegationId: other, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com', arguments: ARGS,
  });
  assert.equal((staging as { code: string }).code, 'DELEGATION_NOT_CONFIGURED');
});

// ---------------------------------------------------------------------------------------------
// The browser asserts nothing
// ---------------------------------------------------------------------------------------------

test('a request that tries to assert authority is refused, not stripped', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));
  const plane = h.dispatch();

  for (const extra of [
    { goalId: 'goal_attacker' },
    { controllerId: 'attacker.controller' },
    { maxActions: 9999 },
    { expiresAt: Number.MAX_SAFE_INTEGER },
    { authority: 'DELEGATED_RUN' },
    { proposalFingerprint: 'fp_forged' },
    { sessionId: 'session_1' },
    { slotClaimed: false },
  ]) {
    const outcome = plane.authorizeDelegatedRun({
      connection: CONNECTION, request: { delegationId, proposalId, ...extra },
    });
    assert.equal(denialCode(outcome), 'REQUEST_MALFORMED', Object.keys(extra)[0]);
    assert.equal(outcome.authorization, undefined);
    assert.equal(outcome.slotClaimed, false);
  }
  assertNoEffect(h.store, delegationId, proposalId);
});

test('the fingerprint is WAG-computed and covers the browser context', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const first = h.stage(delegationId);
  const second = h.stage(delegationId, { arguments: { workspace_id: 'ws_1', query: 'different' } });
  assert.notEqual(
    (first as { fingerprint: string }).fingerprint,
    (second as { fingerprint: string }).fingerprint,
    'different arguments must never share an identity',
  );
  const stored = h.store.getStagedProposalRow(stagedId(first));
  assert.equal(stored?.fingerprint, (first as { fingerprint: string }).fingerprint,
    'the stored identity is the one WAG derived; no parameter could have supplied one');
});

test('a staged row edited behind WAG is refused as inconsistent', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));
  (h.store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    .prepare('UPDATE staged_proposals SET arguments = ? WHERE proposal_id = ?')
    .run(JSON.stringify({ workspace_id: 'ws_1', query: 'injected' }), proposalId);

  const outcome = h.dispatch().authorizeDelegatedRun({
    connection: CONNECTION, request: { delegationId, proposalId },
  });
  // Named for what it is. This catches a partial write and a future code path that edits a row and
  // forgets the column; it is *not* tamper evidence, because the digest is unkeyed and lives in
  // the row it covers — an editor can recompute it with the exported function.
  assert.equal(denialCode(outcome), 'PROPOSAL_INCONSISTENT');
  assertNoEffect(h.store, delegationId, proposalId);
});

// ---------------------------------------------------------------------------------------------
// The bindings, each refused with zero effect
// ---------------------------------------------------------------------------------------------

test('every out-of-scope dispatch fails closed and spends nothing', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();

  for (const [label, over] of [
    ['TOOL_NOT_DELEGATED', { tool: 'repo.snapshot', arguments: { workspace_id: 'ws_1' } }],
    ['WORKSPACE_MISMATCH', { workspaceId: 'ws_2', arguments: { workspace_id: 'ws_2', query: 'needle' } }],
    ['ORIGIN_NOT_ALLOWED', { origin: 'https://evil.example' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const outcome = h.stage(delegationId, over);
    assert.equal(outcome.staged, false, label);
    assert.equal((outcome as { code: string }).code, label);
  }
  assert.equal(h.store.countStagedProposals(delegationId), 0, 'nothing out of scope was queued');

  const foreign = stagedId(h.stage(undefined, {},
    { ownerId: 'owner_2', sessionId: 'session_other', adapterId: ADAPTER }));
  const outcome = h.dispatch().authorizeDelegatedRun({
    connection: CONNECTION, request: { delegationId, proposalId: foreign },
  });
  assert.equal(denialCode(outcome), 'PROPOSAL_NOT_FOR_THIS_DELEGATION');
  assertNoEffect(h.store, delegationId, foreign);
});

test('cross-goal and cross-workspace use are refused', async (t) => {
  const h = await harness(t);
  const goalOne = h.issue();
  const underGoalOne = stagedId(h.stage(goalOne));
  const goalTwo = h.issue({ goalId: 'goal_second' });

  const crossGoal = h.dispatch().authorizeDelegatedRun({
    connection: CONNECTION, request: { delegationId: goalTwo, proposalId: underGoalOne },
  });
  assert.equal(denialCode(crossGoal), 'PROPOSAL_NOT_FOR_THIS_DELEGATION');
  assertNoEffect(h.store, goalTwo, underGoalOne);

  // Its own goal, since one goal may hold only one live delegation.
  const otherWorkspace = h.issue({ goalId: 'goal_third', workspaceId: 'ws_other' });
  const refused = h.stage(otherWorkspace);
  assert.equal((refused as { code: string }).code, 'WORKSPACE_MISMATCH');
});

test('a session or adapter that does not hold the delegation is refused', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));

  for (const [code, connection] of [
    ['SESSION_MISMATCH', { ownerId: 'owner_1', sessionId: 'session_2', adapterId: ADAPTER }],
    ['ADAPTER_MISMATCH', { ownerId: 'owner_1', sessionId: 'session_1', adapterId: 'browser.chatgpt.native.verify.v3' }],
  ] as Array<[string, ConnectionIdentity]>) {
    const outcome = h.dispatch().authorizeDelegatedRun({ connection, request: { delegationId, proposalId } });
    assert.equal(denialCode(outcome), code);
  }
  assertNoEffect(h.store, delegationId, proposalId);
});

test('expiry, revocation and supersession are read at the moment of use', async (t) => {
  const h = await harness(t);
  const expiring = h.issue({}, 5_000);
  const expiringProposal = stagedId(h.stage(expiring));
  h.advance(5_001);
  assert.equal(
    denialCode(h.dispatch().authorizeDelegatedRun({
      connection: CONNECTION, request: { delegationId: expiring, proposalId: expiringProposal },
    })),
    'DELEGATION_EXPIRED',
  );
  assertNoEffect(h.store, expiring, expiringProposal);

  // The first has expired by now, and an expired delegation is not live, so a replacement may be
  // issued without revoking it first.
  const revocable = h.issue();
  const revocableProposal = stagedId(h.stage(revocable));
  assert.equal(h.control().revoke(revocable), true);
  assert.equal(h.control().revoke(revocable), false, 'revocation is one-way, not a toggle');
  assert.equal(
    denialCode(h.dispatch().authorizeDelegatedRun({
      connection: CONNECTION, request: { delegationId: revocable, proposalId: revocableProposal },
    })),
    'DELEGATION_REVOKED',
  );
  assertNoEffect(h.store, revocable, revocableProposal);
});

test('a revoked delegation cannot be renewed back into a fresh budget', async (t) => {
  const h = await harness(t);
  const first = h.issue();
  assert.equal(h.control().revoke(first), true);
  const renewed = h.control().renew({
    delegationId: first, goalId: GOAL, bindings: BINDINGS, ttlMs: 60_000,
  });
  assert.equal(renewed.ok, false);
  assert.equal((renewed as { code: string }).code, 'DELEGATION_REVOKED');
});

test('renewal retires the predecessor in one transaction', async (t) => {
  const h = await harness(t);
  const first = h.issue();
  const renewed = h.control().renew({
    delegationId: first, goalId: GOAL, bindings: BINDINGS, ttlMs: 60_000,
  });
  assert.equal(renewed.ok, true);
  const successorId = (renewed as { delegationId: string }).delegationId;
  const predecessor = h.store.getUiDelegationRow(first);
  assert.equal(predecessor?.supersededBy, successorId);
  assert.ok(predecessor?.revokedAt, 'revoked in the same transaction, so the goal never has two');

  // And the predecessor authorises nothing, chain or no chain.
  const proposal = stagedId(h.dispatch({ configuredDelegationId: successorId }).stageProposal({
    connection: CONNECTION, delegationId: successorId, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com', arguments: ARGS,
  }));
  const outcome = h.dispatch({ configuredDelegationId: first }).authorizeDelegatedRun({
    connection: CONNECTION, request: { delegationId: first, proposalId: proposal },
  });
  assert.equal(denialCode(outcome), 'DELEGATION_REVOKED');
});

// ---------------------------------------------------------------------------------------------
// The kill switch stops autonomy and leaves the human route alone
// ---------------------------------------------------------------------------------------------

test('the kill switch stops delegated dispatch and delegated staging', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));

  h.setKillSwitch(true);
  assert.equal(
    denialCode(h.dispatch().authorizeDelegatedRun({
      connection: CONNECTION, request: { delegationId, proposalId },
    })),
    'KILL_SWITCH_ENGAGED',
  );
  assert.equal((h.stage(delegationId) as { code: string }).code, 'KILL_SWITCH_ENGAGED');
  assertNoEffect(h.store, delegationId, proposalId);

  h.setKillSwitch(false);
  assert.equal(
    h.dispatch().authorizeDelegatedRun({
      connection: CONNECTION, request: { delegationId, proposalId },
    }).decision.admitted,
    true,
    'it pauses autonomy; it does not revoke authority',
  );
});

test('the kill switch does not block the human route', async (t) => {
  // `human-presence-boundary.md` is explicit: the stop pauses autonomy and must not stop someone
  // from acting themselves. Checking it before the delegated branch refused undelegated staging
  // too, which would have bricked the path a person uses to take over.
  const h = await harness(t);
  h.setKillSwitch(true);
  const proposalId = stagedId(h.stage(undefined));
  assert.deepEqual(
    h.dispatch().recordHumanRun({ connection: CONNECTION, proposalId }),
    { ok: true },
    'a human can still stage and run while automation is stopped',
  );
  assert.equal(h.store.getRunAuthority(proposalId)?.authority, 'HUMAN_RUN');
});

// ---------------------------------------------------------------------------------------------
// One parent, many children; budget; replay; restart
// ---------------------------------------------------------------------------------------------

test('one delegation authorises many in-scope Runs without a fresh grant', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const plane = h.dispatch();
  const proposals = [0, 1, 2].map(() => stagedId(h.stage(delegationId)));

  for (const [index, proposalId] of proposals.entries()) {
    const outcome = plane.authorizeDelegatedRun({
      connection: CONNECTION, request: { delegationId, proposalId },
    });
    assert.equal(outcome.decision.admitted, true, `dispatch ${index + 1} of 3`);
    assert.equal(outcome.authorization?.goalId, GOAL, 'the goal comes from the delegation row');
    assert.equal(outcome.authorization?.controllerId, CONTROLLER);
    assert.equal(h.store.getStagedProposalRow(proposalId)?.state, 'DISPATCHED');
  }
  assert.equal(h.store.countDelegationClaims(delegationId), 3);
});

test('the action budget is a ceiling on the parent, and staging cannot outrun it', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue({ maxActions: 2 });
  const first = stagedId(h.stage(delegationId));
  const second = stagedId(h.stage(delegationId));
  assert.equal((h.stage(delegationId) as { code: string }).code, 'STAGING_LIMIT_REACHED');

  const plane = h.dispatch();
  for (const proposalId of [first, second]) {
    assert.equal(
      plane.authorizeDelegatedRun({ connection: CONNECTION, request: { delegationId, proposalId } })
        .decision.admitted, true,
    );
  }
  assert.equal(h.store.countDelegationClaims(delegationId), 2);
});

test('a replayed dispatch is refused and spends nothing further', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));
  const plane = h.dispatch();

  assert.equal(
    plane.authorizeDelegatedRun({ connection: CONNECTION, request: { delegationId, proposalId } })
      .decision.admitted, true,
  );
  for (let i = 0; i < 3; i += 1) {
    const outcome = plane.authorizeDelegatedRun({
      connection: CONNECTION, request: { delegationId, proposalId },
    });
    assert.equal(denialCode(outcome), 'PROPOSAL_NOT_STAGED', `replay ${i + 1}`);
    assert.equal(outcome.authorization, undefined);
    assert.equal(outcome.slotClaimed, false, 'a replay spends no further slot');
  }
  assert.equal(h.store.countDelegationClaims(delegationId), 1, 'exactly one slot was spent');
});

test('a dispatch survives a restart as spent, and cannot be redelivered', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));
  assert.equal(
    h.dispatch().authorizeDelegatedRun({ connection: CONNECTION, request: { delegationId, proposalId } })
      .decision.admitted, true,
  );

  const reopened = h.restart();
  assert.equal(reopened.countDelegationClaims(delegationId), 1, 'the slot is still spent');
  assert.equal(reopened.getRunAuthority(proposalId)?.authority, 'DELEGATED_RUN');

  const outcome = h.dispatch({ store: reopened }).authorizeDelegatedRun({
    connection: CONNECTION, request: { delegationId, proposalId },
  });
  assert.equal(denialCode(outcome), 'PROPOSAL_NOT_STAGED');
  assert.equal(reopened.countDelegationClaims(delegationId), 1);
});

test('a restart with a different adapter session cannot use the old delegation', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));

  const reopened = h.restart();
  const outcome = h.dispatch({ store: reopened }).authorizeDelegatedRun({
    connection: { ownerId: 'owner_1', sessionId: 'session_after_reload', adapterId: ADAPTER },
    request: { delegationId, proposalId },
  });
  assert.equal(denialCode(outcome), 'SESSION_MISMATCH');
  assertNoEffect(reopened, delegationId, proposalId);
});

// ---------------------------------------------------------------------------------------------
// Staging is bounded in every direction the browser can push
// ---------------------------------------------------------------------------------------------

test('staging validates its inputs rather than trusting a parameter type', async (t) => {
  const h = await harness(t);
  for (const [field, value] of [
    ['tool', ''], ['tool', 'x'.repeat(129)], ['tool', 42],
    ['workspaceId', ''], ['workspaceId', null],
    ['origin', ''], ['origin', 'not-a-url'], ['origin', 'https://chatgpt.com/path'],
    ['origin', 'https://chatgpt.com/'],
  ] as Array<[string, unknown]>) {
    const outcome = h.stage(undefined, { [field]: value });
    assert.equal(outcome.staged, false, `${field}=${String(value)}`);
    assert.equal((outcome as { code: string }).code, 'STAGING_INPUT_INVALID', `${field}=${String(value)}`);
  }
});

test('the staged field bounds catch what the v4 argument schema cannot see', async (t) => {
  // These two checks overlap almost everywhere, which a mutation exposed: with the field bounds
  // removed, every case the suite tested still refused, because v4's argument schema or the origin
  // parse caught it under the same code. This is where they do not overlap — `health` takes no
  // `workspace_id`, so there is nothing for the argument schema to cross-check the staged
  // `workspaceId` against, and only the field bound sees that it is 300 characters long.
  //
  // Reachable only on a direct plane call: through the router the envelope schema bounds the field
  // first, so this is about the plane's own contract rather than the transport's.
  const h = await harness(t);
  const refused = h.dispatch().stageProposal({
    connection: CONNECTION,
    tool: 'health',
    workspaceId: 'x'.repeat(300),
    origin: 'https://chatgpt.com',
    arguments: {},
  });
  assert.equal(refused.staged, false);
  assert.equal((refused as unknown as { code: string }).code, 'STAGING_INPUT_INVALID');
  assert.match((refused as unknown as { detail: string }).detail, /workspaceId must be a string of 1\.\.256/);
  assert.equal(h.store.countAllStagedProposals(CONNECTION.sessionId, ADAPTER), 0);
});

test('an undelegated stage/run loop cannot grow the store without limit', async (t) => {
  // The queue bound alone was not a bound: it counts open rows, and running one frees a slot, so
  // a stage/run loop grew the tables without limit. Measured by a review.
  const h = await harness(t);
  const plane = h.dispatch();
  let staged = 0;
  let refusal: { code: string } | undefined;
  for (let i = 0; i < 700; i += 1) {
    const outcome = h.stage(undefined, { arguments: { workspace_id: 'ws_1', query: `q${i}` } });
    if (!outcome.staged) { refusal = outcome as { code: string }; break; }
    staged += 1;
    plane.recordHumanRun({ connection: CONNECTION, proposalId: (outcome as { proposalId: string }).proposalId });
  }
  assert.equal(refusal?.code, 'STAGING_LIMIT_REACHED', 'the loop is stopped by a total cap');
  assert.ok(staged < 700, `the loop terminated after ${staged} rows rather than running to completion`);
  assert.equal(
    h.store.countAllStagedProposals(CONNECTION.sessionId, CONNECTION.adapterId), staged,
    'and the total is exactly what was staged',
  );
});

test('the open queue is bounded even when nothing is ever run', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < MAX_OPEN_STAGED_PER_SESSION; i += 1) {
    assert.equal(h.stage(undefined, { arguments: { workspace_id: 'ws_1', query: `q${i}` } }).staged,
      true, `staging ${i + 1}`);
  }
  const refused = h.stage(undefined, { arguments: { workspace_id: 'ws_1', query: 'one too many' } });
  assert.equal((refused as { code: string }).code, 'STAGING_LIMIT_REACHED');
});

test('staging is rate limited per browser context', async (t) => {
  const h = await harness(t);
  const plane = new UiDelegationDispatchPlane({
    port: createDelegationDispatchPort(h.store),
    killSwitch: () => false,
    now: () => 1_000_000,
    rateLimit: createProposalRateLimit({ attempts: 3, windowMs: 60_000 }),
  });
  const stage = (query: string) => plane.stageProposal({
    connection: CONNECTION, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com', arguments: { workspace_id: 'ws_1', query },
  });
  for (let i = 0; i < 3; i += 1) assert.equal(stage(`q${i}`).staged, true, `attempt ${i + 1}`);
  const refused = stage('one too many');
  assert.equal(refused.staged, false);
  assert.equal((refused as { code: string }).code, 'STAGING_RATE_LIMITED');
});

// ---------------------------------------------------------------------------------------------
// The audit distinction, including refusals
// ---------------------------------------------------------------------------------------------

test('HUMAN_RUN and DELEGATED_RUN are distinguishable by record, and cannot be confused', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const delegated = stagedId(h.stage(delegationId));
  const human = stagedId(h.stage(undefined));

  h.dispatch().authorizeDelegatedRun({ connection: CONNECTION, request: { delegationId, proposalId: delegated } });
  assert.deepEqual(h.dispatch().recordHumanRun({ connection: CONNECTION, proposalId: human }), { ok: true });

  const d = h.store.getRunAuthority(delegated);
  assert.equal(d?.authority, 'DELEGATED_RUN');
  assert.equal(d?.goalId, GOAL);
  assert.equal(d?.delegationId, delegationId);
  assert.equal(d?.controllerId, CONTROLLER);

  const m = h.store.getRunAuthority(human);
  assert.equal(m?.authority, 'HUMAN_RUN');
  assert.equal(m?.goalId, undefined, 'a human Run names no goal');
  assert.equal(m?.delegationId, undefined);

  assert.throws(
    () => (h.store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('UPDATE run_authority SET delegation_id = ? WHERE proposal_id = ?')
      .run(delegationId, human),
    /CHECK constraint failed/,
  );
});

test('a delegated proposal cannot be laundered through the human path', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));
  const outcome = h.dispatch().recordHumanRun({ connection: CONNECTION, proposalId });
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { code: string }).code, 'PROPOSAL_IS_DELEGATED');
  assertNoEffect(h.store, delegationId, proposalId);
});

test('every refusal is recorded as DELEGATED_RUN_REFUSED with its reason', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));
  const plane = h.dispatch();

  plane.authorizeDelegatedRun({ connection: CONNECTION, request: { delegationId, proposalId, goalId: 'x' } });
  plane.authorizeDelegatedRun({
    connection: { ownerId: 'owner_1', sessionId: 'session_2', adapterId: ADAPTER },
    request: { delegationId, proposalId },
  });

  const mine = h.store.listDelegatedRunRefusals({
    sessionId: CONNECTION.sessionId, adapterId: ADAPTER,
  });
  assert.deepEqual(mine.map((r) => r.reasonCode), ['REQUEST_MALFORMED']);
  assert.equal(mine[0]?.authority, 'DELEGATED_RUN_REFUSED');
  assert.equal(mine[0]?.slotClaimed, false, 'refused before the claim, so nothing was spent');

  // The refusal is recorded against the context that made it, not the one that holds the grant.
  const other = h.store.listDelegatedRunRefusals({ sessionId: 'session_2', adapterId: ADAPTER });
  assert.deepEqual(other.map((r) => r.reasonCode), ['SESSION_MISMATCH']);
});

test('the audit records identity, not content', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const secret = 'correct-horse-battery-staple';
  const proposalId = stagedId(h.stage(delegationId, {
    arguments: { workspace_id: 'ws_1', query: secret },
  }));
  h.dispatch().authorizeDelegatedRun({ connection: CONNECTION, request: { delegationId, proposalId } });

  const row = h.store.getRunAuthority(proposalId);
  assert.ok(row);
  assert.equal(JSON.stringify(row).includes(secret), false,
    'the audit row carries ids and a hash, never the arguments themselves');
  assert.match(row.proposalFingerprint, /^fp_[a-f0-9]{64}$/);

  // And the refusal log carries no content either.
  h.dispatch().authorizeDelegatedRun({ connection: CONNECTION, request: { delegationId, proposalId } });
  const refusals = h.store.listDelegatedRunRefusals({ sessionId: CONNECTION.sessionId, adapterId: ADAPTER });
  assert.equal(JSON.stringify(refusals).includes(secret), false);
});

test('an unknown delegation or proposal is refused rather than treated as unrestricted', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const plane = h.dispatch();
  assert.equal(
    denialCode(plane.authorizeDelegatedRun({
      connection: CONNECTION,
      request: { delegationId: 'uidel_does_not_exist_at_all', proposalId: `prop_${'a'.repeat(24)}` },
    })),
    'NO_DELEGATION',
  );
  assert.equal(
    denialCode(plane.authorizeDelegatedRun({
      connection: CONNECTION, request: { delegationId, proposalId: `prop_${'a'.repeat(24)}` },
    })),
    'NO_PROPOSAL',
  );
});

test('a delegation whose stored bindings will not parse denies rather than throwing', async (t) => {
  const h = await harness(t);
  h.store.insertUiDelegation({
    delegationId: 'uidel_broken_but_present', goalId: GOAL, controllerId: CONTROLLER,
    createdAt: 1_000_000, notBefore: 1_000_000, expiresAt: 1_060_000, bindings: 'not json at all',
  });
  const outcome = h.dispatch({ configuredDelegationId: 'uidel_broken_but_present' })
    .authorizeDelegatedRun({
      connection: CONNECTION,
      request: { delegationId: 'uidel_broken_but_present', proposalId: `prop_${'a'.repeat(24)}` },
    });
  assert.equal(denialCode(outcome), 'DELEGATION_MALFORMED');
});

// ---------------------------------------------------------------------------------------------
// Findings from the second adversarial review
// ---------------------------------------------------------------------------------------------

test('a result may only be attached by the context that staged the proposal', async (t) => {
  // Measured before the fix: a second context attached a result id to another context's audit
  // row and — since the attach is single-use — permanently denied the legitimate one. This was
  // the only method on the browser-reachable plane without an identity check.
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));
  const plane = h.dispatch();
  assert.equal(
    plane.authorizeDelegatedRun({ connection: CONNECTION, request: { delegationId, proposalId } })
      .decision.admitted, true,
  );

  const intruder = plane.attachResult({
    connection: { ownerId: 'owner_2', sessionId: 'session_other', adapterId: ADAPTER },
    proposalId, resultId: 'res_from_someone_else',
  });
  assert.equal(intruder.ok, false);
  assert.equal((intruder as { code: string }).code, 'PROPOSAL_NOT_OWNED');
  assert.equal(h.store.getRunAuthority(proposalId)?.resultId, undefined, 'and nothing was written');

  // The owner can still attach, which is what the intruder would otherwise have denied it.
  assert.deepEqual(plane.attachResult({ connection: CONNECTION, proposalId, resultId: 'res_1' }), { ok: true });
  assert.equal(h.store.getRunAuthority(proposalId)?.resultId, 'res_1');
  const again = plane.attachResult({ connection: CONNECTION, proposalId, resultId: 'res_2' });
  assert.equal((again as { code: string }).code, 'RESULT_ALREADY_ATTACHED');
});

test('dispatch is rate limited, and a rate refusal writes nothing at all', async (t) => {
  // The refusal log was bounded in rows but not in writes: every attempt, including one with no
  // delegation configured, was a full transaction. 400 attempts measured as 400 of them.
  const h = await harness(t);
  const plane = new UiDelegationDispatchPlane({
    port: createDelegationDispatchPort(h.store),
    killSwitch: () => false,
    now: () => 1_000_000,
    dispatchRateLimit: createProposalRateLimit({ attempts: 3, windowMs: 60_000 }),
  });
  const attempt = () => plane.authorizeDelegatedRun({
    connection: CONNECTION,
    request: { delegationId: `uidel_${'a'.repeat(24)}`, proposalId: `prop_${'b'.repeat(24)}` },
  });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(denialCode(attempt()), 'NO_DELEGATION', `attempt ${i + 1}`);
  }
  const limited = attempt();
  assert.equal(denialCode(limited), 'DISPATCH_RATE_LIMITED');
  assert.equal(limited.slotClaimed, false);

  const rows = h.store.listDelegatedRunRefusals({ sessionId: CONNECTION.sessionId, adapterId: ADAPTER });
  assert.equal(rows.length, 3, 'the three that got through were audited, the rate refusal was not');
  assert.deepEqual([...new Set(rows.map((r) => r.reasonCode))], ['NO_DELEGATION']);
});

test('one goal holds one live delegation, and renew is how it is replaced', async (t) => {
  // "One goal, one parent delegation" was a convention: `issue` enforced nothing, so calling it
  // twice produced two live rows and two full budgets — bypassing the revoked/superseded checks
  // that `renew` makes.
  const h = await harness(t);
  const first = h.issue();
  assert.throws(
    () => h.control().issue({ goalId: GOAL, ttlMs: 60_000, bindings: BINDINGS }),
    /second live delegation for goal_abc/,
  );
  assert.equal(h.control().revoke(first), true);
  assert.doesNotThrow(
    () => h.control().issue({ goalId: GOAL, ttlMs: 60_000, bindings: BINDINGS }),
    'revoking frees the goal',
  );
});

test('a delegation may not be scheduled to begin beyond the window ceiling', async (t) => {
  const h = await harness(t);
  assert.throws(
    () => h.control().issue({
      goalId: 'goal_future', ttlMs: 60_000, notBeforeMs: 5 * 60 * 60 * 1000,
      bindings: { ...BINDINGS, goalId: 'goal_future' },
    }),
    /may not start more than/,
  );
});

test('a store whose delegation tables lack their constraints is refused at open', async (t) => {
  // Column names alone were not enough: a review built a store with every required column and no
  // CHECK, no PRIMARY KEY and no FOREIGN KEY, opened it without complaint, and wrote a HUMAN_RUN
  // row carrying a delegation id — the thing the ADR calls impossible.
  const dir = await mkdtemp(join(tmpdir(), 'wag-noconstraints-'));
  const file = join(dir, 'weak.sqlite');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const { DatabaseSync } = await import('node:sqlite');
  const weak = new DatabaseSync(file);
  weak.exec('CREATE TABLE run_authority ('
    + 'proposal_id TEXT, authority TEXT, goal_id TEXT, delegation_id TEXT, controller_id TEXT, '
    + 'dispatched_at INTEGER, proposal_fingerprint TEXT, tool TEXT, workspace_id TEXT, '
    + 'session_id TEXT, adapter_id TEXT, origin TEXT, result_id TEXT)');
  weak.close();

  assert.throws(
    () => new SqliteDurableStore(file),
    /run_authority table without the constraints this schema relies on/,
  );
});

test('refusing a pre-acceptance store leaves the file unchanged', async (t) => {
  // A check whose stated job is "refuse at open" was handing the old store four new tables first.
  const dir = await mkdtemp(join(tmpdir(), 'wag-oldshape2-'));
  const file = join(dir, 'old.sqlite');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE staged_proposals ('
    + 'proposal_id TEXT PRIMARY KEY, delegation_id TEXT, tool TEXT, workspace_id TEXT, '
    + 'origin TEXT, arguments TEXT, session_id TEXT, adapter_id TEXT, staged_at INTEGER, '
    + 'fingerprint TEXT, dispatched_at INTEGER)');
  const listTables = (db: { prepare(s: string): { all(): unknown } }) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>).map((r) => r.name);
  const before = listTables(old);
  old.close();

  assert.throws(() => new SqliteDurableStore(file), /pre-acceptance staged_proposals table/);

  const after = new DatabaseSync(file);
  const tables = listTables(after);
  after.close();
  assert.deepEqual(tables, before, 'the refused store gained no tables on the way out');
});

test('a throw after the claim still records that a slot was spent', async (t) => {
  // Contention *raises* out of the store rather than returning a code — deliberately, and pinned
  // by its own test. Without a catch here, an exception between the claim and the dispatch escaped
  // having spent a slot and written nothing at all: no refusal row, no `slot_claimed` flag, and a
  // CLAIMED row for recovery to find with no record of why.
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));

  const real = createDelegationDispatchPort(h.store);
  const exploding = {
    ...real,
    markDelegatedDispatched: () => { throw new Error('SQLITE_BUSY: database is locked'); },
  };
  const plane = new UiDelegationDispatchPlane({
    port: exploding, killSwitch: () => false, now: () => 1_000_000,
    configuredDelegationId: delegationId,
  });

  assert.throws(
    () => plane.authorizeDelegatedRun({ connection: CONNECTION, request: { delegationId, proposalId } }),
    /SQLITE_BUSY/,
    'the failure still propagates; it simply stops being silent about what it cost',
  );

  assert.equal(h.store.countDelegationClaims(delegationId), 1, 'the slot really was spent');
  assert.equal(h.store.getStagedProposalRow(proposalId)?.state, 'CLAIMED');
  const rows = h.store.listDelegatedRunRefusals({ sessionId: CONNECTION.sessionId, adapterId: ADAPTER });
  assert.equal(rows.length, 1, 'and the spend is on the record');
  assert.equal(rows[0]?.reasonCode, 'DISPATCH_FAILED_AFTER_CLAIM');
  assert.equal(rows[0]?.slotClaimed, true);
  assert.equal(rows[0]?.goalId, GOAL);

  // Recovery retires it without releasing the slot or running it.
  assert.equal(h.store.abandonExpiredClaims(1_000_000 + 120_000, 60_000), 1);
  assert.equal(h.store.getStagedProposalRow(proposalId)?.state, 'ABANDONED');
  assert.equal(h.store.countDelegationClaims(delegationId), 1);
  assert.equal(h.store.getRunAuthority(proposalId), undefined);
});

test('a refusal after the claim reports slotClaimed, and one before it does not', async (t) => {
  const h = await harness(t);
  const delegationId = h.issue();
  const proposalId = stagedId(h.stage(delegationId));

  // Before the claim: the policy refuses, nothing is spent.
  const before = h.dispatch().authorizeDelegatedRun({
    connection: { ownerId: 'owner_1', sessionId: 'session_2', adapterId: ADAPTER },
    request: { delegationId, proposalId },
  });
  assert.equal(before.slotClaimed, false);
  assert.equal(h.store.countDelegationClaims(delegationId), 0);

  // After the claim: a port whose dispatch refuses rather than throws.
  const real = createDelegationDispatchPort(h.store);
  const refusing = {
    ...real,
    markDelegatedDispatched: () => ({
      ok: false as const, code: 'PROPOSAL_NOT_CLAIMED', detail: 'left CLAIMED concurrently',
    }),
  };
  const plane = new UiDelegationDispatchPlane({
    port: refusing, killSwitch: () => false, now: () => 1_000_000,
    configuredDelegationId: delegationId,
  });
  const after = plane.authorizeDelegatedRun({
    connection: CONNECTION, request: { delegationId, proposalId },
  });
  assert.equal(after.decision.admitted, false);
  assert.equal(after.slotClaimed, true, 'the slot is spent and the caller is told so');
  assert.equal(h.store.countDelegationClaims(delegationId), 1);
  const rows = h.store.listDelegatedRunRefusals({ sessionId: CONNECTION.sessionId, adapterId: ADAPTER });
  assert.equal(rows.at(-1)?.slotClaimed, true);
});
