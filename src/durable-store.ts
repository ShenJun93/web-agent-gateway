import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { GatewayAuthority } from './caller-context.js';
import type { GitCommitChange } from './git-commit-backend.js';

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

export type CommitState =
  | 'PENDING_APPROVAL' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED'
  | 'REJECTED' | 'EXPIRED' | 'OUTCOME_UNKNOWN';

export interface CreateCommitRecord extends GatewayAuthority {
  workspaceId: string;
  backendKind: string;
  branch: string;
  oldHead: string;
  treeSha: string;
  /** `Name <email>` the commit would be attributed to, read from the untrusted repository. */
  author: string;
  /** `Name <email>` git would stamp as committer. */
  committer: string;
  /**
   * The exact repository the proposal was planned against. The worktree root alone is not
   * enough: an inherited `GIT_DIR` leaves the worktree looking right while refs, HEAD and the
   * branch all come from somewhere else.
   */
  gitDir: string;
  commonDir: string;
  /** Paths whose CRLF endings WAG normalized, exactly as git would have. */
  eolNormalized: readonly string[];
  paths: readonly string[];
  changes: readonly GitCommitChange[];
  message: string;
  messageSha256: string;
  fingerprint: string;
  createdAt: number;
  reviewDeadline: number;
}

export interface CommitRecord extends CreateCommitRecord {
  commitId: string;
  state: CommitState;
  reviewedAt?: number;
  executionStartedAt?: number;
  completedAt?: number;
  resultCommit?: string;
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

/**
 * What a proposal costs a lease's byte budget: the larger of what it removes and what it writes.
 *
 * Defined here rather than in `durable-mutation.ts` because the store is the lower layer — the
 * other direction would make the two modules import each other, which happens to work under ESM
 * while the call is deferred and is a trap waiting for someone to hoist it.
 *
 * Counting only the insertion, which is what this did first, let a proposal replacing 32 KiB of
 * content with one byte charge one byte. A budget is meant to bound impact, and deleting is
 * impact.
 */
export function affectedBytes(record: { before: string; after: string }): number {
  return Math.max(Buffer.byteLength(record.before, 'utf8'), Buffer.byteLength(record.after, 'utf8'));
}

export class SqliteDurableStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.open();
    } catch (error) {
      // Schema setup can refuse — a pre-acceptance delegation table does exactly that. Leaving the
      // handle open on the way out holds the file on Windows and leaks a connection everywhere
      // else, so the failed store closes itself rather than relying on a caller that never got one.
      try { this.db.close(); } catch { /* the throw above is the interesting one */ }
      throw error;
    }
  }

  private open(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    // Before any `CREATE TABLE`, including the ones that have nothing to do with delegation. A
    // check whose stated job is "refuse at open" should leave the file as it found it, and an
    // earlier placement handed a pre-acceptance store the tables it was missing on the way out.
    this.assertDelegationSchemaShape();
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
    // New table rather than new columns: the schema is created with CREATE TABLE IF NOT EXISTS
    // and there is no migration framework, so a table appears on existing databases for free
    // while a column would not (ADR-0022, ADR-0023).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commits (
        commit_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        branch TEXT NOT NULL,
        old_head TEXT NOT NULL,
        tree_sha TEXT NOT NULL,
        author TEXT NOT NULL,
        committer TEXT NOT NULL,
        git_dir TEXT NOT NULL,
        common_dir TEXT NOT NULL,
        eol_normalized TEXT NOT NULL,
        paths TEXT NOT NULL,
        changes TEXT NOT NULL,
        message TEXT NOT NULL,
        message_sha256 TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        review_deadline INTEGER NOT NULL,
        reviewed_at INTEGER,
        execution_started_at INTEGER,
        completed_at INTEGER,
        result_commit TEXT,
        error_class TEXT,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
      );
      CREATE INDEX IF NOT EXISTS idx_commits_state ON commits(state, created_at);
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
    // Autonomous Goal Lease v1 (ADR-0028). Two tables rather than columns on `mutations`, for the
    // reason stated above: there is no migration framework here.
    //
    // `mutation_authority` is what makes POLICY_APPROVED and HUMAN_APPROVED distinguishable after
    // the fact. A row is written at admission and never updated, so the authority under which an
    // effect happened is a durable fact rather than something inferred from which code path ran.
    // A mutation with no row was admitted by neither and cannot have executed.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_leases (
        lease_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        not_before INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        bindings TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mutation_authority (
        mutation_id TEXT PRIMARY KEY,
        authority TEXT NOT NULL,
        lease_id TEXT,
        admitted_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        result_sha256 TEXT NOT NULL,
        diff_bytes INTEGER NOT NULL,
        FOREIGN KEY(mutation_id) REFERENCES mutations(mutation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mutation_authority_lease ON mutation_authority(lease_id);
      CREATE TABLE IF NOT EXISTS commit_authority (
        commit_id TEXT PRIMARY KEY,
        authority TEXT NOT NULL,
        lease_id TEXT,
        admitted_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        old_head TEXT NOT NULL,
        path_count INTEGER NOT NULL,
        FOREIGN KEY(commit_id) REFERENCES commits(commit_id)
      );
      CREATE INDEX IF NOT EXISTS idx_commit_authority_lease ON commit_authority(lease_id);
    `);
    // Goal UI Delegation v1 (ADR-0029). New tables, for the reason above: no migration framework.
    //
    // The lifecycle is explicit in the schema rather than implied by a nullable timestamp:
    //
    //   STAGED --claim--> CLAIMED --dispatch--> DISPATCHED --result--> RESULTED
    //      |                 |
    //      |                 +--abandon (claim TTL elapsed)--> ABANDONED   [terminal]
    //      +--human run--> DISPATCHED --result--> RESULTED
    //
    // Every transition is a single-assignment `UPDATE ... WHERE state = '<previous>'` whose row
    // count must be exactly one, so two callers cannot both advance the same proposal.
    //
    //   ui_delegations          the parent grant. Immutable once inserted; only revocation and the
    //                           supersession link mutate it, and both are one-way.
    //   staged_proposals        the queued candidate, inert, carrying its own state.
    //   delegation_claims       the budget ledger. One row per *claim*, which is the documented
    //                           point at which a slot is spent. `(delegation, proposal)` is the
    //                           primary key, so duplicate delivery cannot claim twice.
    //   run_authority           one row per Run that happened. The CHECK makes it structurally
    //                           impossible for a HUMAN_RUN row to carry a delegation or a
    //                           DELEGATED_RUN row to omit one.
    //   delegated_run_refusals  one row per refused delegated attempt, with its reason code and
    //                           whether a slot had already been claimed. Bounded per delegation,
    //                           because an audit the browser can drive is a write the browser can
    //                           drive.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ui_delegations (
        delegation_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        controller_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        not_before INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        supersedes TEXT,
        superseded_by TEXT,
        bindings TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staged_proposals (
        proposal_id TEXT PRIMARY KEY,
        delegation_id TEXT,
        tool TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        arguments TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        staged_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        claimed_at INTEGER,
        dispatched_at INTEGER,
        resulted_at INTEGER,
        abandoned_at INTEGER,
        FOREIGN KEY(delegation_id) REFERENCES ui_delegations(delegation_id),
        CHECK (state IN ('STAGED', 'CLAIMED', 'DISPATCHED', 'RESULTED', 'ABANDONED'))
      );
      CREATE TABLE IF NOT EXISTS delegation_claims (
        delegation_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY (delegation_id, proposal_id),
        FOREIGN KEY(delegation_id) REFERENCES ui_delegations(delegation_id),
        FOREIGN KEY(proposal_id) REFERENCES staged_proposals(proposal_id)
      );
      CREATE TABLE IF NOT EXISTS run_authority (
        proposal_id TEXT PRIMARY KEY,
        authority TEXT NOT NULL,
        goal_id TEXT,
        delegation_id TEXT,
        controller_id TEXT,
        dispatched_at INTEGER NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        tool TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        result_id TEXT,
        FOREIGN KEY(proposal_id) REFERENCES staged_proposals(proposal_id),
        CHECK (
          (authority = 'DELEGATED_RUN'
            AND delegation_id IS NOT NULL AND goal_id IS NOT NULL AND controller_id IS NOT NULL)
          OR
          (authority = 'HUMAN_RUN'
            AND delegation_id IS NULL AND goal_id IS NULL AND controller_id IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS delegated_run_refusals (
        refusal_id INTEGER PRIMARY KEY AUTOINCREMENT,
        authority TEXT NOT NULL,
        requested_delegation_id TEXT,
        requested_proposal_id TEXT,
        goal_id TEXT,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        refused_at INTEGER NOT NULL,
        reason_code TEXT NOT NULL,
        slot_claimed INTEGER NOT NULL,
        CHECK (authority = 'DELEGATED_RUN_REFUSED'),
        CHECK (slot_claimed IN (0, 1))
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_staged_proposals_delegation ON staged_proposals(delegation_id);
      CREATE INDEX IF NOT EXISTS idx_staged_proposals_state ON staged_proposals(state, claimed_at);
      CREATE INDEX IF NOT EXISTS idx_run_authority_delegation ON run_authority(delegation_id);
      CREATE INDEX IF NOT EXISTS idx_refusals_delegation
        ON delegated_run_refusals(requested_delegation_id, refused_at);
      CREATE INDEX IF NOT EXISTS idx_refusals_session
        ON delegated_run_refusals(session_id, adapter_id, refused_at);
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

  /**
   * Every admitted session for one adapter, newest first.
   *
   * For the local controller's tooling only, and it exists because of a bootstrap problem: a
   * delegation binds a `sessionId`, and a session id is minted by WAG when the extension connects.
   * So a human issuing a delegation has to be able to *find out* which session to bind it to, and
   * the alternative — reading it out of a log, or off a screen — is how people bind the wrong one.
   *
   * Adding it to the store widens nothing on the browser path. The dispatch port is built by
   * enumerating the names it may carry, not by removing the ones it may not, so a method added here
   * is absent there until someone deliberately lists it.
   */
  listAdapterSessions(adapterId: string): readonly AdapterSessionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM adapter_sessions WHERE adapter_id = ? ORDER BY created_at DESC',
    ).all(adapterId) as Record<string, unknown>[];
    return rows.map(adapterSessionFromRow);
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

  /**
   * Open workspaces for one principal, newest first. For the local controller's tooling.
   *
   * Same reasoning as `listAdapterSessions`: a delegation binds exactly one `workspaceId`, and a
   * human who has to transcribe that id from a screen will eventually bind the wrong one — which
   * would be a delegation that silently authorises work in a directory nobody meant.
   */
  listWorkspacesForOwner(ownerId: string): readonly WorkspaceRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM workspaces WHERE owner_id = ? ORDER BY created_at DESC',
    ).all(ownerId) as Record<string, unknown>[];
    return rows.map(workspaceFromRow);
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
    const record = this.getMutation(mutationId);
    return this.transition(mutationId, 'PENDING_APPROVAL', 'QUEUED', now, () => {
      const result = this.db.prepare(`UPDATE mutations
        SET state = 'QUEUED', reviewed_at = ?, execution_admission_deadline = ?
        WHERE mutation_id = ? AND state = 'PENDING_APPROVAL' AND review_deadline > ?`)
        .run(now, now + admissionTtlMs, mutationId, now);
      if (Number(result.changes) !== 1) return false;
      // Inside `apply`, which runs inside the transition's BEGIN IMMEDIATE — not after it.
      // Written after the commit, as this was first, a crash in between left a QUEUED record
      // with no authority row that `reconcile()` would then execute, and a throwing INSERT made
      // the operator's approval report failure on a transition that had durably succeeded. Both
      // are gone: the insert is now inside the same transaction and a failure rolls the whole
      // admission back.
      //
      // Recorded here rather than at the call site so the two admission paths are symmetric and
      // neither can forget. Without it, "no authority row" would mean both "admitted by a human"
      // and "never admitted", and the audit could not tell POLICY from HUMAN by absence.
      if (record) {
        this.recordMutationAuthority({
          mutationId,
          authority: 'HUMAN_APPROVED',
          admittedAt: now,
          fingerprint: record.fingerprint,
          workspaceId: record.workspaceId,
          path: record.path,
          resultSha256: record.resultSha256,
          diffBytes: affectedBytes(record),
        });
      }
      return true;
    });
  }

  /**
   * The policy-admission transition. Deliberately a *separate method* from `approveMutation`.
   *
   * It performs the identical CAS — same states, same `review_deadline > now` condition — and
   * then writes the authority row in the same transaction, so a record can never reach QUEUED
   * under a lease without a durable statement of which lease admitted it. Sharing the CAS with
   * `approveMutation` by adding a parameter was the alternative; keeping them apart means the
   * human path cannot acquire a lease argument by accident, and a reader can see at the call site
   * which authority is in play.
   */
  policyAdmitMutation(input: {
    mutationId: string;
    leaseId: string;
    now: number;
    admissionTtlMs: number;
  }): MutationRecord | undefined {
    const record = this.getMutation(input.mutationId);
    if (!record) return undefined;
    return this.transition(input.mutationId, 'PENDING_APPROVAL', 'QUEUED', input.now, () => {
      const result = this.db.prepare(`UPDATE mutations
        SET state = 'QUEUED', reviewed_at = ?, execution_admission_deadline = ?
        WHERE mutation_id = ? AND state = 'PENDING_APPROVAL' AND review_deadline > ?`)
        .run(input.now, input.now + input.admissionTtlMs, input.mutationId, input.now);
      if (Number(result.changes) !== 1) return false;
      // In the transaction, for the reason given on the human path above. Here the crash window
      // additionally refunded the file and its bytes to the lease budget, because spend is
      // counted from these rows.
      this.recordMutationAuthority({
        mutationId: input.mutationId,
        authority: 'POLICY_APPROVED',
        leaseId: input.leaseId,
        admittedAt: input.now,
        fingerprint: record.fingerprint,
        workspaceId: record.workspaceId,
        path: record.path,
        resultSha256: record.resultSha256,
        diffBytes: affectedBytes(record),
      });
      return true;
    });
  }

  /**
   * Written once, never updated. `INSERT OR IGNORE` so a retry cannot rewrite the authority of a
   * record that already has one — an admission's provenance is not a mutable field.
   */
  recordMutationAuthority(input: {
    mutationId: string;
    authority: 'HUMAN_APPROVED' | 'POLICY_APPROVED';
    leaseId?: string;
    admittedAt: number;
    fingerprint: string;
    workspaceId: string;
    path: string;
    resultSha256: string;
    diffBytes: number;
  }): void {
    this.db.prepare(`INSERT OR IGNORE INTO mutation_authority
      (mutation_id, authority, lease_id, admitted_at, fingerprint, workspace_id, path, result_sha256, diff_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.mutationId, input.authority, input.leaseId ?? null, input.admittedAt,
        input.fingerprint, input.workspaceId, input.path, input.resultSha256, input.diffBytes);
  }

  getMutationAuthority(mutationId: string): {
    authority: 'HUMAN_APPROVED' | 'POLICY_APPROVED';
    leaseId?: string;
    admittedAt: number;
    fingerprint: string;
    path: string;
    resultSha256: string;
    diffBytes: number;
  } | undefined {
    const row = this.db.prepare('SELECT * FROM mutation_authority WHERE mutation_id = ?').get(mutationId) as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      authority: row.authority as 'HUMAN_APPROVED' | 'POLICY_APPROVED',
      ...(row.lease_id === null ? {} : { leaseId: String(row.lease_id) }),
      admittedAt: Number(row.admitted_at),
      fingerprint: String(row.fingerprint),
      path: String(row.path),
      resultSha256: String(row.result_sha256),
      diffBytes: Number(row.diff_bytes),
    };
  }

  /**
   * The commit twin of `recordMutationAuthority`.
   *
   * Commits live in their own table, so `mutation_authority`'s foreign key could not carry them
   * and a policy-admitted commit was, in the durable record, byte-identical to one the operator
   * approved. A review found that: the audit claim held for mutations and silently did not hold
   * for the more consequential record kind.
   */
  recordCommitAuthority(input: {
    commitId: string;
    authority: 'HUMAN_APPROVED' | 'POLICY_APPROVED';
    leaseId?: string;
    admittedAt: number;
    fingerprint: string;
    workspaceId: string;
    branch: string;
    oldHead: string;
    pathCount: number;
  }): void {
    this.db.prepare(`INSERT OR IGNORE INTO commit_authority
      (commit_id, authority, lease_id, admitted_at, fingerprint, workspace_id, branch, old_head, path_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.commitId, input.authority, input.leaseId ?? null, input.admittedAt,
        input.fingerprint, input.workspaceId, input.branch, input.oldHead, input.pathCount);
  }

  getCommitAuthority(commitId: string): {
    authority: 'HUMAN_APPROVED' | 'POLICY_APPROVED';
    leaseId?: string;
    admittedAt: number;
    branch: string;
    pathCount: number;
  } | undefined {
    const row = this.db.prepare('SELECT * FROM commit_authority WHERE commit_id = ?').get(commitId) as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      authority: row.authority as 'HUMAN_APPROVED' | 'POLICY_APPROVED',
      ...(row.lease_id === null ? {} : { leaseId: String(row.lease_id) }),
      admittedAt: Number(row.admitted_at),
      branch: String(row.branch),
      pathCount: Number(row.path_count),
    };
  }

  /**
   * Refuse to run against a store whose delegation tables predate this schema.
   *
   * `CREATE TABLE IF NOT EXISTS` is silent about a table that exists with the wrong shape, and
   * this branch changed these tables twice before acceptance. A store created at either earlier
   * revision would keep its old columns and then fail deep inside an insert, or — worse — read as
   * working while a column nothing populates silently governs a decision. Checked at open, where
   * the answer is unambiguous and the fix is to discard a pre-acceptance store.
   */
  private assertDelegationSchemaShape(): void {
    const required: Record<string, { columns: readonly string[]; constraints: readonly string[] }> = {
      ui_delegations: { columns: ['supersedes', 'superseded_by'], constraints: ['PRIMARY KEY'] },
      staged_proposals: {
        columns: ['state', 'claimed_at', 'dispatched_at', 'resulted_at', 'abandoned_at'],
        constraints: ["CHECK (state IN ('STAGED', 'CLAIMED', 'DISPATCHED', 'RESULTED', 'ABANDONED'))"],
      },
      delegation_claims: {
        columns: ['claimed_at', 'fingerprint'],
        constraints: ['PRIMARY KEY (delegation_id, proposal_id)'],
      },
      run_authority: {
        columns: ['authority', 'result_id'],
        constraints: ["authority = 'DELEGATED_RUN'", "authority = 'HUMAN_RUN'", 'CHECK'],
      },
      delegated_run_refusals: {
        columns: ['reason_code', 'slot_claimed'],
        constraints: ["CHECK (authority = 'DELEGATED_RUN_REFUSED')"],
      },
    };

    for (const [table, expected] of Object.entries(required)) {
      // A table this process has not created yet is not a wrong table. Checked before the CREATEs
      // so that refusing an old store does not first hand it four new tables — a review pointed
      // out that a check whose job is "refuse at open" was leaving the file changed.
      const ddl = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table) as { sql?: string } | undefined;
      if (!ddl?.sql) continue;

      const present = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((row) => String(row.name)));
      const missingColumns = expected.columns.filter((column) => !present.has(column));
      if (missingColumns.length > 0) {
        throw new Error(
          `Durable store has a pre-acceptance ${table} table (missing ${missingColumns.join(', ')}). `
          + 'Delegation tables changed before acceptance and there is no migration framework: '
          + 'discard the pre-acceptance store rather than running against it.',
        );
      }

      // Column names alone were not enough. A review built a store with every required column and
      // no CHECK, no PRIMARY KEY and no FOREIGN KEY, opened it without complaint, and then wrote a
      // HUMAN_RUN row carrying a delegation id — the very thing ADR-0029 calls structurally
      // impossible. SQLite keeps the original DDL text, so the constraints can be checked too.
      const missingConstraints = expected.constraints.filter((needle) => !ddl.sql?.includes(needle));
      if (missingConstraints.length > 0) {
        throw new Error(
          `Durable store has a ${table} table without the constraints this schema relies on `
          + `(missing ${missingConstraints.join('; ')}). The constraints are what make the audit `
          + 'distinction and the claim ledger hold, so a table lacking them is refused rather than '
          + 'trusted. Discard the store rather than running against it.',
        );
      }
    }
  }

  insertUiDelegation(record: {
    delegationId: string; goalId: string; controllerId: string;
    createdAt: number; notBefore: number; expiresAt: number; bindings: string; supersedes?: string;
  }): void {
    this.db.prepare(`INSERT INTO ui_delegations
      (delegation_id, goal_id, controller_id, created_at, not_before, expires_at, bindings, supersedes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.delegationId, record.goalId, record.controllerId,
        record.createdAt, record.notBefore, record.expiresAt, record.bindings,
        record.supersedes ?? null);
  }

  getUiDelegationRow(delegationId: string): {
    delegationId: string; goalId: string; controllerId: string;
    createdAt: number; notBefore: number; expiresAt: number; revokedAt?: number;
    supersedes?: string; supersededBy?: string; bindings: string;
  } | undefined {
    const row = this.db.prepare('SELECT * FROM ui_delegations WHERE delegation_id = ?').get(delegationId) as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      delegationId: String(row.delegation_id),
      goalId: String(row.goal_id),
      controllerId: String(row.controller_id),
      createdAt: Number(row.created_at),
      notBefore: Number(row.not_before),
      expiresAt: Number(row.expires_at),
      ...(row.revoked_at === null ? {} : { revokedAt: Number(row.revoked_at) }),
      ...(row.supersedes === null ? {} : { supersedes: String(row.supersedes) }),
      ...(row.superseded_by === null ? {} : { supersededBy: String(row.superseded_by) }),
      bindings: String(row.bindings),
    };
  }

  /**
   * Delegations for a goal that are still capable of authorising anything.
   *
   * Live means un-revoked, un-superseded and inside its window. Expiry counts as dead: a window
   * that has closed authorises nothing, so refusing to issue alongside one would be refusing to
   * replace a corpse.
   */
  countLiveDelegationsForGoal(goalId: string, now: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM ui_delegations
       WHERE goal_id = ? AND revoked_at IS NULL AND superseded_by IS NULL
         AND not_before <= ? AND expires_at > ?`,
    ).get(goalId, now, now) as { n: number };
    return Number(row.n);
  }

  /** One-way, and idempotent. A revoked delegation is never un-revoked. */
  revokeUiDelegation(delegationId: string, now: number): boolean {
    const result = this.db.prepare(
      'UPDATE ui_delegations SET revoked_at = ? WHERE delegation_id = ? AND revoked_at IS NULL',
    ).run(now, delegationId);
    return Number(result.changes) === 1;
  }

  /**
   * Replace a delegation with a successor, atomically.
   *
   * Three separate statements were wrong here, and an adversarial review found why: a crash
   * between linking the successor and revoking the predecessor left **two live delegations for
   * one goal, each with a full budget**. The comment at the time called that "losing authority is
   * the safe direction", which described the other branch. Authority was being doubled.
   *
   * In one transaction there is no such branch. Either the goal has exactly one live delegation
   * or it has the old one, and never both.
   */
  renewUiDelegation(input: {
    predecessorId: string;
    successor: {
      delegationId: string; goalId: string; controllerId: string;
      createdAt: number; notBefore: number; expiresAt: number; bindings: string;
    };
    now: number;
  }): { ok: true } | { ok: false; code: string; detail: string } {
    const refuse = (code: string, detail: string) => {
      this.db.exec('ROLLBACK');
      return { ok: false as const, code, detail };
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(
        'SELECT controller_id, goal_id, revoked_at, superseded_by FROM ui_delegations WHERE delegation_id = ?',
      ).get(input.predecessorId) as Record<string, unknown> | undefined;
      if (!existing) return refuse('NO_DELEGATION', 'there is no such delegation to renew');
      if (existing.revoked_at !== null) {
        // A revoked delegation is finished. Renewing one would turn a deliberate stop into a
        // fresh full budget, which is the opposite of what revocation is for.
        return refuse('DELEGATION_REVOKED', 'a revoked delegation cannot be renewed');
      }
      if (existing.superseded_by !== null) {
        return refuse('DELEGATION_SUPERSEDED', 'this delegation was already superseded');
      }
      if (String(existing.controller_id) !== input.successor.controllerId) {
        return refuse('CONTROLLER_MISMATCH', 'another controller may not renew this delegation');
      }
      if (String(existing.goal_id) !== input.successor.goalId) {
        return refuse('GOAL_MISMATCH', 'a renewal must stay within the goal it renews');
      }

      this.db.prepare(`INSERT INTO ui_delegations
        (delegation_id, goal_id, controller_id, created_at, not_before, expires_at, bindings, supersedes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.successor.delegationId, input.successor.goalId, input.successor.controllerId,
          input.successor.createdAt, input.successor.notBefore, input.successor.expiresAt,
          input.successor.bindings, input.predecessorId);
      const linked = this.db.prepare(
        'UPDATE ui_delegations SET superseded_by = ? WHERE delegation_id = ? AND superseded_by IS NULL',
      ).run(input.successor.delegationId, input.predecessorId);
      if (Number(linked.changes) !== 1) {
        return refuse('DELEGATION_SUPERSEDED', 'the predecessor was superseded concurrently');
      }
      this.db.prepare(
        'UPDATE ui_delegations SET revoked_at = ? WHERE delegation_id = ? AND revoked_at IS NULL',
      ).run(input.now, input.predecessorId);

      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  insertStagedProposal(record: {
    proposalId: string; delegationId?: string; tool: string; workspaceId: string; origin: string;
    argumentsJson: string; sessionId: string; adapterId: string; stagedAt: number; fingerprint: string;
  }): void {
    this.db.prepare(`INSERT INTO staged_proposals
      (proposal_id, delegation_id, tool, workspace_id, origin, arguments,
       session_id, adapter_id, staged_at, fingerprint, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STAGED')`)
      .run(record.proposalId, record.delegationId ?? null, record.tool, record.workspaceId,
        record.origin, record.argumentsJson, record.sessionId, record.adapterId,
        record.stagedAt, record.fingerprint);
  }

  getStagedProposalRow(proposalId: string): {
    proposalId: string; delegationId?: string; tool: string; workspaceId: string; origin: string;
    argumentsJson: string; sessionId: string; adapterId: string; stagedAt: number;
    fingerprint: string; state: string;
    claimedAt?: number; dispatchedAt?: number; resultedAt?: number; abandonedAt?: number;
  } | undefined {
    const row = this.db.prepare('SELECT * FROM staged_proposals WHERE proposal_id = ?').get(proposalId) as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      proposalId: String(row.proposal_id),
      ...(row.delegation_id === null ? {} : { delegationId: String(row.delegation_id) }),
      tool: String(row.tool),
      workspaceId: String(row.workspace_id),
      origin: String(row.origin),
      argumentsJson: String(row.arguments),
      sessionId: String(row.session_id),
      adapterId: String(row.adapter_id),
      stagedAt: Number(row.staged_at),
      fingerprint: String(row.fingerprint),
      state: String(row.state),
      ...(row.claimed_at === null ? {} : { claimedAt: Number(row.claimed_at) }),
      ...(row.dispatched_at === null ? {} : { dispatchedAt: Number(row.dispatched_at) }),
      ...(row.resulted_at === null ? {} : { resultedAt: Number(row.resulted_at) }),
      ...(row.abandoned_at === null ? {} : { abandonedAt: Number(row.abandoned_at) }),
    };
  }

  /** Proposals staged under a delegation, in any state. Bounds how much it can queue. */
  countStagedProposals(delegationId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM staged_proposals WHERE delegation_id = ?')
      .get(delegationId) as { n: number };
    return Number(row.n);
  }

  /** Proposals this browser context is holding that have not yet left `STAGED`. */
  countOpenStagedProposals(sessionId: string, adapterId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM staged_proposals
       WHERE session_id = ? AND adapter_id = ? AND state = 'STAGED'`,
    ).get(sessionId, adapterId) as { n: number };
    return Number(row.n);
  }

  /** Every row this browser context has ever staged, whatever became of it. */
  countAllStagedProposals(sessionId: string, adapterId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM staged_proposals WHERE session_id = ? AND adapter_id = ?',
    ).get(sessionId, adapterId) as { n: number };
    return Number(row.n);
  }

  /** Slots this parent delegation has spent. A claim spends one; a dispatch spends none. */
  countDelegationClaims(delegationId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM delegation_claims WHERE delegation_id = ?')
      .get(delegationId) as { n: number };
    return Number(row.n);
  }

  /**
   * Claim one action slot: `STAGED -> CLAIMED`, atomically, or change nothing at all.
   *
   * This is the transaction the whole design rests on, so it re-reads every time-varying fact
   * *inside* the write lock rather than trusting what the policy saw a moment ago. The policy
   * still runs first — it produces the informative refusal — but this layer is what remains true
   * when two processes race, when delivery is duplicated, and when the process died between the
   * decision and the effect.
   *
   * What it re-reads: revocation, supersession, the validity window **and its ceiling**, the
   * proposal's state, the proposal's delegation, its fingerprint, and the slot count. What it does
   * **not** re-read: session, adapter, tool, origin and workspace, which the policy checks and
   * this does not. Anything that calls this without the policy in front of it gets none of those,
   * which is why nothing does.
   *
   * `goalId` and `controllerId` are read from the delegation row, never passed in. A caller cannot
   * label a claim with a goal that did not authorise it.
   */
  claimDelegatedDispatch(input: {
    delegationId: string; proposalId: string; now: number; expectedFingerprint: string;
    maxWindowMs: number;
  }): { ok: true; goalId: string; controllerId: string } | { ok: false; code: string; detail: string } {
    const refuse = (code: string, detail: string) => {
      this.db.exec('ROLLBACK');
      return { ok: false as const, code, detail };
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const delegation = this.db.prepare(
        `SELECT goal_id, controller_id, not_before, expires_at, revoked_at, superseded_by, bindings
         FROM ui_delegations WHERE delegation_id = ?`,
      ).get(input.delegationId) as Record<string, unknown> | undefined;
      if (!delegation) return refuse('NO_DELEGATION', 'the delegation no longer exists');
      if (delegation.revoked_at !== null) {
        return refuse('DELEGATION_REVOKED', 'the delegation was revoked before this claim');
      }
      if (delegation.superseded_by !== null) {
        return refuse('DELEGATION_SUPERSEDED', 'the delegation was superseded before this claim');
      }
      const notBefore = Number(delegation.not_before);
      const expiresAt = Number(delegation.expires_at);
      if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || expiresAt <= notBefore) {
        return refuse('DELEGATION_MALFORMED', 'the stored validity window is not a window');
      }
      if (expiresAt - notBefore > input.maxWindowMs) {
        // Re-checked here as well as at the policy, because a row inserted by anything other than
        // the control plane never passed the control plane's ceiling check.
        return refuse('DELEGATION_MALFORMED', 'the stored window exceeds the ceiling');
      }
      if (!(input.now >= notBefore)) return refuse('DELEGATION_NOT_YET_VALID', 'not yet valid');
      if (!(input.now < expiresAt)) return refuse('DELEGATION_EXPIRED', 'expired before this claim');

      let maxActions: unknown;
      try { maxActions = (JSON.parse(String(delegation.bindings)) as { maxActions?: unknown }).maxActions; }
      catch { return refuse('DELEGATION_MALFORMED', 'the stored bindings are not JSON'); }
      if (!Number.isInteger(maxActions) || (maxActions as number) <= 0) {
        return refuse('DELEGATION_MALFORMED', 'maxActions is not a positive integer');
      }

      const proposal = this.db.prepare(
        `SELECT delegation_id, state, fingerprint FROM staged_proposals WHERE proposal_id = ?`,
      ).get(input.proposalId) as Record<string, unknown> | undefined;
      if (!proposal) return refuse('NO_PROPOSAL', 'there is no staged proposal with that id');
      if (proposal.delegation_id === null || String(proposal.delegation_id) !== input.delegationId) {
        return refuse('PROPOSAL_NOT_FOR_THIS_DELEGATION', 'staged under another delegation');
      }
      if (String(proposal.state) !== 'STAGED') {
        return refuse('PROPOSAL_NOT_STAGED', `the proposal is ${String(proposal.state)}`);
      }
      if (String(proposal.fingerprint) !== input.expectedFingerprint) {
        return refuse('PROPOSAL_INCONSISTENT', 'the staged identity changed since it was judged');
      }

      const used = this.db.prepare('SELECT COUNT(*) AS n FROM delegation_claims WHERE delegation_id = ?')
        .get(input.delegationId) as { n: number };
      if (Number(used.n) + 1 > (maxActions as number)) {
        return refuse('ACTION_LIMIT_REACHED', `the delegation has already claimed ${Number(used.n)} actions`);
      }

      const claimed = this.db.prepare(
        `UPDATE staged_proposals SET state = 'CLAIMED', claimed_at = ?
         WHERE proposal_id = ? AND state = 'STAGED'`,
      ).run(input.now, input.proposalId);
      if (Number(claimed.changes) !== 1) {
        return refuse('PROPOSAL_NOT_STAGED', 'another claim took this proposal first');
      }
      this.db.prepare(`INSERT INTO delegation_claims
        (delegation_id, proposal_id, claimed_at, fingerprint) VALUES (?, ?, ?, ?)`)
        .run(input.delegationId, input.proposalId, input.now, input.expectedFingerprint);

      this.db.exec('COMMIT');
      return { ok: true, goalId: String(delegation.goal_id), controllerId: String(delegation.controller_id) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * `CLAIMED -> DISPATCHED`, and write the audit row that says a delegated Run happened.
   *
   * Separate from the claim on purpose. The claim spends the budget; this records the handoff.
   * A crash between them leaves a CLAIMED row that `abandonExpiredClaims` retires — the slot stays
   * spent and the proposal is never run — which is the only honest resolution, because WAG cannot
   * know whether a dispatch that was in flight reached anything.
   */
  markDelegatedDispatched(input: { proposalId: string; now: number }):
  { ok: true } | { ok: false; code: string; detail: string } {
    const refuse = (code: string, detail: string) => {
      this.db.exec('ROLLBACK');
      return { ok: false as const, code, detail };
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const proposal = this.db.prepare(
        `SELECT delegation_id, state, tool, workspace_id, origin, session_id, adapter_id, fingerprint
         FROM staged_proposals WHERE proposal_id = ?`,
      ).get(input.proposalId) as Record<string, unknown> | undefined;
      if (!proposal) return refuse('NO_PROPOSAL', 'there is no staged proposal with that id');
      if (String(proposal.state) !== 'CLAIMED') {
        return refuse('PROPOSAL_NOT_CLAIMED', `the proposal is ${String(proposal.state)}, not CLAIMED`);
      }
      const delegationId = proposal.delegation_id === null ? undefined : String(proposal.delegation_id);
      if (delegationId === undefined) {
        return refuse('PROPOSAL_NOT_FOR_THIS_DELEGATION', 'a claimed proposal must name its delegation');
      }
      const delegation = this.db.prepare(
        'SELECT goal_id, controller_id FROM ui_delegations WHERE delegation_id = ?',
      ).get(delegationId) as Record<string, unknown> | undefined;
      if (!delegation) return refuse('NO_DELEGATION', 'the delegation vanished between claim and dispatch');

      const advanced = this.db.prepare(
        `UPDATE staged_proposals SET state = 'DISPATCHED', dispatched_at = ?
         WHERE proposal_id = ? AND state = 'CLAIMED'`,
      ).run(input.now, input.proposalId);
      if (Number(advanced.changes) !== 1) {
        return refuse('PROPOSAL_NOT_CLAIMED', 'the proposal left CLAIMED concurrently');
      }
      this.db.prepare(`INSERT INTO run_authority
        (proposal_id, authority, goal_id, delegation_id, controller_id, dispatched_at,
         proposal_fingerprint, tool, workspace_id, session_id, adapter_id, origin)
        VALUES (?, 'DELEGATED_RUN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.proposalId, String(delegation.goal_id), delegationId,
          String(delegation.controller_id), input.now, String(proposal.fingerprint),
          String(proposal.tool), String(proposal.workspace_id), String(proposal.session_id),
          String(proposal.adapter_id), String(proposal.origin));

      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Record a Run that no delegation authorised — `STAGED -> DISPATCHED` on the human path.
   *
   * `HUMAN_RUN` is an honest name for what WAG can establish: not "a person was present" — the
   * gateway cannot see the click — but "nothing delegated this". The CHECK constraint keeps the
   * two apart in the schema, so this row can never acquire a delegation id later.
   *
   * A proposal staged **under** a delegation is refused here. An adversarial review found that
   * allowing it let the browser-reachable plane run delegated work while spending no slot and
   * writing an audit row saying no delegation authorised it — true of the row, false of the work.
   */
  recordHumanRun(input: { proposalId: string; now: number }):
  { ok: true } | { ok: false; code: string; detail: string } {
    const refuse = (code: string, detail: string) => {
      this.db.exec('ROLLBACK');
      return { ok: false as const, code, detail };
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const proposal = this.db.prepare(
        `SELECT delegation_id, state, tool, workspace_id, origin, session_id, adapter_id, fingerprint
         FROM staged_proposals WHERE proposal_id = ?`,
      ).get(input.proposalId) as Record<string, unknown> | undefined;
      if (!proposal) return refuse('NO_PROPOSAL', 'there is no staged proposal with that id');
      if (proposal.delegation_id !== null) {
        return refuse(
          'PROPOSAL_IS_DELEGATED',
          'a proposal staged under a delegation is run through the delegated path or not at all',
        );
      }
      if (String(proposal.state) !== 'STAGED') {
        return refuse('PROPOSAL_NOT_STAGED', `the proposal is ${String(proposal.state)}, not STAGED`);
      }
      const advanced = this.db.prepare(
        `UPDATE staged_proposals SET state = 'DISPATCHED', dispatched_at = ?
         WHERE proposal_id = ? AND state = 'STAGED'`,
      ).run(input.now, input.proposalId);
      if (Number(advanced.changes) !== 1) {
        return refuse('PROPOSAL_NOT_STAGED', 'another dispatch claimed this proposal first');
      }
      this.db.prepare(`INSERT INTO run_authority
        (proposal_id, authority, dispatched_at, proposal_fingerprint, tool, workspace_id,
         session_id, adapter_id, origin)
        VALUES (?, 'HUMAN_RUN', ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.proposalId, input.now, String(proposal.fingerprint), String(proposal.tool),
          String(proposal.workspace_id), String(proposal.session_id), String(proposal.adapter_id),
          String(proposal.origin));
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Record a refused delegated attempt, durably and distinguishably.
   *
   * Bounded per delegation and per browser context, because this is an audit the browser can
   * drive: without a bound, "record every refusal" would itself be the unbounded write the rest
   * of this design refuses to grant. Oldest rows are pruned in the same transaction, so the cap
   * holds without a sweeper.
   *
   * `slotClaimed` is the fact that matters when reading this back: a refusal before the claim
   * consumed nothing, and one after it consumed a slot that will not be returned.
   */
  recordDelegatedRunRefusal(input: {
    requestedDelegationId?: string; requestedProposalId?: string; goalId?: string;
    sessionId: string; adapterId: string; refusedAt: number; reasonCode: string;
    slotClaimed: boolean; maxRowsPerScope: number;
  }): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO delegated_run_refusals
        (authority, requested_delegation_id, requested_proposal_id, goal_id,
         session_id, adapter_id, refused_at, reason_code, slot_claimed)
        VALUES ('DELEGATED_RUN_REFUSED', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.requestedDelegationId ?? null, input.requestedProposalId ?? null,
          input.goalId ?? null, input.sessionId, input.adapterId, input.refusedAt,
          input.reasonCode, input.slotClaimed ? 1 : 0);
      // Prune by browser context, which is the scope the browser actually controls. A delegation
      // id can be anything the caller asked for, so bounding on it alone would not bound anything.
      this.db.prepare(
        `DELETE FROM delegated_run_refusals WHERE refusal_id IN (
           SELECT refusal_id FROM delegated_run_refusals
           WHERE session_id = ? AND adapter_id = ?
           ORDER BY refused_at DESC, refusal_id DESC
           LIMIT -1 OFFSET ?
         )`,
      ).run(input.sessionId, input.adapterId, input.maxRowsPerScope);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Retire claims that never reached a dispatch — `CLAIMED -> ABANDONED`, terminal.
   *
   * **Not yet wired.** Nothing in `src/` calls this: no module constructs the dispatch plane, so
   * there is no runtime to call it from. A review caught the previous comment asserting "called at
   * startup and periodically", which was a description of the intended wiring written as fact. It
   * belongs in the runtime that wires the plane, which is the next milestone.
   *
   * It deliberately does **not** release the slot and
   * deliberately does **not** re-dispatch: WAG cannot know whether the dispatch that followed the
   * claim reached anything, so the only safe reading of a crash is "this one is spent and over".
   * Resurrecting it would be the silent double-run this state machine exists to prevent.
   */
  abandonExpiredClaims(now: number, claimTtlMs: number): number {
    const result = this.db.prepare(
      `UPDATE staged_proposals SET state = 'ABANDONED', abandoned_at = ?
       WHERE state = 'CLAIMED' AND claimed_at <= ?`,
    ).run(now, now - claimTtlMs);
    return Number(result.changes);
  }

  /** `DISPATCHED -> RESULTED`. Attaches the canonical result id once, and only once. */
  attachRunResult(proposalId: string, resultId: string, now: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.db.prepare(
        'UPDATE run_authority SET result_id = ? WHERE proposal_id = ? AND result_id IS NULL',
      ).run(resultId, proposalId);
      if (Number(updated.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare(
        `UPDATE staged_proposals SET state = 'RESULTED', resulted_at = ?
         WHERE proposal_id = ? AND state = 'DISPATCHED'`,
      ).run(now, proposalId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getRunAuthority(proposalId: string): {
    authority: 'HUMAN_RUN' | 'DELEGATED_RUN';
    goalId?: string; delegationId?: string; controllerId?: string;
    dispatchedAt: number; proposalFingerprint: string; tool: string; workspaceId: string;
    sessionId: string; adapterId: string; origin: string; resultId?: string;
  } | undefined {
    const row = this.db.prepare('SELECT * FROM run_authority WHERE proposal_id = ?').get(proposalId) as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      authority: row.authority as 'HUMAN_RUN' | 'DELEGATED_RUN',
      ...(row.goal_id === null ? {} : { goalId: String(row.goal_id) }),
      ...(row.delegation_id === null ? {} : { delegationId: String(row.delegation_id) }),
      ...(row.controller_id === null ? {} : { controllerId: String(row.controller_id) }),
      dispatchedAt: Number(row.dispatched_at),
      proposalFingerprint: String(row.proposal_fingerprint),
      tool: String(row.tool),
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      adapterId: String(row.adapter_id),
      origin: String(row.origin),
      ...(row.result_id === null ? {} : { resultId: String(row.result_id) }),
    };
  }

  listDelegationClaims(delegationId: string): Array<{ proposalId: string; claimedAt: number }> {
    return (this.db.prepare(
      `SELECT proposal_id, claimed_at FROM delegation_claims
       WHERE delegation_id = ? ORDER BY claimed_at, proposal_id`,
    ).all(delegationId) as Array<{ proposal_id: string; claimed_at: number }>)
      .map((r) => ({ proposalId: r.proposal_id, claimedAt: Number(r.claimed_at) }));
  }

  listDelegatedRunRefusals(input: { sessionId: string; adapterId: string }): Array<{
    authority: 'DELEGATED_RUN_REFUSED'; requestedDelegationId?: string; requestedProposalId?: string;
    goalId?: string; refusedAt: number; reasonCode: string; slotClaimed: boolean;
  }> {
    return (this.db.prepare(
      `SELECT * FROM delegated_run_refusals WHERE session_id = ? AND adapter_id = ?
       ORDER BY refused_at, refusal_id`,
    ).all(input.sessionId, input.adapterId) as Array<Record<string, unknown>>)
      .map((row) => ({
        authority: 'DELEGATED_RUN_REFUSED' as const,
        ...(row.requested_delegation_id === null
          ? {} : { requestedDelegationId: String(row.requested_delegation_id) }),
        ...(row.requested_proposal_id === null
          ? {} : { requestedProposalId: String(row.requested_proposal_id) }),
        ...(row.goal_id === null ? {} : { goalId: String(row.goal_id) }),
        refusedAt: Number(row.refused_at),
        reasonCode: String(row.reason_code),
        slotClaimed: Number(row.slot_claimed) === 1,
      }));
  }

  insertGoalLease(record: {
    leaseId: string; createdAt: number; notBefore: number; expiresAt: number; bindings: string;
  }): void {
    this.db.prepare(`INSERT INTO goal_leases (lease_id, created_at, not_before, expires_at, bindings)
      VALUES (?, ?, ?, ?, ?)`)
      .run(record.leaseId, record.createdAt, record.notBefore, record.expiresAt, record.bindings);
  }

  getGoalLeaseRow(leaseId: string): {
    leaseId: string; createdAt: number; notBefore: number; expiresAt: number; revokedAt?: number; bindings: string;
  } | undefined {
    const row = this.db.prepare('SELECT * FROM goal_leases WHERE lease_id = ?').get(leaseId) as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      leaseId: String(row.lease_id),
      createdAt: Number(row.created_at),
      notBefore: Number(row.not_before),
      expiresAt: Number(row.expires_at),
      ...(row.revoked_at === null ? {} : { revokedAt: Number(row.revoked_at) }),
      bindings: String(row.bindings),
    };
  }

  /** Idempotent, and one-way: a revoked lease is never un-revoked. */
  revokeGoalLease(leaseId: string, now: number): boolean {
    const result = this.db.prepare('UPDATE goal_leases SET revoked_at = ? WHERE lease_id = ? AND revoked_at IS NULL')
      .run(now, leaseId);
    return Number(result.changes) === 1;
  }

  listGoalLeaseIds(): string[] {
    return (this.db.prepare('SELECT lease_id FROM goal_leases ORDER BY created_at').all() as Array<{ lease_id: string }>)
      .map((r) => r.lease_id);
  }

  /**
   * What a lease has already spent, counted from durable rows rather than from memory.
   *
   * Files are counted by *distinct path*, so editing the same file twice spends one file of the
   * budget and two lots of bytes — which matches what the binding means. Counting rows would let
   * a lease exhaust its file budget rewriting one file.
   */
  goalLeaseSpend(leaseId: string): { filesChanged: number; bytesWritten: number } {
    // Distinct (workspace, path), not distinct path. `workspaceRoots` is a list, so a lease
    // binding two repositories counted `src/index.ts` in both as one file — `maxFiles: 5` over
    // two roots would have permitted ten actual files. A review found it.
    const row = this.db.prepare(`SELECT COUNT(DISTINCT workspace_id || char(10) || path) AS files,
      COALESCE(SUM(diff_bytes), 0) AS bytes
      FROM mutation_authority WHERE lease_id = ?`).get(leaseId) as { files: number; bytes: number };
    return { filesChanged: Number(row.files), bytesWritten: Number(row.bytes) };
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

  /**
   * Outstanding proposals for one caller. The review list is finite and ordered by age, so an
   * uncapped caller can bury a genuine proposal under lookalikes inside the review window.
   */
  countPendingMutations(authority: GatewayAuthority, now: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS pending FROM mutations
      WHERE state = 'PENDING_APPROVAL' AND review_deadline > ?
        AND owner_id = ? AND session_id = ? AND adapter_id = ?`)
      .get(now, authority.ownerId, authority.sessionId, authority.adapterId) as { pending: number };
    return Number(row.pending);
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

  createCommit(input: CreateCommitRecord): CommitRecord {
    const record: CommitRecord = { commitId: `cmt_${randomUUID()}`, ...input, state: 'PENDING_APPROVAL' };
    this.db.prepare(`INSERT INTO commits
      (commit_id, owner_id, session_id, adapter_id, workspace_id, backend_kind, branch, old_head,
       tree_sha, author, committer, git_dir, common_dir, eol_normalized, paths, changes, message, message_sha256, fingerprint, state, created_at, review_deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.commitId, record.ownerId, record.sessionId, record.adapterId, record.workspaceId,
        record.backendKind, record.branch, record.oldHead, record.treeSha, record.author, record.committer, record.gitDir, record.commonDir, JSON.stringify(record.eolNormalized), JSON.stringify(record.paths),
        JSON.stringify(record.changes), record.message, record.messageSha256, record.fingerprint, record.state, record.createdAt,
        record.reviewDeadline);
    return record;
  }

  getCommit(commitId: string): CommitRecord | undefined {
    const row = this.db.prepare('SELECT * FROM commits WHERE commit_id = ?').get(commitId);
    return row ? commitFromRow(row as Record<string, unknown>) : undefined;
  }

  listPendingCommits(limit = 20): CommitRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const rows = this.db.prepare("SELECT * FROM commits WHERE state = 'PENDING_APPROVAL' ORDER BY created_at LIMIT ?").all(safeLimit);
    return rows.map((row) => commitFromRow(row as Record<string, unknown>));
  }

  /**
   * Outstanding proposals for one caller. The operator's review list is finite, so an unbounded
   * caller could bury a real proposal under lookalikes within the review window.
   */
  countPendingCommits(authority: GatewayAuthority, now: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS pending FROM commits
      WHERE state = 'PENDING_APPROVAL' AND review_deadline > ?
        AND owner_id = ? AND session_id = ? AND adapter_id = ?`)
      .get(now, authority.ownerId, authority.sessionId, authority.adapterId) as { pending: number };
    return Number(row.pending);
  }

  listRecoverableCommits(): CommitRecord[] {
    const rows = this.db.prepare("SELECT * FROM commits WHERE state IN ('PENDING_APPROVAL','EXECUTING') ORDER BY created_at").all();
    return rows.map((row) => commitFromRow(row as Record<string, unknown>));
  }

  /** Single-use and TTL-bounded: the conditional UPDATE is what makes a replay a no-op. */
  claimCommit(commitId: string, now: number): CommitRecord | undefined {
    return this.transitionCommit(commitId, 'PENDING_APPROVAL', () => {
      const result = this.db.prepare(`UPDATE commits SET state = 'EXECUTING', reviewed_at = ?, execution_started_at = ?
        WHERE commit_id = ? AND state = 'PENDING_APPROVAL' AND review_deadline > ?`)
        .run(now, now, commitId, now);
      return Number(result.changes) === 1;
    });
  }

  rejectCommit(commitId: string, now: number): boolean {
    return Boolean(this.transitionCommit(commitId, 'PENDING_APPROVAL', () => {
      const result = this.db.prepare(`UPDATE commits SET state = 'REJECTED', completed_at = ?
        WHERE commit_id = ? AND state = 'PENDING_APPROVAL' AND review_deadline > ?`)
        .run(now, commitId, now);
      return Number(result.changes) === 1;
    }));
  }

  expireCommit(commitId: string, now: number): boolean {
    return Boolean(this.transitionCommit(commitId, 'PENDING_APPROVAL', () => {
      const result = this.db.prepare(`UPDATE commits SET state = 'EXPIRED', completed_at = ?
        WHERE commit_id = ? AND state = 'PENDING_APPROVAL' AND review_deadline <= ?`)
        .run(now, commitId, now);
      return Number(result.changes) === 1;
    }));
  }

  finishCommit(
    commitId: string,
    state: Extract<CommitState, 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN'>,
    now: number,
    resultCommit?: string,
    errorClass?: string,
  ): boolean {
    return Boolean(this.transitionCommit(commitId, 'EXECUTING', () => {
      const result = this.db.prepare(`UPDATE commits
        SET state = ?, completed_at = ?, result_commit = ?, error_class = ?
        WHERE commit_id = ? AND state = 'EXECUTING'`)
        .run(state, now, resultCommit ?? null, errorClass ?? null, commitId);
      return Number(result.changes) === 1;
    }));
  }

  private transitionCommit(commitId: string, fromState: CommitState, apply: () => boolean): CommitRecord | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.getCommit(commitId);
      if (!before || before.state !== fromState || !apply()) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const after = this.getCommit(commitId)!;
      this.db.exec('COMMIT');
      return after;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

function commitFromRow(row: Record<string, unknown>): CommitRecord {
  return {
    commitId: String(row.commit_id), ownerId: String(row.owner_id),
    sessionId: String(row.session_id), adapterId: String(row.adapter_id),
    workspaceId: String(row.workspace_id), backendKind: String(row.backend_kind),
    branch: String(row.branch), oldHead: String(row.old_head), treeSha: String(row.tree_sha),
    author: String(row.author), committer: String(row.committer),
    gitDir: String(row.git_dir), commonDir: String(row.common_dir),
    eolNormalized: JSON.parse(String(row.eol_normalized)) as string[],
    paths: JSON.parse(String(row.paths)) as string[],
    changes: JSON.parse(String(row.changes)) as GitCommitChange[],
    message: String(row.message), messageSha256: String(row.message_sha256),
    fingerprint: String(row.fingerprint), state: String(row.state) as CommitState,
    createdAt: Number(row.created_at), reviewDeadline: Number(row.review_deadline),
    ...(row.reviewed_at === null ? {} : { reviewedAt: Number(row.reviewed_at) }),
    ...(row.execution_started_at === null ? {} : { executionStartedAt: Number(row.execution_started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    ...(row.result_commit === null ? {} : { resultCommit: String(row.result_commit) }),
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
