import { createHash } from 'node:crypto';

import type { GatewayCallerContext } from './caller-context.js';
import type { SqliteDurableStore, WorkspaceRecord } from './durable-store.js';
import {
  RemoteGitPushStore,
  type RemoteGitExpectedState,
  type RemoteGitPushRecord,
} from './remote-git-push-store.js';

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_REVIEW_TTL_MS = 5 * 60_000;
const DEFAULT_ACTIVE_TTL_MS = 2 * 60_000;
const MAX_TTL_MS = 5 * 60_000;

export interface RemoteGitPushInput {
  remote: string;
  sourceOid: string;
  destinationRef: string;
  reviewedOid?: string;
  reviewReceiptDigest?: string;
}

export interface RemoteGitPushPlan {
  repositoryIdentity: string;
  resolvedPushUrl: string;
  sourceOid: string;
  destinationRef: string;
  expectedRemoteState: RemoteGitExpectedState;
  commitSubject: string;
  changedFilesSummary: string;
  aheadCommitCount?: number;
}

export interface RemoteGitInspectInput {
  remote: string;
  refs: string[];
}

export type RemoteGitAuthenticationState = 'AVAILABLE' | 'UNKNOWN';

export interface RemoteGitInspectObservation {
  repositoryIdentity: string;
  effectiveFetchUrl: string;
  effectivePushUrl: string;
  defaultBranch: string | null;
  refs: Array<{ ref: string; oid: string | null }>;
  authenticationState: RemoteGitAuthenticationState;
}

export interface RemoteGitInspectResult extends RemoteGitInspectObservation {
  remote: string;
  observedAt: string;
}

export type RemoteGitPushBackendOutcome =
  | { outcome: 'SUCCEEDED'; observedRemoteOid: string; errorClass?: never }
  | { outcome: 'NOT_OBSERVED'; observedRemoteOid?: string; errorClass?: string }
  | { outcome: 'DIVERGENT_REMOTE'; observedRemoteOid: string; errorClass?: string }
  | { outcome: 'OUTCOME_UNKNOWN'; observedRemoteOid?: string; errorClass?: string };

export interface RemoteGitPushBackend {
  inspect(workspaceRoot: string, input: RemoteGitInspectInput): Promise<RemoteGitInspectObservation>;
  plan(workspaceRoot: string, input: RemoteGitPushInput): Promise<RemoteGitPushPlan>;
  execute(record: RemoteGitPushRecord): Promise<RemoteGitPushBackendOutcome>;
  reconcile(record: RemoteGitPushRecord): Promise<RemoteGitPushBackendOutcome>;
}

export interface RemoteGitPushResultView {
  pushId: string;
  status: 'approval_required' | 'active' | 'succeeded' | 'not_observed' | 'quarantined' | 'expired' | 'revoked';
  state: RemoteGitPushRecord['state'];
  sourceOid: string;
  destinationRef: string;
  remoteDisplayName: string;
  resolvedPushUrl: string;
  expectedRemoteState: RemoteGitExpectedState;
  grantFingerprint: string;
  reviewDeadline: number;
  expiresAt?: number;
  observedRemoteOid?: string;
  outcomeClass?: string;
  errorClass?: string;
}

export interface RemoteGitPushLocalReviewView extends RemoteGitPushResultView {
  workspaceRoot: string;
  repositoryIdentity: string;
  commitSubject: string;
  changedFilesSummary: string;
  aheadCommitCount?: number;
  reviewedCommitOid?: string;
  reviewReceiptDigest?: string;
  maxUses: 1;
  activeGrantTtlMs: number;
}

export interface RemoteGitPushAutonomousTarget {
  resolvedPushUrl: string;
  destinationRef: string;
}

export interface RemoteGitPushAutonomousPolicy {
  /**
   * Standing local authority. This predicate is configured outside MCP arguments and cannot be
   * widened by the model. The normal backend still revalidates repository identity, remote state,
   * fast-forward ancestry, protected refs and the kill switch immediately before the effect.
   */
  permits(target: RemoteGitPushAutonomousTarget): boolean;
  /**
   * When true, requests outside the standing allowlist are denied rather than falling back to a
   * per-push Human approval. This is the automation-first production mode.
   */
  denyUnmatched?: boolean;
}

export class DurableRemoteGitPushCoordinator {
  readonly #now: () => number;
  readonly #reviewTtlMs: number;
  readonly #activeTtlMs: number;

