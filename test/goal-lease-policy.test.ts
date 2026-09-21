import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateGoalLease,
  matchesPattern,
  validateBindings,
  type GoalLeaseBindings,
  type GoalLeaseRecord,
  type LeaseDenialCode,
  type LeaseRequest,
} from '../src/goal-lease.js';

/**
 * The policy engine is the approver under a Goal Lease, so these tests are mostly about what it
 * refuses. It is pure, so every case here is exact: no clock, no filesystem, no store.
 */
const ROOT = 'E:/fixture/workspace';
const NOW = 1_000_000;

const BINDINGS: GoalLeaseBindings = {
  workspaceRoots: [ROOT],
  allowedTools: ['mutation.preview'],
  pathPatterns: ['src/**/*.ts', 'ticket-id.js'],
  maxFiles: 3,
  maxBytes: 10_000,
  maxDiffBytes: 4_000,
  admittedSessions: ['session_ok'],
  admittedAdapters: ['browser.chatgpt.native.operator.v4'],
  commitSemantics: 'none',
};

const LEASE: GoalLeaseRecord = {
  leaseId: 'lease_test',
  createdAt: NOW - 1000,
  notBefore: NOW - 1000,
  expiresAt: NOW + 1000,
  bindings: BINDINGS,
};

const REQUEST: LeaseRequest = {
  tool: 'mutation.preview',
  sessionId: 'session_ok',
  adapterId: 'browser.chatgpt.native.operator.v4',
  workspaceRoot: ROOT,
  path: 'ticket-id.js',
  diffBytes: 100,
};

const NO_SPEND = { filesChanged: 0, bytesWritten: 0 };

function decide(over: {
  lease?: GoalLeaseRecord | undefined;
  request?: Partial<LeaseRequest>;
  spend?: { filesChanged: number; bytesWritten: number };
  now?: number;
  killSwitch?: boolean;
} = {}) {
  return evaluateGoalLease({
    lease: 'lease' in over ? over.lease : LEASE,
    now: over.now ?? NOW,
    request: { ...REQUEST, ...over.request },
    spend: over.spend ?? NO_SPEND,
    killSwitch: over.killSwitch ?? false,
  });
}

function denialOf(over: Parameters<typeof decide>[0]): LeaseDenialCode {
  const decision = decide(over);
  assert.equal(decision.admitted, false, 'expected a denial');
  return (decision as { code: LeaseDenialCode }).code;
}

test('a request strictly inside the lease is admitted', () => {
  assert.deepEqual(decide(), { admitted: true });
});

test('every binding is load-bearing: change one thing and it is denied', () => {
  // Each row is a single deviation from a request that is otherwise admitted above, so a guard
  // that stopped being consulted would show up here as an admission rather than a denial.
  const cases: Array<[LeaseDenialCode, Parameters<typeof decide>[0]]> = [
    ['NO_LEASE', { lease: undefined }],
    ['KILL_SWITCH_ENGAGED', { killSwitch: true }],
    ['LEASE_REVOKED', { lease: { ...LEASE, revokedAt: NOW - 1 } }],
    ['LEASE_EXPIRED', { now: LEASE.expiresAt }],
    ['LEASE_NOT_YET_VALID', { now: LEASE.notBefore - 1 }],
    ['SESSION_NOT_ADMITTED', { request: { sessionId: 'session_other' } }],
    ['ADAPTER_NOT_ADMITTED', { request: { adapterId: 'browser.chatgpt.native.verify.v3' } }],
    ['TOOL_NOT_GRANTED', { request: { tool: 'git.commit' } }],
    ['WORKSPACE_NOT_GRANTED', { request: { workspaceRoot: 'E:/somewhere/else' } }],
    ['PATH_NOT_GRANTED', { request: { path: 'README.md' } }],
    ['PATH_ESCAPES_ROOT', { request: { path: '../outside.ts' } }],
    ['PATH_ESCAPES_ROOT', { request: { path: '/etc/passwd' } }],
    ['PATH_ESCAPES_ROOT', { request: { path: 'C:/Windows/system32/drivers/etc/hosts' } }],
    ['DIFF_TOO_LARGE', { request: { diffBytes: 4_001 } }],
    ['FILE_BUDGET_EXHAUSTED', { spend: { filesChanged: 3, bytesWritten: 0 } }],
    ['BYTE_BUDGET_EXHAUSTED', { spend: { filesChanged: 0, bytesWritten: 9_950 } }],
    ['COMMIT_NOT_GRANTED', { request: { wantsCommit: true } }],
  ];
  for (const [expected, over] of cases) {
    assert.equal(denialOf(over), expected, `${expected} case`);
  }
});

