import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateDelegatedRun,
  MAX_DELEGATION_WINDOW_MS,
  parseDispatchRequest,
  validateDelegationBindings,
  type ConnectionIdentity,
  type DelegationDenialCode,
  type ProposalState,
  type StagedProposalRecord,
  type UiDelegationBindings,
  type UiDelegationRecord,
  type WorkspaceAuthorityRecord,
} from '../src/goal-ui-delegation.js';
import { canonicalProposalFingerprint } from '../src/proposal-fingerprint.js';

/**
 * The pure policy has no clock, no store and no browser, which is what makes every case here
 * exact. Almost all of it is about what is refused — and, just as much, about what it declines to
 * accept as input at all.
 */
const NOW = 1_000_000;
const DELEGATION_ID = 'uidel_policy_fixture';

const BINDINGS: UiDelegationBindings = {
  goalId: 'goal_abc',
  controllerId: 'claude.local.controller',
  allowedOrigins: ['https://chatgpt.com'],
  allowedTools: ['repo.search', 'file.read'],
  workspaceId: 'ws_1',
  sessionId: 'session_1',
  adapterId: 'browser.chatgpt.native.operator.v4',
  maxActions: 5,
};

const DELEGATION: UiDelegationRecord = {
  delegationId: DELEGATION_ID,
  createdAt: NOW - 1000,
  notBefore: NOW - 1000,
  expiresAt: NOW + 60_000,
  bindings: BINDINGS,
};

const CONNECTION: ConnectionIdentity = {
  ownerId: 'owner_1',
  sessionId: 'session_1',
  adapterId: 'browser.chatgpt.native.operator.v4',
};

/** The durable workspace row, owned by exactly the connection above unless a case says otherwise. */
const WORKSPACE: WorkspaceAuthorityRecord = {
  ownerId: 'owner_1',
  sessionId: 'session_1',
  adapterId: 'browser.chatgpt.native.operator.v4',
};

function stage(over: Partial<StagedProposalRecord> = {}): StagedProposalRecord {
  const base = {
    proposalId: 'prop_1',
    delegationId: DELEGATION_ID,
    tool: 'repo.search',
    workspaceId: 'ws_1',
    origin: 'https://chatgpt.com',
    arguments: { workspace_id: 'ws_1', query: 'needle' },
    sessionId: 'session_1',
    adapterId: 'browser.chatgpt.native.operator.v4',
    stagedAt: NOW - 500,
    state: 'STAGED' as ProposalState,
    ...over,
  } as StagedProposalRecord;
  // Unless a test deliberately supplies a wrong one, the stored fingerprint is the one WAG would
  // have computed at staging — from the same six fields, including the browser context.
  if (over.fingerprint !== undefined) return base;
  return { ...base, fingerprint: canonicalProposalFingerprint(base) };
}

function decide(over: {
  delegation?: UiDelegationRecord | undefined;
  proposal?: StagedProposalRecord | undefined;
  connection?: ConnectionIdentity;
  workspace?: WorkspaceAuthorityRecord | undefined;
  spend?: { actionsUsed: number };
  now?: number;
  killSwitch?: boolean;
  configuredDelegationId?: string | undefined;
} = {}) {
  return evaluateDelegatedRun({
    killSwitch: over.killSwitch ?? false,
    configuredDelegationId: 'configuredDelegationId' in over
      ? over.configuredDelegationId : DELEGATION_ID,
    delegation: 'delegation' in over ? over.delegation : DELEGATION,
    proposal: 'proposal' in over ? over.proposal : stage(),
    connection: over.connection ?? CONNECTION,
    workspace: 'workspace' in over ? over.workspace : WORKSPACE,
    now: over.now ?? NOW,
    spend: over.spend ?? { actionsUsed: 0 },
  });
}

function denialOf(over: Parameters<typeof decide>[0]): DelegationDenialCode {
  const decision = decide(over);
  assert.equal(decision.admitted, false, 'expected a denial');
  return (decision as { code: DelegationDenialCode }).code;
}

test('a dispatch strictly inside the delegation is admitted, and carries WAG-computed identity', () => {
  const decision = decide();
  assert.equal(decision.admitted, true);
  assert.equal(
    (decision as { fingerprint: string }).fingerprint,
    canonicalProposalFingerprint(stage()),
    'the admission reports the identity WAG derived, not one it was told',
  );
});

