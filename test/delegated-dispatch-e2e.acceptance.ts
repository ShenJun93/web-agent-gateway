import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BROWSER_DELEGATION_ADAPTER_ID } from '../src/adapter-admission.js';
import {
  DELEGATED_DISPATCH_PROTOCOL_VERSION as V,
  DELEGATED_DISPATCH_VERBS,
} from '../src/browser-adapter/protocol-v5.js';
import { createHarnessLane, HARNESS_LANE, type HarnessLane } from '../src/harness-authority.js';

/**
 * The zero-manual-Run end-to-end proof, in the ADR-0027 fixture-only lane.
 *
 * Everything here runs against a store and a "config" the lane created for itself. **It proves the
 * transport and the policy. It proves nothing about production**, where issuing a delegation and
 * naming it are human acts and `goalUiDelegationId` is unset unless someone sets it — so every
 * delegation row out there is inert and Run stays human.
 *
 * The header used to add "the rule patch is unapplied". A human applied it on 2026-09-21, so that
 * clause was stale within a day of being written; the rest of the sentence is unaffected, because
 * the patch changed what is *permitted* and this lane never depended on that. Production evidence
 * now lives in `test/delegated-run-production-runtime.test.ts`, which runs the shipped runtime.
 *
 * What a "manual Run" would have been: a person clicking Run in the side panel. Nothing in this
 * file clicks anything, and there is no UI in it at all. The extension asks; WAG decides.
 */
let laneRoot: string;

async function lane(t: { after(fn: () => void | Promise<void>): void }): Promise<HarnessLane> {
  const root = join(laneRoot, `lane_${Math.random().toString(36).slice(2, 10)}`);
  const created = await createHarnessLane({
    lane: HARNESS_LANE, root, startMs: 1_700_000_000_000,
  });
  // One hook, closing before removing. Hooks run in registration order, and on Windows removing a
  // directory whose SQLite handle is still open answers with EBUSY — measured here, sixteen times.
  t.after(async () => {
    await created.close();
    await rm(root, { recursive: true, force: true });
  });
  return created;
}

test.before(async () => {
  process.env.WAG_HARNESS_LANE = '1';
  laneRoot = await mkdtemp(join(tmpdir(), 'wag-e2e-'));
});
test.after(async () => { await rm(laneRoot, { recursive: true, force: true }); });

let seq = 0;
const rid = () => `req_${(seq += 1).toString().padStart(8, '0')}`;

/** Bind a fresh connection, as the extension does when the native port opens. */
function bind(router: { handle(raw: unknown): { type: string } }, sessionId: string) {
  const bound = router.handle({
    version: V, type: 'session.bind', requestId: rid(), sessionId,
    provider: 'chatgpt', origin: 'https://chatgpt.com',
  });
  assert.equal(bound.type, 'result', 'the session binds');
}

const stage = (
  router: { handle(raw: unknown): unknown },
  sessionId: string,
  over: Record<string, unknown> = {},
) => router.handle({
  version: V, type: 'run.stage', requestId: rid(), sessionId,
  tool: 'repo.search', workspaceId: 'WORKSPACE', origin: 'https://chatgpt.com',
  arguments: { workspace_id: 'WORKSPACE', query: 'needle' },
  ...over,
}) as { type: string; result?: { proposalId: string }; error?: { code: string } };

const dispatch = (
  router: { handle(raw: unknown): unknown },
  sessionId: string,
  delegationId: string,
  proposalId: string,
) => router.handle({
  version: V, type: 'run.dispatch', requestId: rid(), sessionId, delegationId, proposalId,
}) as { type: string; result?: Record<string, unknown>; error?: { code: string; message: string } };

const errorCode = (envelope: { type: string; error?: { code: string } }): string => {
  assert.equal(envelope.type, 'error', `expected an error envelope, got ${JSON.stringify(envelope)}`);
  return envelope.error?.code ?? '';
};