test('the lease cannot grant authority over its own policy', () => {
  // Requirement 9. These are refused even though the pattern below would otherwise match them,
  // which is the point: the protection is not a gap in the patterns, it is a rule above them.
  const wideOpen: GoalLeaseRecord = {
    ...LEASE,
    bindings: { ...BINDINGS, pathPatterns: ['**'] },
  };
  for (const path of [
    '.claude/settings.json',
    '.claude/hooks/wag-human-gate-guard.mjs',
    '.CLAUDE/rules/human-presence-boundary.md',
    '.git/config',
    'docs/adr/0027-allow-a-fixture-only-harness-authority-lane.md',
    'AGENTS.md',
    'package.json',
    'tsconfig.build.json',
  ]) {
    const decision = evaluateGoalLease({
      lease: wideOpen, now: NOW, request: { ...REQUEST, path }, spend: NO_SPEND, killSwitch: false,
    });
    assert.equal(decision.admitted, false, `${path} must be refused`);
    assert.equal((decision as { code: string }).code, 'AUTHORITY_FILE_PROTECTED', path);
  }
});

test('an empty list grants nothing rather than everything', () => {
  // The classic default-deny inversion. An empty allowlist read as "no restriction" is how these
  // engines fail open, so it is refused at validation and would deny at evaluation regardless.
  for (const field of ['workspaceRoots', 'allowedTools', 'pathPatterns', 'admittedSessions', 'admittedAdapters'] as const) {
    const bindings = { ...BINDINGS, [field]: [] } as unknown as GoalLeaseBindings;
    assert.ok(validateBindings(bindings), `${field} empty must fail validation`);
    const decision = evaluateGoalLease({
      lease: { ...LEASE, bindings }, now: NOW, request: REQUEST, spend: NO_SPEND, killSwitch: false,
    });
    assert.equal(decision.admitted, false, `${field} empty must deny`);
    assert.equal((decision as { code: string }).code, 'LEASE_MALFORMED');
  }
});

test('a commit is admitted only on the bound branch at the bound HEAD', () => {
  const committing: GoalLeaseRecord = {
    ...LEASE,
    bindings: {
      ...BINDINGS,
      commitSemantics: 'commit-to-bound-branch',
      branch: 'feat/autonomous',
      headSha: 'abc123',
      allowedTools: ['mutation.preview', 'git.commit'],
    },
  };
  const ask = (over: Partial<LeaseRequest>) => evaluateGoalLease({
    lease: committing, now: NOW, spend: NO_SPEND, killSwitch: false,
    request: { ...REQUEST, wantsCommit: true, branch: 'feat/autonomous', headSha: 'abc123', ...over },
  });

  assert.deepEqual(ask({}), { admitted: true });
  assert.equal((ask({ branch: 'main' }) as { code: string }).code, 'BRANCH_NOT_GRANTED');
  assert.equal((ask({ branch: undefined }) as { code: string }).code, 'BRANCH_NOT_GRANTED');
  // HEAD having moved means the lease was written against a repository that no longer exists.
  assert.equal((ask({ headSha: 'def456' }) as { code: string }).code, 'HEAD_MOVED');
  assert.equal((ask({ headSha: undefined }) as { code: string }).code, 'HEAD_MOVED');
});

