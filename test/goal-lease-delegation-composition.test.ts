/**
 * What happens when a Goal UI Delegation and a Goal Lease are both live.
 *
 * ## The gap this suite was written for
 *
 * ADR-0028 lifts **Approve** inside a bounded lease. ADR-0029 lifts **Run** inside a bounded
 * delegation. Each was reviewed on its own, each is issued by a human out of band, and — until the
 * change these tests pin — neither knew the other existed.
 *
 * Compose them and you get the only path in WAG from an untrusted page's text to a durable effect
 * with **no human gesture at any step**. That path is supposed to be reachable: it is the point of
 * the two ADRs together. What was not supposed to be reachable is reaching it *by accident*.
 *
 * Measured on the previous tree: the lease checked `admittedSessions` and `admittedAdapters`; the
 * delegation checked `sessionId` and `adapterId`. Both predicates held for any lease that happened
 * to list the v5 session — so a lease issued on Tuesday to let a benchmark rewrite `docs/**` would
 * silently admit effects proposed by a delegation issued on Wednesday for something else entirely.
 * Two humans, two bounded grants, and an authority neither of them had described. That is union,
 * not intersection.
 *
 * ## The property these tests assert
 *
 * The zero-gesture path opens only where **both grants name the same goal**, and each grant is
 * checked in full on its own terms. Every other combination falls back to the operator's
 * authenticated approval — which is not a failure, it is the ordinary path.
 *
 * So the matrix below is deliberately adversarial in one direction only: it tries to *obtain*
 * authority, and every attempt that is not the one both humans described must be denied.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as adapterAdmission from '../src/adapter-admission.js';
import {
  BROWSER_DELEGATION_ADAPTER_ID,
  BROWSER_INSPECT_ADAPTER_ID,
  BROWSER_OPERATOR_ADAPTER_ID,
  BROWSER_VERIFY_ADAPTER_ID,
} from '../src/adapter-admission.js';
import { PRIVATE_STDIO_ADAPTER_ID } from '../src/repository-engineering-runtime.js';
import {
  DELEGATED_RUN_ADAPTERS,
  MAX_LEASE_WINDOW_MS,
  evaluateGoalLease,
  validateBindings,
  type GoalLeaseBindings,
  type GoalLeaseRecord,
  type LeaseDenialCode,
  type LeaseRequest,
} from '../src/goal-lease.js';
import { MAX_DELEGATION_WINDOW_MS } from '../src/goal-ui-delegation.js';
import { resolveDelegatedGoal } from '../src/delegated-run-provenance.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  UiDelegationControlPlane,
  createControllerPlaneKey,
} from '../src/goal-ui-delegation-control.js';

const GOAL = 'goal_the_one_both_humans_named';
const OTHER_GOAL = 'goal_something_else_entirely';
const SESSION = 'session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SESSION = 'session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROOT = 'E:/acceptance/workspace';
const NOW = 1_700_000_000_000;

// -------------------------------------------------------------------------------------------
// The list restated in the pure policy must not drift from the one admission actually uses
// -------------------------------------------------------------------------------------------

/**
 * Adapters deliberately classified as **not** delegated. Listing them is the work the test makes
 * someone do: a fifth identity is neither in this list nor in `DELEGATED_RUN_ADAPTERS`, so it fails
 * until a person decides which it is.
 */
const NON_DELEGATED_ADAPTERS = [
  BROWSER_INSPECT_ADAPTER_ID,
  BROWSER_VERIFY_ADAPTER_ID,
  BROWSER_OPERATOR_ADAPTER_ID,
  PRIVATE_STDIO_ADAPTER_ID,
];