/** Stage a proposal under the configured delegation and return its id. */
function stagedUnder(l: HarnessLane, router: { handle(raw: unknown): unknown }, delegationId: string,
  over: Record<string, unknown> = {}): string {
  const outcome = stage(router, l.delegation().connection.sessionId, {
    delegationId,
    workspaceId: l.workspaceId,
    // The arguments must name the workspace the proposal is staged for; every tool resolves its
    // workspace from `arguments.workspace_id`, and the delegation binds the staged `workspaceId`.
    arguments: { workspace_id: l.workspaceId, query: 'needle' },
    ...over,
  });
  assert.equal(outcome.type, 'result', `staging failed: ${JSON.stringify(outcome)}`);
  return outcome.result!.proposalId;
}

// ---------------------------------------------------------------------------------------------
// The proof itself
// ---------------------------------------------------------------------------------------------

test('a delegated Run happens end to end with no human gesture', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);

  // Stage: inert. Nothing has run, nothing is authorised, no budget is spent.
  const proposalId = stagedUnder(l, router, delegationId);
  assert.equal(d.durable().getStagedProposalRow(proposalId)?.state, 'STAGED');
  assert.equal(d.durable().countDelegationClaims(delegationId), 0);
  assert.equal(d.durable().getRunAuthority(proposalId), undefined);

  // Dispatch: the whole gesture, replaced.
  const ran = dispatch(router, session, delegationId, proposalId);
  assert.equal(ran.type, 'result', JSON.stringify(ran));
  assert.equal(ran.result?.authority, 'DELEGATED_RUN');
  assert.equal(ran.result?.proposalId, proposalId);
  assert.equal(ran.result?.goalId, 'goal_lane_fixture', 'the goal comes from the delegation row');

  const audit = d.durable().getRunAuthority(proposalId);
  assert.equal(audit?.authority, 'DELEGATED_RUN');
  assert.equal(audit?.delegationId, delegationId);
  assert.equal(audit?.controllerId, 'harness.lane.controller.test-only');
  assert.match(audit?.proposalFingerprint ?? '', /^fp_[a-f0-9]{64}$/);
  assert.equal(d.durable().getStagedProposalRow(proposalId)?.state, 'DISPATCHED');
  assert.equal(d.durable().countDelegationClaims(delegationId), 1);

  // And the result id closes the loop.
  const attached = router.handle({
    version: V, type: 'run.result', requestId: rid(), sessionId: session,
    proposalId, resultId: 'res_e2e_0001',
  }) as { type: string };
  assert.equal(attached.type, 'result');
  assert.equal(d.durable().getRunAuthority(proposalId)?.resultId, 'res_e2e_0001');
  assert.equal(d.durable().getStagedProposalRow(proposalId)?.state, 'RESULTED');
});

test('one delegation drives many Runs, and stops at its budget', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue({ maxActions: 3 });
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);

  const proposals = [0, 1, 2].map((i) =>
    stagedUnder(l, router, delegationId, { arguments: { workspace_id: l.workspaceId, query: `q${i}` } }));
  for (const [i, proposalId] of proposals.entries()) {
    assert.equal(dispatch(router, session, delegationId, proposalId).type, 'result', `run ${i + 1}`);
  }
  assert.equal(d.durable().countDelegationClaims(delegationId), 3);

  // A fourth cannot even be staged: a delegation may not queue past its budget.
  const fourth = stage(router, session, {
    delegationId, workspaceId: l.workspaceId,
    arguments: { workspace_id: l.workspaceId, query: 'fourth' },
  });
  assert.equal(errorCode(fourth), 'STAGING_LIMIT_REACHED');
});

// ---------------------------------------------------------------------------------------------
// Every refusal the transport has to carry, end to end
// ---------------------------------------------------------------------------------------------

test('replay of a dispatched proposal is refused and spends nothing further', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);
  const proposalId = stagedUnder(l, router, delegationId);
  assert.equal(dispatch(router, session, delegationId, proposalId).type, 'result');

  for (let i = 0; i < 3; i += 1) {
    assert.equal(errorCode(dispatch(router, session, delegationId, proposalId)),
      'PROPOSAL_NOT_STAGED', `replay ${i + 1}`);
  }
  assert.equal(d.durable().countDelegationClaims(delegationId), 1, 'exactly one slot, still');
});

