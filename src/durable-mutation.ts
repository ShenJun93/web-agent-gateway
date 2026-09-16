import { createHash } from 'node:crypto';
import { assertReadTarget, validateReadPath } from './path-policy.js';
import type { GatewayAuthority, GatewayCallerContext } from './caller-context.js';
import type { FileMutationBackend } from './file-mutation-backend.js';
import type { MutationRecord, SqliteDurableStore } from './durable-store.js';

const MAX_FRAGMENT_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

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
  before: string;
  after: string;
}

export class DurableMutationCoordinator {
  private readonly backends: Map<string, FileMutationBackend>;
  private readonly now: () => number;
  private readonly reviewTtlMs: number;
  private readonly admissionTtlMs: number;

  constructor(private readonly options: {
    store: SqliteDurableStore;
    backends: readonly FileMutationBackend[];
    now?: () => number;
    reviewTtlMs?: number;
    admissionTtlMs?: number;
  }) {
    this.backends = new Map(options.backends.map((backend) => [backend.kind, backend]));
    if (this.backends.size !== options.backends.length) throw new Error('Duplicate file mutation backend kind');
    this.now = options.now ?? Date.now;
    this.reviewTtlMs = boundedTtl(options.reviewTtlMs ?? 60_000);
    this.admissionTtlMs = boundedTtl(options.admissionTtlMs ?? 60_000);
  }

  async preview(caller: GatewayCallerContext, workspaceId: string, input: DurableMutationInput): Promise<MutationPreview> {
    const workspace = this.options.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error('Unknown workspace_id');
    assertIdentity(caller, workspace);
    const backend = this.backend(workspace.backendKind);
    const path = validateReadPath(input.path);
    await assertReadTarget(workspace.canonicalRoot, path);
    validateInput(input);
    const original = await backend.readExact(workspace.canonicalRoot, path);
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
    return this.options.store.listPendingMutations(limit).map(toLocalReviewView);
  }

  reviewLocal(mutationId: string): MutationLocalReviewView | undefined {
    const record = this.options.store.getMutation(mutationId);
    return record ? toLocalReviewView(record) : undefined;
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
      const original = await backend.readExact(workspace.canonicalRoot, claimed.path);
      const candidate = original.replace(claimed.before, claimed.after);
      await backend.updateExisting(workspace.canonicalRoot, claimed.path, original, candidate);
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
      current = await backend.readExact(workspace.canonicalRoot, record.path);
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
    await assertReadTarget(root, path);
    const original = await backend.readExact(root, path);
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
      const current = await backend.readExact(root, record.path);
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

function validateInput(input: DurableMutationInput): void {
  if (!SHA256_RE.test(input.baseSha256)) throw new Error('Gateway rejected invalid base SHA-256');
  if (!input.before) throw new Error('Gateway rejected before text must be non-empty');
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
  if (countOccurrences(original, input.before) !== 1) throw new Error('Gateway rejected before text must occur exactly once');
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

function toLocalReviewView(record: MutationRecord): MutationLocalReviewView {
  return { ...toResultView(record), before: record.before, after: record.after };
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

function boundedTtl(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 60_000) throw new Error('Invalid mutation TTL');
  return value;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
