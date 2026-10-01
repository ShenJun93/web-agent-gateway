import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { GatewayAuthority } from './caller-context.js';

export type RemoteGitPushGrantState =
  | 'PENDING'
  | 'ACTIVE'
  | 'CONSUMED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'QUARANTINED';

export type RemoteGitExpectedState =
  | { kind: 'ABSENT' }
  | { kind: 'OID'; oid: string };

export interface CreateRemoteGitPushRecord extends GatewayAuthority {
  workspaceId: string;
  workspaceRoot: string;
  repositoryIdentity: string;
  remoteDisplayName: string;
  resolvedPushUrl: string;
  sourceOid: string;
  destinationRef: string;
  expectedRemoteState: RemoteGitExpectedState;
  reviewedCommitOid?: string;
  reviewReceiptDigest?: string;
  commitSubject: string;
  changedFilesSummary: string;
  aheadCommitCount?: number;
  requestFingerprint: string;
  grantFingerprint: string;
  createdAt: number;
  reviewDeadline: number;
  maxUses: 1;
}

export interface RemoteGitPushRecord extends CreateRemoteGitPushRecord {
  pushId: string;
  state: RemoteGitPushGrantState;
  approvedAt?: number;
  expiresAt?: number;
  useCount: number;
  executionStartedAt?: number;
  completedAt?: number;
  observedRemoteOid?: string;
  outcomeClass?: string;
  errorClass?: string;
}

export interface RemoteGitPushAuditEvent {
  sequence: number;
  pushId: string;
  observedAt: number;
  fromState?: RemoteGitPushGrantState;
  toState: RemoteGitPushGrantState;
  outcomeClass?: string;
  errorClass?: string;
}

