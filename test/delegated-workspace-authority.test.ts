/**
 * A delegated Run may only act in a workspace its own browser context owns.
 *
 * ## The production failure this closes
 *
 * On 2026-09-22 a human-submitted prompt produced a real `DELEGATED_RUN`: the extension observed
 * one candidate, WAG admitted it, a budget slot was spent and the audit row was written. It then
 * produced nothing. The workspace the delegation named was owned by a `…operator.v4` session; the
 * delegated caller was `…delegation.v5`; and `AdmittedWorkspaceService.sameAuthority` requires the
 * owner, session **and** adapter to match, so every tool refused the work the audit row asserted.
 *
 * That refusal is correct and is not weakened here. The defect was upstream of it: **nothing
 * refused the delegation earlier**, so an impossible run cost a slot that single-assignment state
 * can never return.
 *
 * So the ownership fact is now asked twice on the delegated path, both times before the CLAIM:
 *
 *   at staging    a candidate whose delegated workspace belongs elsewhere never becomes a row
 *   at dispatch   re-read from durable state, because the two moments are far apart
 *
 * ## What is deliberately *not* asserted here
 *
 * That a v5 session can acquire a workspace at all — `delegated-run-production-runtime.test.ts`
 * already drives the real v5 `run.stage` + `run.human` path for `workspace.open` end to end, and
 * `admitted-workspace.test.ts` pins the tuple stamping and the restart reopen. Those are the
 * mechanism; this file is the refusal.
 */
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
  UiDelegationDispatchPlane,
} from '../src/goal-ui-delegation-dispatch.js';
import { createProposalRateLimit } from '../src/proposal-rate-limit.js';
import type { ConnectionIdentity, UiDelegationBindings } from '../src/goal-ui-delegation.js';
import { giveWorkspace } from './support/workspace-fixture.js';

const CONTROLLER = 'local.operator.cli';
const GOAL = 'goal_workspace_authority';
const ORIGIN = 'https://chatgpt.com';
const TOOL = 'repo.search';
const WORKSPACE = 'ws_delegated';
const V5 = 'browser.chatgpt.native.delegation.v5';
const V4 = 'browser.chatgpt.native.operator.v4';

/** The v5 context the delegation is bound to. Every case below varies the workspace, not this. */
const CALLER: ConnectionIdentity = {
  ownerId: 'owner_local', sessionId: 'session_v5_0001', adapterId: V5,
};

const BINDINGS: UiDelegationBindings = {
  goalId: GOAL,
  controllerId: CONTROLLER,
  allowedOrigins: [ORIGIN],
  allowedTools: [TOOL],
  workspaceId: WORKSPACE,
  sessionId: CALLER.sessionId,
  adapterId: V5,
  maxActions: 4,
};

const ARGS = { workspace_id: WORKSPACE, query: 'needle' };

interface Harness {
  readonly store: SqliteDurableStore;
  readonly delegationId: string;
  own(over?: Partial<ConnectionIdentity>): void;
  plane(): UiDelegationDispatchPlane;
  stage(): ReturnType<UiDelegationDispatchPlane['stageProposal']>;
  restart(): void;
}

async function harness(t: test.TestContext): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'wag-ws-authority-'));
  const file = join(directory, 'state.sqlite');
  let store = new SqliteDurableStore(file);
  const opened = [store];
  t.after(async () => {
    for (const s of opened) { try { s.close(); } catch { /* already closed */ } }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });

  const { delegationId } = new UiDelegationControlPlane({
    store, key: createControllerPlaneKey(CONTROLLER),
  }).issue({ goalId: GOAL, ttlMs: 60 * 60_000, bindings: BINDINGS });

  const h: Harness = {
    get store() { return store; },
    delegationId,
    /** Write the workspace row, owned by the v5 caller unless a case overrides part of the tuple. */
    own(over: Partial<ConnectionIdentity> = {}) {
      giveWorkspace(store, { workspaceId: WORKSPACE, ...CALLER, ...over });
    },
    plane: () => new UiDelegationDispatchPlane({
      port: createDelegationDispatchPort(store),
      killSwitch: () => false,
      configuredDelegationId: delegationId,
      rateLimit: createProposalRateLimit({ attempts: 10_000 }),
      dispatchRateLimit: createProposalRateLimit({ attempts: 10_000 }),
    }),
    stage: () => h.plane().stageProposal({
      connection: CALLER, delegationId, tool: TOOL,
      workspaceId: WORKSPACE, origin: ORIGIN, arguments: ARGS,
    }),
    restart: () => { store.close(); store = new SqliteDurableStore(file); opened.push(store); },
  };
  return h;
}

const refusal = (outcome: { staged: boolean }): { code: string; detail: string } => {
  assert.equal(outcome.staged, false, `expected a refusal: ${JSON.stringify(outcome)}`);
  return outcome as unknown as { code: string; detail: string };
};

const stagedId = (outcome: { staged: boolean }): string => {
  assert.equal(outcome.staged, true, `expected staging to succeed: ${JSON.stringify(outcome)}`);
  return (outcome as unknown as { proposalId: string }).proposalId;
};

