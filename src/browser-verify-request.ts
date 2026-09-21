import { createHash, randomUUID } from 'node:crypto';
import type { GatewayCallerContext } from './caller-context.js';
import type {
  BrowserVerifyRequestErrorClass,
  BrowserVerifyRequestRecord,
  SqliteDurableStore,
  VerifyJobState,
  WorkspaceRecord,
} from './durable-store.js';
import type { DurableVerifyJobCoordinator, VerifyJobView } from './durable-verify-job.js';
import { resolveVerifyProfile, type ResolvedVerifyProfile, type VerifyProfile } from './verify-profile.js';

const REVIEW_TTL_MS = 60_000;
const DISPATCH_TTL_MS = 300_000;
const MAX_PENDING_PER_SESSION = 8;
const MAX_PENDING_GLOBAL = 32;

export interface BrowserVerifyPreviewView {
  status: 'approval_required';
  request_id: string;
  profile: string;
  fingerprint: string;
  expires_at: number;
}

export interface BrowserVerifyResultView {
  request_id: string;
  profile: string;
  state: BrowserVerifyRequestRecord['state'] | VerifyJobState;
  expires_at: number;
  completed_at?: number;
  exit_code?: number;
  output?: string;
  output_truncated?: boolean;
  error_class?: string;
}

export interface BrowserVerifyLocalReviewView {
  requestId: string;
  workspaceRoot: string;
  profileName: string;
  planSha256: string;
  fingerprint: string;
  state: 'PENDING_APPROVAL';
  createdAt: number;
  reviewDeadline: number;
}

export class BrowserVerifyRequestCoordinator {
  private readonly now: () => number;

  constructor(private readonly options: {
    store: SqliteDurableStore;
    profiles: () => Readonly<Record<string, VerifyProfile>>;
    browserProfiles: () => readonly string[];
    jobs: DurableVerifyJobCoordinator;
    now?: () => number;
  }) {
    this.now = options.now ?? Date.now;
  }
  preview(
    caller: GatewayCallerContext,
    workspaceId: string,
    profileName: string,
  ): BrowserVerifyPreviewView {
    const workspace = this.options.store.getWorkspace(workspaceId);
    if (!workspace || !sameAuthority(caller, workspace)) {
      throw new Error('Gateway denied verify request');
    }
    const profile = this.resolveBrowserProfile(profileName);
    const createdAt = this.now();
    const requestId = `verifyreq_${randomUUID()}`;
    const fingerprint = requestFingerprint(
      requestId, workspaceId, profileName, profile.planSha256,
    );
    const record = this.options.store.createBrowserVerifyRequest({
      requestId,
      ownerId: caller.ownerId,
      sessionId: caller.sessionId,
      adapterId: caller.adapterId,
      workspaceId,
      profileName,
      planSha256: profile.planSha256,
      fingerprint,
      createdAt,
      reviewDeadline: createdAt + REVIEW_TTL_MS,
    }, {
      perSession: MAX_PENDING_PER_SESSION,
      global: MAX_PENDING_GLOBAL,
    });
    if (!record) throw new Error('Gateway denied verify request');
    return {
      status: 'approval_required',
      request_id: record.requestId,
      profile: record.profileName,
      fingerprint: record.fingerprint,
      expires_at: record.reviewDeadline,
    };
  }

  result(caller: GatewayCallerContext, requestId: string): BrowserVerifyResultView {
    let record = this.authorizedRequest(caller, requestId);
    if (record.state === 'PENDING_APPROVAL' && record.reviewDeadline <= this.now()) {
      this.options.store.expireBrowserVerifyRequest(record.requestId, this.now());
      record = this.authorizedRequest(caller, requestId);
    }
    if (record.state !== 'DISPATCHED') return requestView(record);
    if (!record.linkedJobId) throw new Error('Gateway denied verify request');
    const job = this.options.jobs.result(caller, record.linkedJobId);
    return dispatchedView(record, job);
  }

  reconcile(): void {
    const now = this.now();
    for (const record of this.options.store.listPendingBrowserVerifyRequests(100)) {
      if (record.reviewDeadline <= now) {
        this.options.store.expireBrowserVerifyRequest(record.requestId, now);
      }
    }
  }
  listPendingLocal(limit = 20): BrowserVerifyLocalReviewView[] {
    this.reconcile();
    const result: BrowserVerifyLocalReviewView[] = [];
    for (const record of this.options.store.listPendingBrowserVerifyRequests(limit)) {
      const view = this.localView(record);
      if (view) result.push(view);
    }
    return result;
  }

  reviewLocal(requestId: string): BrowserVerifyLocalReviewView | undefined {
    let record = this.options.store.getBrowserVerifyRequest(requestId);
    if (!record || record.state !== 'PENDING_APPROVAL') return undefined;
    if (record.reviewDeadline <= this.now()) {
      this.options.store.expireBrowserVerifyRequest(record.requestId, this.now());
      return undefined;
    }
    return this.localView(record);
  }

  rejectLocal(requestId: string): boolean {
    const record = this.options.store.getBrowserVerifyRequest(requestId);
    if (!record || record.state !== 'PENDING_APPROVAL') return false;
    const now = this.now();
    if (record.reviewDeadline <= now) {
      this.options.store.expireBrowserVerifyRequest(requestId, now);
      return false;
    }
    return this.options.store.rejectBrowserVerifyRequest(requestId, now);
  }
  async approveLocal(requestId: string): Promise<boolean> {
    const record = this.options.store.getBrowserVerifyRequest(requestId);
    if (!record || record.state !== 'PENDING_APPROVAL') return false;
    const now = this.now();
    if (record.reviewDeadline <= now) {
      this.options.store.expireBrowserVerifyRequest(requestId, now);
      return false;
    }

    const current = this.revalidateForApproval(record, now);
    if (!current) return false;
    const approved = this.options.store.approveBrowserVerifyRequestAndCreateJob({
      requestId,
      now,
      dispatchDeadline: now + DISPATCH_TTL_MS,
      currentPlanSha256: current.planSha256,
    });
    if (!approved) return false;
    await this.options.jobs.dispatch(approved.job.jobId);
    return true;
  }

