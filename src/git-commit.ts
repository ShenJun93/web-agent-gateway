import { createHash } from 'node:crypto';
import type { GatewayAuthority, GatewayCallerContext } from './caller-context.js';
import type { CommitRecord, SqliteDurableStore } from './durable-store.js';
import type { GitCommitBackend, GitCommitChange, GitCommitPlan } from './git-commit-backend.js';
import { assertReadTarget, validateReadPath } from './path-policy.js';
import { createProposalRateLimit, type ProposalRateLimit } from './proposal-rate-limit.js';

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_PATHS = 64;
const DEFAULT_REVIEW_TTL_MS = 60_000;
const MAX_TTL_MS = 5 * 60_000;
/** A git object id: 40 hex for a sha-1 repository, 64 for a sha-256 one. */
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_PENDING_PER_CALLER = 8;

/**
 * Backend failures whose outcome is genuinely unknown to this process: the executor call failed,
 * the helper was still running and was interrupted, or its output could not be read. The commit
 * may or may not have landed, so the durable record — which is the audit record — must say so
 * instead of claiming a clean failure.
 */
const AMBIGUOUS_FAILURES = new Set([
  'EXECUTOR_ERROR', 'HELPER_DID_NOT_COMPLETE', 'OUTPUT_TRUNCATED', 'MALFORMED_HELPER_OUTPUT', 'UNKNOWN',
]);

/** Branches a commit may never target unless local configuration says otherwise. */
export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master'] as const;

export interface GitCommitInput {
  paths: readonly string[];
  message: string;
}

export interface GitCommitPreview {
  status: 'approval_required';
  commitId: string;
  branch: string;
  oldHead: string;
  treeSha: string;
  paths: string[];
  changes: GitCommitChange[];
  /** Paths whose CRLF endings WAG normalized before hashing, as git itself would have. */
  eolNormalized: string[];
  messageSha256: string;
  fingerprint: string;
  expiresAt: number;
}

export interface GitCommitResultView {
  commitId: string;
  state: CommitRecord['state'];
  branch: string;
  oldHead: string;
  treeSha: string;
  paths: string[];
  changes: GitCommitChange[];
  eolNormalized: string[];
  fingerprint: string;
  reviewDeadline: number;
  commit?: string;
  completedAt?: number;
  errorClass?: string;
}

/**
 * What the local operator sees, and only the operator.
 *
 * It adds the message body, the repository the commit would land in — so an operator with
 * several pending reviews approves a named repository rather than a bare branch name — and the
 * author and committer git would stamp.
 *
 * Those two identities are deliberately absent from the remote projection. They come from
 * `.git/config` and `~/.gitconfig`, which the path policy makes unreadable through
 * `file.read` and `repo.search`; returning them in a preview would have made the commit
 * proposal a disclosure channel for the operator's own name and address.
 */
export interface GitCommitLocalReviewView extends GitCommitResultView {
  message: string;
  workspaceRoot: string;
  author: string;
  committer: string;
}

/**
 * Owns the reviewed-commit lifecycle: propose, local approval, one compare-and-swap commit.
 *
 * The remote caller can propose and read. Only the local operator can cause a commit, and every
 * fact the operator approved is revalidated by the backend immediately before the ref moves
 * (ADR-0023).
 */
export class DurableCommitCoordinator {
  private readonly now: () => number;
  private readonly reviewTtlMs: number;
  private readonly protectedBranches: ReadonlySet<string>;
  private readonly rateLimit: ProposalRateLimit;