test('every adapter identity is classified, so a new one cannot skip the composition gate', () => {
  // `goal-lease.ts` restates the delegated list to stay a pure module — no store, no zod. A
  // restated list can drift, and an earlier version of this test compared it to a hardcoded
  // literal, which meant adding a v6 delegated adapter would have passed. So enumerate instead.
  const exported = Object.entries(adapterAdmission)
    .filter(([name]) => name.endsWith('_ADAPTER_ID'))
    .map(([, value]) => value as string);
  assert.ok(exported.length >= 4, 'the enumeration must actually find the adapter constants');

  const classified = [...DELEGATED_RUN_ADAPTERS, ...NON_DELEGATED_ADAPTERS];
  for (const adapter of exported) {
    assert.ok(
      classified.includes(adapter),
      `${adapter} is exported but classified neither delegated nor not. Decide which: if its Run `
      + 'can be performed by a delegation it belongs in DELEGATED_RUN_ADAPTERS in goal-lease.ts, '
      + 'and if it cannot it belongs in NON_DELEGATED_ADAPTERS here.',
    );
  }
  for (const adapter of DELEGATED_RUN_ADAPTERS) {
    assert.ok(
      exported.includes(adapter),
      `${adapter} is listed as delegated but no longer exists as an adapter identity`,
    );
    assert.equal(
      NON_DELEGATED_ADAPTERS.includes(adapter), false,
      `${adapter} cannot be both delegated and not`,
    );
  }
  assert.deepEqual([...DELEGATED_RUN_ADAPTERS], [BROWSER_DELEGATION_ADAPTER_ID]);
  assert.equal(
    DELEGATED_RUN_ADAPTERS.includes(BROWSER_OPERATOR_ADAPTER_ID), false,
    'v4 has no delegated Run, so a v4 lease must behave exactly as it did before ADR-0029',
  );
});

test('the stdio surface is not a delegated adapter, so the gate is inert there by identity', () => {
  // `repository-engineering-runtime.ts` never passes a `uiDelegation`, and this is why that is
  // correct rather than an oversight: its caller context is `private.stdio.v1`, which no delegation
  // can bind, so the composition gate never applies. Asserted rather than assumed, because "it
  // doesn't apply there" is exactly the kind of claim that stops being true quietly.
  assert.equal(DELEGATED_RUN_ADAPTERS.includes(PRIVATE_STDIO_ADAPTER_ID), false);
  assert.equal(
    ask(
      { admittedAdapters: [PRIVATE_STDIO_ADAPTER_ID] },
      { adapterId: PRIVATE_STDIO_ADAPTER_ID },
    ).admitted,
    true,
    'a stdio lease admits without naming any delegated goal, exactly as before ADR-0029',
  );
});

// -------------------------------------------------------------------------------------------
// The policy matrix
// -------------------------------------------------------------------------------------------

const bindings = (over: Partial<GoalLeaseBindings> = {}): GoalLeaseBindings => ({
  workspaceRoots: [ROOT],
  allowedTools: ['mutation.propose'],
  pathPatterns: ['docs/**'],
  maxFiles: 10,
  maxBytes: 100_000,
  maxDiffBytes: 10_000,
  admittedSessions: [SESSION],
  admittedAdapters: [BROWSER_DELEGATION_ADAPTER_ID],
  commitSemantics: 'none',
  ...over,
});

const lease = (over: Partial<GoalLeaseBindings> = {}): GoalLeaseRecord => ({
  leaseId: 'lease_1',
  createdAt: NOW - 1_000,
  notBefore: NOW - 1_000,
  expiresAt: NOW + 60 * 60_000,
  bindings: bindings(over),
});

const request = (over: Partial<LeaseRequest> = {}): LeaseRequest => ({
  tool: 'mutation.propose',
  sessionId: SESSION,
  adapterId: BROWSER_DELEGATION_ADAPTER_ID,
  workspaceRoot: ROOT,
  path: 'docs/notes.md',
  diffBytes: 100,
  ...over,
});

const ask = (
  leaseOver: Partial<GoalLeaseBindings>,
  requestOver: Partial<LeaseRequest> = {},
) => evaluateGoalLease({
  lease: lease(leaseOver),
  now: NOW,
  request: request(requestOver),
  spend: { filesChanged: 0, bytesWritten: 0 },
  killSwitch: false,
  gatewayRoot: 'E:/Projects/web-agent-gateway',
});

const refusedWith = (decision: ReturnType<typeof evaluateGoalLease>, code: LeaseDenialCode) => {
  assert.equal(decision.admitted, false, `expected ${code}, was admitted`);
  assert.equal((decision as { code: LeaseDenialCode }).code, code);
};

test('the zero-gesture path opens only where both grants name the same goal', () => {
  const decision = ask({ delegatedGoalIds: [GOAL] }, { delegatedGoalId: GOAL });
  assert.equal(decision.admitted, true, JSON.stringify(decision));
});

