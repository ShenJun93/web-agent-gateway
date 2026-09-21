/**
 * What survives a crash, and what a spent slot means afterwards (ADR-0029).
 *
 * The state machine is `STAGED -> CLAIMED -> DISPATCHED -> RESULTED`, plus terminal `ABANDONED`.
 * Every transition is a single-assignment `UPDATE ... WHERE state = '<previous>'`, so the questions
 * worth testing are not "does the happy path work" but:
 *
 *   - a process that died between CLAIM and DISPATCH — is the slot still spent, and does the row
 *     ever reach a terminal state?
 *   - a process that died between DISPATCH and the result — can a redelivery run it again?
 *   - does a refund ever happen? (It must not: a refund turns a crash into extra budget.)
 *
 * The answers are deliberately pessimistic. WAG cannot know whether a dispatch that was in flight
 * reached a tool, so it assumes it did.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { BROWSER_DELEGATION_ADAPTER_ID } from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  UiDelegationControlPlane,
  createControllerPlaneKey,
} from '../src/goal-ui-delegation-control.js';
import { MAX_DELEGATION_WINDOW_MS } from '../src/goal-ui-delegation.js';
import {
  CLAIM_TTL_MS,
  UiDelegationDispatchPlane,
  createDelegationDispatchPort,
} from '../src/goal-ui-delegation-dispatch.js';
import { DelegatedDispatchRouter } from '../src/delegated-dispatch-router.js';
import { DelegatedRunCoordinator, delegatedRunResultId } from '../src/delegated-run-executor.js';
import { DelegationClaimSweeper } from '../src/delegation-claim-sweeper.js';

const WORKSPACE = 'ws_recovery';
const ORIGIN = 'https://chatgpt.com';
const TOOL = 'repo.search';
const CONNECTION = {
  ownerId: 'owner_recovery',
  sessionId: 'session_recovery_0001',
  adapterId: BROWSER_DELEGATION_ADAPTER_ID,
};

interface Fixture {
  store: SqliteDurableStore;
  path: string;
  delegationId: string;
  now: { value: number };
  executed: string[];
  toolBehaviour: { mode: 'ok' | 'throw' | 'error' };
  coordinator: DelegatedRunCoordinator;
  reopen(): Fixture;
}

async function fixture(t: test.TestContext, options: { maxActions?: number } = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'wag-delegation-recovery-'));
  const path = join(directory, 'state.sqlite');
  const now = { value: 1_700_000_000_000 };
  const stores: SqliteDurableStore[] = [];

  const build = (existingDelegationId?: string): Fixture => {
    const store = new SqliteDurableStore(path);
    stores.push(store);
    const port = createDelegationDispatchPort(store);

    let delegationId = existingDelegationId;
    if (delegationId === undefined) {
      const control = new UiDelegationControlPlane({
        store, key: createControllerPlaneKey('recovery.controller'), now: () => now.value,
      });
      delegationId = control.issue({
        goalId: 'goal_recovery',
        ttlMs: 60 * 60_000,
        bindings: {
          goalId: 'goal_recovery',
          controllerId: 'recovery.controller',
          allowedOrigins: [ORIGIN],
          allowedTools: [TOOL],
          workspaceId: WORKSPACE,
          sessionId: CONNECTION.sessionId,
          adapterId: BROWSER_DELEGATION_ADAPTER_ID,
          maxActions: options.maxActions ?? 3,
        },
      }).delegationId;
    }

    const executed: string[] = [];
    const toolBehaviour: { mode: 'ok' | 'throw' | 'error' } = { mode: 'ok' };
    const plane = new UiDelegationDispatchPlane({
      port, killSwitch: () => false, configuredDelegationId: delegationId, now: () => now.value,
    });
    const router = new DelegatedDispatchRouter({ plane, connection: CONNECTION });
    const coordinator = new DelegatedRunCoordinator({
      router, port, sessionId: CONNECTION.sessionId,
      executor: {
        async callTool(input) {
          executed.push(input.tool);
          if (toolBehaviour.mode === 'throw') throw new Error('the tool blew up');
          if (toolBehaviour.mode === 'error') return { ok: false };
          return { ok: true, structuredContent: { matches: [] } };
        },
      },
    });

    const self: Fixture = {
      store, path, delegationId, now, executed, toolBehaviour, coordinator,
      reopen: () => { store.close(); return build(delegationId); },
    };
    return self;
  };

  const first = build();
  // One ordered cleanup. Closing a store twice is harmless; leaving one open on Windows is not —
  // the directory refuses to unlink and the whole suite fails with EBUSY.
  t.after(async () => {
    for (const store of stores) { try { store.close(); } catch { /* already closed */ } }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });
  return first;
}

