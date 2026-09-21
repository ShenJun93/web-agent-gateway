import { createHash } from 'node:crypto';
import { assertCreateTarget, assertReadTarget, validateReadPath } from './path-policy.js';
import { createProposalRateLimit, type ProposalRateLimit } from './proposal-rate-limit.js';
import { evaluateGoalLease, type GoalLeaseBindings, type LeaseDecision } from './goal-lease.js';
import type { GatewayAuthority, GatewayCallerContext } from './caller-context.js';
import type { FileMutationBackend } from './file-mutation-backend.js';
import type { MutationRecord, SqliteDurableStore } from './durable-store.js';

/**
 * The tool name this coordinator's records are judged as under a lease.
 *
 * A constant rather than anything the proposal carries: the lease grants tools, and a proposal
 * must not be able to nominate which grant it is checked against.
 */
const MUTATION_TOOL = 'mutation.preview';

/** Outstanding proposals one caller may have awaiting review, as for commits. */
const MAX_PENDING_PER_CALLER = 8;
/** The store's own ceiling for a pending query, so the overdue sweep sees everything it lists. */
const PENDING_SCAN_LIMIT = 100;
const MAX_FRAGMENT_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
/** SHA-256 of the empty string: the base hash that marks a mutation as a creation (ADR-0022). */
const EMPTY_SHA256 = createHash('sha256').update('', 'utf8').digest('hex');

export interface DurableMutationInput {
  path: string;
  baseSha256: string;
  before: string;
  after: string;
}
export interface MutationPreview {
  status: 'approval_required';
  mutationId: string;
  fingerprint: string;
  expiresAt: number;
  path: string;
  baseSha256: string;
  resultSha256: string;
  additions: number;
  removals: number;
}

export interface MutationResultView {
  mutationId: string;
  state: MutationRecord['state'];
  path: string;
  baseSha256: string;
  resultSha256: string;
  fingerprint: string;
  additions: number;
  removals: number;
  reviewDeadline: number;
  executionAdmissionDeadline?: number;
  completedAt?: number;
  errorClass?: string;
}

export interface MutationLocalReviewView extends MutationResultView {
  /**
   * Which repository the edit lands in. The commit review has named it since ADR-0023; the
   * mutation review did not, and with an untrusted page as the proposer an operator could be
   * shown several indistinguishable `src/index.ts` diffs from different roots.
   */
  workspaceRoot: string;
  before: string;
  after: string;
}

export class DurableMutationCoordinator {
  private readonly backends: Map<string, FileMutationBackend>;
  private readonly now: () => number;
  private readonly reviewTtlMs: number;
  private readonly admissionTtlMs: number;
  private readonly rateLimit: ProposalRateLimit;

  constructor(private readonly options: {
    store: SqliteDurableStore;
    backends: readonly FileMutationBackend[];
    now?: () => number;
    reviewTtlMs?: number;
    admissionTtlMs?: number;
    rateLimit?: ProposalRateLimit;
    /**
     * Absent by default, which is what makes autonomous admission off by default: with no lease
     * configured, `admitByPolicy` refuses and the only way to an effect is a human on the
     * operator's Approve route, exactly as before.
     */
    goalLease?: {
      leaseId: string;
      /** Consulted on every admission, so engaging it takes effect immediately. */
      killSwitch: () => boolean;
    };
  }) {
    this.backends = new Map(options.backends.map((backend) => [backend.kind, backend]));
    if (this.backends.size !== options.backends.length) throw new Error('Duplicate file mutation backend kind');
    this.now = options.now ?? Date.now;
    this.reviewTtlMs = boundedTtl(options.reviewTtlMs ?? 60_000);
    this.admissionTtlMs = boundedTtl(options.admissionTtlMs ?? 60_000);
    this.rateLimit = options.rateLimit ?? createProposalRateLimit({
      message: 'Gateway denied mutation: too many proposal attempts',
    });
  }