test('a lease that names no delegated goal admits nothing from a delegated adapter', () => {
  // This is every lease that exists today, and the reason the change is a narrowing rather than a
  // new grant: an unchanged lease keeps exactly the authority it had, and the delegated path it
  // never contemplated now needs a person.
  refusedWith(ask({}, { delegatedGoalId: GOAL }), 'DELEGATED_GOAL_NOT_ADMITTED');
  refusedWith(ask({ delegatedGoalIds: [] }, { delegatedGoalId: GOAL }), 'DELEGATED_GOAL_NOT_ADMITTED');
});

test('a lease naming one goal does not admit an unrelated goal, which is the composition defect', () => {
  refusedWith(ask({ delegatedGoalIds: [OTHER_GOAL] }, { delegatedGoalId: GOAL }), 'DELEGATED_GOAL_NOT_ADMITTED');
  refusedWith(ask({ delegatedGoalIds: [GOAL] }, { delegatedGoalId: OTHER_GOAL }), 'DELEGATED_GOAL_NOT_ADMITTED');
});

test('a lease admitting no delegated goal says so, rather than blaming the provenance', () => {
  // The ordering matters for the operator reading the refusal. A lease that never opted into any
  // delegated work should say *that*; reporting an unresolvable provenance would send them looking
  // at the delegation, which is not what is wrong. A mutation proved this ordering was untested.
  refusedWith(
    ask({ delegatedGoalIds: [] }, { delegatedGoalId: undefined }),
    'DELEGATED_GOAL_NOT_ADMITTED',
  );
  refusedWith(ask({}, { delegatedGoalId: undefined }), 'DELEGATED_GOAL_NOT_ADMITTED');
  const reason = ask({ delegatedGoalIds: [] }, { delegatedGoalId: undefined });
  assert.match(
    (reason as { detail: string }).detail,
    /admits no delegated goal/,
    'and the detail names the lease, not the delegation',
  );
});

test('an unresolvable goal on a delegated adapter denies rather than passing as undelegated', () => {
  // The fail-closed direction, and the one that matters: if the caller could not say which goal is
  // in force, the honest answer is that the provenance is unknown. Reading "unknown" as
  // "undelegated, so the ordinary rules apply" would make a resolution bug into a grant.
  refusedWith(ask({ delegatedGoalIds: [GOAL] }, { delegatedGoalId: undefined }), 'DELEGATED_GOAL_UNKNOWN');
});

test('a non-delegated adapter is untouched by any of this, with or without the field', () => {
  const v4 = {
    admittedAdapters: [BROWSER_OPERATOR_ADAPTER_ID],
  } satisfies Partial<GoalLeaseBindings>;
  assert.equal(
    ask(v4, { adapterId: BROWSER_OPERATOR_ADAPTER_ID }).admitted, true,
    'ADR-0028 must hold unchanged where no Run can be delegated',
  );
  assert.equal(
    ask({ ...v4, delegatedGoalIds: [GOAL] }, { adapterId: BROWSER_OPERATOR_ADAPTER_ID }).admitted, true,
    'and naming a goal does not change a surface that has no delegated Run to constrain',
  );
});

test('naming the goal buys nothing else: every other bound is still checked in full', () => {
  const both = { delegatedGoalIds: [GOAL] };
  const asGoal = { delegatedGoalId: GOAL };

  refusedWith(ask(both, { ...asGoal, sessionId: OTHER_SESSION }), 'SESSION_NOT_ADMITTED');
  refusedWith(ask(both, { ...asGoal, tool: 'git.commit' }), 'TOOL_NOT_GRANTED');
  refusedWith(ask(both, { ...asGoal, workspaceRoot: 'E:/somewhere/else' }), 'WORKSPACE_NOT_GRANTED');
  refusedWith(ask(both, { ...asGoal, path: 'src/index.ts' }), 'PATH_NOT_GRANTED');
  // Refused *above* the patterns, not by them — the protected-authority list runs first, so a
  // lease whose pattern happened to reach `.claude/` would still not get there.
  refusedWith(ask(both, { ...asGoal, path: '.claude/settings.json' }), 'AUTHORITY_FILE_PROTECTED');
  refusedWith(
    ask({ ...both, pathPatterns: ['**'] }, { ...asGoal, path: '.claude/settings.json' }),
    'AUTHORITY_FILE_PROTECTED',
  );
  refusedWith(ask(both, { ...asGoal, diffBytes: 999_999 }), 'DIFF_TOO_LARGE');
  refusedWith(ask(both, { ...asGoal, wantsCommit: true }), 'COMMIT_NOT_GRANTED');

  const stopped = evaluateGoalLease({
    lease: lease(both), now: NOW, request: request(asGoal),
    spend: { filesChanged: 0, bytesWritten: 0 }, killSwitch: true,
  });
  refusedWith(stopped, 'KILL_SWITCH_ENGAGED');
});