/** Nothing was spent and nothing was asserted: the two things the production dead end got wrong. */
function assertNothingSpent(store: SqliteDurableStore, delegationId: string, proposalId?: string) {
  assert.equal(store.countDelegationClaims(delegationId), 0, 'a budget slot was spent');
  if (proposalId !== undefined) {
    assert.equal(store.getRunAuthority(proposalId), undefined, 'a run-authority row was written');
    assert.equal(store.getStagedProposalRow(proposalId)?.state, 'STAGED', 'the proposal moved');
  }
}

// ---------------------------------------------------------------------------------------------
// The exact production shape
// ---------------------------------------------------------------------------------------------

test('a v4-owned workspace and a v5 session: refused, and nothing is staged', async (t) => {
  const h = await harness(t);
  // Precisely the store the failed proof had: the workspace exists, its root is fine, its id is
  // the one the delegation binds — and a v4 session opened it.
  h.own({ adapterId: V4, sessionId: 'session_v4_0001' });

  const refused = refusal(h.stage());
  assert.equal(refused.code, 'WORKSPACE_NOT_OWNED');
  assert.match(refused.detail, /different owner, session or adapter/);
  assertNothingSpent(h.store, h.delegationId);
  assert.equal(
    h.store.countAllStagedProposals(CALLER.sessionId, V5), 0,
    'a candidate that can never run must not become a row',
  );
});

test('a v5-owned workspace with the matching session and adapter is admitted', async (t) => {
  const h = await harness(t);
  h.own();

  const proposalId = stagedId(h.stage());
  const outcome = h.plane().authorizeDelegatedRun({
    connection: CALLER, request: { delegationId: h.delegationId, proposalId },
  });
  assert.equal(outcome.decision.admitted, true, JSON.stringify(outcome.decision));
  assert.equal(outcome.authorization?.workspaceId, WORKSPACE);
  assert.equal(h.store.getRunAuthority(proposalId)?.authority, 'DELEGATED_RUN');
  assert.equal(h.store.countDelegationClaims(h.delegationId), 1, 'exactly one slot, for real work');
});

// ---------------------------------------------------------------------------------------------
// Every part of the tuple is load-bearing
// ---------------------------------------------------------------------------------------------

test('cross-session, cross-adapter and cross-owner are each refused on their own', async (t) => {
  const cases: Array<[string, Partial<ConnectionIdentity>]> = [
    ['another session on the same adapter', { sessionId: 'session_v5_0002' }],
    ['the same session id on another adapter', { adapterId: V4 }],
    ['another local principal entirely', { ownerId: 'owner_someone_else' }],
  ];
  for (const [what, over] of cases) {
    const h = await harness(t);
    h.own(over);
    const refused = refusal(h.stage());
    assert.equal(refused.code, 'WORKSPACE_NOT_OWNED', what);
    assertNothingSpent(h.store, h.delegationId);
  }
});

test('a workspace id that resolves to no row denies, rather than reading as unconstrained', async (t) => {
  const h = await harness(t);
  // No `own()` call at all. An absent row is the classic place an allowlist fails open.
  const refused = refusal(h.stage());
  assert.equal(refused.code, 'WORKSPACE_NOT_OWNED');
  assert.match(refused.detail, /does not exist/);
  assertNothingSpent(h.store, h.delegationId);
});

// ---------------------------------------------------------------------------------------------
// The guarantee is at dispatch, not the fail-fast at staging
// ---------------------------------------------------------------------------------------------

test('ownership lost between staging and dispatch costs no claim and no budget', async (t) => {
  const h = await harness(t);
  h.own();
  const proposalId = stagedId(h.stage());

  // The row changes under WAG between the ask and the act. Staging's copy of this check has
  // already passed, so if it were the only one the slot would be gone before anything noticed.
  h.own({ adapterId: V4 });

  const outcome = h.plane().authorizeDelegatedRun({
    connection: CALLER, request: { delegationId: h.delegationId, proposalId },
  });
  assert.equal(outcome.decision.admitted, false);
  assert.equal((outcome.decision as { code: string }).code, 'WORKSPACE_NOT_OWNED');
  assert.equal(outcome.slotClaimed, false, 'the refusal must land before the CLAIM');
  assertNothingSpent(h.store, h.delegationId, proposalId);
});

test('at dispatch, every part of the tuple is compared — not just the adapter', async (t) => {
  // Found by mutation: removing the `ownerId` clause, or the `sessionId` clause, or both, left
  // this suite green. Staging refuses those two cases first, so nothing reached the policy's copy
  // of the check with only the owner or only the session wrong — and a guard no test reaches is
  // the defect this milestone exists to fix, not one to reintroduce one layer down.
  //
  // So the row is re-owned *after* staging, which is the one ordering staging cannot cover.
  const cases: Array<[string, Partial<ConnectionIdentity>]> = [
    ['a different local principal', { ownerId: 'owner_someone_else' }],
    ['a different v5 session', { sessionId: 'session_v5_0002' }],
    ['a different adapter', { adapterId: V4 }],
  ];
  for (const [what, over] of cases) {
    const h = await harness(t);
    h.own();
    const proposalId = stagedId(h.stage());
    h.own(over);

    const outcome = h.plane().authorizeDelegatedRun({
      connection: CALLER, request: { delegationId: h.delegationId, proposalId },
    });
    assert.equal(outcome.decision.admitted, false, what);
    assert.equal((outcome.decision as { code: string }).code, 'WORKSPACE_NOT_OWNED', what);
    assert.equal(outcome.slotClaimed, false, what);
    assertNothingSpent(h.store, h.delegationId, proposalId);
  }
});

