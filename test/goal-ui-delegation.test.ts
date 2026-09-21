import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateUiDelegation,
  MAX_DELEGATION_WINDOW_MS,
  validateDelegationBindings,
  type DelegatedRunRequest,
  type DelegationDenialCode,
  type UiDelegationBindings,
  type UiDelegationRecord,
} from '../src/goal-ui-delegation.js';

/**
 * Goal UI Delegation is the authority that lets a bounded goal drive Run without a human click,
 * so these tests are almost entirely about what it refuses. The pure policy has no clock, no
 * store and no browser, which is what makes every case below exact.
 */
const NOW = 1_000_000;
const FINGERPRINT = 'fp_9f8a7b6c5d4e3f2a';

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
  delegationId: 'uidel_1',
  createdAt: NOW - 1000,
  notBefore: NOW - 1000,
  expiresAt: NOW + 60_000,
  bindings: BINDINGS,
};

const REQUEST: DelegatedRunRequest = {
  goalId: 'goal_abc',
  controllerId: 'claude.local.controller',
  delegationId: 'uidel_1',
  nonce: 'nonce_abcdefghijklmnop',
  tool: 'repo.search',
  workspaceId: 'ws_1',
  sessionId: 'session_1',
  adapterId: 'browser.chatgpt.native.operator.v4',
  origin: 'https://chatgpt.com',
  proposalFingerprint: FINGERPRINT,
  expectedProposalFingerprint: FINGERPRINT,
};

const NO_SPEND = { actionsUsed: 0, nonceAlreadyUsed: false };

function decide(over: {
  delegation?: UiDelegationRecord | undefined;
  request?: Partial<DelegatedRunRequest>;
  spend?: { actionsUsed: number; nonceAlreadyUsed: boolean };
  now?: number;
  killSwitch?: boolean;
} = {}) {
  return evaluateUiDelegation({
    delegation: 'delegation' in over ? over.delegation : DELEGATION,
    now: over.now ?? NOW,
    request: { ...REQUEST, ...over.request },
    spend: over.spend ?? NO_SPEND,
    killSwitch: over.killSwitch ?? false,
  });
}

function denialOf(over: Parameters<typeof decide>[0]): DelegationDenialCode {
  const decision = decide(over);
  assert.equal(decision.admitted, false, 'expected a denial');
  return (decision as { code: DelegationDenialCode }).code;
}

test('a dispatch strictly inside the delegation is admitted', () => {
  assert.deepEqual(decide(), { admitted: true });
});

test('every binding is load-bearing: change one thing and Run stays human', () => {
  const cases: Array<[DelegationDenialCode, Parameters<typeof decide>[0]]> = [
    ['NO_DELEGATION', { delegation: undefined }],
    ['KILL_SWITCH_ENGAGED', { killSwitch: true }],
    ['DELEGATION_REVOKED', { delegation: { ...DELEGATION, revokedAt: NOW - 1 } }],
    ['DELEGATION_EXPIRED', { now: DELEGATION.expiresAt }],
    ['DELEGATION_NOT_YET_VALID', { now: DELEGATION.notBefore - 1 }],
    ['GOAL_MISMATCH', { request: { goalId: 'goal_other' } }],
    ['CONTROLLER_MISMATCH', { request: { controllerId: 'somebody.else' } }],
    ['SESSION_MISMATCH', { request: { sessionId: 'session_2' } }],
    ['ADAPTER_MISMATCH', { request: { adapterId: 'browser.chatgpt.native.verify.v3' } }],
    ['WORKSPACE_MISMATCH', { request: { workspaceId: 'ws_2' } }],
    ['ORIGIN_NOT_ALLOWED', { request: { origin: 'https://evil.example' } }],
    ['TOOL_NOT_DELEGATED', { request: { tool: 'mutation.preview' } }],
    ['ACTION_LIMIT_REACHED', { spend: { actionsUsed: 5, nonceAlreadyUsed: false } }],
    ['NONCE_REPLAYED', { spend: { actionsUsed: 0, nonceAlreadyUsed: true } }],
    ['NONCE_MALFORMED', { request: { nonce: 'short' } }],
    ['PROPOSAL_IDENTITY_MISMATCH', { request: { proposalFingerprint: 'fp_something_else' } }],
  ];
  for (const [expected, over] of cases) {
    assert.equal(denialOf(over), expected, `${expected} case`);
  }
});