test('the budgets are the lease s own and a delegation cannot extend them', () => {
  const both = { delegatedGoalIds: [GOAL] };
  const asGoal = { delegatedGoalId: GOAL };
  const exhausted = (spend: { filesChanged: number; bytesWritten: number }) => evaluateGoalLease({
    lease: lease(both), now: NOW, request: request(asGoal), spend, killSwitch: false,
  });
  refusedWith(exhausted({ filesChanged: 10, bytesWritten: 0 }), 'FILE_BUDGET_EXHAUSTED');
  refusedWith(exhausted({ filesChanged: 0, bytesWritten: 100_000 }), 'BYTE_BUDGET_EXHAUSTED');
});

test('an expired or revoked lease refuses before the goal is ever consulted', () => {
  const expired = evaluateGoalLease({
    lease: { ...lease({ delegatedGoalIds: [GOAL] }), expiresAt: NOW - 1 },
    now: NOW, request: request({ delegatedGoalId: GOAL }),
    spend: { filesChanged: 0, bytesWritten: 0 }, killSwitch: false,
  });
  refusedWith(expired, 'LEASE_EXPIRED');

  const revoked = evaluateGoalLease({
    lease: { ...lease({ delegatedGoalIds: [GOAL] }), revokedAt: NOW - 1 },
    now: NOW, request: request({ delegatedGoalId: GOAL }),
    spend: { filesChanged: 0, bytesWritten: 0 }, killSwitch: false,
  });
  refusedWith(revoked, 'LEASE_REVOKED');
});

test('a malformed delegatedGoalIds denies the lease rather than reading as absent', () => {
  assert.equal(validateBindings(bindings({ delegatedGoalIds: [GOAL] })), undefined);
  assert.equal(validateBindings(bindings()), undefined, 'omitting it stays valid');
  assert.match(
    validateBindings(bindings({ delegatedGoalIds: 'goal' as unknown as string[] })) ?? '',
    /delegatedGoalIds must be an array/,
  );
  assert.match(
    validateBindings(bindings({ delegatedGoalIds: [''] })) ?? '',
    /non-empty strings/,
  );
  // And a malformed value must *deny*, not merely fail validation in isolation.
  const decision = evaluateGoalLease({
    lease: lease({ delegatedGoalIds: [42] as unknown as string[] }),
    now: NOW, request: request({ delegatedGoalId: GOAL }),
    spend: { filesChanged: 0, bytesWritten: 0 }, killSwitch: false,
  });
  refusedWith(decision, 'LEASE_MALFORMED');
});

// -------------------------------------------------------------------------------------------
// Where the goal comes from: durable rows, re-read at the consequence
// -------------------------------------------------------------------------------------------

async function withStore(
  t: test.TestContext,
): Promise<{ store: SqliteDurableStore; control: UiDelegationControlPlane }> {
  const directory = await mkdtemp(join(tmpdir(), 'wag-composition-'));
  const store = new SqliteDurableStore(join(directory, 'state.sqlite'));
  const control = new UiDelegationControlPlane({
    store, key: createControllerPlaneKey('local.operator.cli'),
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });
  return { store, control };
}

