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
  | 'AUTHORITY_FILE_PROTECTED';

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

const deny = (code: LeaseDenialCode, detail: string): LeaseDecision => ({ admitted: false, code, detail });

/**
 * Paths a lease may never grant, whatever its patterns say.
 *
 * Requirement 9: a lease must not authorise modifying its own authority. These are matched on the
 * `/`-separated relative path, case-insensitively, because Windows will happily open `.CLAUDE/`.
 */
const PROTECTED_PREFIXES = ['.claude/', '.git/', 'docs/adr/'] as const;
const PROTECTED_EXACT = ['agents.md', 'claude.md', 'tsconfig.build.json', 'package.json'] as const;

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
}): LeaseDecision {
  const { lease, now, request, spend } = input;

  if (input.killSwitch) return deny('KILL_SWITCH_ENGAGED', 'the local kill switch is engaged');
  if (!lease) return deny('NO_LEASE', 'no active lease, so manual human approval is required');

  const malformed = validateBindings(lease.bindings);
  if (malformed) return deny('LEASE_MALFORMED', malformed);

  if (typeof lease.revokedAt === 'number') return deny('LEASE_REVOKED', `revoked at ${lease.revokedAt}`);
  if (!Number.isFinite(now)) return deny('LEASE_MALFORMED', 'the clock is not a finite number');
  if (now < lease.notBefore) return deny('LEASE_NOT_YET_VALID', `not valid until ${lease.notBefore}`);
  if (now >= lease.expiresAt) return deny('LEASE_EXPIRED', `expired at ${lease.expiresAt}`);

  const b = lease.bindings;

  if (!b.admittedSessions.includes(request.sessionId)) {
    return deny('SESSION_NOT_ADMITTED', 'this session is not bound to the lease');
  }
  if (!b.admittedAdapters.includes(request.adapterId)) {
    return deny('ADAPTER_NOT_ADMITTED', `adapter ${request.adapterId} is not bound to the lease`);
  }
  if (!b.allowedTools.includes(request.tool)) {
    return deny('TOOL_NOT_GRANTED', `tool ${request.tool} is not granted`);
  }
  if (!b.workspaceRoots.includes(request.workspaceRoot)) {
    return deny('WORKSPACE_NOT_GRANTED', 'the workspace root is not one the lease names');
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