test('a wrong session is refused by the transport before the plane is reached', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);
  const proposalId = stagedUnder(l, router, delegationId);

  // The envelope names a session this connection does not hold. The router compares it against
  // the admitted identity rather than believing it.
  const wrong = router.handle({
    version: V, type: 'run.dispatch', requestId: rid(), sessionId: 'session_somebody_else',
    delegationId, proposalId,
  }) as { type: string; error?: { code: string } };
  assert.equal(errorCode(wrong), 'SESSION_MISMATCH');
  assert.equal(d.durable().countDelegationClaims(delegationId), 0, 'and nothing was spent');
  assert.equal(d.durable().getStagedProposalRow(proposalId)?.state, 'STAGED');
});

test('wrong workspace, wrong origin and an undelegated tool are refused at staging', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);

  assert.equal(errorCode(stage(router, session, {
    delegationId, workspaceId: 'ws_somewhere_else',
    arguments: { workspace_id: 'ws_somewhere_else', query: 'needle' },
  })), 'WORKSPACE_MISMATCH');
  assert.equal(errorCode(stage(router, session, {
    delegationId, workspaceId: l.workspaceId, origin: 'https://evil.example',
    arguments: { workspace_id: l.workspaceId, query: 'needle' },
  })), 'ORIGIN_NOT_ALLOWED');
  assert.equal(errorCode(stage(router, session, {
    delegationId, workspaceId: l.workspaceId, tool: 'repo.snapshot',
    arguments: { workspace_id: l.workspaceId },
  })), 'TOOL_NOT_DELEGATED');
  assert.equal(d.durable().countStagedProposals(delegationId), 0, 'none of it was queued');
});

test('an expired and a revoked delegation each refuse, read at the moment of use', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const session = d.connection.sessionId;

  const expiring = d.issue({ ttlMs: 5_000 });
  let router = d.connect();
  bind(router, session);
  const expiringProposal = stagedUnder(l, router, expiring);
  l.advanceClock(5_001);
  router = d.connect();
  bind(router, session);
  assert.equal(errorCode(dispatch(router, session, expiring, expiringProposal)), 'DELEGATION_EXPIRED');
  assert.equal(d.durable().countDelegationClaims(expiring), 0);

  const revocable = d.issue();
  router = d.connect();
  bind(router, session);
  const revocableProposal = stagedUnder(l, router, revocable);
  assert.equal(d.revoke(revocable), true);
  assert.equal(errorCode(dispatch(router, session, revocable, revocableProposal)), 'DELEGATION_REVOKED');
  assert.equal(d.durable().countDelegationClaims(revocable), 0);
});

test('a delegation nobody named in config authorises nothing over the wire', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const unnamed = d.issueUnnamed();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);

  // Staging under it is refused, so the proposal never exists.
  assert.equal(errorCode(stage(router, session, {
    delegationId: unnamed, workspaceId: l.workspaceId,
    arguments: { workspace_id: l.workspaceId, query: 'needle' },
  })), 'DELEGATION_NOT_CONFIGURED');

  // And with a *different* delegation configured, the unnamed one still authorises nothing.
  const named = d.issue();
  const fresh = d.connect();
  bind(fresh, session);
  const proposalId = stagedUnder(l, fresh, named);
  assert.equal(errorCode(dispatch(fresh, session, unnamed, proposalId)), 'DELEGATION_NOT_CONFIGURED');
});

