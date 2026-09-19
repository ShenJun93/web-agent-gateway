import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { GatewayAuthority } from './caller-context.js';

export type MutationState =
  | 'PENDING_APPROVAL' | 'QUEUED' | 'EXECUTING'
  | 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  | 'REJECTED' | 'EXPIRED';

export type VerifyJobState = 'QUEUED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN';
export type VerifyJobErrorClass =
  | 'DISPATCH_DEADLINE_EXPIRED' | 'WORKSPACE_MISSING' | 'WORKSPACE_OWNERSHIP_MISMATCH'
  | 'UNSUPPORTED_BACKEND' | 'PROFILE_MISSING' | 'PROFILE_PLAN_DRIFT'
  | 'RESTART_RESUME_DISABLED' | 'RESTART_EXECUTION_UNVERIFIABLE'
  | 'EXECUTION_TIMEOUT_UNCONFIRMED' | 'EXECUTION_PORT_ERROR_UNCONFIRMED';

export type BrowserVerifyRequestState =
  | 'PENDING_APPROVAL' | 'REJECTED' | 'EXPIRED' | 'INVALIDATED' | 'DISPATCHED';
export type BrowserVerifyRequestErrorClass =
  | 'WORKSPACE_MISSING' | 'WORKSPACE_OWNERSHIP_MISMATCH'
  | 'PROFILE_MISSING' | 'PROFILE_NOT_ALLOWED' | 'PROFILE_PLAN_DRIFT'
  | 'RESTART_RESUME_NOT_ALLOWED';

export interface LocalPrincipalRecord {
  ownerId: string;
  createdAt: number;
}

export interface AdapterSessionRecord {
  sessionId: string;
  ownerId: string;
  adapterId: string;
  correlationSha256: string;
  createdAt: number;
}
export interface WorkspaceRecord extends GatewayAuthority {
  workspaceId: string;
  canonicalRoot: string;
  backendKind: string;
  createdAt: number;
}

export interface MutationRecord extends GatewayAuthority {
  mutationId: string;
  workspaceId: string;
  backendKind: string;
  path: string;
  baseSha256: string;
  before: string;
  after: string;
  resultSha256: string;
  fingerprint: string;
  additions: number;
  removals: number;
  state: MutationState;
  createdAt: number;
  reviewDeadline: number;
  reviewedAt?: number;
  executionAdmissionDeadline?: number;
  executionStartedAt?: number;
  completedAt?: number;
  resultMetadata?: string;
  errorClass?: string;
}

export interface CreateWorkspaceRecord extends GatewayAuthority {
  canonicalRoot: string;
  backendKind: string;
  createdAt: number;
}

export interface CreateMutationRecord extends GatewayAuthority {
  workspaceId: string;
  backendKind: string;
  path: string;
  baseSha256: string;
  before: string;
  after: string;
  resultSha256: string;
  fingerprint: string;
  additions: number;
  removals: number;
  createdAt: number;
  reviewDeadline: number;
}
export interface AuditEvent {
  sequence: number;
  mutationId: string;
  observedAt: number;
  fromState?: MutationState;
  toState: MutationState;
  fingerprint: string;
  path: string;
  additions: number;
  removals: number;
}
export interface CreateVerifyJobRecord extends GatewayAuthority {
  workspaceId: string;
  backendKind: string;
  profileName: string;
  planSha256: string;
  createdAt: number;
  dispatchDeadline: number;
}

export interface VerifyJobRecord extends CreateVerifyJobRecord {
  jobId: string;
  state: VerifyJobState;
  attemptId?: string;
  executionStartedAt?: number;
  completedAt?: number;
  exitCode?: number;
  output?: string;
  outputTruncated?: boolean;
  errorClass?: VerifyJobErrorClass;
}

export interface VerifyJobEvent {
  sequence: number;
  jobId: string;
  observedAt: number;
  fromState?: VerifyJobState;
  toState: VerifyJobState;
  attemptId?: string;
  errorClass?: VerifyJobErrorClass;
}