  constructor(private readonly options: {
    store: SqliteDurableStore;
    backend: GitCommitBackend;
    protectedBranches?: readonly string[];
    rateLimit?: ProposalRateLimit;
    now?: () => number;
    reviewTtlMs?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.reviewTtlMs = Math.min(Math.max(options.reviewTtlMs ?? DEFAULT_REVIEW_TTL_MS, 1_000), MAX_TTL_MS);
    this.rateLimit = options.rateLimit ?? createProposalRateLimit({
      message: 'Gateway denied commit: too many proposal attempts',
    });
    this.protectedBranches = new Set(
      (options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES).map((branch) => branch.toLowerCase()),
    );
  }

  async preview(caller: GatewayCallerContext, workspaceId: string, input: GitCommitInput): Promise<GitCommitPreview> {
    const workspace = this.options.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error('Unknown workspace_id');
    assertIdentity(caller, workspace);
    const message = validateMessage(input.message);
    const paths = await validatePaths(input.paths, workspace.canonicalRoot);

    const createdAt = this.now();
    if (this.options.store.countPendingCommits(authorityOf(caller), createdAt) >= MAX_PENDING_PER_CALLER) {
      throw new Error('Gateway denied commit: too many proposals awaiting review');
    }
    // Charged before the planner, because the planner is the expensive part and a plan that
    // fails creates no record — so a record-counting cap never sees it.
    this.rateLimit.charge(authorityOf(caller), createdAt);

    const plan = await this.options.backend.plan(workspace.canonicalRoot, paths, message);
    assertPlanShape(plan);
    if (this.isProtected(plan.branch)) throw new Error('Gateway denied protected branch commit');

    const messageSha256 = sha256(message);
    const record = this.options.store.createCommit({
      ...authorityOf(caller),
      workspaceId,
      backendKind: this.options.backend.kind,
      branch: plan.branch,
      oldHead: plan.head,
      treeSha: plan.tree,
      author: plan.author,
      committer: plan.committer,
      gitDir: plan.gitDir,
      commonDir: plan.commonDir,
      eolNormalized: plan.eolNormalized,
      paths,
      changes: plan.changes,
      message,
      messageSha256,
      fingerprint: fingerprintOf(workspaceId, plan, paths, messageSha256),
      createdAt,
      reviewDeadline: createdAt + this.reviewTtlMs,
    });
    return toPreview(record);
  }

  result(caller: GatewayCallerContext, commitId: string): GitCommitResultView {
    const record = this.options.store.getCommit(commitId);
    if (!record) throw new Error('Unknown commit_id');
    assertIdentity(caller, record);
    return toResultView(record);
  }

  listPendingLocal(limit = 20): GitCommitLocalReviewView[] {
    return this.options.store.listPendingCommits(limit).map((record) => this.toLocalReviewView(record));
  }

  reviewLocal(commitId: string): GitCommitLocalReviewView | undefined {
    const record = this.options.store.getCommit(commitId);
    return record ? this.toLocalReviewView(record) : undefined;
  }

  private toLocalReviewView(record: CommitRecord): GitCommitLocalReviewView {
    return {
      ...toResultView(record),
      message: record.message,
      workspaceRoot: this.options.store.getWorkspace(record.workspaceId)?.canonicalRoot ?? '',
      author: record.author,
      committer: record.committer,
    };
  }

  async approveLocal(commitId: string): Promise<boolean> {
    const now = this.now();
    const claimed = this.options.store.claimCommit(commitId, now);
    if (!claimed) {
      const current = this.options.store.getCommit(commitId);
      if (current?.state === 'PENDING_APPROVAL' && current.reviewDeadline <= now) {
        this.options.store.expireCommit(commitId, now);
      }
      return false;
    }

    const workspace = this.options.store.getWorkspace(claimed.workspaceId);
    if (!workspace) {
      this.options.store.finishCommit(commitId, 'FAILED', this.now(), undefined, 'WorkspaceMissing');
      return true;
    }
    // The operator approved a message; prove the stored body still matches the digest the
    // preview bound and the review page displayed.
    if (sha256(claimed.message) !== claimed.messageSha256) {
      this.options.store.finishCommit(commitId, 'FAILED', this.now(), undefined, 'MessageDigestMismatch');
      return true;
    }
    // Re-check policy against the record, not against anything the caller can still influence.
    if (this.isProtected(claimed.branch)) {
      this.options.store.finishCommit(commitId, 'FAILED', this.now(), undefined, 'ProtectedBranch');
      return true;
    }

    try {
      // The path policy is re-applied here, not only at preview: approval is a separate moment,
      // and a stored path must still pass workspace confinement before it reaches git.
      const paths = await validatePaths(claimed.paths, workspace.canonicalRoot);
      const result = await this.options.backend.commit(workspace.canonicalRoot, {
        paths,
        message: claimed.message,
        expectedBranch: claimed.branch,
        expectedOldHead: claimed.oldHead,
        expectedTree: claimed.treeSha,
        expectedAuthor: claimed.author,
        expectedCommitter: claimed.committer,
        expectedGitDir: claimed.gitDir,
        expectedCommonDir: claimed.commonDir,
      });
      if (!OBJECT_ID_RE.test(result.commit) || result.tree !== claimed.treeSha || result.previousHead !== claimed.oldHead) {
        this.options.store.finishCommit(commitId, 'OUTCOME_UNKNOWN', this.now(), undefined, 'UnexpectedBackendResult');
        return true;
      }
      this.options.store.finishCommit(commitId, 'SUCCEEDED', this.now(), result.commit);
    } catch (error) {
      // A drift or precondition refusal is a clean failure: the ref only moves through the
      // backend's compare-and-swap, so nothing partial can have landed. Losing sight of the
      // helper is a different thing entirely and must not be recorded as a clean failure.
      const reason = errorClass(error);
      const state = AMBIGUOUS_FAILURES.has(reason) ? 'OUTCOME_UNKNOWN' : 'FAILED';
      this.options.store.finishCommit(commitId, state, this.now(), undefined, reason);
    }
    return true;
  }

  /**
   * Case-folded: on a case-insensitive filesystem `Main` and `main` are the same branch, so an
   * exact-match check would let a case variant move a protected ref.
   */
  private isProtected(branch: string): boolean {
    return this.protectedBranches.has(branch.toLowerCase());
  }

  rejectLocal(commitId: string): boolean {
    return this.options.store.rejectCommit(commitId, this.now());
  }

  /**
   * A commit claimed by a previous process cannot be safely replayed: its outcome is genuinely
   * unknown to this process, and re-running it would either be refused by compare-and-swap or
   * duplicate an applied commit. It is recorded as unknown rather than retried.
   */
  async reconcile(): Promise<void> {
    for (const record of this.options.store.listRecoverableCommits()) {
      const now = this.now();
      if (record.state === 'PENDING_APPROVAL') {
        if (record.reviewDeadline <= now) this.options.store.expireCommit(record.commitId, now);
        continue;
      }
      this.options.store.finishCommit(record.commitId, 'OUTCOME_UNKNOWN', now, undefined, 'InterruptedExecution');
    }
  }
}

function validateMessage(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Gateway rejected commit message');
  if (value.trim() === '') throw new Error('Gateway rejected empty commit message');
  if (value.includes('\0')) throw new Error('Gateway rejected commit message binary content');
  if (Buffer.byteLength(value, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('Gateway rejected commit message exceeds 8 KiB');
  return value;
}

/**
 * Selected paths go through the same policy as every other target and are then deduplicated and
 * ordered, so the preview binds one canonical set that approval can compare against exactly.
 */
async function validatePaths(input: readonly string[], canonicalRoot: string): Promise<string[]> {
  if (!Array.isArray(input) || input.length === 0) throw new Error('Gateway rejected empty commit path set');
  if (input.length > MAX_PATHS) throw new Error('Gateway rejected commit path set exceeds 64 entries');
  const safe = new Set<string>();
  for (const candidate of input) {
    if (typeof candidate !== 'string') throw new Error('Gateway rejected commit path');
    // The shared policy only rejects control characters on Windows. The helper parses
    // line-oriented git output, so a newline in a path must be refused on every platform.
    if (/[\u0000-\u001f\u007f]/.test(candidate)) throw new Error('Gateway rejected commit path control character');
    const path = validateReadPath(candidate);
    await assertReadTarget(canonicalRoot, path);
    safe.add(path);
  }
  return [...safe].sort();
}

function assertPlanShape(plan: GitCommitPlan): void {
  if (!OBJECT_ID_RE.test(plan.head) || !OBJECT_ID_RE.test(plan.tree)) {
    throw new Error('Gateway rejected backend commit plan');
  }
  for (const identity of [plan.author, plan.committer]) {
    if (typeof identity !== 'string' || identity === '' || identity.length > 512) {
      throw new Error('Gateway rejected backend commit plan');
    }
  }
  if (!Array.isArray(plan.eolNormalized) || plan.eolNormalized.some((value) => typeof value !== 'string')) {
    throw new Error('Gateway rejected backend commit plan');
  }
  for (const value of [plan.gitDir, plan.commonDir]) {
    if (typeof value !== 'string' || value === '' || value.length > 4096) {
      throw new Error('Gateway rejected backend commit plan');
    }
  }
  // The change set is what the operator reviews and what v1 restricts to additions and
  // modifications. That rule is enforced inside the helper; it is re-checked here so the review
  // page can never render, and the record can never store, a shape the host did not accept.
  if (!Array.isArray(plan.changes) || plan.changes.length === 0 || plan.changes.length > 4_096) {
    throw new Error('Gateway rejected backend commit plan');
  }
  for (const change of plan.changes) {
    if (change.status !== 'A' && change.status !== 'M') throw new Error('Gateway rejected backend commit change');
    if (typeof change.path !== 'string' || change.path === '') throw new Error('Gateway rejected backend commit change');
  }
}

function fingerprintOf(workspaceId: string, plan: GitCommitPlan, paths: readonly string[], messageSha256: string): string {
  return sha256([
    workspaceId, plan.branch, plan.head, plan.tree, plan.author, plan.committer, plan.gitDir, plan.commonDir,
    messageSha256, ...paths, '|eol|', ...plan.eolNormalized,
  ].join('\0'));
}

function authorityOf(caller: GatewayCallerContext): GatewayAuthority {
  return { ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId };
}

function assertIdentity(caller: GatewayCallerContext, record: GatewayAuthority): void {
  if (record.ownerId !== caller.ownerId || record.sessionId !== caller.sessionId || record.adapterId !== caller.adapterId) {
    throw new Error('Gateway denied commit');
  }
}

function toPreview(record: CommitRecord): GitCommitPreview {
  return {
    status: 'approval_required',
    commitId: record.commitId,
    branch: record.branch,
    oldHead: record.oldHead,
    treeSha: record.treeSha,
    paths: [...record.paths],
    changes: [...record.changes],
    eolNormalized: [...record.eolNormalized],
    messageSha256: record.messageSha256,
    fingerprint: record.fingerprint,
    expiresAt: record.reviewDeadline,
  };
}

function toResultView(record: CommitRecord): GitCommitResultView {
  return {
    commitId: record.commitId,
    state: record.state,
    branch: record.branch,
    oldHead: record.oldHead,
    treeSha: record.treeSha,
    paths: [...record.paths],
    changes: [...record.changes],
    eolNormalized: [...record.eolNormalized],
    fingerprint: record.fingerprint,
    reviewDeadline: record.reviewDeadline,
    ...(record.resultCommit === undefined ? {} : { commit: record.resultCommit }),
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const match = /Gateway git commit failed: ([A-Z_]+)/.exec(error.message);
  return match ? match[1]! : error.constructor.name;
}