const bind = async (f: Fixture): Promise<void> => {
  const bound = await f.coordinator.handle({
    version: 5, type: 'session.bind', requestId: `req_${randomUUID()}`,
    sessionId: CONNECTION.sessionId, provider: 'chatgpt', origin: ORIGIN,
  });
  assert.equal(bound.type, 'result');
};

const stage = async (f: Fixture): Promise<string> => {
  const staged = await f.coordinator.handle({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId: CONNECTION.sessionId, delegationId: f.delegationId,
    tool: TOOL, workspaceId: WORKSPACE, origin: ORIGIN,
    arguments: { workspace_id: WORKSPACE, query: 'needle' },
  });
  assert.equal(staged.type, 'result', JSON.stringify(staged));
  return (staged.result as { proposalId: string }).proposalId;
};

const dispatch = (f: Fixture, proposalId: string) => f.coordinator.handle({
  version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
  sessionId: CONNECTION.sessionId, delegationId: f.delegationId, proposalId,
});

/**
 * Claim without dispatching — precisely the window a crash lands in.
 *
 * The fingerprint comes from the stored row rather than being recomputed here: the store re-derives
 * and compares it inside the transaction, and handing it a value this test invented would be
 * testing the test.
 */
const claimOnly = (f: Fixture, proposalId: string) => f.store.claimDelegatedDispatch({
  delegationId: f.delegationId,
  proposalId,
  now: f.now.value,
  expectedFingerprint: f.store.getStagedProposalRow(proposalId)!.fingerprint,
  maxWindowMs: MAX_DELEGATION_WINDOW_MS,
});

// -------------------------------------------------------------------------------------------
// The sweeper
// -------------------------------------------------------------------------------------------

test('a claim that never reached dispatch is retired, and the slot stays spent', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const proposalId = await stage(f);

  const claimed = claimOnly(f, proposalId);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(f.store.getStagedProposalRow(proposalId)?.state, 'CLAIMED');
  assert.equal(f.store.countDelegationClaims(f.delegationId), 1);

  const sweeper = new DelegationClaimSweeper({
    port: { abandonExpiredClaims: (now, ttl) => f.store.abandonExpiredClaims(now, ttl) },
    now: () => f.now.value,
  });

  // Not yet: a claim inside its TTL is in flight, not stale.
  assert.equal(sweeper.sweep(), 0);
  assert.equal(f.store.getStagedProposalRow(proposalId)?.state, 'CLAIMED');

  f.now.value += CLAIM_TTL_MS + 1;
  assert.equal(sweeper.sweep(), 1);

  const row = f.store.getStagedProposalRow(proposalId);
  assert.equal(row?.state, 'ABANDONED');
  assert.ok(row?.abandonedAt !== undefined, 'and it is terminal, with a timestamp');
  assert.equal(
    f.store.countDelegationClaims(f.delegationId), 1,
    'the slot is NOT refunded — a refund would make a crash a way to exceed maxActions',
  );
  assert.equal(f.store.getRunAuthority(proposalId), undefined, 'and no Run was ever recorded');
});

test('the sweeper never touches a dispatched row', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const proposalId = await stage(f);
  assert.equal((await dispatch(f, proposalId)).type, 'result');

  f.now.value += CLAIM_TTL_MS * 100;
  const sweeper = new DelegationClaimSweeper({
    port: { abandonExpiredClaims: (now, ttl) => f.store.abandonExpiredClaims(now, ttl) },
    now: () => f.now.value,
  });
  assert.equal(sweeper.sweep(), 0);
  assert.equal(
    f.store.getStagedProposalRow(proposalId)?.state, 'RESULTED',
    'a row that reached a tool keeps its own ending; abandoning it would claim knowledge nobody has',
  );
});

