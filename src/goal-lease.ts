/**
 * Autonomous Goal Lease v1 — the bindings, and the deterministic policy that reads them.
 *
 * A lease is a bounded grant: while one is active, WAG's own policy may admit an action that is
 * strictly inside it, without a human gesture per action. The point is that the *approver* is this
 * code — a pure function over a durable record — and never the model, the page, or anything that
 * read either of those.
 *
 * ## What this module is, and is not
 *
 * It is not an approval shortcut. There is no branch here that says "if a lease exists, allow";
 * `evaluate` starts denied and returns admitted only after every binding has been checked, and
 * every unknown or malformed input lands in the deny arm. It does not touch the Run button or the
 * operator's Approve route, which continue to work exactly as before and remain the only path
 * when no lease is active.
 *
 * It is also deliberately I/O-free. Every fact it judges — the clock, the workspace root on disk,
 * the current HEAD, how many files the lease has already spent — is passed in by the caller, so
 * this function is total, synchronous and exhaustively testable, and so that the *caller* is
 * visibly responsible for revalidating those facts immediately before the consequence.
 *
 * ## Why the matcher is hand-written
 *
 * Path patterns come from the lease, and a lease is data. Compiling data into a `RegExp` is how
 * this repository already produced one catastrophic-backtracking defect, measured at 530s on a
 * 540KB input. `matchesPattern` below is an explicit two-pointer matcher with a single backtrack
 * point, which cannot blow up that way.
 */

/** Every reason an action can fail to be admitted. Exhaustive, and every one is a denial. */
export type LeaseDenialCode =
  | 'NO_LEASE'
  | 'LEASE_MALFORMED'
  | 'LEASE_NOT_YET_VALID'
  | 'LEASE_EXPIRED'
  | 'LEASE_REVOKED'
  | 'KILL_SWITCH_ENGAGED'
  | 'TOOL_NOT_GRANTED'
  | 'SESSION_NOT_ADMITTED'
  | 'ADAPTER_NOT_ADMITTED'
  | 'WORKSPACE_NOT_GRANTED'
  | 'PATH_NOT_GRANTED'
  | 'PATH_ESCAPES_ROOT'
  | 'FILE_BUDGET_EXHAUSTED'
  | 'BYTE_BUDGET_EXHAUSTED'
  | 'DIFF_TOO_LARGE'
  | 'BRANCH_NOT_GRANTED'
  | 'HEAD_MOVED'
  | 'COMMIT_NOT_GRANTED'
  | 'AUTHORITY_FILE_PROTECTED'
  | 'SELF_MODIFICATION_REFUSED'
  /**
   * The action reached here from an adapter whose Run can be delegated, and this lease does not
   * name the goal that delegation serves. See `delegatedGoalIds`.
   */
  | 'DELEGATED_GOAL_NOT_ADMITTED'
  /**
   * The adapter can have its Run delegated, and the caller could not say which goal is in force.
   * Denied rather than treated as undelegated: an unknown provenance on the one path that needs no
   * human gesture is the case that must fail closed.
   */
  | 'DELEGATED_GOAL_UNKNOWN';

export type LeaseDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly code: LeaseDenialCode; readonly detail: string };

/** Git semantics a lease may grant. `none` is the default and forbids every commit. */
export type LeaseCommitSemantics = 'none' | 'commit-to-bound-branch';

/**
 * Exactly what a lease grants. Everything absent is denied; there is no wildcard for any field,
 * and an empty list grants nothing rather than everything — which is the opposite of the usual
 * accident and is asserted by a test.
 */
