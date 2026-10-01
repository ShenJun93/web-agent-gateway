import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GatewayAuthority } from './caller-context.js';

export type ChangeSetState =
  | 'PREPARED'
  | 'APPLYING'
  | 'APPLIED'
  | 'VERIFIED'
  | 'PARTIAL_EFFECT_DETECTED';

export interface CreateChangeSetRecord extends GatewayAuthority {
  workspaceId: string;
  canonicalRoot: string;
  backendKind: string;
  baseHead: string;
  planSha256: string;
  operationsJson: string;
  createdAt: number;
}

export interface ChangeSetRecord extends CreateChangeSetRecord {
  changeId: string;
  state: ChangeSetState;
  applyStartedAt?: number;
  completedAt?: number;
  errorClass?: string;
}

export class ChangeSetStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('Change-set store requires an absolute state path');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS change_sets_v1 (
        change_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        canonical_root TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        base_head TEXT NOT NULL,
        plan_sha256 TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        apply_started_at INTEGER,
        completed_at INTEGER,
        error_class TEXT,
        CHECK (state IN (
          'PREPARED', 'APPLYING', 'APPLIED', 'VERIFIED', 'PARTIAL_EFFECT_DETECTED'
        ))
      )
    `);
  }

  create(input: CreateChangeSetRecord): ChangeSetRecord {
    const changeId = `change_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO change_sets_v1 (
        change_id, owner_id, session_id, adapter_id, workspace_id,
        canonical_root, backend_kind, base_head, plan_sha256,
        operations_json, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?)
    `).run(
      changeId,
      input.ownerId,
      input.sessionId,
      input.adapterId,
      input.workspaceId,
      input.canonicalRoot,
      input.backendKind,
      input.baseHead,
      input.planSha256,
      input.operationsJson,
      input.createdAt,
    );
    const record = this.get(changeId);
    if (!record) throw new Error('Change-set record did not persist');
    return record;
  }

  get(changeId: string): ChangeSetRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM change_sets_v1 WHERE change_id = ?',
    ).get(changeId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  claimPrepared(changeId: string, observedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE change_sets_v1
      SET state = 'APPLYING', apply_started_at = ?, error_class = NULL
      WHERE change_id = ? AND state = 'PREPARED'
    `).run(observedAt, changeId);
    return Number(result.changes) === 1;
  }

  resetPrepared(changeId: string, errorClass?: string): boolean {
    const result = this.db.prepare(`
      UPDATE change_sets_v1
      SET state = 'PREPARED', apply_started_at = NULL, completed_at = NULL, error_class = ?
      WHERE change_id = ? AND state IN ('APPLYING', 'APPLIED')
    `).run(errorClass ?? null, changeId);
    return Number(result.changes) === 1;
  }

  markApplied(changeId: string): boolean {
    const result = this.db.prepare(`
      UPDATE change_sets_v1
      SET state = 'APPLIED', error_class = NULL
      WHERE change_id = ? AND state = 'APPLYING'
    `).run(changeId);
    return Number(result.changes) === 1;
  }

  markVerified(changeId: string, completedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE change_sets_v1
      SET state = 'VERIFIED', completed_at = ?, error_class = NULL
      WHERE change_id = ? AND state IN ('APPLYING', 'APPLIED')
    `).run(completedAt, changeId);
    return Number(result.changes) === 1;
  }

  markPartial(changeId: string, completedAt: number, errorClass: string): boolean {
    const result = this.db.prepare(`
      UPDATE change_sets_v1
      SET state = 'PARTIAL_EFFECT_DETECTED', completed_at = ?, error_class = ?
      WHERE change_id = ? AND state IN ('APPLYING', 'APPLIED')
    `).run(completedAt, errorClass, changeId);
    return Number(result.changes) === 1;
  }

  setPreparedError(changeId: string, errorClass: string): boolean {
    const result = this.db.prepare(`
      UPDATE change_sets_v1
      SET error_class = ?
      WHERE change_id = ? AND state = 'PREPARED'
    `).run(errorClass, changeId);
    return Number(result.changes) === 1;
  }

  listRecoverable(limit = 100): ChangeSetRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Invalid change-set recovery limit');
    }
    const rows = this.db.prepare(`
      SELECT * FROM change_sets_v1
      WHERE state IN ('APPLYING', 'APPLIED')
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function fromRow(row: Record<string, unknown>): ChangeSetRecord {
  return {
    changeId: String(row.change_id),
    ownerId: String(row.owner_id),
    sessionId: String(row.session_id),
    adapterId: String(row.adapter_id),
    workspaceId: String(row.workspace_id),
    canonicalRoot: String(row.canonical_root),
    backendKind: String(row.backend_kind),
    baseHead: String(row.base_head),
    planSha256: String(row.plan_sha256),
    operationsJson: String(row.operations_json),
    state: String(row.state) as ChangeSetState,
    createdAt: Number(row.created_at),
    ...(row.apply_started_at === null ? {} : { applyStartedAt: Number(row.apply_started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    ...(row.error_class === null ? {} : { errorClass: String(row.error_class) }),
  };
}