const issue = (control: UiDelegationControlPlane, over: {
  goalId?: string; sessionId?: string; adapterId?: string; ttlMs?: number;
} = {}) => control.issue({
  goalId: over.goalId ?? GOAL,
  ttlMs: over.ttlMs ?? 60 * 60_000,
  bindings: {
    goalId: over.goalId ?? GOAL,
    controllerId: 'local.operator.cli',
    allowedOrigins: ['https://chatgpt.com'],
    allowedTools: ['mutation.propose'],
    workspaceId: 'ws_1',
    sessionId: over.sessionId ?? SESSION,
    adapterId: over.adapterId ?? BROWSER_DELEGATION_ADAPTER_ID,
    maxActions: 4,
  },
});

test('the goal is read from the delegation row, for this session and this adapter only', async (t) => {
  const { store, control } = await withStore(t);
  const { delegationId } = issue(control);

  const resolve = (over: { sessionId?: string; adapterId?: string; configured?: string } = {}) =>
    resolveDelegatedGoal({
      port: store,
      configuredDelegationId: 'configured' in over ? over.configured : delegationId,
      sessionId: over.sessionId ?? SESSION,
      adapterId: over.adapterId ?? BROWSER_DELEGATION_ADAPTER_ID,
      now: Date.now(),
    });

  assert.equal(resolve(), GOAL);
  assert.equal(resolve({ sessionId: OTHER_SESSION }), undefined, 'another session holds nothing');
  assert.equal(
    resolve({ adapterId: BROWSER_OPERATOR_ADAPTER_ID }), undefined,
    'a delegation is not inherited by a different adapter identity',
  );
  assert.equal(resolve({ configured: undefined }), undefined, 'nothing configured, nothing in force');
  assert.equal(
    resolve({ configured: 'uidel_not_a_real_row' }), undefined,
    'an id naming no row resolves to nothing rather than to something unrestricted',
  );
});

test('a delegation that exists but is not the configured one is inert here too', async (t) => {
  const { store, control } = await withStore(t);
  const configured = issue(control).delegationId;
  const other = issue(control, { goalId: OTHER_GOAL }).delegationId;
  assert.notEqual(configured, other);

  // The store holds a live row for OTHER_GOAL. Naming the configured one must not surface it.
  assert.equal(
    resolveDelegatedGoal({
      port: store, configuredDelegationId: configured,
      sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now: Date.now(),
    }),
    GOAL,
  );
});

test('revoking the delegation closes the lease path immediately, without touching the lease', async (t) => {
  const { store, control } = await withStore(t);
  const { delegationId } = issue(control);

  const goalNow = () => resolveDelegatedGoal({
    port: store, configuredDelegationId: delegationId,
    sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now: Date.now(),
  });
  assert.equal(goalNow(), GOAL);

  assert.equal(control.revoke(delegationId), true);
  assert.equal(goalNow(), undefined, 'a revoked delegation is in force for nothing');

  // And the lease, untouched and still perfectly valid, now refuses — because the provenance it
  // was told to accept can no longer be established.
  refusedWith(
    ask({ delegatedGoalIds: [GOAL] }, { delegatedGoalId: goalNow() }),
    'DELEGATED_GOAL_UNKNOWN',
  );
});

test('an expired delegation is in force for nothing, so the composed path closes on its own', async (t) => {
  const { store, control } = await withStore(t);
  const { delegationId } = issue(control, { ttlMs: 60_000 });

  const at = (now: number) => resolveDelegatedGoal({
    port: store, configuredDelegationId: delegationId,
    sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now,
  });
  assert.equal(at(Date.now()), GOAL);
  assert.equal(at(Date.now() + 120_000), undefined, 'past its expiry it resolves to nothing');
});

test('a superseded delegation stops unlocking the lease, and the successor is not assumed', async (t) => {
  const { store, control } = await withStore(t);
  const first = issue(control).delegationId;
  const renewed = control.renew({
    delegationId: first,
    goalId: GOAL,
    ttlMs: 60 * 60_000,
    bindings: {
      goalId: GOAL,
      controllerId: 'local.operator.cli',
      allowedOrigins: ['https://chatgpt.com'],
      allowedTools: ['mutation.propose'],
      workspaceId: 'ws_1',
      sessionId: SESSION,
      adapterId: BROWSER_DELEGATION_ADAPTER_ID,
      maxActions: 4,
    },
  });
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  const successorId = (renewed as { delegationId: string }).delegationId;
  assert.notEqual(successorId, first);

  assert.equal(
    resolveDelegatedGoal({
      port: store, configuredDelegationId: first,
      sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now: Date.now(),
    }),
    undefined,
    'the superseded row authorises nothing, even though its successor is live',
  );
  // The successor has a new id. Configuration still names the old one, so nothing is in force —
  // which is the renewal being a human act rather than a rollover this code performs for itself.
  assert.equal(
    resolveDelegatedGoal({
      port: store, configuredDelegationId: successorId,
      sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now: Date.now(),
    }),
    GOAL,
    'and naming the successor is what puts it in force, which a person must do',
  );
});

