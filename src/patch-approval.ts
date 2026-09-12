import { randomUUID } from 'node:crypto';

const MAX_TTL_MS = 60_000;

export interface PatchApprovalSummary {
  path: string;
  additions: number;
  removals: number;
}

export interface PatchApprovalRequest {
  approvalId: string;
  fingerprint: string;
  expiresAt: number;
  pendingExpiresAt: number;
  approvedAt?: number;
  approvedExpiresAt?: number;
  summary: PatchApprovalSummary;
  approved: boolean;
}

interface PatchApprovalStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

export class PatchApprovalStore {
  private readonly entries = new Map<string, PatchApprovalRequest>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PatchApprovalStoreOptions = {}) {
    const ttlMs = options.ttlMs ?? MAX_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new Error('Patch approval TTL must be finite and no more than 60 seconds');
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
  }

  createPending(input: { fingerprint: string; summary: PatchApprovalSummary }): PatchApprovalRequest {
    this.pruneExpired();
    const createdAt = this.currentTime();
    const pendingExpiresAt = createdAt + this.ttlMs;
    const request: PatchApprovalRequest = {
      approvalId: `pa_${randomUUID()}`,
      fingerprint: input.fingerprint,
      expiresAt: pendingExpiresAt,
      pendingExpiresAt,
      summary: { ...input.summary },
      approved: false,
    };
    this.entries.set(request.approvalId, request);
    return { ...request, summary: { ...request.summary } };
  }

  approveLocal(approvalId: string, fingerprint: string): boolean {
    this.pruneExpired();
    const request = this.entries.get(approvalId);
    if (!request || request.fingerprint !== fingerprint) return false;
    if (request.approved) return true;
    const approvedAt = this.currentTime();
    request.approved = true;
    request.approvedAt = approvedAt;
    request.approvedExpiresAt = approvedAt + this.ttlMs;
    return true;
  }

  consume(approvalId: string, fingerprint: string): boolean {
    this.pruneExpired();
    const request = this.entries.get(approvalId);
    if (!request || !request.approved || request.fingerprint !== fingerprint) return false;
    this.entries.delete(approvalId);
    return true;
  }

  revoke(approvalId: string): boolean {
    this.pruneExpired();
    return this.entries.delete(approvalId);
  }

  get(approvalId: string): PatchApprovalRequest | undefined {
    this.pruneExpired();
    const request = this.entries.get(approvalId);
    return request ? { ...request, summary: { ...request.summary } } : undefined;
  }

  listPending(limit = 20): PatchApprovalRequest[] {
    this.pruneExpired();
    const safeLimit = Math.min(Math.max(limit, 0), 100);
    return [...this.entries.values()].slice(0, safeLimit).map((request) => ({
      ...request,
      summary: { ...request.summary },
    }));
  }

  private currentTime(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error('Patch approval clock must be finite');
    return now;
  }

  private pruneExpired(): void {
    const now = this.currentTime();
    for (const [approvalId, request] of this.entries) {
      const expiresAt = request.approved ? request.approvedExpiresAt : request.pendingExpiresAt;
      if (expiresAt === undefined || expiresAt <= now) this.entries.delete(approvalId);
    }
  }
}