test('a delegation whose bindings are not an object denies rather than throwing', async (t) => {
  // Why the workspace lookup at dispatch reads the id defensively: the bindings have only been
  // JSON-parsed at that point, and `null.workspaceId` would throw on the one path that ends in a
  // consequence. The *value* it falls back to is unobservable — the policy denies malformed
  // bindings before the workspace check — but the absence of a throw is not.
  const h = await harness(t);
  h.own();
  const proposalId = stagedId(h.stage());
  (h.store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    .prepare('UPDATE ui_delegations SET bindings = ? WHERE delegation_id = ?')
    .run('null', h.delegationId);

  const outcome = h.plane().authorizeDelegatedRun({
    connection: CALLER, request: { delegationId: h.delegationId, proposalId },
  });
  assert.equal(outcome.decision.admitted, false);
  assert.equal((outcome.decision as { code: string }).code, 'DELEGATION_MALFORMED');
  assertNothingSpent(h.store, h.delegationId, proposalId);
});

test('a delegation whose workspace never existed is refused at dispatch too', async (t) => {
  const h = await harness(t);
  h.own();
  const proposalId = stagedId(h.stage());
  // Delete the row rather than re-owning it: `undefined` and "owned elsewhere" are different
  // inputs and both must deny.
  (h.store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    .prepare('DELETE FROM workspaces WHERE workspace_id = ?').run(WORKSPACE);

  const outcome = h.plane().authorizeDelegatedRun({
    connection: CALLER, request: { delegationId: h.delegationId, proposalId },
  });
  assert.equal((outcome.decision as { code: string }).code, 'WORKSPACE_NOT_OWNED');
  assert.equal(outcome.slotClaimed, false);
  assertNothingSpent(h.store, h.delegationId, proposalId);
});

// ---------------------------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------------------------

test('ownership survives a restart, so the delegated path still works after one', async (t) => {
  const h = await harness(t);
  h.own();
  const proposalId = stagedId(h.stage());

  h.restart();

  const outcome = h.plane().authorizeDelegatedRun({
    connection: CALLER, request: { delegationId: h.delegationId, proposalId },
  });
  assert.equal(outcome.decision.admitted, true, JSON.stringify(outcome.decision));
  const stored = h.store.getWorkspace(WORKSPACE);
  assert.deepEqual(
    { ownerId: stored?.ownerId, sessionId: stored?.sessionId, adapterId: stored?.adapterId },
    { ...CALLER },
    'the tuple on the row is the one the delegation was issued against',
  );
});

// ---------------------------------------------------------------------------------------------
// The human path is untouched
// ---------------------------------------------------------------------------------------------

test('an undelegated stage is unaffected by workspace ownership', async (t) => {
  const h = await harness(t);
  // No workspace row at all, and a workspace some other adapter owns: neither matters here.
  // ADR-0026 is unchanged where no delegation authorises the proposal, and the human path has its
  // own resolution at execution — adding this check there would refuse a person their own Run.
  const withoutRow = h.plane().stageProposal({
    connection: CALLER, tool: TOOL, workspaceId: WORKSPACE, origin: ORIGIN, arguments: ARGS,
  });
  stagedId(withoutRow);

  h.own({ adapterId: V4 });
  const withForeignRow = h.plane().stageProposal({
    connection: CALLER, tool: TOOL, workspaceId: WORKSPACE, origin: ORIGIN, arguments: ARGS,
  });
  stagedId(withForeignRow);
});

test('the refusal is recorded as its own reason code, distinct from a binding mismatch', async (t) => {
  const h = await harness(t);
  h.own({ adapterId: V4 });
  const proposalId = 'prop_never_staged_00000000';

  const outcome = h.plane().authorizeDelegatedRun({
    connection: CALLER, request: { delegationId: h.delegationId, proposalId },
  });
  // No proposal, so this one stops earlier — the point is that the two codes are different words
  // for different facts, and an operator reading the audit can tell them apart.
  assert.equal((outcome.decision as { code: string }).code, 'NO_PROPOSAL');

  h.own();
  const staged = stagedId(h.stage());
  const mismatch = h.plane().stageProposal({
    connection: CALLER, delegationId: h.delegationId, tool: TOOL,
    workspaceId: 'ws_not_the_delegated_one', origin: ORIGIN,
    arguments: { workspace_id: 'ws_not_the_delegated_one', query: 'needle' },
  });
  assert.equal(refusal(mismatch).code, 'WORKSPACE_MISMATCH', 'a binding mismatch keeps its code');
  assert.ok(staged.startsWith('prop_'));
});