test('the browser cannot assert authority: every extra field is refused, not ignored', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);
  const proposalId = stagedUnder(l, router, delegationId);

  for (const extra of [
    { goalId: 'goal_attacker' },
    { controllerId: 'attacker.controller' },
    { maxActions: 9999 },
    { expiresAt: Number.MAX_SAFE_INTEGER },
    { authority: 'DELEGATED_RUN' },
    { proposalFingerprint: 'fp_forged' },
    { slotClaimed: false },
    { state: 'STAGED' },
  ]) {
    const forged = router.handle({
      version: V, type: 'run.dispatch', requestId: rid(), sessionId: session,
      delegationId, proposalId, ...extra,
    }) as { type: string; error?: { code: string } };
    assert.equal(errorCode(forged), 'ENVELOPE_MALFORMED', Object.keys(extra)[0]);
  }
  assert.equal(d.durable().countDelegationClaims(delegationId), 0, 'and none of it spent a slot');
  assert.equal(d.durable().getStagedProposalRow(proposalId)?.state, 'STAGED');
});

test('the v5 surface carries no issuance verb', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);

  const listed = router.handle({
    version: V, type: 'verbs.list', requestId: rid(), sessionId: session,
  }) as { type: string; result?: { verbs: string[] } };
  assert.equal(listed.type, 'result');
  assert.deepEqual(listed.result?.verbs, [...DELEGATED_DISPATCH_VERBS]);
  assert.deepEqual(
    listed.result?.verbs.filter((v) => /issue|grant|renew|revoke|widen|authori/i.test(v)), [],
  );

  for (const verb of ['delegation.issue', 'delegation.revoke', 'delegation.renew', 'tool.call']) {
    const attempt = router.handle({
      version: V, type: verb, requestId: rid(), sessionId: session,
    }) as { type: string; error?: { code: string } };
    assert.equal(errorCode(attempt), 'ENVELOPE_MALFORMED', verb);
  }
});

// ---------------------------------------------------------------------------------------------
// Reconnect and restart
// ---------------------------------------------------------------------------------------------

test('a reconnect starts unbound and cannot act until it binds again', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const first = d.connect();
  const session = d.connection.sessionId;
  bind(first, session);
  const proposalId = stagedUnder(l, first, delegationId);

  // The port drops. A fresh router holds no memory of the bind.
  const second = d.connect();
  assert.equal(second.isBound, false);
  assert.equal(errorCode(dispatch(second, session, delegationId, proposalId)), 'NOT_BOUND');
  assert.equal(d.durable().countDelegationClaims(delegationId), 0, 'an unbound port spends nothing');

  bind(second, session);
  assert.equal(dispatch(second, session, delegationId, proposalId).type, 'result',
    'and the staged proposal survived the reconnect');
});

test('restart after CLAIMED cannot double-run or resurrect authority', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);
  const proposalId = stagedUnder(l, router, delegationId);

  // Claim without dispatching, which is what a crash between the two leaves behind.
  const claimed = d.durable().claimDelegatedDispatch({
    delegationId, proposalId, now: l.now(),
    expectedFingerprint: d.durable().getStagedProposalRow(proposalId)?.fingerprint ?? '',
    maxWindowMs: 4 * 60 * 60 * 1000,
  });
  assert.equal(claimed.ok, true);

  await l.reopen();
  const after = d.connect();
  bind(after, session);
  assert.equal(d.durable().getStagedProposalRow(proposalId)?.state, 'CLAIMED', 'the claim survived');
  assert.equal(d.durable().countDelegationClaims(delegationId), 1, 'and the slot is still spent');
  assert.equal(d.durable().getRunAuthority(proposalId), undefined, 'but no Run was recorded');
  assert.equal(errorCode(dispatch(after, session, delegationId, proposalId)), 'PROPOSAL_NOT_STAGED');

  // Recovery retires it. It is never run, and the slot is not returned.
  assert.equal(d.durable().abandonExpiredClaims(l.now() + 120_000, 60_000), 1);
  assert.equal(d.durable().getStagedProposalRow(proposalId)?.state, 'ABANDONED');
  assert.equal(d.durable().countDelegationClaims(delegationId), 1);
  assert.equal(d.durable().getRunAuthority(proposalId), undefined);
});

test('restart after DISPATCHED cannot re-run', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);
  const proposalId = stagedUnder(l, router, delegationId);
  assert.equal(dispatch(router, session, delegationId, proposalId).type, 'result');

  await l.reopen();
  const after = d.connect();
  bind(after, session);
  assert.equal(d.durable().getRunAuthority(proposalId)?.authority, 'DELEGATED_RUN');
  assert.equal(errorCode(dispatch(after, session, delegationId, proposalId)), 'PROPOSAL_NOT_STAGED');
  assert.equal(d.durable().countDelegationClaims(delegationId), 1);
});