  async preview(caller: GatewayCallerContext, workspaceId: string, input: DurableMutationInput): Promise<MutationPreview> {
    const workspace = this.options.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error('Unknown workspace_id');
    assertIdentity(caller, workspace);
    const backend = this.backend(workspace.backendKind);
    const path = validateReadPath(input.path);
    validateInput(input);

    // Two different bounds, both of which were missing here while the commit path had one.
    // The live cap is what keeps the operator's review list legible; the attempt window is what
    // stops a caller driving unbounded backend reads with proposals that never become records.
    const chargedAt = this.now();
    if (this.options.store.countPendingMutations(authorityOf(caller), chargedAt) >= MAX_PENDING_PER_CALLER) {
      throw new Error('Gateway denied mutation: too many proposals awaiting review');
    }
    this.rateLimit.charge(authorityOf(caller), chargedAt);

    if (isCreationInput(input)) await assertCreateTarget(workspace.canonicalRoot, path);
    else await assertReadTarget(workspace.canonicalRoot, path);
    const original = await readBase(backend, workspace.canonicalRoot, path, input);
    const prepared = prepareMutation(workspaceId, path, original, input);
    const createdAt = this.now();
    const record = this.options.store.createMutation({
      ...caller,
      workspaceId,
      backendKind: workspace.backendKind,
      path,
      baseSha256: prepared.baseSha256,
      before: input.before,
      after: input.after,
      resultSha256: prepared.resultSha256,
      fingerprint: prepared.fingerprint,
      additions: prepared.additions,
      removals: prepared.removals,
      createdAt,
      reviewDeadline: createdAt + this.reviewTtlMs,
    });
    return toPreview(record);
  }

  result(caller: GatewayCallerContext, mutationId: string): MutationResultView {
    const record = this.options.store.getMutation(mutationId);
    if (!record) throw new Error('Unknown mutation_id');
    assertIdentity(caller, record);
    return toResultView(record);
  }

  listPendingLocal(limit = 20): MutationLocalReviewView[] {
    this.expireOverduePending();
    return this.options.store.listPendingMutations(limit).map((record) => this.toLocalReviewView(record));
  }

  /**
   * Expire every pending record whose review window has already closed, before any of them is
   * offered for review.
   *
   * `listPendingMutations` selects on state alone, while `approveMutation` additionally requires
   * `review_deadline > now`. Without this pass the review page renders an Approve button that the
   * server can only ever refuse — which is exactly what a live operator hit, at the moment they
   * were racing the clock, and the refusal told them nothing about why.
   *
   * The transition is the one `reconcile()` already performs, so durable semantics are unchanged:
   * the record genuinely becomes EXPIRED rather than being hidden from one view while staying
   * actionable in another. `browser-verify-request` has reconciled before listing since it was
   * written; this brings mutations into line with it.
   */
  private expireOverduePending(): void {
    const now = this.now();
    for (const record of this.options.store.listPendingMutations(PENDING_SCAN_LIMIT)) {
      if (record.reviewDeadline > now) continue;
      // A failed expiry must not cost the operator their review page. `transition` rolls back and
      // rethrows, and this sweep now runs in front of every render — so without this the old,
      // survivable failure (a record shown that cannot be approved) would become a 500 on GET /,
      // at exactly the moment someone is racing a review window. The approval CAS still refuses
      // the record either way; only the tidying is best-effort.
      try { this.options.store.expireMutation(record.mutationId, 'PENDING_APPROVAL', now); }
      catch { /* leave it listed; reconcile() will try again */ }
    }
  }

  private toLocalReviewView(record: MutationRecord): MutationLocalReviewView {
    return {
      ...toResultView(record),
      before: record.before,
      after: record.after,
      workspaceRoot: this.options.store.getWorkspace(record.workspaceId)?.canonicalRoot ?? '',
    };
  }