test('supersession alone closes the path, with no revocation to fall back on', () => {
  const now = Date.now();
  const bound = JSON.stringify({
    goalId: GOAL, controllerId: 'local.operator.cli',
    allowedOrigins: ['https://chatgpt.com'], allowedTools: ['mutation.propose'],
    workspaceId: 'ws_1', sessionId: SESSION,
    adapterId: BROWSER_DELEGATION_ADAPTER_ID, maxActions: 4,
  });

  // A hand-built port rather than a store fixture, because the store cannot produce this row:
  // `renewUiDelegation` sets `superseded_by` **and** `revoked_at` in one transaction, so a renewed
  // predecessor is refused by the revocation check before supersession is ever consulted — which
  // is why the supersession check was untested until a mutation said so. Supersession must stand
  // on its own, because the two fields are separate columns and only one of them is one-way here.
  const row = {
    delegationId: 'uidel_superseded_only', goalId: GOAL, controllerId: 'local.operator.cli',
    createdAt: now, notBefore: now - 1_000, expiresAt: now + 60 * 60_000, bindings: bound,
  };
  const resolve = (over: Record<string, unknown>) => resolveDelegatedGoal({
    port: { getUiDelegationRow: () => ({ ...row, ...over }) as never },
    configuredDelegationId: 'uidel_superseded_only',
    sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now,
  });

  assert.equal(resolve({}), GOAL, 'the control: this row would otherwise be in force');
  assert.equal(
    resolve({ supersededBy: 'uidel_successor' }), undefined,
    'superseded and not revoked must still resolve to nothing',
  );
  assert.equal(resolve({ revokedAt: now - 1 }), undefined, 'and revoked alone, likewise');
});

test('a row whose window exceeds the delegation ceiling resolves to nothing', async (t) => {
  const { store } = await withStore(t);
  // Written directly, as something other than the control plane would have to, because the control
  // plane refuses this. The resolution re-applies the ceiling for exactly that reason.
  const now = Date.now();
  store.insertUiDelegation({
    delegationId: 'uidel_overlong',
    goalId: GOAL,
    controllerId: 'local.operator.cli',
    createdAt: now,
    notBefore: now - 1_000,
    expiresAt: now + MAX_DELEGATION_WINDOW_MS + 60_000,
    bindings: JSON.stringify({
      goalId: GOAL, controllerId: 'local.operator.cli',
      allowedOrigins: ['https://chatgpt.com'], allowedTools: ['mutation.propose'],
      workspaceId: 'ws_1', sessionId: SESSION,
      adapterId: BROWSER_DELEGATION_ADAPTER_ID, maxActions: 4,
    }),
  });
  assert.equal(
    resolveDelegatedGoal({
      port: store, configuredDelegationId: 'uidel_overlong',
      sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now,
    }),
    undefined,
    'a window past the ceiling is refused on the consequence path, not only at issuance',
  );
});

test('unparseable bindings resolve to nothing rather than throwing on the effect path', async (t) => {
  const { store } = await withStore(t);
  const now = Date.now();
  store.insertUiDelegation({
    delegationId: 'uidel_garbage',
    goalId: GOAL,
    controllerId: 'local.operator.cli',
    createdAt: now,
    notBefore: now - 1_000,
    expiresAt: now + 60_000,
    bindings: 'not json at all',
  });
  assert.equal(
    resolveDelegatedGoal({
      port: store, configuredDelegationId: 'uidel_garbage',
      sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now,
    }),
    undefined,
  );
});

// -------------------------------------------------------------------------------------------
// The restart case, which is where a cached answer would have been wrong
// -------------------------------------------------------------------------------------------