export interface GoalLeaseBindings {
  /** Canonical absolute roots. A workspace must resolve to one of these exactly. */
  readonly workspaceRoots: readonly string[];
  readonly allowedTools: readonly string[];
  /** Relative to the matched root, `/`-separated. `*` stays inside a segment, `**` crosses. */
  readonly pathPatterns: readonly string[];
  readonly maxFiles: number;
  readonly maxBytes: number;
  /** A single proposal larger than this is refused regardless of the remaining budget. */
  readonly maxDiffBytes: number;
  readonly admittedSessions: readonly string[];
  readonly admittedAdapters: readonly string[];
  /**
   * Goals whose **delegated** Run this lease will accept work from. Absent means none.
   *
   * ## Why a lease has to say this at all
   *
   * A Goal Lease lifts Approve; a Goal UI Delegation lifts Run (ADR-0029). Each is bounded, each
   * is issued by a human out of band, and neither mentions the other. Composed, they are the only
   * path from an untrusted page's text to an effect with **no human gesture at any step** — and
   * before this field, they composed on nothing but coincidence: the lease checked the session and
   * the adapter, the delegation checked the session and the adapter, and a lease issued for one
   * purpose would silently admit work a delegation issued for an entirely different purpose had
   * proposed. Two humans, two grants, one authority neither of them described.
   *
   * Naming the goal makes the composition an **intersection of two deliberate statements**. The
   * delegation says which goal may Run; the lease says which goal's delegated work it will Approve.
   * Both must name the same goal or the effect falls back to the operator's authenticated approval,
   * which is the ordinary path and not a failure.
   *
   * It is not a widening. A lease that omits it is exactly as strong as it was before — its
   * delegated-adapter actions simply need a person, as every action did before ADR-0029.
   */
  readonly delegatedGoalIds?: readonly string[];
  readonly commitSemantics: LeaseCommitSemantics;
  /** Required when `commitSemantics` is not `none`. */
  readonly branch?: string;
  /** The HEAD the lease was written against; a CAS expectation, not a preference. */
  readonly headSha?: string;
}

export interface GoalLeaseRecord {
  readonly leaseId: string;
  readonly createdAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
  readonly bindings: GoalLeaseBindings;
}

/** What the caller must have revalidated immediately before asking. */
export interface LeaseRequest {
  readonly tool: string;
  readonly sessionId: string;
  readonly adapterId: string;
  /** The workspace's canonical root as read from the durable record, already resolved. */
  readonly workspaceRoot: string;
  /** Relative to `workspaceRoot`, `/`-separated, never absolute and never containing `..`. */
  readonly path: string;
  /** Bytes this one proposal would write. */
  readonly diffBytes: number;
  /**
   * The goal of the live, configured Goal UI Delegation bound to this session and adapter.
   *
   * Resolved by the caller from durable rows immediately before asking — never from a message, a
   * proposal payload or a tool argument. `undefined` means no such delegation was found, which on
   * a delegated adapter is a denial rather than a pass: see `DELEGATED_GOAL_UNKNOWN`.
   */
  readonly delegatedGoalId?: string;
  /** A commit is being requested as part of this action. */
  readonly wantsCommit?: boolean;
  readonly branch?: string;
  /** HEAD as read from the repository *now*, not when the lease was made. */
  readonly headSha?: string;
}

/** What the lease has already spent, counted from durable records, not from memory. */
export interface LeaseSpend {
  readonly filesChanged: number;
  readonly bytesWritten: number;
}

/**
 * The longest a lease may be valid for: twelve hours.
 *
 * Chosen to cover a working day of continuous execution and not a weekend. It is an upper bound
 * on how long an unattended grant can outlive the operator's attention, which is the property
 * that matters; a shorter one is always available by setting `expiresAt`.
 */
export const MAX_LEASE_WINDOW_MS = 12 * 60 * 60 * 1000;

const deny = (code: LeaseDenialCode, detail: string): LeaseDecision => ({ admitted: false, code, detail });

/**
 * Adapters whose **Run** can be performed by a Goal UI Delegation rather than by a person.
 *
 * Restated here rather than imported, because this module is pure by design — no store, no crypto,
 * no zod — and importing `adapter-admission.js` would drag all three into the one function that has
 * to stay trivially reviewable.
 *
 * A restated list is a list that can drift, so the drift has to be caught by something that fires.
 * `goal-lease-delegation-composition.test.ts` enumerates **every** `*_ADAPTER_ID` this codebase
 * exports and asserts each one is classified here as delegated or explicitly not. Adding a fifth
 * adapter identity therefore fails that test until someone says which it is — which is the point,
 * because the failure mode being guarded against is a new delegated adapter silently skipping the
 * composition gate below.
 */
export const DELEGATED_RUN_ADAPTERS: readonly string[] = ['browser.chatgpt.native.delegation.v5'];

/**
 * Paths a lease may never grant, whatever its patterns say.
 *
 * Requirement 9: a lease must not authorise modifying its own authority. These are matched on the
 * `/`-separated relative path, case-insensitively, because Windows will happily open `.CLAUDE/`.
 */
const PROTECTED_PREFIXES = ['.claude/', '.git/', 'docs/adr/'] as const;
const PROTECTED_EXACT = ['agents.md', 'claude.md', 'tsconfig.build.json', 'package.json'] as const;

/**
 * Containment on already-normalised, absolute, comparable paths.
 *
 * Separators are unified and the comparison is case-insensitive, because this runs on Windows
 * where `E:\Repo` and `e:/repo` name the same directory. It is not a substitute for a realpath
 * check — the caller passes canonical roots — but it must not be defeated by spelling.
 */