  private authorizedRequest(
    caller: GatewayCallerContext,
    requestId: string,
  ): BrowserVerifyRequestRecord {
    const record = this.options.store.getBrowserVerifyRequest(requestId);
    if (!record || !sameAuthority(caller, record)) {
      throw new Error('Gateway denied verify request');
    }
    return record;
  }
  private resolveBrowserProfile(profileName: string): ResolvedVerifyProfile {
    if (!this.options.browserProfiles().includes(profileName)) {
      throw new Error('Gateway denied verify profile');
    }
    const source = this.options.profiles()[profileName];
    if (!source) throw new Error('Gateway denied verify profile');
    let resolved: ResolvedVerifyProfile;
    try {
      resolved = resolveVerifyProfile(source);
    } catch {
      throw new Error('Gateway denied verify profile');
    }
    if (resolved.resumeQueuedAfterRestart) {
      throw new Error('Gateway denied verify profile');
    }
    return resolved;
  }

  private revalidateForApproval(
    record: BrowserVerifyRequestRecord,
    now: number,
  ): ResolvedVerifyProfile | undefined {
    const source = this.options.profiles()[record.profileName];
    if (!source) return this.invalidate(record.requestId, now, 'PROFILE_MISSING');
    if (!this.options.browserProfiles().includes(record.profileName)) {
      return this.invalidate(record.requestId, now, 'PROFILE_NOT_ALLOWED');
    }
    let resolved: ResolvedVerifyProfile;
    try {
      resolved = resolveVerifyProfile(source);
    } catch {
      return this.invalidate(record.requestId, now, 'PROFILE_PLAN_DRIFT');
    }
    if (resolved.resumeQueuedAfterRestart) {
      return this.invalidate(record.requestId, now, 'RESTART_RESUME_NOT_ALLOWED');
    }
    if (resolved.planSha256 !== record.planSha256) {
      return this.invalidate(record.requestId, now, 'PROFILE_PLAN_DRIFT');
    }
    return resolved;
  }

  private invalidate(
    requestId: string,
    now: number,
    errorClass: BrowserVerifyRequestErrorClass,
  ): undefined {
    this.options.store.invalidateBrowserVerifyRequest(requestId, now, errorClass);
    return undefined;
  }

  private localView(
    record: BrowserVerifyRequestRecord,
  ): BrowserVerifyLocalReviewView | undefined {
    const workspace = this.options.store.getWorkspace(record.workspaceId);
    if (!workspace || !sameAuthority(record, workspace)) {
      this.options.store.invalidateBrowserVerifyRequest(
        record.requestId,
        this.now(),
        workspace ? 'WORKSPACE_OWNERSHIP_MISMATCH' : 'WORKSPACE_MISSING',
      );
      return undefined;
    }
    return {
      requestId: record.requestId,
      workspaceRoot: workspace.canonicalRoot,
      profileName: record.profileName,
      planSha256: record.planSha256,
      fingerprint: record.fingerprint,
      state: 'PENDING_APPROVAL',
      createdAt: record.createdAt,
      reviewDeadline: record.reviewDeadline,
    };
  }
}

function requestFingerprint(
  requestId: string,
  workspaceId: string,
  profileName: string,
  planSha256: string,
): string {
  return createHash('sha256')
    .update('browser-verify-v1\0', 'utf8')
    .update(workspaceId, 'utf8').update('\0')
    .update(profileName, 'utf8').update('\0')
    .update(planSha256, 'utf8').update('\0')
    .update(requestId, 'utf8')
    .digest('hex');
}

function requestView(record: BrowserVerifyRequestRecord): BrowserVerifyResultView {
  return {
    request_id: record.requestId,
    profile: record.profileName,
    state: record.state,
    expires_at: record.reviewDeadline,
    ...(record.completedAt === undefined ? {} : { completed_at: record.completedAt }),
    ...(record.errorClass === undefined ? {} : { error_class: record.errorClass }),
  };
}

function dispatchedView(
  request: BrowserVerifyRequestRecord,
  job: VerifyJobView,
): BrowserVerifyResultView {
  return {
    request_id: request.requestId,
    profile: request.profileName,
    state: job.state,
    expires_at: request.reviewDeadline,
    ...(job.completedAt === undefined ? {} : { completed_at: job.completedAt }),
    ...(job.exitCode === undefined ? {} : { exit_code: job.exitCode }),
    ...(job.output === undefined ? {} : { output: job.output }),
    ...(job.outputTruncated === undefined ? {} : { output_truncated: job.outputTruncated }),
    ...(job.errorClass === undefined ? {} : { error_class: job.errorClass }),
  };
}

function sameAuthority(
  expected: Pick<GatewayCallerContext, 'ownerId' | 'sessionId' | 'adapterId'>,
  actual: Pick<GatewayCallerContext, 'ownerId' | 'sessionId' | 'adapterId'>,
): boolean {
  return expected.ownerId === actual.ownerId
    && expected.sessionId === actual.sessionId
    && expected.adapterId === actual.adapterId;
}