export class RemoteGitPushStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS remote_git_push_grants (
        push_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        repository_identity TEXT NOT NULL,
        remote_display_name TEXT NOT NULL,
        resolved_push_url TEXT NOT NULL,
        source_oid TEXT NOT NULL,
        destination_ref TEXT NOT NULL,
        expected_remote_kind TEXT NOT NULL CHECK (expected_remote_kind IN ('ABSENT','OID')),
        expected_remote_oid TEXT,
        reviewed_commit_oid TEXT,
        review_receipt_digest TEXT,
        commit_subject TEXT NOT NULL,
        changed_files_summary TEXT NOT NULL,
        ahead_commit_count INTEGER,
        request_fingerprint TEXT NOT NULL,
        grant_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PENDING','ACTIVE','CONSUMED','EXPIRED','REVOKED','QUARANTINED')),
        created_at INTEGER NOT NULL,
        review_deadline INTEGER NOT NULL,
        approved_at INTEGER,
        expires_at INTEGER,
        max_uses INTEGER NOT NULL CHECK (max_uses = 1),
        use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= 1),
        execution_started_at INTEGER,
        completed_at INTEGER,
        observed_remote_oid TEXT,
        outcome_class TEXT,
        error_class TEXT,
        CHECK (
          (expected_remote_kind = 'ABSENT' AND expected_remote_oid IS NULL)
          OR
          (expected_remote_kind = 'OID' AND expected_remote_oid IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_remote_git_push_live
        ON remote_git_push_grants(request_fingerprint, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_remote_git_push_pending
        ON remote_git_push_grants(state, created_at);

      CREATE TABLE IF NOT EXISTS remote_git_push_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        push_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        outcome_class TEXT,
        error_class TEXT,
        FOREIGN KEY(push_id) REFERENCES remote_git_push_grants(push_id)
      );
      CREATE INDEX IF NOT EXISTS idx_remote_git_push_audit_push
        ON remote_git_push_audit(push_id, sequence);
    `);
  }

  close(): void {
    this.#db.close();
  }

  createProposal(input: CreateRemoteGitPushRecord): RemoteGitPushRecord {
    const pushId = 'push_' + randomUUID();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const live = this.#db.prepare(`
        SELECT push_id FROM remote_git_push_grants
        WHERE request_fingerprint = ? AND state IN ('PENDING','ACTIVE')
        LIMIT 2
      `).all(input.requestFingerprint);
      if (live.length !== 0) throw new Error('REMOTE_GIT_PUSH_LIVE_GRANT_EXISTS');

      this.#db.prepare(`
        INSERT INTO remote_git_push_grants (
          push_id, owner_id, session_id, adapter_id, workspace_id, workspace_root,
          repository_identity, remote_display_name, resolved_push_url, source_oid,
          destination_ref, expected_remote_kind, expected_remote_oid,
          reviewed_commit_oid, review_receipt_digest, commit_subject, changed_files_summary,
          ahead_commit_count, request_fingerprint, grant_fingerprint, state,
          created_at, review_deadline, max_uses, use_count
        ) VALUES (
          ?,?,?,?,?,?,?,?,?,?,
          ?,?,?,?,?,?,?,?,
          ?,?,'PENDING',?,?,1,0
        )
      `).run(
        pushId,
        input.ownerId,
        input.sessionId,
        input.adapterId,
        input.workspaceId,
        input.workspaceRoot,
        input.repositoryIdentity,
        input.remoteDisplayName,
        input.resolvedPushUrl,
        input.sourceOid,
        input.destinationRef,
        input.expectedRemoteState.kind,
        input.expectedRemoteState.kind === 'OID' ? input.expectedRemoteState.oid : null,
        input.reviewedCommitOid ?? null,
        input.reviewReceiptDigest ?? null,
        input.commitSubject,
        input.changedFilesSummary,
        input.aheadCommitCount ?? null,
        input.requestFingerprint,
        input.grantFingerprint,
        input.createdAt,
        input.reviewDeadline,
      );
      this.#audit(pushId, input.createdAt, undefined, 'PENDING');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return this.get(pushId)!;
  }

  get(pushId: string): RemoteGitPushRecord | undefined {
    const row = this.#db.prepare(
      'SELECT * FROM remote_git_push_grants WHERE push_id = ?',
    ).get(pushId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }

  listPending(limit = 20): RemoteGitPushRecord[] {
    const safe = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return (this.#db.prepare(`
      SELECT * FROM remote_git_push_grants
      WHERE state = 'PENDING'
      ORDER BY created_at ASC, push_id ASC
      LIMIT ?
    `).all(safe) as Record<string, unknown>[]).map(fromRow);
  }

  findLive(requestFingerprint: string): RemoteGitPushRecord[] {
    return (this.#db.prepare(`
      SELECT * FROM remote_git_push_grants
      WHERE request_fingerprint = ? AND state IN ('PENDING','ACTIVE')
      ORDER BY created_at ASC, push_id ASC
      LIMIT 3
    `).all(requestFingerprint) as Record<string, unknown>[]).map(fromRow);
  }

  approve(pushId: string, now: number, expiresAt: number): RemoteGitPushRecord | undefined {
    return this.#transition(pushId, ['PENDING'], 'ACTIVE', now, () => {
      const result = this.#db.prepare(`
        UPDATE remote_git_push_grants
        SET state = 'ACTIVE', approved_at = ?, expires_at = ?
        WHERE push_id = ? AND state = 'PENDING' AND review_deadline > ?
      `).run(now, expiresAt, pushId, now);
      return Number(result.changes) === 1;
    });
  }

  /**
   * Autonomous remote policy consumes the approval/claim window atomically.
   *
   * A normal Human approval intentionally stops at ACTIVE so the exact model request must return
   * to claim the one-shot grant. Autonomous policy has no second Human gesture and therefore must
   * not create a crash/race window between authority activation and execution claim.
   */
  activateAndClaim(pushId: string, now: number, expiresAt: number): RemoteGitPushRecord | undefined {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.get(pushId);
      if (!before || before.state !== 'PENDING') {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      const result = this.#db.prepare(`
        UPDATE remote_git_push_grants
        SET state = 'ACTIVE', approved_at = ?, expires_at = ?,
            use_count = 1, execution_started_at = ?
        WHERE push_id = ? AND state = 'PENDING'
          AND review_deadline > ?
          AND use_count = 0
          AND execution_started_at IS NULL
      `).run(now, expiresAt, now, pushId, now);
      if (Number(result.changes) !== 1) {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      const after = this.get(pushId)!;
      this.#audit(pushId, now, 'PENDING', 'ACTIVE');
      this.#db.exec('COMMIT');
      return after;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  reject(pushId: string, now: number): boolean {
    return this.#transition(pushId, ['PENDING','ACTIVE'], 'REVOKED', now, () => {
      const result = this.#db.prepare(`
        UPDATE remote_git_push_grants
        SET state = 'REVOKED', completed_at = ?, outcome_class = 'HUMAN_REVOKED'
        WHERE push_id = ? AND state IN ('PENDING','ACTIVE') AND execution_started_at IS NULL
      `).run(now, pushId);
      return Number(result.changes) === 1;
    }) !== undefined;
  }

  expire(pushId: string, now: number): RemoteGitPushRecord | undefined {
    const current = this.get(pushId);
    if (!current) return undefined;
    if (current.state === 'PENDING' && current.reviewDeadline <= now) {
      return this.#transition(pushId, ['PENDING'], 'EXPIRED', now, () => {
        const result = this.#db.prepare(`
          UPDATE remote_git_push_grants
          SET state = 'EXPIRED', completed_at = ?, outcome_class = 'REVIEW_EXPIRED'
          WHERE push_id = ? AND state = 'PENDING' AND review_deadline <= ?
        `).run(now, pushId, now);
        return Number(result.changes) === 1;
      });
    }
    if (
      current.state === 'ACTIVE'
      && current.expiresAt !== undefined
      && current.expiresAt <= now
      && current.executionStartedAt === undefined
    ) {
      return this.#transition(pushId, ['ACTIVE'], 'EXPIRED', now, () => {
        const result = this.#db.prepare(`
          UPDATE remote_git_push_grants
          SET state = 'EXPIRED', completed_at = ?, outcome_class = 'GRANT_EXPIRED'
          WHERE push_id = ? AND state = 'ACTIVE'
            AND expires_at IS NOT NULL AND expires_at <= ?
            AND execution_started_at IS NULL
        `).run(now, pushId, now);
        return Number(result.changes) === 1;
      });
    }
    return current;
  }

  expireOverdue(now: number): void {
    const rows = this.#db.prepare(`
      SELECT push_id FROM remote_git_push_grants
      WHERE
        (state = 'PENDING' AND review_deadline <= ?)
        OR
        (state = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ? AND execution_started_at IS NULL)
      LIMIT 100
    `).all(now, now) as { push_id: string }[];
    for (const row of rows) this.expire(row.push_id, now);
  }

  claimExecution(pushId: string, now: number): RemoteGitPushRecord | undefined {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.get(pushId);
      if (!before || before.state !== 'ACTIVE') {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      const result = this.#db.prepare(`
        UPDATE remote_git_push_grants
        SET use_count = use_count + 1, execution_started_at = ?
        WHERE push_id = ? AND state = 'ACTIVE'
          AND expires_at IS NOT NULL AND expires_at > ?
          AND use_count < max_uses
          AND execution_started_at IS NULL
      `).run(now, pushId, now);
      if (Number(result.changes) !== 1) {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      this.#db.exec('COMMIT');
      return this.get(pushId);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  finish(input: {
    pushId: string;
    state: Extract<RemoteGitPushGrantState, 'CONSUMED' | 'REVOKED' | 'QUARANTINED'>;
    now: number;
    observedRemoteOid?: string;
    outcomeClass: string;
    errorClass?: string;
  }): RemoteGitPushRecord | undefined {
    return this.#transition(input.pushId, ['ACTIVE'], input.state, input.now, () => {
      const result = this.#db.prepare(`
        UPDATE remote_git_push_grants
        SET state = ?, completed_at = ?, observed_remote_oid = ?,
            outcome_class = ?, error_class = ?
        WHERE push_id = ? AND state = 'ACTIVE' AND execution_started_at IS NOT NULL
      `).run(
        input.state,
        input.now,
        input.observedRemoteOid ?? null,
        input.outcomeClass,
        input.errorClass ?? null,
        input.pushId,
      );
      return Number(result.changes) === 1;
    });
  }

  listInterruptedActive(limit = 100): RemoteGitPushRecord[] {
    const safe = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return (this.#db.prepare(`
      SELECT * FROM remote_git_push_grants
      WHERE state = 'ACTIVE' AND execution_started_at IS NOT NULL
      ORDER BY execution_started_at ASC
      LIMIT ?
    `).all(safe) as Record<string, unknown>[]).map(fromRow);
  }

  audit(pushId: string): RemoteGitPushAuditEvent[] {
    return (this.#db.prepare(`
      SELECT sequence, push_id, observed_at, from_state, to_state, outcome_class, error_class
      FROM remote_git_push_audit
      WHERE push_id = ?
      ORDER BY sequence ASC
    `).all(pushId) as Record<string, unknown>[]).map((row) => ({
      sequence: Number(row.sequence),
      pushId: String(row.push_id),
      observedAt: Number(row.observed_at),
      ...(row.from_state === null ? {} : { fromState: String(row.from_state) as RemoteGitPushGrantState }),
      toState: String(row.to_state) as RemoteGitPushGrantState,
      ...(row.outcome_class === null ? {} : { outcomeClass: String(row.outcome_class) }),
      ...(row.error_class === null ? {} : { errorClass: String(row.error_class) }),
    }));
  }

  #transition(
    pushId: string,
    fromStates: readonly RemoteGitPushGrantState[],
    toState: RemoteGitPushGrantState,
    now: number,
    apply: () => boolean,
  ): RemoteGitPushRecord | undefined {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.get(pushId);
      if (!before || !fromStates.includes(before.state)) {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      if (!apply()) {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      const after = this.get(pushId)!;
      this.#audit(pushId, now, before.state, toState, after.outcomeClass, after.errorClass);
      this.#db.exec('COMMIT');
      return after;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #audit(
    pushId: string,
    observedAt: number,
    fromState: RemoteGitPushGrantState | undefined,
    toState: RemoteGitPushGrantState,
    outcomeClass?: string,
    errorClass?: string,
  ): void {
    this.#db.prepare(`
      INSERT INTO remote_git_push_audit (
        push_id, observed_at, from_state, to_state, outcome_class, error_class
      ) VALUES (?,?,?,?,?,?)
    `).run(
      pushId,
      observedAt,
      fromState ?? null,
      toState,
      outcomeClass ?? null,
      errorClass ?? null,
    );
  }
}

function fromRow(row: Record<string, unknown>): RemoteGitPushRecord {
  const expectedRemoteState: RemoteGitExpectedState = row.expected_remote_kind === 'ABSENT'
    ? { kind: 'ABSENT' }
    : { kind: 'OID', oid: String(row.expected_remote_oid) };
  return {
    pushId: String(row.push_id),
    ownerId: String(row.owner_id),
    sessionId: String(row.session_id),
    adapterId: String(row.adapter_id),
    workspaceId: String(row.workspace_id),
    workspaceRoot: String(row.workspace_root),
    repositoryIdentity: String(row.repository_identity),
    remoteDisplayName: String(row.remote_display_name),
    resolvedPushUrl: String(row.resolved_push_url),
    sourceOid: String(row.source_oid),
    destinationRef: String(row.destination_ref),
    expectedRemoteState,
    ...(row.reviewed_commit_oid === null ? {} : { reviewedCommitOid: String(row.reviewed_commit_oid) }),
    ...(row.review_receipt_digest === null ? {} : { reviewReceiptDigest: String(row.review_receipt_digest) }),
    commitSubject: String(row.commit_subject),
    changedFilesSummary: String(row.changed_files_summary),
    ...(row.ahead_commit_count === null ? {} : { aheadCommitCount: Number(row.ahead_commit_count) }),
    requestFingerprint: String(row.request_fingerprint),
    grantFingerprint: String(row.grant_fingerprint),
    state: String(row.state) as RemoteGitPushGrantState,
    createdAt: Number(row.created_at),
    reviewDeadline: Number(row.review_deadline),
    ...(row.approved_at === null ? {} : { approvedAt: Number(row.approved_at) }),
    ...(row.expires_at === null ? {} : { expiresAt: Number(row.expires_at) }),
    maxUses: 1,
    useCount: Number(row.use_count),
    ...(row.execution_started_at === null ? {} : { executionStartedAt: Number(row.execution_started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    ...(row.observed_remote_oid === null ? {} : { observedRemoteOid: String(row.observed_remote_oid) }),
    ...(row.outcome_class === null ? {} : { outcomeClass: String(row.outcome_class) }),
    ...(row.error_class === null ? {} : { errorClass: String(row.error_class) }),
  };
}