test('a tool the adapter exposes is still refused unless it was delegated', () => {
  // The whole point of a delegation being narrower than the surface. The v4 adapter exposes
  // twelve tools; a read delegation must not carry the consequential five merely because they
  // exist.
  for (const tool of ['mutation.preview', 'file.create', 'mutation.result', 'git.commit', 'git.commit.result']) {
    assert.equal(denialOf({ request: { tool } }), 'TOOL_NOT_DELEGATED', tool);
  }
  // And the ones actually delegated are admitted.
  for (const tool of ['repo.search', 'file.read']) {
    assert.deepEqual(decide({ request: { tool } }), { admitted: true }, tool);
  }
});

test('nothing the page can say widens the delegation', () => {
  // These are the fields a hostile page could influence: the origin it is served from and the
  // proposal content that produced the fingerprint. Neither can grant anything.
  assert.equal(denialOf({ request: { origin: 'https://chatgpt.com.evil.example' } }), 'ORIGIN_NOT_ALLOWED');
  assert.equal(denialOf({ request: { origin: 'http://chatgpt.com' } }), 'ORIGIN_NOT_ALLOWED',
    'a downgraded scheme is a different origin');
  assert.equal(denialOf({ request: { origin: 'https://chatgpt.com:8443' } }), 'ORIGIN_NOT_ALLOWED',
    'a different port is a different origin');
  assert.equal(denialOf({ request: { origin: 'not-a-url' } }), 'ORIGIN_NOT_ALLOWED');
  // A proposal whose identity is not the one delegated for cannot borrow the delegation.
  assert.equal(denialOf({ request: { proposalFingerprint: 'fp_swapped' } }), 'PROPOSAL_IDENTITY_MISMATCH');
  assert.equal(denialOf({ request: { proposalFingerprint: '' } }), 'PROPOSAL_IDENTITY_MISMATCH');
});

test('a replayed dispatch is refused even when everything else is valid', () => {
  // Staleness and replay are the failure this design most has to survive: a captured dispatch
  // must not be re-runnable.
  assert.equal(denialOf({ spend: { actionsUsed: 1, nonceAlreadyUsed: true } }), 'NONCE_REPLAYED');
  for (const nonce of ['', 'tooshort', 'has spaces in it', 'x'.repeat(129), 'has/slash+chars=']) {
    assert.equal(denialOf({ request: { nonce } }), 'NONCE_MALFORMED', JSON.stringify(nonce));
  }
});

test('the action limit counts what came before, not just this request', () => {
  assert.deepEqual(decide({ spend: { actionsUsed: 4, nonceAlreadyUsed: false } }), { admitted: true });
  assert.equal(denialOf({ spend: { actionsUsed: 5, nonceAlreadyUsed: false } }), 'ACTION_LIMIT_REACHED');
  assert.equal(denialOf({ spend: { actionsUsed: 99, nonceAlreadyUsed: false } }), 'ACTION_LIMIT_REACHED');
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
  assert.deepEqual(decide({ delegation: ok, now: NOW + 1 }), { admitted: true });
  const tooLong = { ...DELEGATION, notBefore: NOW, expiresAt: NOW + MAX_DELEGATION_WINDOW_MS + 1 };
  assert.equal(denialOf({ delegation: tooLong, now: NOW + 1 }), 'DELEGATION_MALFORMED');
});

test('bindings that are not an object deny rather than throw', () => {
  for (const bindings of [null, 'a string', 42, []] as unknown as UiDelegationBindings[]) {
    assert.ok(validateDelegationBindings(bindings), 'must be refused');
    assert.equal(denialOf({ delegation: { ...DELEGATION, bindings } }), 'DELEGATION_MALFORMED');
  }
});

test('the kill switch is checked before the delegation is even loaded', () => {
  // So a stop works even when the delegation record is unreadable or absent.
  assert.equal(denialOf({ killSwitch: true, delegation: undefined }), 'KILL_SWITCH_ENGAGED');
  assert.equal(denialOf({
    killSwitch: true,
    delegation: { ...DELEGATION, bindings: null as unknown as UiDelegationBindings },
  }), 'KILL_SWITCH_ENGAGED');
});