  reviewLocal(mutationId: string): MutationLocalReviewView | undefined {
    const record = this.options.store.getMutation(mutationId);
    return record ? this.toLocalReviewView(record) : undefined;
  }

  /**
   * Admit a pending record under an Autonomous Goal Lease (ADR-0028), with no human gesture.
   *
   * This is not an approval shortcut and shares no code with the Run button or the operator's
   * Approve route, both of which are untouched and remain the only path when no lease is
   * configured. What happens here is that a *deterministic local policy* reads a durable lease
   * and a durable proposal record and decides. The model does not decide; neither does the page.
   *
   * Every fact judged is re-read here, immediately before the consequence, rather than taken
   * from whatever proposed the action:
   *
   *   - the lease comes from the store and is re-parsed and re-validated on every call, so a
   *     lease revoked or expired a millisecond ago is refused;
   *   - the session, adapter, path and size come from the durable record, which the ordinary
   *     validation already produced — not from browser text;
   *   - the workspace root is re-derived from the workspace row, not from the proposal;
   *   - the file's own bytes are re-checked by `executeQueued`, which refuses a divergent target.
   *
   * Returns the decision so a caller can log precisely why something was refused.
   */
  async admitByPolicy(mutationId: string): Promise<LeaseDecision> {
    const lease = this.options.goalLease;
    if (!lease) return { admitted: false, code: 'NO_LEASE', detail: 'no lease is configured on this coordinator' };

    const record = this.options.store.getMutation(mutationId);
    if (!record) return { admitted: false, code: 'NO_LEASE', detail: 'no such mutation' };
    if (record.state !== 'PENDING_APPROVAL') {
      return { admitted: false, code: 'NO_LEASE', detail: `record is ${record.state}, not awaiting review` };
    }
    const workspace = this.options.store.getWorkspace(record.workspaceId);
    if (!workspace) return { admitted: false, code: 'WORKSPACE_NOT_GRANTED', detail: 'the workspace is gone' };

    const stored = this.options.store.getGoalLeaseRow(lease.leaseId);
    if (!stored) return { admitted: false, code: 'NO_LEASE', detail: 'the configured lease is not in the store' };

    let bindings: GoalLeaseBindings;
    try {
      bindings = JSON.parse(stored.bindings) as GoalLeaseBindings;
    } catch {
      // A lease whose bindings will not parse is refused, never treated as absent restrictions.
      return { admitted: false, code: 'LEASE_MALFORMED', detail: 'the stored bindings are not JSON' };
    }

    const decision = evaluateGoalLease({
      lease: {
        leaseId: stored.leaseId,
        createdAt: stored.createdAt,
        notBefore: stored.notBefore,
        expiresAt: stored.expiresAt,
        ...(stored.revokedAt === undefined ? {} : { revokedAt: stored.revokedAt }),
        bindings,
      },
      now: this.now(),
      request: {
        tool: MUTATION_TOOL,
        sessionId: record.sessionId,
        adapterId: record.adapterId,
        workspaceRoot: workspace.canonicalRoot,
        path: record.path,
        diffBytes: Buffer.byteLength(record.after, 'utf8'),
      },
      spend: this.options.store.goalLeaseSpend(stored.leaseId),
      killSwitch: lease.killSwitch(),
    });
    if (!decision.admitted) return decision;

    const admitted = this.options.store.policyAdmitMutation({
      mutationId,
      leaseId: stored.leaseId,
      now: this.now(),
      admissionTtlMs: this.admissionTtlMs,
    });
    if (!admitted) {
      // Lost the CAS: something else moved the record between the decision and the transition.
      return { admitted: false, code: 'LEASE_EXPIRED', detail: 'the record was no longer awaiting review' };
    }
    await this.executeQueued(mutationId);
    return { admitted: true };
  }