test('every binding is load-bearing: change one thing and Run stays human', () => {
  const cases: Array<[DelegationDenialCode, Parameters<typeof decide>[0]]> = [
    ['KILL_SWITCH_ENGAGED', { killSwitch: true }],
    ['NO_DELEGATION', { delegation: undefined }],
    ['DELEGATION_NOT_CONFIGURED', { configuredDelegationId: undefined }],
    ['DELEGATION_NOT_CONFIGURED', { configuredDelegationId: 'uidel_a_different_one' }],
    ['DELEGATION_REVOKED', { delegation: { ...DELEGATION, revokedAt: NOW - 1 } }],
    ['DELEGATION_SUPERSEDED', { delegation: { ...DELEGATION, supersededBy: 'uidel_successor' } }],
    ['DELEGATION_EXPIRED', { now: DELEGATION.expiresAt }],
    ['DELEGATION_NOT_YET_VALID', { now: DELEGATION.notBefore - 1 }],
    ['NO_PROPOSAL', { proposal: undefined }],
    ['PROPOSAL_NOT_STAGED', { proposal: stage({ state: 'CLAIMED' }) }],
    ['PROPOSAL_NOT_FOR_THIS_DELEGATION', { proposal: stage({ delegationId: 'uidel_other' }) }],
    ['SESSION_MISMATCH', { connection: { ...CONNECTION, sessionId: 'session_2' } }],
    ['ADAPTER_MISMATCH', { connection: { ...CONNECTION, adapterId: 'browser.chatgpt.native.verify.v3' } }],
    ['WORKSPACE_MISMATCH', { proposal: stage({ workspaceId: 'ws_2' }) }],
    ['ORIGIN_NOT_ALLOWED', { proposal: stage({ origin: 'https://evil.example' }) }],
    ['TOOL_NOT_DELEGATED', { proposal: stage({ tool: 'mutation.preview' }) }],
    ['ACTION_LIMIT_REACHED', { spend: { actionsUsed: 5 } }],
    ['PROPOSAL_INCONSISTENT', { proposal: stage({ fingerprint: 'fp_not_the_real_one' }) }],
  ];
  for (const [expected, over] of cases) {
    assert.equal(denialOf(over), expected, `${expected} case`);
  }
});

test('a delegation is inert unless local configuration names it', () => {
  // The row is not the grant. This is what keeps issuance a human act: a delegation that arrived
  // by any route other than the human's out-of-band one authorises nothing on its own.
  assert.equal(denialOf({ configuredDelegationId: undefined }), 'DELEGATION_NOT_CONFIGURED');
  assert.equal(denialOf({ configuredDelegationId: '' }), 'DELEGATION_NOT_CONFIGURED');
  assert.equal(denialOf({ configuredDelegationId: `${DELEGATION_ID} ` }), 'DELEGATION_NOT_CONFIGURED');
  assert.equal(denialOf({ configuredDelegationId: DELEGATION_ID.toUpperCase() }), 'DELEGATION_NOT_CONFIGURED');
  assert.equal(decide({ configuredDelegationId: DELEGATION_ID }).admitted, true);
});

test('only a STAGED proposal may be claimed', () => {
  for (const state of ['CLAIMED', 'DISPATCHED', 'RESULTED', 'ABANDONED'] as ProposalState[]) {
    const decision = decide({ proposal: stage({ state }) });
    assert.equal(decision.admitted, false, state);
    assert.equal((decision as { code: string }).code, 'PROPOSAL_NOT_STAGED');
    assert.match((decision as { detail: string }).detail, new RegExp(state),
      'the refusal names the state, so "someone got there first" reads differently from "reaped"');
  }
});

test('the request carries no authority, because it carries no such fields', () => {
  const valid = { delegationId: 'uidel_0123456789abcdef', proposalId: 'prop_abc12345' };
  assert.deepEqual(parseDispatchRequest(valid), { ok: true, request: valid });

  for (const forged of [
    { ...valid, goalId: 'goal_abc' },
    { ...valid, controllerId: 'claude.local.controller' },
    { ...valid, expiresAt: Number.MAX_SAFE_INTEGER },
    { ...valid, maxActions: 9999 },
    { ...valid, authority: 'DELEGATED_RUN' },
    { ...valid, proposalFingerprint: 'fp_whatever' },
    { ...valid, killSwitch: false },
    { ...valid, state: 'STAGED' },
    { ...valid, slotClaimed: false },
  ]) {
    assert.equal(parseDispatchRequest(forged).ok, false, `${Object.keys(forged).join(',')} must be refused`);
  }
});