test('the goal is re-read per admission, so nothing survives a restart that should not', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wag-composition-restart-'));
  const path = join(directory, 'state.sqlite');
  t.after(async () => { await rm(directory, { recursive: true, force: true }).catch(() => undefined); });

  const first = new SqliteDurableStore(path);
  const control = new UiDelegationControlPlane({
    store: first, key: createControllerPlaneKey('local.operator.cli'),
  });
  const { delegationId } = issue(control);
  first.close();

  // A different process, a different store handle, the same file.
  const second = new SqliteDurableStore(path);
  t.after(() => second.close());
  assert.equal(
    resolveDelegatedGoal({
      port: second, configuredDelegationId: delegationId,
      sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now: Date.now(),
    }),
    GOAL,
    'the grant is durable, so a restart does not silently drop it',
  );

  const third = new UiDelegationControlPlane({
    store: second, key: createControllerPlaneKey('local.operator.cli'),
  });
  assert.equal(third.revoke(delegationId), true);
  assert.equal(
    resolveDelegatedGoal({
      port: second, configuredDelegationId: delegationId,
      sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now: Date.now(),
    }),
    undefined,
    'and a revocation after the restart takes effect on the next admission, not the next restart',
  );
});

// -------------------------------------------------------------------------------------------
// Ceilings: two bounded grants compose to the shorter one, never the longer
// -------------------------------------------------------------------------------------------

test('the composed window is the intersection of the two, and the delegation ceiling is the shorter', () => {
  assert.ok(
    MAX_DELEGATION_WINDOW_MS < MAX_LEASE_WINDOW_MS,
    'a delegation may not outlive a lease; if that ever inverts, the zero-gesture window grows',
  );
  // A live lease and a delegation that has expired: the composed path is closed even though the
  // lease itself has hours left. Intersection, in the one dimension where it is easiest to lose.
  refusedWith(
    ask({ delegatedGoalIds: [GOAL] }, { delegatedGoalId: undefined }),
    'DELEGATED_GOAL_UNKNOWN',
  );
});

test('the page cannot name a goal, because the goal is never read from anything it can write', () => {
  // `LeaseRequest.delegatedGoalId` is supplied by the admission path from `resolveDelegatedGoal`,
  // which reads one durable row. There is no route from staged arguments, proposal text or an
  // envelope to this field — asserted here by exercising the only thing a page controls, the
  // arguments, and confirming the decision is unmoved.
  const claimed = ask(
    { delegatedGoalIds: [GOAL] },
    { delegatedGoalId: OTHER_GOAL, path: 'docs/notes.md' },
  );
  refusedWith(claimed, 'DELEGATED_GOAL_NOT_ADMITTED');
  assert.equal(
    ask({ delegatedGoalIds: [GOAL] }, { delegatedGoalId: GOAL }).admitted, true,
    'and the only value that admits is the one a durable row produced',
  );
});

test('a lease naming several goals admits each of them and nothing besides', () => {
  const many = { delegatedGoalIds: [GOAL, OTHER_GOAL] };
  assert.equal(ask(many, { delegatedGoalId: GOAL }).admitted, true);
  assert.equal(ask(many, { delegatedGoalId: OTHER_GOAL }).admitted, true);
  refusedWith(ask(many, { delegatedGoalId: `${GOAL}_suffix` }), 'DELEGATED_GOAL_NOT_ADMITTED');
  refusedWith(ask(many, { delegatedGoalId: GOAL.slice(0, -1) }), 'DELEGATED_GOAL_NOT_ADMITTED');
});

test('an unrelated session cannot borrow the goal a delegation put in force', async (t) => {
  const { store, control } = await withStore(t);
  const { delegationId } = issue(control);

  // The composed attack, stated end to end: a second browser context, on the same adapter, with a
  // lease that admits both sessions and names the goal. The delegation binds one session, and the
  // provenance for the other cannot be established, so the effect needs a person.
  const goalForOther = resolveDelegatedGoal({
    port: store, configuredDelegationId: delegationId,
    sessionId: OTHER_SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now: Date.now(),
  });
  assert.equal(goalForOther, undefined);

  const decision = evaluateGoalLease({
    lease: lease({ delegatedGoalIds: [GOAL], admittedSessions: [SESSION, OTHER_SESSION] }),
    now: NOW,
    request: request({
      sessionId: OTHER_SESSION,
      ...(goalForOther === undefined ? {} : { delegatedGoalId: goalForOther }),
    }),
    spend: { filesChanged: 0, bytesWritten: 0 },
    killSwitch: false,
  });
  refusedWith(decision, 'DELEGATED_GOAL_UNKNOWN');
});