  async approveLocal(mutationId: string): Promise<boolean> {
    const now = this.now();
    const approved = this.options.store.approveMutation(mutationId, now, this.admissionTtlMs);
    if (!approved) {
      const current = this.options.store.getMutation(mutationId);
      if (current?.state === 'PENDING_APPROVAL' && current.reviewDeadline <= now) {
        this.options.store.expireMutation(mutationId, 'PENDING_APPROVAL', now);
      }
      return false;
    }
    await this.executeQueued(mutationId);
    return true;
  }

  rejectLocal(mutationId: string): boolean {
    return this.options.store.rejectMutation(mutationId, this.now());
  }

  async reconcile(): Promise<void> {
    for (const record of this.options.store.listRecoverableMutations()) {
      const now = this.now();
      if (record.state === 'PENDING_APPROVAL') {
        if (record.reviewDeadline <= now) this.options.store.expireMutation(record.mutationId, 'PENDING_APPROVAL', now);
        continue;
      }
      if (record.state === 'QUEUED') {
        if ((record.executionAdmissionDeadline ?? 0) <= now) {
          this.options.store.expireMutation(record.mutationId, 'QUEUED', now);
        } else {
          await this.executeQueued(record.mutationId);
        }
        continue;
      }
      await this.reconcileExecuting(record);
    }
  }

  private async executeQueued(mutationId: string): Promise<void> {
    const now = this.now();
    const claimed = this.options.store.claimMutation(mutationId, now);
    if (!claimed) {
      const current = this.options.store.getMutation(mutationId);
      if (current?.state === 'QUEUED' && (current.executionAdmissionDeadline ?? 0) <= now) {
        this.options.store.expireMutation(mutationId, 'QUEUED', now);
      }
      return;
    }
    const workspace = this.options.store.getWorkspace(claimed.workspaceId);
    if (!workspace) {
      this.options.store.finishMutation(mutationId, 'FAILED', this.now(), undefined, 'WorkspaceMissing');
      return;
    }
    const backend = this.backend(claimed.backendKind);
    try {
      await this.revalidateStoredPlan(workspace.canonicalRoot, claimed, backend);
      const original = await readBase(backend, workspace.canonicalRoot, claimed.path, claimed);
      const candidate = original.replace(claimed.before, claimed.after);
      if (isCreationInput(claimed)) {
        await backend.createNew(workspace.canonicalRoot, claimed.path, candidate);
      } else {
        await backend.updateExisting(workspace.canonicalRoot, claimed.path, original, candidate);
      }
      const finalText = await backend.readExact(workspace.canonicalRoot, claimed.path);
      if (sha256(finalText) !== claimed.resultSha256) throw new Error('Gateway rejected post-write SHA-256 mismatch');
      this.options.store.finishMutation(mutationId, 'SUCCEEDED', this.now(), JSON.stringify({ resultSha256: claimed.resultSha256 }));
    } catch (error) {
      await this.reconcileExecutionFailure(claimed, workspace.canonicalRoot, backend, error);
    }
  }

  private async reconcileExecuting(record: MutationRecord): Promise<void> {
    const workspace = this.options.store.getWorkspace(record.workspaceId);
    if (!workspace) {
      this.options.store.finishMutation(record.mutationId, 'OUTCOME_UNKNOWN', this.now(), undefined, 'WorkspaceMissing');
      return;
    }
    const backend = this.backend(record.backendKind);
    let current: string;
    try {
      current = await readBase(backend, workspace.canonicalRoot, record.path, record);
    } catch (error) {
      this.options.store.finishMutation(record.mutationId, 'OUTCOME_UNKNOWN', this.now(), undefined, errorClass(error));
      return;
    }
    const currentHash = sha256(current);
    if (currentHash === record.resultSha256) {
      this.options.store.finishMutation(record.mutationId, 'SUCCEEDED', this.now(), JSON.stringify({ resultSha256: record.resultSha256 }));
      return;
    }
    if (currentHash === record.baseSha256 && (record.executionAdmissionDeadline ?? 0) > this.now()) {
      if (this.options.store.requeueExecuting(record.mutationId, this.now())) await this.executeQueued(record.mutationId);
      return;
    }
    this.options.store.finishMutation(record.mutationId, 'OUTCOME_UNKNOWN', this.now(), undefined, 'DivergentTarget');
  }