function isWithin(root: string, candidate: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const r = norm(root);
  const c = norm(candidate);
  return c === r || c.startsWith(`${r}/`);
}

function isProtectedAuthorityPath(relative: string): boolean {
  const lower = relative.toLowerCase();
  if (PROTECTED_EXACT.includes(lower as (typeof PROTECTED_EXACT)[number])) return true;
  return PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Glob match with `*` (within a segment) and `**` (across segments).
 *
 * Two pointers and one remembered star, so there is no recursion and no backtracking tree. Written
 * out rather than compiled to a `RegExp` on purpose — see the module header.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  // `**` is only meaningful as a whole segment; anywhere else it behaves as a single `*`.
  const p = pattern.split('/');
  const v = value.split('/');
  return matchSegments(p, 0, v, 0);
}

function matchSegments(p: readonly string[], pi: number, v: readonly string[], vi: number): boolean {
  let pIndex = pi;
  let vIndex = vi;
  let starP = -1;
  let starV = 0;
  while (vIndex < v.length) {
    const seg = p[pIndex];
    if (seg === '**') {
      starP = pIndex;
      starV = vIndex;
      pIndex += 1;
      continue;
    }
    if (pIndex < p.length && seg !== undefined && matchSegment(seg, v[vIndex] ?? '')) {
      pIndex += 1;
      vIndex += 1;
      continue;
    }
    if (starP !== -1) {
      // The one backtrack point: let `**` swallow another segment.
      starV += 1;
      vIndex = starV;
      pIndex = starP + 1;
      continue;
    }
    return false;
  }
  while (pIndex < p.length && p[pIndex] === '**') pIndex += 1;
  return pIndex === p.length;
}

/** Single segment, `*` matching any run of non-separator characters. Same two-pointer shape. */
function matchSegment(pattern: string, value: string): boolean {
  let pi = 0;
  let vi = 0;
  let starP = -1;
  let starV = 0;
  while (vi < value.length) {
    if (pi < pattern.length && (pattern[pi] === value[vi])) { pi += 1; vi += 1; continue; }
    if (pi < pattern.length && pattern[pi] === '*') { starP = pi; starV = vi; pi += 1; continue; }
    if (starP !== -1) { starV += 1; vi = starV; pi = starP + 1; continue; }
    return false;
  }
  while (pi < pattern.length && pattern[pi] === '*') pi += 1;
  return pi === pattern.length;
}

/**
 * Whether the bindings are structurally sound.
 *
 * Separate from `evaluate` so a malformed lease is refused at creation *and* again at use — a
 * lease is a file, and the file can change between those two moments.
 */
export function validateBindings(bindings: GoalLeaseBindings): string | undefined {
  // The value arrives from `JSON.parse` on a durable row, so it can be anything JSON can be —
  // `null`, a string, a number. Dereferencing it first made a malformed lease *throw* rather
  // than deny, which is fail-closed in effect but not what this module claims: every malformed
  // input is supposed to land in the deny arm, and a thrown TypeError is not that arm.
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) {
    return 'bindings must be an object';
  }
  if (!Array.isArray(bindings.workspaceRoots) || bindings.workspaceRoots.length === 0) {
    return 'workspaceRoots must list at least one root';
  }
  if (bindings.workspaceRoots.some((r) => typeof r !== 'string' || r.length === 0)) {
    return 'workspaceRoots must all be non-empty';
  }
  if (!Array.isArray(bindings.allowedTools) || bindings.allowedTools.length === 0) {
    return 'allowedTools must list at least one tool';
  }
  if (!Array.isArray(bindings.pathPatterns) || bindings.pathPatterns.length === 0) {
    return 'pathPatterns must list at least one pattern';
  }
  for (const field of ['maxFiles', 'maxBytes', 'maxDiffBytes'] as const) {
    const value = bindings[field];
    if (!Number.isInteger(value) || value <= 0) return `${field} must be a positive integer`;
  }
  if (!Array.isArray(bindings.admittedSessions) || bindings.admittedSessions.length === 0) {
    return 'admittedSessions must list at least one session';
  }
  if (!Array.isArray(bindings.admittedAdapters) || bindings.admittedAdapters.length === 0) {
    return 'admittedAdapters must list at least one adapter';
  }
  // Optional, but not unvalidated: present-and-malformed must deny, never read as absent.
  if (bindings.delegatedGoalIds !== undefined) {
    if (!Array.isArray(bindings.delegatedGoalIds)) return 'delegatedGoalIds must be an array';
    if (bindings.delegatedGoalIds.some((g) => typeof g !== 'string' || g.length === 0)) {
      return 'delegatedGoalIds must all be non-empty strings';
    }
  }
  if (bindings.commitSemantics !== 'none' && bindings.commitSemantics !== 'commit-to-bound-branch') {
    return 'commitSemantics must be none or commit-to-bound-branch';
  }
  if (bindings.commitSemantics === 'commit-to-bound-branch') {
    if (!bindings.branch) return 'a commit-granting lease must bind an exact branch';
    if (!bindings.headSha) return 'a commit-granting lease must bind a starting HEAD';
  }
  // A pattern that reaches outside the root can never be satisfied, so refuse it rather than
  // carry a binding whose meaning depends on a later check.
  for (const pattern of bindings.pathPatterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) return 'pathPatterns must all be non-empty';
    if (pattern.startsWith('/') || pattern.includes('..') || /^[A-Za-z]:/.test(pattern) || pattern.includes('\\')) {
      return `pathPattern ${pattern} must be relative, forward-slashed, and must not contain ..`;
    }
  }
  return undefined;
}