  constructor(readonly options: {
    store: RemoteGitPushStore;
    workspaceStore: Pick<SqliteDurableStore, 'getWorkspace'>;
    backend: RemoteGitPushBackend;
    now?: () => number;
    reviewTtlMs?: number;
    activeTtlMs?: number;
    autonomous?: RemoteGitPushAutonomousPolicy;
    killSwitch?: () => boolean;
    effectBoundary?: {
      revalidateWorkspace(workspaceId: string, canonicalRoot: string): Promise<void>;
    };
  }) {
    this.#now = options.now ?? Date.now;
    this.#reviewTtlMs = boundedTtl(options.reviewTtlMs ?? DEFAULT_REVIEW_TTL_MS);
    this.#activeTtlMs = boundedTtl(options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS);
  }

  async inspect(
    caller: GatewayCallerContext,
    workspaceId: string,
    rawInput: RemoteGitInspectInput,
  ): Promise<RemoteGitInspectResult> {
    const input = validateInspectInput(rawInput);
    const workspace = this.#workspaceFor(caller, workspaceId);
    await this.options.effectBoundary?.revalidateWorkspace(workspaceId, workspace.canonicalRoot);
    const observation = await this.options.backend.inspect(workspace.canonicalRoot, input);
    assertInspectMatchesRequest(observation, input);
    return {
      ...observation,
      remote: input.remote,
      observedAt: new Date(this.#now()).toISOString(),
    };
  }

  async request(
    caller: GatewayCallerContext,
    workspaceId: string,
    rawInput: RemoteGitPushInput,
  ): Promise<RemoteGitPushResultView> {
    if (this.options.killSwitch?.()) {
      throw new Error('Gateway denied remote git push: KILL_SWITCH_ENGAGED');
    }
    const input = validateInput(rawInput);
    if (input.reviewedOid !== undefined && input.reviewedOid !== input.sourceOid) {
      throw new Error('Gateway denied remote git push: reviewed OID does not match source OID');
    }
    const workspace = this.#workspaceFor(caller, workspaceId);
    const now = this.#now();
    this.options.store.expireOverdue(now);

    const requestFingerprint = requestFingerprintOf(caller, workspaceId, input);
    const live = this.options.store.findLive(requestFingerprint)
      .filter((record) => sameAuthority(caller, record));
    if (live.length > 1) {
      throw new Error('AMBIGUOUS_REMOTE_EFFECT_GRANT');
    }
    if (live.length === 1) {
      const record = live[0]!;
      if (record.state === 'PENDING') {
        const autonomous = this.#autonomousDecision(record);
        if (autonomous === 'ALLOW') return this.#executeAutonomousPending(record);
        if (autonomous === 'DENY') throw new Error('AUTONOMOUS_REMOTE_POLICY_DENIED');
        return toResult(record);
      }
      if (record.state === 'ACTIVE') {
        return this.#executeActive(record);
      }
    }

    const plan = await this.options.backend.plan(workspace.canonicalRoot, input);
    assertPlanMatchesRequest(plan, input);
    const autonomous = this.#autonomousDecision(plan);
    if (autonomous === 'DENY') throw new Error('AUTONOMOUS_REMOTE_POLICY_DENIED');
    const grantFingerprint = grantFingerprintOf(requestFingerprint, plan);
    let record: RemoteGitPushRecord;
    try {
      record = this.options.store.createProposal({
        ownerId: caller.ownerId,
        sessionId: caller.sessionId,
        adapterId: caller.adapterId,
        workspaceId,
        workspaceRoot: workspace.canonicalRoot,
        repositoryIdentity: plan.repositoryIdentity,
        remoteDisplayName: input.remote,
        resolvedPushUrl: plan.resolvedPushUrl,
        sourceOid: plan.sourceOid,
        destinationRef: plan.destinationRef,
        expectedRemoteState: plan.expectedRemoteState,
        ...(input.reviewedOid === undefined ? {} : { reviewedCommitOid: input.reviewedOid }),
        ...(input.reviewReceiptDigest === undefined ? {} : { reviewReceiptDigest: input.reviewReceiptDigest }),
        commitSubject: plan.commitSubject,
        changedFilesSummary: plan.changedFilesSummary,
        ...(plan.aheadCommitCount === undefined ? {} : { aheadCommitCount: plan.aheadCommitCount }),
        requestFingerprint,
        grantFingerprint,
        createdAt: now,
        reviewDeadline: now + this.#reviewTtlMs,
        maxUses: 1,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'REMOTE_GIT_PUSH_LIVE_GRANT_EXISTS') throw error;
      const raced = this.options.store.findLive(requestFingerprint)
        .filter((candidate) => sameAuthority(caller, candidate));
      if (raced.length !== 1) throw new Error('AMBIGUOUS_REMOTE_EFFECT_GRANT');
      const racedRecord = raced[0]!;
      if (racedRecord.state === 'ACTIVE') return this.#executeActive(racedRecord);
      const racedAutonomous = this.#autonomousDecision(racedRecord);
      if (racedAutonomous === 'ALLOW') return this.#executeAutonomousPending(racedRecord);
      if (racedAutonomous === 'DENY') throw new Error('AUTONOMOUS_REMOTE_POLICY_DENIED');
      return toResult(racedRecord);
    }
    return autonomous === 'ALLOW'
      ? this.#executeAutonomousPending(record)
      : toResult(record);
  }

  result(caller: GatewayCallerContext, pushId: string): RemoteGitPushResultView {
    const record = this.options.store.expire(pushId, this.#now())
      ?? this.options.store.get(pushId);
    if (!record || !sameAuthority(caller, record)) {
      throw new Error('Gateway denied remote git push');
    }
    return toResult(record);
  }

  listPendingLocal(limit = 20): RemoteGitPushLocalReviewView[] {
    this.options.store.expireOverdue(this.#now());
    return this.options.store.listPending(limit)
      .map((record) => toLocalReview(record, this.#activeTtlMs));
  }

  reviewLocal(pushId: string): RemoteGitPushLocalReviewView | undefined {
    const record = this.options.store.expire(pushId, this.#now())
      ?? this.options.store.get(pushId);
    return record ? toLocalReview(record, this.#activeTtlMs) : undefined;
  }

  async approveLocal(pushId: string): Promise<boolean> {
    if (this.options.killSwitch?.()) return false;
    const now = this.#now();
    const current = this.options.store.expire(pushId, now)
      ?? this.options.store.get(pushId);
    if (!current || current.state !== 'PENDING') return false;
    return this.options.store.approve(pushId, now, now + this.#activeTtlMs) !== undefined;
  }

  rejectLocal(pushId: string): boolean {
    return this.options.store.reject(pushId, this.#now());
  }

  async reconcile(): Promise<void> {
    const now = this.#now();
    this.options.store.expireOverdue(now);
    for (const record of this.options.store.listInterruptedActive()) {
      let outcome: RemoteGitPushBackendOutcome;
      try {
        outcome = await this.options.backend.reconcile(record);
      } catch (error) {
        outcome = { outcome: 'OUTCOME_UNKNOWN', errorClass: errorClass(error) };
      }
      this.#finishFromOutcome(record, outcome, this.#now());
    }
  }

  #autonomousDecision(target: RemoteGitPushAutonomousTarget): 'ALLOW' | 'DENY' | 'HUMAN' {
    const policy = this.options.autonomous;
    if (!policy) return 'HUMAN';
    if (policy.permits(target)) return 'ALLOW';
    return policy.denyUnmatched === true ? 'DENY' : 'HUMAN';
  }

  async #executeAutonomousPending(record: RemoteGitPushRecord): Promise<RemoteGitPushResultView> {
    const now = this.#now();
    const claimed = this.options.store.activateAndClaim(
      record.pushId,
      now,
      now + this.#activeTtlMs,
    );
    if (!claimed) {
      const current = this.options.store.expire(record.pushId, now)
        ?? this.options.store.get(record.pushId);
      if (!current) throw new Error('REMOTE_EFFECT_GRANT_REQUIRED');
      if (current.state === 'ACTIVE' && current.executionStartedAt === undefined) {
        return this.#executeActive(current);
      }
      return toResult(current);
    }
    return this.#executeClaimed(claimed);
  }

  async #executeActive(record: RemoteGitPushRecord): Promise<RemoteGitPushResultView> {
    const now = this.#now();
    const claimed = this.options.store.claimExecution(record.pushId, now);
    if (!claimed) {
      const current = this.options.store.expire(record.pushId, now)
        ?? this.options.store.get(record.pushId);
      if (!current) throw new Error('REMOTE_EFFECT_GRANT_REQUIRED');
      return toResult(current);
    }
    return this.#executeClaimed(claimed);
  }

  async #executeClaimed(claimed: RemoteGitPushRecord): Promise<RemoteGitPushResultView> {
    if (this.options.killSwitch?.()) {
      const terminal = this.options.store.finish({
        pushId: claimed.pushId,
        state: 'REVOKED',
        now: this.#now(),
        outcomeClass: 'KILL_SWITCH_ENGAGED',
      });
      return toResult(terminal ?? claimed);
    }

    try {
      await this.options.effectBoundary?.revalidateWorkspace(
        claimed.workspaceId,
        claimed.workspaceRoot,
      );
    } catch (error) {
      const terminal = this.options.store.finish({
        pushId: claimed.pushId,
        state: 'REVOKED',
        now: this.#now(),
        outcomeClass: 'PRE_EFFECT_REVALIDATION_FAILED',
        errorClass: errorClass(error),
      });
      return toResult(terminal ?? claimed);
    }

    let outcome: RemoteGitPushBackendOutcome;
    try {
      outcome = await this.options.backend.execute(claimed);
    } catch (error) {
      const failed: RemoteGitPushBackendOutcome = {
        outcome: 'OUTCOME_UNKNOWN',
        errorClass: errorClass(error),
      };
      outcome = await this.#reconcileAfterUncertainty(claimed, failed);
    }
    if (outcome.outcome === 'OUTCOME_UNKNOWN') {
      outcome = await this.#reconcileAfterUncertainty(claimed, outcome);
    }
    const terminal = this.#finishFromOutcome(claimed, outcome, this.#now());
    return toResult(terminal ?? claimed);
  }

  async #reconcileAfterUncertainty(
    record: RemoteGitPushRecord,
    uncertain: RemoteGitPushBackendOutcome,
  ): Promise<RemoteGitPushBackendOutcome> {
    try {
      const reconciled = await this.options.backend.reconcile(record);
      if (reconciled.outcome === 'SUCCEEDED') return reconciled;
      return reconciled.errorClass === undefined && uncertain.errorClass !== undefined
        ? { ...reconciled, errorClass: uncertain.errorClass }
        : reconciled;
    } catch (error) {
      return {
        outcome: 'OUTCOME_UNKNOWN',
        errorClass: uncertain.errorClass ?? errorClass(error),
      };
    }
  }

  #finishFromOutcome(
    record: RemoteGitPushRecord,
    outcome: RemoteGitPushBackendOutcome,
    now: number,
  ): RemoteGitPushRecord | undefined {
    if (outcome.outcome === 'SUCCEEDED') {
      if (outcome.observedRemoteOid !== record.sourceOid) {
        return this.options.store.finish({
          pushId: record.pushId,
          state: 'QUARANTINED',
          now,
          observedRemoteOid: outcome.observedRemoteOid,
          outcomeClass: 'DIVERGENT_REMOTE',
          errorClass: 'UnexpectedObservedRemoteOid',
        });
      }
      return this.options.store.finish({
        pushId: record.pushId,
        state: 'CONSUMED',
        now,
        observedRemoteOid: outcome.observedRemoteOid,
        outcomeClass: 'SUCCEEDED',
      });
    }
    if (outcome.outcome === 'NOT_OBSERVED') {
      return this.options.store.finish({
        pushId: record.pushId,
        state: 'REVOKED',
        now,
        ...(outcome.observedRemoteOid === undefined ? {} : { observedRemoteOid: outcome.observedRemoteOid }),
        outcomeClass: 'NOT_OBSERVED',
        ...(outcome.errorClass === undefined ? {} : { errorClass: outcome.errorClass }),
      });
    }
    return this.options.store.finish({
      pushId: record.pushId,
      state: 'QUARANTINED',
      now,
      ...(outcome.observedRemoteOid === undefined ? {} : { observedRemoteOid: outcome.observedRemoteOid }),
      outcomeClass: outcome.outcome,
      ...(outcome.errorClass === undefined ? {} : { errorClass: outcome.errorClass }),
    });
  }

  #workspaceFor(caller: GatewayCallerContext, workspaceId: string): WorkspaceRecord {
    const workspace = this.options.workspaceStore.getWorkspace(workspaceId);
    if (!workspace || !sameAuthority(caller, workspace)) {
      throw new Error('Gateway denied remote git push workspace');
    }
    return workspace;
  }
}

function validateInspectInput(input: RemoteGitInspectInput): RemoteGitInspectInput {
  if (!REMOTE_NAME.test(input.remote)) throw new Error('Gateway denied remote git inspect remote name');
  if (!Array.isArray(input.refs) || input.refs.length > 32) {
    throw new Error('Gateway denied remote git inspect refs');
  }
  const seen = new Set<string>();
  for (const ref of input.refs) {
    assertReadableHeadRef(ref);
    if (seen.has(ref)) throw new Error('Gateway denied duplicate remote git inspect ref');
    seen.add(ref);
  }
  return { remote: input.remote, refs: [...input.refs] };
}

function validateInput(input: RemoteGitPushInput): RemoteGitPushInput {
  if (!REMOTE_NAME.test(input.remote)) throw new Error('Gateway denied remote git push remote name');
  if (!OID.test(input.sourceOid)) throw new Error('Gateway denied remote git push source OID');
  assertFeatureRef(input.destinationRef);
  if (input.reviewedOid !== undefined && !OID.test(input.reviewedOid)) {
    throw new Error('Gateway denied remote git push reviewed OID');
  }
  if (input.reviewReceiptDigest !== undefined && !SHA256.test(input.reviewReceiptDigest)) {
    throw new Error('Gateway denied remote git push review receipt digest');
  }
  return { ...input };
}

function assertReadableHeadRef(ref: string): void {
  if (!ref.startsWith('refs/heads/')) throw new Error('Gateway denied remote git inspect ref');
  const name = ref.slice('refs/heads/'.length);
  if (
    name.length === 0
    || name.length > 240
    || name.startsWith('-')
    || name.startsWith('.')
    || name.endsWith('/')
    || name.endsWith('.')
    || name.endsWith('.lock')
    || name.includes('..')
    || name.includes('//')
    || name.includes('@{')
    || /[\u0000-\u0020~^:?*\\[\]\\]/.test(name)
  ) {
    throw new Error('Gateway denied remote git inspect ref');
  }
}

function assertFeatureRef(ref: string): void {
  if (!ref.startsWith('refs/heads/')) throw new Error('Gateway denied remote git push destination ref');
  const name = ref.slice('refs/heads/'.length);
  if (
    name.length === 0
    || name.length > 240
    || name.toLowerCase() === 'main'
    || name.toLowerCase() === 'master'
    || name.startsWith('-')
    || name.startsWith('.')
    || name.endsWith('/')
    || name.endsWith('.')
    || name.endsWith('.lock')
    || name.includes('..')
    || name.includes('//')
    || name.includes('@{')
    || /[\u0000-\u0020~^:?*\\[\]\\]/.test(name)
  ) {
    throw new Error('Gateway denied remote git push destination ref');
  }
}

function assertInspectMatchesRequest(
  observation: RemoteGitInspectObservation,
  input: RemoteGitInspectInput,
): void {
  if (!/^repo_[0-9a-f]{64}$/.test(observation.repositoryIdentity)) {
    throw new Error('Gateway denied remote git inspect repository identity');
  }
  for (const value of [observation.effectiveFetchUrl, observation.effectivePushUrl]) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
      throw new Error('Gateway denied remote git inspect URL');
    }
  }
  if (
    observation.defaultBranch !== null
    && !observation.defaultBranch.startsWith('refs/heads/')
  ) {
    throw new Error('Gateway denied remote git inspect default branch');
  }
  if (
    observation.authenticationState !== 'AVAILABLE'
    && observation.authenticationState !== 'UNKNOWN'
  ) {
    throw new Error('Gateway denied remote git inspect authentication state');
  }
  if (observation.refs.length !== input.refs.length) {
    throw new Error('Gateway denied remote git inspect ref result');
  }
  for (let index = 0; index < input.refs.length; index += 1) {
    const expected = input.refs[index]!;
    const actual = observation.refs[index]!;
    if (actual.ref !== expected || (actual.oid !== null && !OID.test(actual.oid))) {
      throw new Error('Gateway denied remote git inspect ref result');
    }
  }
}

function assertPlanMatchesRequest(plan: RemoteGitPushPlan, input: RemoteGitPushInput): void {
  if (plan.sourceOid !== input.sourceOid || plan.destinationRef !== input.destinationRef) {
    throw new Error('Gateway denied remote git push backend plan identity');
  }
  if (!/^repo_[0-9a-f]{64}$/.test(plan.repositoryIdentity)) {
    throw new Error('Gateway denied remote git push repository identity');
  }
  if (typeof plan.resolvedPushUrl !== 'string' || plan.resolvedPushUrl.length === 0 || plan.resolvedPushUrl.length > 2048) {
    throw new Error('Gateway denied remote git push URL');
  }
  if (
    plan.expectedRemoteState.kind === 'OID'
    && !OID.test(plan.expectedRemoteState.oid)
  ) {
    throw new Error('Gateway denied remote git push expected remote state');
  }
  if (
    plan.commitSubject.length === 0
    || plan.commitSubject.length > 512
    || plan.changedFilesSummary.length === 0
    || plan.changedFilesSummary.length > 1024
  ) {
    throw new Error('Gateway denied remote git push review summary');
  }
  if (
    plan.aheadCommitCount !== undefined
    && (!Number.isSafeInteger(plan.aheadCommitCount) || plan.aheadCommitCount < 0)
  ) {
    throw new Error('Gateway denied remote git push ahead count');
  }
}

function requestFingerprintOf(
  caller: GatewayCallerContext,
  workspaceId: string,
  input: RemoteGitPushInput,
): string {
  return sha256([
    'remote-git-push-request-v1',
    caller.ownerId,
    caller.sessionId,
    caller.adapterId,
    workspaceId,
    input.remote,
    input.sourceOid,
    input.destinationRef,
    input.reviewedOid ?? '',
    input.reviewReceiptDigest ?? '',
  ].join('\0'));
}

function grantFingerprintOf(
  requestFingerprint: string,
  plan: RemoteGitPushPlan,
): string {
  return sha256([
    'remote-git-push-grant-v1',
    requestFingerprint,
    plan.repositoryIdentity,
    plan.resolvedPushUrl,
    plan.sourceOid,
    plan.destinationRef,
    plan.expectedRemoteState.kind,
    plan.expectedRemoteState.kind === 'OID' ? plan.expectedRemoteState.oid : '',
  ].join('\0'));
}

function sameAuthority(
  caller: GatewayCallerContext,
  record: Pick<RemoteGitPushRecord | WorkspaceRecord, 'ownerId' | 'sessionId' | 'adapterId'>,
): boolean {
  return (
    record.ownerId === caller.ownerId
    && record.sessionId === caller.sessionId
    && record.adapterId === caller.adapterId
  );
}

function toResult(record: RemoteGitPushRecord): RemoteGitPushResultView {
  const status: RemoteGitPushResultView['status'] =
    record.state === 'PENDING' ? 'approval_required'
      : record.state === 'ACTIVE' ? 'active'
        : record.state === 'CONSUMED' ? 'succeeded'
          : record.state === 'EXPIRED' ? 'expired'
            : record.state === 'REVOKED' && record.outcomeClass === 'NOT_OBSERVED'
              ? 'not_observed'
              : record.state === 'REVOKED' ? 'revoked'
                : 'quarantined';
  return {
    pushId: record.pushId,
    status,
    state: record.state,
    sourceOid: record.sourceOid,
    destinationRef: record.destinationRef,
    remoteDisplayName: record.remoteDisplayName,
    resolvedPushUrl: record.resolvedPushUrl,
    expectedRemoteState: record.expectedRemoteState,
    grantFingerprint: record.grantFingerprint,
    reviewDeadline: record.reviewDeadline,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.observedRemoteOid === undefined ? {} : { observedRemoteOid: record.observedRemoteOid }),
    ...(record.outcomeClass === undefined ? {} : { outcomeClass: record.outcomeClass }),
    ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
  };
}

function toLocalReview(
  record: RemoteGitPushRecord,
  activeGrantTtlMs: number,
): RemoteGitPushLocalReviewView {
  return {
    ...toResult(record),
    workspaceRoot: record.workspaceRoot,
    repositoryIdentity: record.repositoryIdentity,
    commitSubject: record.commitSubject,
    changedFilesSummary: record.changedFilesSummary,
    ...(record.aheadCommitCount === undefined ? {} : { aheadCommitCount: record.aheadCommitCount }),
    ...(record.reviewedCommitOid === undefined ? {} : { reviewedCommitOid: record.reviewedCommitOid }),
    ...(record.reviewReceiptDigest === undefined ? {} : { reviewReceiptDigest: record.reviewReceiptDigest }),
    maxUses: 1,
    activeGrantTtlMs,
  };
}

function boundedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_TTL_MS) {
    throw new Error('Remote Git push TTL must be between 1 second and 5 minutes');
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