  private async revalidateStoredPlan(root: string, record: MutationRecord, backend: FileMutationBackend): Promise<void> {
    const path = validateReadPath(record.path);
    if (isCreationInput(record)) await assertCreateTarget(root, path);
    else await assertReadTarget(root, path);
    const original = await readBase(backend, root, path, record);
    const prepared = prepareMutation(record.workspaceId, path, original, {
      path,
      baseSha256: record.baseSha256,
      before: record.before,
      after: record.after,
    });
    if (prepared.fingerprint !== record.fingerprint || prepared.resultSha256 !== record.resultSha256) {
      throw new Error('Gateway rejected durable mutation fingerprint mismatch');
    }
  }

  private async reconcileExecutionFailure(
    record: MutationRecord,
    root: string,
    backend: FileMutationBackend,
    error: unknown,
  ): Promise<void> {
    try {
      const current = await readBase(backend, root, record.path, record);
      const currentHash = sha256(current);
      if (currentHash === record.resultSha256) {
        this.options.store.finishMutation(record.mutationId, 'SUCCEEDED', this.now(), JSON.stringify({ resultSha256: record.resultSha256 }));
        return;
      }
      if (currentHash === record.baseSha256) {
        this.options.store.finishMutation(record.mutationId, 'FAILED', this.now(), undefined, errorClass(error));
        return;
      }
      this.options.store.finishMutation(record.mutationId, 'OUTCOME_UNKNOWN', this.now(), undefined, 'DivergentTarget');
    } catch {
      this.options.store.finishMutation(record.mutationId, 'OUTCOME_UNKNOWN', this.now(), undefined, errorClass(error));
    }
  }

  private backend(kind: string): FileMutationBackend {
    const backend = this.backends.get(kind);
    if (!backend) throw new Error(`Unknown file mutation backend: ${kind}`);
    return backend;
  }
}

/**
 * A creation is encoded as a mutation whose base is the empty file (ADR-0022). No historical
 * record can be mistaken for one, because an update always carries a non-empty `before`.
 */
export function isCreationInput(input: Pick<DurableMutationInput, 'baseSha256' | 'before'>): boolean {
  return input.before === '' && input.baseSha256 === EMPTY_SHA256;
}

function validateInput(input: DurableMutationInput): void {
  if (!SHA256_RE.test(input.baseSha256)) throw new Error('Gateway rejected invalid base SHA-256');
  if (isCreationInput(input)) {
    if (!input.after) throw new Error('Gateway rejected empty file creation');
  } else if (!input.before) {
    throw new Error('Gateway rejected before text must be non-empty');
  }
  rejectUnsafeText(input.before, 'before');
  rejectUnsafeText(input.after, 'after');
  if (Buffer.byteLength(input.before, 'utf8') > MAX_FRAGMENT_BYTES) throw new Error('Gateway rejected before exceeds 32 KiB');
  if (Buffer.byteLength(input.after, 'utf8') > MAX_FRAGMENT_BYTES) throw new Error('Gateway rejected after exceeds 32 KiB');
}