test('a dispatch request must be two well-formed references and nothing else', () => {
  for (const bad of [
    null, undefined, 'a string', 42, [], {},
    { delegationId: 'uidel_0123456789abcdef' },
    { proposalId: 'prop_abc12345' },
    { delegationId: 'uidel_0123456789abcdef', proposalId: '' },
    { delegationId: 'uidel_0123456789abcdef', proposalId: 'short' },
    { delegationId: 'uidel_0123456789abcdef', proposalId: 'has spaces in it' },
    { delegationId: 'uidel_1', proposalId: 'prop_abc12345' },
    { delegationId: '', proposalId: 'prop_abc12345' },
    { delegationId: 'uidel_0123456789abcdef', proposalId: 'x'.repeat(129) },
    { delegationId: 42, proposalId: 'prop_abc12345' },
  ]) {
    assert.equal(parseDispatchRequest(bad).ok, false, JSON.stringify(bad) ?? String(bad));
  }
});

test('a prototype-polluting request is refused, and pollutes nothing', () => {
  const hostile = JSON.parse(
    '{"__proto__": {"polluted": true}, "delegationId": "uidel_0123456789abcdef", "proposalId": "prop_abc12345"}',
  ) as unknown;
  assert.equal(parseDispatchRequest(hostile).ok, false, 'three own keys, so it is not a dispatch request');
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'and Object.prototype is untouched');
});

test('a tool the adapter exposes is still refused unless it was delegated', () => {
  // The v4 adapter exposes twelve tools; a read delegation must not carry the consequential five
  // merely because they exist.
  for (const tool of ['mutation.preview', 'file.create', 'mutation.result', 'git.commit', 'git.commit.result']) {
    assert.equal(denialOf({ proposal: stage({ tool }) }), 'TOOL_NOT_DELEGATED', tool);
  }
  // And names that *extend* a delegated one, which is how an allowlist compared by prefix rather
  // than by equality would leak. A mutation making this a prefix match survived until these
  // existed: every earlier case differed from the allowed names in the first character.
  for (const tool of ['file.readonly', 'file.read.write', 'repo.searchx', 'repo.search.destroy']) {
    assert.equal(denialOf({ proposal: stage({ tool }) }), 'TOOL_NOT_DELEGATED', tool);
  }
  for (const tool of ['repo.search', 'file.read']) {
    assert.equal(decide({ proposal: stage({ tool }) }).admitted, true, tool);
  }
});

test('nothing the page can influence widens the delegation', () => {
  for (const origin of [
    'https://chatgpt.com.evil.example',
    'http://chatgpt.com',
    'https://chatgpt.com:8443',
    'https://chatgpt.com/',
    'not-a-url',
  ]) {
    assert.equal(denialOf({ proposal: stage({ origin }) }), 'ORIGIN_NOT_ALLOWED', origin);
  }
});

test('a proposal staged by another browser context cannot be run by this one', () => {
  assert.equal(denialOf({ proposal: stage({ sessionId: 'session_other' }) }), 'PROPOSAL_NOT_OWNED');
  assert.equal(
    denialOf({ proposal: stage({ adapterId: 'browser.chatgpt.native.verify.v3' }) }),
    'PROPOSAL_NOT_OWNED',
  );
});

test('an undelegated proposal matches no delegation', () => {
  const orphan = stage();
  const { delegationId: _dropped, ...withoutDelegation } = orphan;
  assert.equal(
    denialOf({ proposal: withoutDelegation as StagedProposalRecord }),
    'PROPOSAL_NOT_FOR_THIS_DELEGATION',
  );
});