test('the sweeper runs once on start, so a crashed claim is retired without waiting an interval', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const proposalId = await stage(f);
  assert.equal(claimOnly(f, proposalId).ok, true);
  f.now.value += CLAIM_TTL_MS + 1;

  const sweeper = new DelegationClaimSweeper({
    port: { abandonExpiredClaims: (now, ttl) => f.store.abandonExpiredClaims(now, ttl) },
    now: () => f.now.value,
    intervalMs: 3_600_000,
  });
  t.after(() => sweeper.stop());
  sweeper.start();
  assert.equal(
    f.store.getStagedProposalRow(proposalId)?.state, 'ABANDONED',
    'the rows that most need retiring are the ones already on disk when the process starts',
  );
});

test('a sweep that throws does not take the runtime down', async (t) => {
  const f = await fixture(t);
  const sweeper = new DelegationClaimSweeper({
    port: { abandonExpiredClaims: () => { throw new Error('disk gone'); } },
    now: () => f.now.value,
  });
  assert.equal(sweeper.sweep(), 0, 'it reports nothing swept rather than propagating');
});

// -------------------------------------------------------------------------------------------
// Execution failures, after the durable transition
// -------------------------------------------------------------------------------------------

for (const [label, mode] of [['throws', 'throw'], ['reports an error', 'error']] as const) {
  test(`a tool that ${label} leaves the row dispatched and the slot spent`, async (t) => {
    const f = await fixture(t);
    await bind(f);
    const proposalId = await stage(f);
    f.toolBehaviour.mode = mode;

    const answered = await dispatch(f, proposalId);
    assert.equal(answered.type, 'error', JSON.stringify(answered));
    assert.equal((answered.error as { code: string }).code, 'EXECUTION_FAILED');

    const row = f.store.getStagedProposalRow(proposalId);
    assert.equal(row?.state, 'DISPATCHED', 'not RESULTED: nothing produced a result');
    assert.equal(row?.resultedAt, undefined);
    assert.equal(
      f.store.countDelegationClaims(f.delegationId), 1,
      'the slot was spent at CLAIM, before the tool ran, and is not given back',
    );
    // The Run happened as far as the audit is concerned, because it may have.
    assert.equal(f.store.getRunAuthority(proposalId)?.authority, 'DELEGATED_RUN');
  });
}

test('a failed run cannot be retried into a second execution', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const proposalId = await stage(f);
  f.toolBehaviour.mode = 'throw';
  assert.equal((await dispatch(f, proposalId)).type, 'error');

  f.toolBehaviour.mode = 'ok';
  const retried = await dispatch(f, proposalId);
  assert.equal(retried.type, 'error', 'the row is DISPATCHED and can never return to STAGED');
  assert.deepEqual(f.executed, [TOOL], 'and the tool ran exactly once');
});

// -------------------------------------------------------------------------------------------
// Restart
// -------------------------------------------------------------------------------------------

test('a restart after CLAIMED cannot resurrect the proposal', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const proposalId = await stage(f);
  assert.equal(claimOnly(f, proposalId).ok, true);

  // The process dies here. Everything below is a fresh store over the same file.
  const restarted = f.reopen();
  await bind(restarted);

  const afterRestart = await dispatch(restarted, proposalId);
  assert.equal(afterRestart.type, 'error', JSON.stringify(afterRestart));
  assert.deepEqual(restarted.executed, [], 'nothing ran');
  assert.equal(restarted.store.countDelegationClaims(restarted.delegationId), 1, 'and one slot is still spent');
});

test('a restart after DISPATCHED cannot double-run', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const proposalId = await stage(f);
  assert.equal((await dispatch(f, proposalId)).type, 'result');
  assert.deepEqual(f.executed, [TOOL]);

  const restarted = f.reopen();
  await bind(restarted);
  const replayed = await dispatch(restarted, proposalId);
  assert.equal(replayed.type, 'error');
  assert.deepEqual(restarted.executed, [], 'the new process ran nothing');
  assert.equal(restarted.store.getStagedProposalRow(proposalId)?.state, 'RESULTED');
  assert.equal(restarted.store.countDelegationClaims(restarted.delegationId), 1);
});