function prepareMutation(workspaceId: string, path: string, original: string, input: DurableMutationInput) {
  rejectUnsafeText(original, 'target');
  if (Buffer.byteLength(original, 'utf8') > MAX_FILE_BYTES) throw new Error('Gateway rejected target exceeds 64 KiB');
  const baseSha256 = sha256(original);
  if (baseSha256 !== input.baseSha256) throw new Error('Gateway rejected base SHA-256 mismatch');
  // The occurrence rule is meaningless against empty content, and counting empty-string
  // occurrences would not terminate. For a creation the hash check above already pins the base.
  if (!isCreationInput(input) && countOccurrences(original, input.before) !== 1) {
    throw new Error('Gateway rejected before text must occur exactly once');
  }
  // For a creation `original` and `before` are both empty, so this already yields exactly `after`.
  const candidate = original.replace(input.before, input.after);
  rejectUnsafeText(candidate, 'candidate');
  if (Buffer.byteLength(candidate, 'utf8') > MAX_FILE_BYTES) throw new Error('Gateway rejected candidate exceeds 64 KiB');
  const resultSha256 = sha256(candidate);
  const additions = lineCount(input.after);
  const removals = lineCount(input.before);
  const fingerprint = sha256([
    workspaceId, path, baseSha256, sha256(input.before), sha256(input.after), resultSha256,
  ].join('\0'));
  return { baseSha256, resultSha256, fingerprint, additions, removals };
}

function rejectUnsafeText(value: string, label: string): void {
  if (value.includes('\0')) throw new Error(`Gateway rejected ${label} binary content`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + 1;
  }
}

function lineCount(value: string): number {
  if (!value) return 0;
  return value.split(/\r?\n/).length - (value.endsWith('\n') ? 1 : 0);
}

function assertIdentity(expected: GatewayCallerContext, actual: GatewayAuthority): void {
  if (expected.ownerId !== actual.ownerId || expected.sessionId !== actual.sessionId || expected.adapterId !== actual.adapterId) {
    throw new Error('Gateway denied mutation identity');
  }
}

function toResultView(record: MutationRecord): MutationResultView {
  return {
    mutationId: record.mutationId,
    state: record.state,
    path: record.path,
    baseSha256: record.baseSha256,
    resultSha256: record.resultSha256,
    fingerprint: record.fingerprint,
    additions: record.additions,
    removals: record.removals,
    reviewDeadline: record.reviewDeadline,
    ...(record.executionAdmissionDeadline === undefined ? {} : { executionAdmissionDeadline: record.executionAdmissionDeadline }),
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
  };
}

function toPreview(record: MutationRecord): MutationPreview {
  return {
    status: 'approval_required',
    mutationId: record.mutationId,
    fingerprint: record.fingerprint,
    expiresAt: record.reviewDeadline,
    path: record.path,
    baseSha256: record.baseSha256,
    resultSha256: record.resultSha256,
    additions: record.additions,
    removals: record.removals,
  };
}

/**
 * The review window, bounded.
 *
 * The default stays one minute: on the stdio surface the operator is already at the review
 * page. The ceiling is five minutes, which is what the commit path has always allowed for a
 * strictly more consequential operation, because the browser operator profile adds a window
 * switch between the two human gestures — the live dogfood produced an EXPIRED record in
 * exactly that gap, which makes the intended workflow impractical rather than safe.
 *
 * The TTL is not what makes approval safe. Approval re-reads the file and refuses on any drift
 * from the reviewed bytes; the window only bounds how stale a human's understanding may be.
 */
const MAX_MUTATION_TTL_MS = 5 * 60_000;

function boundedTtl(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_MUTATION_TTL_MS) {
    throw new Error('Invalid mutation TTL');
  }
  return value;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Reads the base content a mutation record is defined against. A creation's base is the empty
 * file, so an absent target is its expected state rather than an error; for an update, absence
 * surfaces through the base-hash comparison instead of being papered over.
 */
async function readBase(
  backend: FileMutationBackend,
  root: string,
  path: string,
  record: Pick<DurableMutationInput, 'baseSha256' | 'before'>,
): Promise<string> {
  if (!isCreationInput(record)) return backend.readExact(root, path);
  return (await backend.readExactIfPresent(root, path)) ?? '';
}

/** The exact tuple the store counts and fences on; never anything else from the caller. */
function authorityOf(caller: GatewayCallerContext): GatewayAuthority {
  return { ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId };
}