export interface CreateBrowserVerifyRequestRecord extends GatewayAuthority {
  requestId: string;
  workspaceId: string;
  profileName: string;
  planSha256: string;
  fingerprint: string;
  createdAt: number;
  reviewDeadline: number;
}

export interface BrowserVerifyRequestRecord extends CreateBrowserVerifyRequestRecord {
  state: BrowserVerifyRequestState;
  approvedAt?: number;
  completedAt?: number;
  linkedJobId?: string;
  errorClass?: BrowserVerifyRequestErrorClass;
}

export interface BrowserVerifyApprovalResult {
  request: BrowserVerifyRequestRecord;
  job: VerifyJobRecord;
}

export class SqliteDurableStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_identity (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        owner_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adapter_sessions (
        session_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        correlation_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(owner_id, adapter_id, correlation_sha256)
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        canonical_root TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mutations (
        mutation_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        path TEXT NOT NULL,
        base_sha256 TEXT NOT NULL,
        before_text TEXT NOT NULL,
        after_text TEXT NOT NULL,
        result_sha256 TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        additions INTEGER NOT NULL,
        removals INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        review_deadline INTEGER NOT NULL,
        reviewed_at INTEGER,
        execution_admission_deadline INTEGER,
        execution_started_at INTEGER,
        completed_at INTEGER,
        result_metadata TEXT,
        error_class TEXT,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        mutation_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        path TEXT NOT NULL,
        additions INTEGER NOT NULL,
        removals INTEGER NOT NULL,
        FOREIGN KEY(mutation_id) REFERENCES mutations(mutation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mutations_state ON mutations(state, created_at);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verify_jobs (
        job_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        plan_sha256 TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        dispatch_deadline INTEGER NOT NULL,
        attempt_id TEXT,
        execution_started_at INTEGER,
        completed_at INTEGER,
        exit_code INTEGER,
        output_text TEXT,
        output_truncated INTEGER,
        error_class TEXT,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
      );
      CREATE INDEX IF NOT EXISTS idx_verify_jobs_state ON verify_jobs(state, created_at);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verify_job_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        attempt_id TEXT,
        error_class TEXT,
        FOREIGN KEY(job_id) REFERENCES verify_jobs(job_id)
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_verify_requests (
        request_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        plan_sha256 TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        review_deadline INTEGER NOT NULL,
        approved_at INTEGER,
        completed_at INTEGER,
        linked_job_id TEXT,
        error_class TEXT,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id),
        FOREIGN KEY(linked_job_id) REFERENCES verify_jobs(job_id)
      );
      CREATE INDEX IF NOT EXISTS idx_browser_verify_requests_state
        ON browser_verify_requests(state, created_at);
      CREATE INDEX IF NOT EXISTS idx_browser_verify_requests_session
        ON browser_verify_requests(owner_id, session_id, adapter_id, state, created_at);
    `);
  }

  getOrCreateLocalPrincipal(now: number): LocalPrincipalRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT owner_id, created_at FROM gateway_identity WHERE singleton_id = 1').get();
      if (existing) {
        this.db.exec('COMMIT');
        return principalFromRow(existing as Record<string, unknown>);
      }
      const record: LocalPrincipalRecord = { ownerId: `owner_${randomUUID()}`, createdAt: now };
      this.db.prepare('INSERT INTO gateway_identity (singleton_id, owner_id, created_at) VALUES (1, ?, ?)')
        .run(record.ownerId, record.createdAt);
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getOrCreateAdapterSession(input: { ownerId: string; adapterId: string; correlationSha256: string; createdAt: number }): AdapterSessionRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.findAdapterSession(input.ownerId, input.adapterId, input.correlationSha256);
      if (existing) {
        this.db.exec('COMMIT');
        return existing;
      }
      const record: AdapterSessionRecord = { sessionId: `session_${randomUUID()}`, ...input };
      this.db.prepare(`INSERT INTO adapter_sessions
        (session_id, owner_id, adapter_id, correlation_sha256, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(record.sessionId, record.ownerId, record.adapterId, record.correlationSha256, record.createdAt);
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getAdapterSession(sessionId: string): AdapterSessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM adapter_sessions WHERE session_id = ?').get(sessionId);
    return row ? adapterSessionFromRow(row as Record<string, unknown>) : undefined;
  }

  findAdapterSession(ownerId: string, adapterId: string, correlationSha256: string): AdapterSessionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM adapter_sessions
      WHERE owner_id = ? AND adapter_id = ? AND correlation_sha256 = ?`)
      .get(ownerId, adapterId, correlationSha256);
    return row ? adapterSessionFromRow(row as Record<string, unknown>) : undefined;
  }
  openWorkspaceRecord(input: CreateWorkspaceRecord): WorkspaceRecord {
    const record = { workspaceId: `ws_${randomUUID()}`, ...input };
    this.db.prepare(`INSERT INTO workspaces
      (workspace_id, owner_id, session_id, adapter_id, canonical_root, backend_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(record.workspaceId, record.ownerId, record.sessionId, record.adapterId,
        record.canonicalRoot, record.backendKind, record.createdAt);
    return record;
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ?').get(workspaceId);
    return row ? workspaceFromRow(row as Record<string, unknown>) : undefined;
  }
  createMutation(input: CreateMutationRecord): MutationRecord {
    const record: MutationRecord = {
      mutationId: `mut_${randomUUID()}`,
      ...input,
      state: 'PENDING_APPROVAL',
    };
    this.db.prepare(`INSERT INTO mutations (
      mutation_id, owner_id, session_id, adapter_id, workspace_id, backend_kind,
      path, base_sha256, before_text, after_text, result_sha256, fingerprint,
      additions, removals, state, created_at, review_deadline
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.mutationId, record.ownerId, record.sessionId, record.adapterId,
        record.workspaceId, record.backendKind, record.path, record.baseSha256,
        record.before, record.after, record.resultSha256, record.fingerprint,
        record.additions, record.removals, record.state, record.createdAt, record.reviewDeadline);
    this.appendAuditEvent(record, undefined, 'PENDING_APPROVAL', record.createdAt);
    return record;
  }

  getMutation(mutationId: string): MutationRecord | undefined {
    const row = this.db.prepare('SELECT * FROM mutations WHERE mutation_id = ?').get(mutationId);
    return row ? mutationFromRow(row as Record<string, unknown>) : undefined;
  }

  listPendingMutations(limit = 20): MutationRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const rows = this.db.prepare("SELECT * FROM mutations WHERE state = 'PENDING_APPROVAL' ORDER BY created_at LIMIT ?").all(safeLimit);
    return rows.map((row) => mutationFromRow(row as Record<string, unknown>));
  }
  approveMutation(mutationId: string, now: number, admissionTtlMs: number): MutationRecord | undefined {
    return this.transition(mutationId, 'PENDING_APPROVAL', 'QUEUED', now, () => {
      const result = this.db.prepare(`UPDATE mutations
        SET state = 'QUEUED', reviewed_at = ?, execution_admission_deadline = ?
        WHERE mutation_id = ? AND state = 'PENDING_APPROVAL' AND review_deadline > ?`)
        .run(now, now + admissionTtlMs, mutationId, now);
      return Number(result.changes) === 1;
    });
  }

  rejectMutation(mutationId: string, now: number): boolean {
    return Boolean(this.transition(mutationId, 'PENDING_APPROVAL', 'REJECTED', now, () => {
      const result = this.db.prepare(`UPDATE mutations SET state = 'REJECTED', completed_at = ?
        WHERE mutation_id = ? AND state = 'PENDING_APPROVAL' AND review_deadline > ?`)
        .run(now, mutationId, now);
      return Number(result.changes) === 1;
    }));
  }

  claimMutation(mutationId: string, now: number): MutationRecord | undefined {
    return this.transition(mutationId, 'QUEUED', 'EXECUTING', now, () => {
      const result = this.db.prepare(`UPDATE mutations SET state = 'EXECUTING', execution_started_at = ?
        WHERE mutation_id = ? AND state = 'QUEUED' AND execution_admission_deadline > ?`)
        .run(now, mutationId, now);
      return Number(result.changes) === 1;
    });
  }
  finishMutation(mutationId: string, state: Extract<MutationState, 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN' | 'EXPIRED'>, now: number, resultMetadata?: string, errorClass?: string): boolean {
    return Boolean(this.transition(mutationId, 'EXECUTING', state, now, () => {
      const result = this.db.prepare(`UPDATE mutations
        SET state = ?, completed_at = ?, result_metadata = ?, error_class = ?
        WHERE mutation_id = ? AND state = 'EXECUTING'`)
        .run(state, now, resultMetadata ?? null, errorClass ?? null, mutationId);
      return Number(result.changes) === 1;
    }));
  }

  expireMutation(mutationId: string, expectedState: Extract<MutationState, 'PENDING_APPROVAL' | 'QUEUED'>, now: number): boolean {
    const deadlineColumn = expectedState === 'PENDING_APPROVAL' ? 'review_deadline' : 'execution_admission_deadline';
    return Boolean(this.transition(mutationId, expectedState, 'EXPIRED', now, () => {
      const result = this.db.prepare(`UPDATE mutations SET state = 'EXPIRED', completed_at = ?
        WHERE mutation_id = ? AND state = ? AND ${deadlineColumn} <= ?`)
        .run(now, mutationId, expectedState, now);
      return Number(result.changes) === 1;
    }));
  }

  requeueExecuting(mutationId: string, now: number): boolean {
    return Boolean(this.transition(mutationId, 'EXECUTING', 'QUEUED', now, () => {
      const result = this.db.prepare(`UPDATE mutations SET state = 'QUEUED', execution_started_at = NULL
        WHERE mutation_id = ? AND state = 'EXECUTING' AND execution_admission_deadline > ?`)
        .run(mutationId, now);
      return Number(result.changes) === 1;
    }));
  }

  listRecoverableMutations(): MutationRecord[] {
    const rows = this.db.prepare("SELECT * FROM mutations WHERE state IN ('PENDING_APPROVAL','QUEUED','EXECUTING') ORDER BY created_at").all();
    return rows.map((row) => mutationFromRow(row as Record<string, unknown>));
  }

  listAuditEvents(mutationId: string): AuditEvent[] {
    const rows = this.db.prepare('SELECT * FROM audit_events WHERE mutation_id = ? ORDER BY sequence').all(mutationId);
    return rows.map((row) => auditFromRow(row as Record<string, unknown>));
  }

  createVerifyJob(input: CreateVerifyJobRecord): VerifyJobRecord {
    const record: VerifyJobRecord = {
      jobId: `job_${randomUUID()}`,
      ...input,
      state: 'QUEUED',
    };
    this.db.prepare(`INSERT INTO verify_jobs (
      job_id, owner_id, session_id, adapter_id, workspace_id, backend_kind,
      profile_name, plan_sha256, state, created_at, dispatch_deadline
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.jobId, record.ownerId, record.sessionId, record.adapterId,
        record.workspaceId, record.backendKind, record.profileName, record.planSha256,
        record.state, record.createdAt, record.dispatchDeadline);
    this.appendVerifyJobEvent(record, undefined, 'QUEUED', record.createdAt);
    return record;
  }

  getVerifyJob(jobId: string): VerifyJobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM verify_jobs WHERE job_id = ?').get(jobId);
    return row ? verifyJobFromRow(row as Record<string, unknown>) : undefined;
  }

  claimVerifyJob(jobId: string, now: number, attemptId: string): VerifyJobRecord | undefined {
    return this.transitionVerifyJob(jobId, 'QUEUED', 'EXECUTING', now, () => {
      const result = this.db.prepare(`UPDATE verify_jobs
        SET state = 'EXECUTING', attempt_id = ?, execution_started_at = ?
        WHERE job_id = ? AND state = 'QUEUED' AND dispatch_deadline > ?`)
        .run(attemptId, now, jobId, now);
      return Number(result.changes) === 1;
    });
  }

  failQueuedVerifyJob(jobId: string, now: number, errorClass: VerifyJobErrorClass): boolean {
    return Boolean(this.transitionVerifyJob(jobId, 'QUEUED', 'FAILED', now, () => {
      const result = this.db.prepare(`UPDATE verify_jobs
        SET state = 'FAILED', completed_at = ?, error_class = ?
        WHERE job_id = ? AND state = 'QUEUED'`)
        .run(now, errorClass, jobId);
      return Number(result.changes) === 1;
    }));
  }

  finishVerifyJob(
    jobId: string,
    state: Extract<VerifyJobState, 'SUCCEEDED' | 'OUTCOME_UNKNOWN'>,
    now: number,
    result?: { exitCode: number; output: string; outputTruncated: boolean },
    errorClass?: VerifyJobErrorClass,
  ): boolean {
    if (state === 'SUCCEEDED' && result === undefined) throw new Error('Verify job success requires result');
    if (state === 'OUTCOME_UNKNOWN' && errorClass === undefined) throw new Error('Verify job unknown outcome requires error class');
    return Boolean(this.transitionVerifyJob(jobId, 'EXECUTING', state, now, () => {
      const updated = this.db.prepare(`UPDATE verify_jobs
        SET state = ?, completed_at = ?, exit_code = ?, output_text = ?, output_truncated = ?, error_class = ?
        WHERE job_id = ? AND state = 'EXECUTING'`)
        .run(state, now, result?.exitCode ?? null, result?.output ?? null,
          result === undefined ? null : (result.outputTruncated ? 1 : 0), errorClass ?? null, jobId);
      return Number(updated.changes) === 1;
    }));
  }

  listRecoverableVerifyJobs(): VerifyJobRecord[] {
    const rows = this.db.prepare("SELECT * FROM verify_jobs WHERE state IN ('QUEUED','EXECUTING') ORDER BY created_at").all();
    return rows.map((row) => verifyJobFromRow(row as Record<string, unknown>));
  }

  listVerifyJobEvents(jobId: string): VerifyJobEvent[] {
    const rows = this.db.prepare('SELECT * FROM verify_job_events WHERE job_id = ? ORDER BY sequence').all(jobId);
    return rows.map((row) => verifyJobEventFromRow(row as Record<string, unknown>));
  }

  createBrowserVerifyRequest(
    input: CreateBrowserVerifyRequestRecord,
    limits: { perSession: number; global: number },
  ): BrowserVerifyRequestRecord | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = this.db.prepare(`SELECT request_id FROM browser_verify_requests
        WHERE owner_id = ? AND session_id = ? AND adapter_id = ?
          AND workspace_id = ? AND profile_name = ?
          AND state = 'PENDING_APPROVAL' AND review_deadline > ?
        LIMIT 1`).get(
        input.ownerId, input.sessionId, input.adapterId,
        input.workspaceId, input.profileName, input.createdAt,
      );
      const sessionCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM browser_verify_requests
        WHERE owner_id = ? AND session_id = ? AND adapter_id = ?
          AND state = 'PENDING_APPROVAL' AND review_deadline > ?`)
        .get(input.ownerId, input.sessionId, input.adapterId, input.createdAt) as { count: number }).count);
      const globalCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM browser_verify_requests
        WHERE state = 'PENDING_APPROVAL' AND review_deadline > ?`)
        .get(input.createdAt) as { count: number }).count);
      if (duplicate || sessionCount >= limits.perSession || globalCount >= limits.global) {
        this.db.exec('ROLLBACK');
        return undefined;
      }

      const record: BrowserVerifyRequestRecord = { ...input, state: 'PENDING_APPROVAL' };
      this.db.prepare(`INSERT INTO browser_verify_requests (
        request_id, owner_id, session_id, adapter_id, workspace_id, profile_name,
        plan_sha256, fingerprint, state, created_at, review_deadline
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.requestId, record.ownerId, record.sessionId, record.adapterId,
        record.workspaceId, record.profileName, record.planSha256, record.fingerprint,
        record.state, record.createdAt, record.reviewDeadline,
      );
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getBrowserVerifyRequest(requestId: string): BrowserVerifyRequestRecord | undefined {
    const row = this.db.prepare('SELECT * FROM browser_verify_requests WHERE request_id = ?').get(requestId);
    return row ? browserVerifyRequestFromRow(row as Record<string, unknown>) : undefined;
  }

  listPendingBrowserVerifyRequests(limit = 20): BrowserVerifyRequestRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const rows = this.db.prepare(`SELECT * FROM browser_verify_requests
      WHERE state = 'PENDING_APPROVAL' ORDER BY created_at LIMIT ?`).all(safeLimit);
    return rows.map((row) => browserVerifyRequestFromRow(row as Record<string, unknown>));
  }

  expireBrowserVerifyRequest(requestId: string, now: number): boolean {
    const updated = this.db.prepare(`UPDATE browser_verify_requests
      SET state = 'EXPIRED', completed_at = ?
      WHERE request_id = ? AND state = 'PENDING_APPROVAL' AND review_deadline <= ?`)
      .run(now, requestId, now);
    return Number(updated.changes) === 1;
  }

  rejectBrowserVerifyRequest(requestId: string, now: number): boolean {
    const updated = this.db.prepare(`UPDATE browser_verify_requests
      SET state = 'REJECTED', completed_at = ?
      WHERE request_id = ? AND state = 'PENDING_APPROVAL' AND review_deadline > ?`)
      .run(now, requestId, now);
    return Number(updated.changes) === 1;
  }

  invalidateBrowserVerifyRequest(
    requestId: string,
    now: number,
    errorClass: BrowserVerifyRequestErrorClass,
  ): boolean {
    const updated = this.db.prepare(`UPDATE browser_verify_requests
      SET state = 'INVALIDATED', completed_at = ?, error_class = ?
      WHERE request_id = ? AND state = 'PENDING_APPROVAL'`)
      .run(now, errorClass, requestId);
    return Number(updated.changes) === 1;
  }

  approveBrowserVerifyRequestAndCreateJob(input: {
    requestId: string;
    now: number;
    dispatchDeadline: number;
    currentPlanSha256: string;
  }): BrowserVerifyApprovalResult | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const request = this.getBrowserVerifyRequest(input.requestId);
      if (!request || request.state !== 'PENDING_APPROVAL' || request.reviewDeadline <= input.now) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const workspace = this.getWorkspace(request.workspaceId);
      if (!workspace || !sameAuthorityTuple(request, workspace)) {
        this.db.prepare(`UPDATE browser_verify_requests
          SET state = 'INVALIDATED', completed_at = ?, error_class = ?
          WHERE request_id = ? AND state = 'PENDING_APPROVAL'`).run(
          input.now, workspace ? 'WORKSPACE_OWNERSHIP_MISMATCH' : 'WORKSPACE_MISSING', request.requestId,
        );
        this.db.exec('COMMIT');
        return undefined;
      }
      if (request.planSha256 !== input.currentPlanSha256) {
        this.db.prepare(`UPDATE browser_verify_requests
          SET state = 'INVALIDATED', completed_at = ?, error_class = 'PROFILE_PLAN_DRIFT'
          WHERE request_id = ? AND state = 'PENDING_APPROVAL'`).run(input.now, request.requestId);
        this.db.exec('COMMIT');
        return undefined;
      }

      const job = this.createVerifyJob({
        ownerId: request.ownerId, sessionId: request.sessionId, adapterId: request.adapterId,
        workspaceId: request.workspaceId, backendKind: workspace.backendKind,
        profileName: request.profileName, planSha256: request.planSha256,
        createdAt: input.now, dispatchDeadline: input.dispatchDeadline,
      });
      const updated = this.db.prepare(`UPDATE browser_verify_requests
        SET state = 'DISPATCHED', approved_at = ?, linked_job_id = ?
        WHERE request_id = ? AND state = 'PENDING_APPROVAL'`)
        .run(input.now, job.jobId, request.requestId);
      if (Number(updated.changes) !== 1) throw new Error('Browser verify approval lost atomic transition');
      const approved = this.getBrowserVerifyRequest(request.requestId)!;
      this.db.exec('COMMIT');
      return { request: approved, job };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transition(mutationId: string, fromState: MutationState, toState: MutationState, observedAt: number, apply: () => boolean): MutationRecord | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.getMutation(mutationId);
      if (!before || before.state !== fromState || !apply()) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const after = this.getMutation(mutationId)!;
      this.appendAuditEvent(after, fromState, toState, observedAt);
      this.db.exec('COMMIT');
      return after;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private appendAuditEvent(record: MutationRecord, fromState: MutationState | undefined, toState: MutationState, observedAt: number): void {
    this.db.prepare(`INSERT INTO audit_events
      (mutation_id, observed_at, from_state, to_state, fingerprint, path, additions, removals)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.mutationId, observedAt, fromState ?? null, toState,
        record.fingerprint, record.path, record.additions, record.removals);
  }
  private transitionVerifyJob(jobId: string, fromState: VerifyJobState, toState: VerifyJobState, observedAt: number, apply: () => boolean): VerifyJobRecord | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.getVerifyJob(jobId);
      if (!before || before.state !== fromState || !apply()) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const after = this.getVerifyJob(jobId)!;
      this.appendVerifyJobEvent(after, fromState, toState, observedAt);
      this.db.exec('COMMIT');
      return after;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private appendVerifyJobEvent(record: VerifyJobRecord, fromState: VerifyJobState | undefined, toState: VerifyJobState, observedAt: number): void {
    this.db.prepare(`INSERT INTO verify_job_events
      (job_id, observed_at, from_state, to_state, attempt_id, error_class)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(record.jobId, observedAt, fromState ?? null, toState,
        record.attemptId ?? null, record.errorClass ?? null);
  }
}

function principalFromRow(row: Record<string, unknown>): LocalPrincipalRecord {
  return { ownerId: String(row.owner_id), createdAt: Number(row.created_at) };
}

function adapterSessionFromRow(row: Record<string, unknown>): AdapterSessionRecord {
  return {
    sessionId: String(row.session_id),
    ownerId: String(row.owner_id),
    adapterId: String(row.adapter_id),
    correlationSha256: String(row.correlation_sha256),
    createdAt: Number(row.created_at),
  };
}
function workspaceFromRow(row: Record<string, unknown>): WorkspaceRecord {
  return {
    workspaceId: String(row.workspace_id), ownerId: String(row.owner_id),
    sessionId: String(row.session_id), adapterId: String(row.adapter_id),
    canonicalRoot: String(row.canonical_root), backendKind: String(row.backend_kind),
    createdAt: Number(row.created_at),
  };
}

function mutationFromRow(row: Record<string, unknown>): MutationRecord {
  return {
    mutationId: String(row.mutation_id), ownerId: String(row.owner_id),
    sessionId: String(row.session_id), adapterId: String(row.adapter_id),
    workspaceId: String(row.workspace_id), backendKind: String(row.backend_kind),
    path: String(row.path), baseSha256: String(row.base_sha256),
    before: String(row.before_text), after: String(row.after_text),
    resultSha256: String(row.result_sha256), fingerprint: String(row.fingerprint),
    additions: Number(row.additions), removals: Number(row.removals),
    state: String(row.state) as MutationState, createdAt: Number(row.created_at),
    reviewDeadline: Number(row.review_deadline),
    ...(row.reviewed_at === null ? {} : { reviewedAt: Number(row.reviewed_at) }),
    ...(row.execution_admission_deadline === null ? {} : { executionAdmissionDeadline: Number(row.execution_admission_deadline) }),
    ...(row.execution_started_at === null ? {} : { executionStartedAt: Number(row.execution_started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    ...(row.result_metadata === null ? {} : { resultMetadata: String(row.result_metadata) }),
    ...(row.error_class === null ? {} : { errorClass: String(row.error_class) }),
  };
}

function auditFromRow(row: Record<string, unknown>): AuditEvent {
  return {
    sequence: Number(row.sequence), mutationId: String(row.mutation_id),
    observedAt: Number(row.observed_at),
    ...(row.from_state === null ? {} : { fromState: String(row.from_state) as MutationState }),
    toState: String(row.to_state) as MutationState,
    fingerprint: String(row.fingerprint), path: String(row.path),
    additions: Number(row.additions), removals: Number(row.removals),
  };
}

function verifyJobFromRow(row: Record<string, unknown>): VerifyJobRecord {
  return {
    jobId: String(row.job_id),
    ownerId: String(row.owner_id),
    sessionId: String(row.session_id),
    adapterId: String(row.adapter_id),
    workspaceId: String(row.workspace_id),
    backendKind: String(row.backend_kind),
    profileName: String(row.profile_name),
    planSha256: String(row.plan_sha256),
    state: String(row.state) as VerifyJobState,
    createdAt: Number(row.created_at),
    dispatchDeadline: Number(row.dispatch_deadline),
    ...(row.attempt_id === null ? {} : { attemptId: String(row.attempt_id) }),
    ...(row.execution_started_at === null ? {} : { executionStartedAt: Number(row.execution_started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
    ...(row.output_text === null ? {} : { output: String(row.output_text) }),
    ...(row.output_truncated === null ? {} : { outputTruncated: Number(row.output_truncated) === 1 }),
    ...(row.error_class === null ? {} : { errorClass: String(row.error_class) as VerifyJobErrorClass }),
  };
}
function verifyJobEventFromRow(row: Record<string, unknown>): VerifyJobEvent {
  return {
    sequence: Number(row.sequence),
    jobId: String(row.job_id),
    observedAt: Number(row.observed_at),
    ...(row.from_state === null ? {} : { fromState: String(row.from_state) as VerifyJobState }),
    toState: String(row.to_state) as VerifyJobState,
    ...(row.attempt_id === null ? {} : { attemptId: String(row.attempt_id) }),
    ...(row.error_class === null ? {} : { errorClass: String(row.error_class) as VerifyJobErrorClass }),
  };
}

function browserVerifyRequestFromRow(row: Record<string, unknown>): BrowserVerifyRequestRecord {
  return {
    requestId: String(row.request_id),
    ownerId: String(row.owner_id),
    sessionId: String(row.session_id),
    adapterId: String(row.adapter_id),
    workspaceId: String(row.workspace_id),
    profileName: String(row.profile_name),
    planSha256: String(row.plan_sha256),
    fingerprint: String(row.fingerprint),
    state: String(row.state) as BrowserVerifyRequestState,
    createdAt: Number(row.created_at),
    reviewDeadline: Number(row.review_deadline),
    ...(row.approved_at === null ? {} : { approvedAt: Number(row.approved_at) }),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    ...(row.linked_job_id === null ? {} : { linkedJobId: String(row.linked_job_id) }),
    ...(row.error_class === null ? {} : {
      errorClass: String(row.error_class) as BrowserVerifyRequestErrorClass,
    }),
  };
}

function sameAuthorityTuple(
  expected: Pick<GatewayAuthority, 'ownerId' | 'sessionId' | 'adapterId'>,
  actual: Pick<GatewayAuthority, 'ownerId' | 'sessionId' | 'adapterId'>,
): boolean {
  return expected.ownerId === actual.ownerId
    && expected.sessionId === actual.sessionId
    && expected.adapterId === actual.adapterId;
}