/**
 * The whole decision. Default-deny: nothing below can `return` an admission early.
 *
 * `killSwitch` is separate from revocation because it is a machine-wide stop that does not need
 * the store to be writable — see `goal-lease-store.ts`.
 */
export function evaluateGoalLease(input: {
  readonly lease: GoalLeaseRecord | undefined;
  readonly now: number;
  readonly request: LeaseRequest;
  readonly spend: LeaseSpend;
  readonly killSwitch: boolean;
  /**
   * The repository the running gateway was loaded from, if the caller can determine it.
   *
   * A lease grants writes inside a workspace. If that workspace happens to *be* the checkout this
   * gateway is executing from, the lease can rewrite the policy enforcing it — `goal-lease.ts`
   * itself, the kill switch, the path policy, the extension's manifest. Listing those by name was
   * the first attempt and a review showed why it fails: the list protected the *configuration* of
   * authority (`.claude/`, ADRs, AGENTS.md) while leaving every file that *implements* it
   * grantable under a `src/**` pattern.
   *
   * Refusing by location instead is precise. It costs a lease nothing when it targets an
   * unrelated repository — where writing `src/foo.ts` is ordinary work — and refuses exactly the
   * case where a bound can dissolve itself.
   */
  readonly gatewayRoot?: string;
}): LeaseDecision {
  const { lease, now, request, spend } = input;

  if (input.killSwitch) return deny('KILL_SWITCH_ENGAGED', 'the local kill switch is engaged');
  if (!lease) return deny('NO_LEASE', 'no active lease, so manual human approval is required');

  const malformed = validateBindings(lease.bindings);
  if (malformed) return deny('LEASE_MALFORMED', malformed);

  if (typeof lease.revokedAt === 'number') return deny('LEASE_REVOKED', `revoked at ${lease.revokedAt}`);
  if (!Number.isFinite(now)) return deny('LEASE_MALFORMED', 'the clock is not a finite number');
  // The lease's *own* time fields, not just the clock. SQLite columns are dynamically typed, so a
  // row holding text yields NaN here — and with `expiresAt` NaN both `now >= expiresAt` and
  // `now < notBefore` are false, so a lease that can never expire falls straight through to the
  // bindings. A review found this: the clock was checked and the deadline it was compared against
  // was not.
  if (!Number.isFinite(lease.notBefore) || !Number.isFinite(lease.expiresAt)) {
    return deny('LEASE_MALFORMED', 'the lease validity window is not two finite numbers');
  }
  if (lease.expiresAt <= lease.notBefore) {
    return deny('LEASE_MALFORMED', 'the lease expires before it begins');
  }
  // A ceiling, because the review window is capped at five minutes while this was unbounded, and
  // a lease valid for a decade is not a bounded grant in any sense the word is doing work. The
  // operator can always issue another; they cannot easily notice one that never ends.
  if (lease.expiresAt - lease.notBefore > MAX_LEASE_WINDOW_MS) {
    return deny('LEASE_MALFORMED',
      `a lease may not be valid for longer than ${MAX_LEASE_WINDOW_MS}ms`);
  }
  if (now < lease.notBefore) return deny('LEASE_NOT_YET_VALID', `not valid until ${lease.notBefore}`);
  if (now >= lease.expiresAt) return deny('LEASE_EXPIRED', `expired at ${lease.expiresAt}`);

  const b = lease.bindings;

  if (!b.admittedSessions.includes(request.sessionId)) {
    return deny('SESSION_NOT_ADMITTED', 'this session is not bound to the lease');
  }
  if (!b.admittedAdapters.includes(request.adapterId)) {
    return deny('ADAPTER_NOT_ADMITTED', `adapter ${request.adapterId} is not bound to the lease`);
  }
  // The composition gate. Placed after session and adapter because it only has meaning once we
  // know which adapter this is, and before tools, workspace and budgets because a lease that will
  // not accept this goal's delegated work should say so rather than refuse on an incidental bound.
  if (DELEGATED_RUN_ADAPTERS.includes(request.adapterId)) {
    const admittedGoals = b.delegatedGoalIds;
    if (!Array.isArray(admittedGoals) || admittedGoals.length === 0) {
      return deny(
        'DELEGATED_GOAL_NOT_ADMITTED',
        `this lease admits no delegated goal, so work reaching it from ${request.adapterId} `
        + 'still needs the operator\'s approval',
      );
    }
    if (request.delegatedGoalId === undefined) {
      return deny(
        'DELEGATED_GOAL_UNKNOWN',
        'no live configured delegation was resolved for this session, so which goal proposed this '
        + 'is unknown, and an unknown provenance is not admitted without a person',
      );
    }
    if (!admittedGoals.includes(request.delegatedGoalId)) {
      return deny(
        'DELEGATED_GOAL_NOT_ADMITTED',
        `goal ${request.delegatedGoalId} is not one this lease accepts delegated work from`,
      );
    }
  }
  if (!b.allowedTools.includes(request.tool)) {
    return deny('TOOL_NOT_GRANTED', `tool ${request.tool} is not granted`);
  }
  if (!b.workspaceRoots.includes(request.workspaceRoot)) {
    return deny('WORKSPACE_NOT_GRANTED', 'the workspace root is not one the lease names');
  }
  // Refused whatever the patterns say, and refused before them: a lease over the gateway's own
  // checkout could edit the approver, the kill switch or the extension manifest, and a bound that
  // can rewrite itself is not a bound.
  if (input.gatewayRoot !== undefined && isWithin(input.gatewayRoot, request.workspaceRoot)) {
    return deny('SELF_MODIFICATION_REFUSED',
      'the workspace is inside the running gateway checkout, so a lease cannot act on it');
  }

  // The path arrives relative and is required to stay that way. This is belt and braces over the
  // path policy that already ran; a lease must not be the thing that widens it.
  const relative = request.path.replace(/\\/g, '/');
  if (relative.length === 0 || relative.startsWith('/') || relative.includes('..') || /^[A-Za-z]:/.test(relative)) {
    return deny('PATH_ESCAPES_ROOT', 'the path is not a plain relative path inside the root');
  }
  if (isProtectedAuthorityPath(relative)) {
    return deny('AUTHORITY_FILE_PROTECTED', `${relative} is authority or policy and a lease cannot grant it`);
  }
  if (!b.pathPatterns.some((pattern) => matchesPattern(pattern, relative))) {
    return deny('PATH_NOT_GRANTED', `${relative} matches no granted pattern`);
  }

  if (!Number.isInteger(request.diffBytes) || request.diffBytes < 0) {
    return deny('LEASE_MALFORMED', 'the proposal size is not a non-negative integer');
  }
  if (request.diffBytes > b.maxDiffBytes) {
    return deny('DIFF_TOO_LARGE', `${request.diffBytes} bytes exceeds the per-proposal limit`);
  }
  if (spend.filesChanged + 1 > b.maxFiles) {
    return deny('FILE_BUDGET_EXHAUSTED', `the lease has already changed ${spend.filesChanged} files`);
  }
  if (spend.bytesWritten + request.diffBytes > b.maxBytes) {
    return deny('BYTE_BUDGET_EXHAUSTED', `the lease has already written ${spend.bytesWritten} bytes`);
  }

  if (request.wantsCommit) {
    if (b.commitSemantics !== 'commit-to-bound-branch') {
      return deny('COMMIT_NOT_GRANTED', 'this lease grants no commit semantics');
    }
    if (!request.branch || request.branch !== b.branch) {
      return deny('BRANCH_NOT_GRANTED', 'the branch is not the one the lease binds');
    }
    // A CAS on history: if HEAD has moved since the lease was written, the lease was written
    // against a repository that no longer exists and must not be reused silently.
    if (!request.headSha || request.headSha !== b.headSha) {
      return deny('HEAD_MOVED', 'HEAD is not the commit the lease was bound to');
    }
  }

  return { admitted: true };
}