// ---------------------------------------------------------------------------------------------
// Identity on the result path, and the refusal audit
// ---------------------------------------------------------------------------------------------

test('a result can only be attached by the context that staged the proposal', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);
  const proposalId = stagedUnder(l, router, delegationId);
  assert.equal(dispatch(router, session, delegationId, proposalId).type, 'result');

  // The envelope claims another session: refused by the transport, before the plane.
  const foreign = router.handle({
    version: V, type: 'run.result', requestId: rid(), sessionId: 'session_somebody_else',
    proposalId, resultId: 'res_not_yours',
  }) as { type: string; error?: { code: string } };
  assert.equal(errorCode(foreign), 'SESSION_MISMATCH');
  assert.equal(d.durable().getRunAuthority(proposalId)?.resultId, undefined);

  // The owner attaches, once.
  assert.equal((router.handle({
    version: V, type: 'run.result', requestId: rid(), sessionId: session,
    proposalId, resultId: 'res_owner_0001',
  }) as { type: string }).type, 'result');
  const again = router.handle({
    version: V, type: 'run.result', requestId: rid(), sessionId: session,
    proposalId, resultId: 'res_again',
  }) as { type: string; error?: { code: string } };
  assert.equal(errorCode(again), 'RESULT_ALREADY_ATTACHED');
  assert.equal(d.durable().getRunAuthority(proposalId)?.resultId, 'res_owner_0001');
});

test('refusals are audited as DELEGATED_RUN_REFUSED with their reason and spend flag', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);
  const proposalId = stagedUnder(l, router, delegationId);

  // One refused dispatch that reached the plane, and one refused by the transport. The delegation
  // named here exists — an id that did not would be `NO_DELEGATION`, which is a different fact.
  const unnamed = d.issueUnnamed();
  assert.equal(errorCode(dispatch(router, session, unnamed, proposalId)),
    'DELEGATION_NOT_CONFIGURED');
  assert.equal(errorCode(router.handle({
    version: V, type: 'run.dispatch', requestId: rid(), sessionId: 'session_other',
    delegationId, proposalId,
  }) as { type: string; error?: { code: string } }), 'SESSION_MISMATCH');

  const rows = d.durable().listDelegatedRunRefusals({
    sessionId: session, adapterId: BROWSER_DELEGATION_ADAPTER_ID,
  });
  assert.deepEqual(rows.map((r) => r.reasonCode), ['DELEGATION_NOT_CONFIGURED'],
    'the transport refusal never reached the plane, so it is not a policy refusal');
  assert.equal(rows[0]?.authority, 'DELEGATED_RUN_REFUSED');
  assert.equal(rows[0]?.slotClaimed, false, 'refused before the claim, so nothing was spent');

  // The audit carries identity, never content.
  assert.equal(JSON.stringify(rows).includes('needle'), false);
  assert.equal(d.durable().countDelegationClaims(delegationId), 0);
});

test('the kill switch stops delegated dispatch over the wire', async (t) => {
  const l = await lane(t);
  const d = l.delegation();
  const delegationId = d.issue();
  const router = d.connect();
  const session = d.connection.sessionId;
  bind(router, session);
  const proposalId = stagedUnder(l, router, delegationId);

  l.setKillSwitch(true);
  const stopped = d.connect();
  bind(stopped, session);
  assert.equal(errorCode(dispatch(stopped, session, delegationId, proposalId)), 'KILL_SWITCH_ENGAGED');
  assert.equal(d.durable().countDelegationClaims(delegationId), 0);

  l.setKillSwitch(false);
  const resumed = d.connect();
  bind(resumed, session);
  assert.equal(dispatch(resumed, session, delegationId, proposalId).type, 'result',
    'it pauses autonomy; it does not revoke authority');
});