test('a commit-granting lease must bind a branch and a HEAD to be valid at all', () => {
  assert.ok(validateBindings({ ...BINDINGS, commitSemantics: 'commit-to-bound-branch' }));
  assert.ok(validateBindings({ ...BINDINGS, commitSemantics: 'commit-to-bound-branch', branch: 'x' }));
  assert.equal(
    validateBindings({ ...BINDINGS, commitSemantics: 'commit-to-bound-branch', branch: 'x', headSha: 'y' }),
    undefined,
  );
});

test('patterns that could reach outside a root are refused at validation', () => {
  for (const pattern of ['/etc/**', '../**', 'src/../../etc/**', 'C:/Windows/**', 'src\\**']) {
    assert.ok(validateBindings({ ...BINDINGS, pathPatterns: [pattern] }), `${pattern} must be refused`);
  }
});

test('the matcher handles the segment cases without regex', () => {
  assert.equal(matchesPattern('src/**/*.ts', 'src/a/b/c.ts'), true);
  assert.equal(matchesPattern('src/**/*.ts', 'src/c.ts'), true);
  assert.equal(matchesPattern('src/**/*.ts', 'test/c.ts'), false);
  assert.equal(matchesPattern('src/*.ts', 'src/a/b.ts'), false, '* does not cross a separator');
  assert.equal(matchesPattern('**', 'anything/at/all.txt'), true);
  assert.equal(matchesPattern('ticket-id.js', 'ticket-id.js'), true);
  assert.equal(matchesPattern('ticket-id.js', 'ticket-id.jsx'), false);
  assert.equal(matchesPattern('*.ts', 'a.ts'), true);
  assert.equal(matchesPattern('a*c', 'abbbbc'), true);
  assert.equal(matchesPattern('a*c', 'abbbbd'), false);
});

test('the matcher does not backtrack catastrophically', () => {
  // The shape that produced a 530s measurement elsewhere in this repository when a pattern was
  // compiled to a RegExp. Budgeted generously; the point is that it is not exponential.
  const pattern = `${'*/'.repeat(20)}*.ts`;
  const value = `${'a/'.repeat(40)}b.js`;
  const started = Date.now();
  assert.equal(matchesPattern(pattern, value), false);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `matching took ${elapsed}ms, which suggests backtracking`);
});

test('a budget is consumed by what came before, not just by this request', () => {
  // Two files already spent of three: one more is allowed, the one after that is not.
  assert.deepEqual(decide({ spend: { filesChanged: 2, bytesWritten: 0 } }), { admitted: true });
  assert.equal(denialOf({ spend: { filesChanged: 3, bytesWritten: 0 } }), 'FILE_BUDGET_EXHAUSTED');
  // Bytes are the sum, not the single request.
  assert.deepEqual(decide({ spend: { filesChanged: 0, bytesWritten: 9_900 }, request: { diffBytes: 100 } }), { admitted: true });
  assert.equal(denialOf({ spend: { filesChanged: 0, bytesWritten: 9_901 }, request: { diffBytes: 100 } }), 'BYTE_BUDGET_EXHAUSTED');
});

test('a non-finite clock denies rather than comparing', () => {
  // Both are refused as malformed rather than compared. Infinity would happen to read as expired
  // and -Infinity as not-yet-valid, but relying on that would mean trusting an arithmetic
  // accident for a security decision; refusing the clock outright is the honest answer, and it
  // does not depend on which side of the comparison the nonsense lands.
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(denialOf({ now }), 'LEASE_MALFORMED', `${now}`);
  }
});

test('a malformed proposal size denies rather than being coerced', () => {
  for (const diffBytes of [-1, 1.5, Number.NaN]) {
    assert.equal(denialOf({ request: { diffBytes } }), 'LEASE_MALFORMED', `${diffBytes}`);
  }
});