test('the action limit counts what came before, not just this request', () => {
  assert.equal(decide({ spend: { actionsUsed: 4 } }).admitted, true);
  assert.equal(denialOf({ spend: { actionsUsed: 5 } }), 'ACTION_LIMIT_REACHED');
  assert.equal(denialOf({ spend: { actionsUsed: 99 } }), 'ACTION_LIMIT_REACHED');
  for (const actionsUsed of [-1, 1.5, Number.NaN]) {
    assert.equal(denialOf({ spend: { actionsUsed } }), 'DELEGATION_MALFORMED', String(actionsUsed));
  }
});

test('an empty allowlist grants nothing rather than everything', () => {
  for (const field of ['allowedOrigins', 'allowedTools'] as const) {
    const bindings = { ...BINDINGS, [field]: [] } as unknown as UiDelegationBindings;
    assert.ok(validateDelegationBindings(bindings), `${field} empty must fail validation`);
    assert.equal(denialOf({ delegation: { ...DELEGATION, bindings } }), 'DELEGATION_MALFORMED', field);
  }
});

test('origins must be exact https origins, refused at validation', () => {
  for (const origin of [
    'https://chatgpt.com/', 'https://chatgpt.com/path', 'http://chatgpt.com',
    '*://chatgpt.com', 'chatgpt.com', 'https://*.chatgpt.com',
  ]) {
    assert.ok(validateDelegationBindings({ ...BINDINGS, allowedOrigins: [origin] }),
      `${origin} must be refused`);
  }
  assert.equal(validateDelegationBindings({ ...BINDINGS, allowedOrigins: ['https://chatgpt.com'] }), undefined);
});

test('a malformed validity window is refused rather than compared', () => {
  const windows: Array<[number, number]> = [
    [Number.NaN, NOW + 1000], [NOW, Number.NaN], [NOW, Number.POSITIVE_INFINITY],
    [NOW + 1000, NOW], [NOW, NOW],
  ];
  for (const [notBefore, expiresAt] of windows) {
    assert.equal(denialOf({ delegation: { ...DELEGATION, notBefore, expiresAt } }),
      'DELEGATION_MALFORMED', `${notBefore}..${expiresAt}`);
  }
  assert.equal(denialOf({ now: Number.NaN }), 'DELEGATION_MALFORMED');
});

test('a delegation may not outlive the ceiling', () => {
  // Shorter than a Goal Lease's twelve hours, deliberately: this one drives the gate itself.
  const ok = { ...DELEGATION, notBefore: NOW, expiresAt: NOW + MAX_DELEGATION_WINDOW_MS };
  assert.equal(decide({ delegation: ok, now: NOW + 1 }).admitted, true);
  const tooLong = { ...DELEGATION, notBefore: NOW, expiresAt: NOW + MAX_DELEGATION_WINDOW_MS + 1 };
  assert.equal(denialOf({ delegation: tooLong, now: NOW + 1 }), 'DELEGATION_MALFORMED');
});

test('bindings that are not an object deny rather than throw', () => {
  for (const bindings of [null, 'a string', 42, []] as unknown as UiDelegationBindings[]) {
    assert.ok(validateDelegationBindings(bindings), 'must be refused');
    assert.equal(denialOf({ delegation: { ...DELEGATION, bindings } }), 'DELEGATION_MALFORMED');
  }
});

test('the kill switch is checked before anything is even loaded', () => {
  // So a stop works even when the delegation record is unreadable, absent, or unconfigured.
  assert.equal(denialOf({ killSwitch: true, delegation: undefined }), 'KILL_SWITCH_ENGAGED');
  assert.equal(denialOf({ killSwitch: true, configuredDelegationId: undefined }), 'KILL_SWITCH_ENGAGED');
  assert.equal(denialOf({
    killSwitch: true,
    delegation: { ...DELEGATION, bindings: null as unknown as UiDelegationBindings },
  }), 'KILL_SWITCH_ENGAGED');
  assert.equal(denialOf({ killSwitch: true, proposal: undefined }), 'KILL_SWITCH_ENGAGED');
});

test('arguments with no canonical form deny rather than throw', () => {
  const broken = stage();
  assert.equal(
    denialOf({ proposal: { ...broken, arguments: { a: undefined } as never } }),
    'PROPOSAL_MALFORMED',
  );
  // Including the unpaired surrogates that were a measured fingerprint collision.
  assert.equal(
    denialOf({ proposal: { ...broken, arguments: { query: '\uD800' } } }),
    'PROPOSAL_MALFORMED',
  );
});