test('a restart does not reset the budget', async (t) => {
  const f = await fixture(t, { maxActions: 2 });
  await bind(f);
  for (let i = 0; i < 2; i += 1) assert.equal((await dispatch(f, await stage(f))).type, 'result');

  const restarted = f.reopen();
  await bind(restarted);
  // Staging caps at maxActions rows first, so the budget is reached there — same number, and the
  // mechanism that fires is named rather than assumed.
  const staged = await restarted.coordinator.handle({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId: CONNECTION.sessionId, delegationId: restarted.delegationId,
    tool: TOOL, workspaceId: WORKSPACE, origin: ORIGIN,
    arguments: { workspace_id: WORKSPACE, query: 'needle' },
  });
  assert.equal(staged.type, 'error');
  assert.equal((staged.error as { code: string }).code, 'STAGING_LIMIT_REACHED');
  assert.deepEqual(restarted.executed, []);
});

// -------------------------------------------------------------------------------------------
// The workspace binding, and the tools it cannot constrain
// -------------------------------------------------------------------------------------------

test('a tool that resolves no workspace cannot be staged under a delegation', async (t) => {
  // `workspace.open` takes a `path`, not a `workspace_id`. Allowing it under a delegation would
  // let the browser open any path the config permits while the audit row named the bound
  // workspace — a delegation that reads narrow and behaves wide.
  const f = await fixture(t);
  await bind(f);

  for (const [tool, args] of [
    ['workspace.open', { path: 'E:\\somewhere\\else' }],
    ['health', {}],
  ] as const) {
    const refused = await f.coordinator.handle({
      version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
      sessionId: CONNECTION.sessionId, delegationId: f.delegationId,
      tool, workspaceId: WORKSPACE, origin: ORIGIN, arguments: args,
    });
    assert.equal(refused.type, 'error', tool);
    assert.equal((refused.error as { code: string }).code, 'STAGING_INPUT_INVALID', tool);
    assert.match((refused.error as { message: string }).message, /resolves no workspace/, tool);
  }
  assert.equal(f.store.countStagedProposals(f.delegationId), 0);
});

test('the same tool is still stageable on the human path', async (t) => {
  // There are no bindings on the human path to satisfy, and a person opening a workspace is the
  // gesture the whole design defers to. Refusing it here would break the ordinary flow to close a
  // hole that only exists when a delegation is involved.
  const f = await fixture(t);
  await bind(f);
  const staged = await f.coordinator.handle({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId: CONNECTION.sessionId,
    tool: 'workspace.open', workspaceId: 'ws_not_yet_open', origin: ORIGIN,
    arguments: { path: 'E:\\somewhere' },
  });
  assert.equal(staged.type, 'result', JSON.stringify(staged));
});

// -------------------------------------------------------------------------------------------
// The result id
// -------------------------------------------------------------------------------------------

test('a result id is derived, so the same run always names the same result', () => {
  const base = { proposalId: 'prop_1', fingerprint: 'fp_1', result: { a: 1 } };
  assert.equal(delegatedRunResultId(base), delegatedRunResultId({ ...base }));
  assert.notEqual(delegatedRunResultId(base), delegatedRunResultId({ ...base, proposalId: 'prop_2' }));
  assert.notEqual(delegatedRunResultId(base), delegatedRunResultId({ ...base, fingerprint: 'fp_2' }));
  assert.notEqual(delegatedRunResultId(base), delegatedRunResultId({ ...base, result: { a: 2 } }));
  // Length-prefixed, so two fields cannot be slid across the boundary between them.
  assert.notEqual(
    delegatedRunResultId({ proposalId: 'ab', fingerprint: 'c', result: null }),
    delegatedRunResultId({ proposalId: 'a', fingerprint: 'bc', result: null }),
  );
  // A result that cannot be serialised is still named, rather than throwing.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.match(delegatedRunResultId({ ...base, result: cyclic }), /^res_[0-9a-f]{32}$/);
});