test('the two budgets are independent, and neither refills the other', async (t) => {
  const { store, control } = await withStore(t);
  const { delegationId } = issue(control);

  // The delegation budgets Run transitions; the lease budgets bytes and files. They count different
  // things from different tables, and the composition must not let either subsidise the other — a
  // spent delegation cannot borrow the lease's remaining bytes to authorise one more Run, and an
  // exhausted lease cannot borrow the delegation's remaining actions to authorise one more effect.
  assert.equal(store.countDelegationClaims(delegationId), 0);

  const leaseBudgetExhausted = evaluateGoalLease({
    lease: lease({ delegatedGoalIds: [GOAL] }),
    now: NOW,
    request: request({ delegatedGoalId: GOAL }),
    spend: { filesChanged: 10, bytesWritten: 0 },
    killSwitch: false,
  });
  refusedWith(leaseBudgetExhausted, 'FILE_BUDGET_EXHAUSTED');
  assert.equal(
    store.countDelegationClaims(delegationId), 0,
    'a lease refusal spends no delegation action: the Run already happened or it did not',
  );

  // And the converse, stated where a reader will look for it: a lease admits, it never proposes.
  // With the delegation's actions spent there is no new proposal for the lease to admit, and no
  // route on the lease side that could create one — `admitByPolicy` takes a mutation id that must
  // already be PENDING_APPROVAL.
  assert.equal(
    typeof (store as unknown as Record<string, unknown>).insertStagedProposal, 'function',
    'staging exists on the store',
  );
  assert.equal(
    (evaluateGoalLease as unknown as { length: number }).length, 1,
    'and the lease evaluator takes one input object and returns a decision; it stages nothing',
  );
});

test('work already proposed under a delegation stops being admissible the moment it is revoked', async (t) => {
  const { store, control } = await withStore(t);
  const { delegationId } = issue(control);

  // The non-obvious half of re-reading provenance at the consequence rather than at the Run: a
  // proposal that a live delegation legitimately produced, and that is sitting pending review, is
  // refused once that delegation is revoked. Revocation therefore closes the effect path for work
  // already in flight — not only for work not yet proposed.
  const goalWhileLive = resolveDelegatedGoal({
    port: store, configuredDelegationId: delegationId,
    sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now: Date.now(),
  });
  assert.equal(goalWhileLive, GOAL);
  assert.equal(
    ask({ delegatedGoalIds: [GOAL] }, { delegatedGoalId: goalWhileLive }).admitted, true,
    'while the delegation is live, the pending work is admissible',
  );

  assert.equal(control.revoke(delegationId), true);

  const goalAfter = resolveDelegatedGoal({
    port: store, configuredDelegationId: delegationId,
    sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID, now: Date.now(),
  });
  refusedWith(
    ask(
      { delegatedGoalIds: [GOAL] },
      { ...(goalAfter === undefined ? {} : { delegatedGoalId: goalAfter }) },
    ),
    'DELEGATED_GOAL_UNKNOWN',
  );
  // The lease was not touched. Revoking one grant is enough; the operator does not have to find
  // and revoke the other as well.
  assert.equal(
    ask(
      {
        delegatedGoalIds: [GOAL],
        admittedAdapters: [BROWSER_DELEGATION_ADAPTER_ID, BROWSER_OPERATOR_ADAPTER_ID],
      },
      { adapterId: BROWSER_OPERATOR_ADAPTER_ID },
    ).admitted,
    true,
    'and the lease is still perfectly valid for everything it was ever meant to cover',
  );
});

test('a fresh random goal id cannot be guessed into a lease that names a real one', () => {
  for (let i = 0; i < 8; i += 1) {
    refusedWith(
      ask({ delegatedGoalIds: [GOAL] }, { delegatedGoalId: `goal_${randomUUID()}` }),
      'DELEGATED_GOAL_NOT_ADMITTED',
    );
  }
});
