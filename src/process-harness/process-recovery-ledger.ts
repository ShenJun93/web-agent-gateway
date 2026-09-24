import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';
import type { ProcessHandle, ProcessStartSpec } from './process-port.js';

export type ProcessRecoveryState = 'RUNNING' | 'EXITED' | 'STOPPED' | 'STALE_IDENTITY';

export interface ProcessInstanceIdentity {
  readonly pid: number;
  readonly instanceId: string;
  readonly executablePath: string;
}

export interface ProcessRecoveryRecord extends GatewayAuthority {
  readonly processId: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly executablePath: string;
  readonly specFingerprint: string;
  readonly state: ProcessRecoveryState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RecoveryRow {
  process_id: string;
  owner_id: string;
  session_id: string;
  adapter_id: string;
  pid: number;
  instance_id: string;
  executable_path: string;
  spec_fingerprint: string;
  state: ProcessRecoveryState;
  created_at: number;
  updated_at: number;
}

const PROCESS_ID = /^process_[0-9a-f-]{36}$/;
const INSTANCE = /^[^\u0000-\u001F]{1,512}$/;
const FINGERPRINT = /^processfp_[a-f0-9]{64}$/;

function fingerprint(spec: ProcessStartSpec): string {
  const hash = createHash('sha256');
  hash.update('WAG/process-start-spec/v1\n', 'utf8');
  hash.update(JSON.stringify({
    argv: [...spec.argv],
    cwd: spec.cwd ?? null,
  }), 'utf8');
  return `processfp_${hash.digest('hex')}`;
}

function validateIdentity(identity: ProcessInstanceIdentity): void {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0) throw new Error('Process recovery pid is invalid');
  if (!INSTANCE.test(identity.instanceId)) throw new Error('Process recovery instance id is invalid');
  if (!isAbsolute(identity.executablePath) || identity.executablePath.includes('\0')
      || Buffer.byteLength(identity.executablePath, 'utf8') > 4096) {
    throw new Error('Process recovery executable path is invalid');
  }
}

function fromRow(row: RecoveryRow): ProcessRecoveryRecord {
  return Object.freeze({
    processId: row.process_id,
    ownerId: row.owner_id,
    sessionId: row.session_id,
    adapterId: row.adapter_id,
    pid: Number(row.pid),
    instanceId: row.instance_id,
    executablePath: row.executable_path,
    specFingerprint: row.spec_fingerprint,
    state: row.state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

export function sameProcessInstance(
  expected: Pick<ProcessRecoveryRecord, 'pid' | 'instanceId' | 'executablePath'>,
  actual: ProcessInstanceIdentity,
): boolean {
  const executableMatches = process.platform === 'win32'
    ? expected.executablePath.toLowerCase() === actual.executablePath.toLowerCase()
    : expected.executablePath === actual.executablePath;
  return expected.pid === actual.pid
    && expected.instanceId === actual.instanceId
    && executableMatches;
}

export class ProcessRecoveryLedger {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  #closed = false;

  constructor(path: string, options: { now?: () => number } = {}) {
    if (!isAbsolute(path)) throw new Error('Process recovery ledger requires an absolute path');
    this.#now = options.now ?? Date.now;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS process_recovery (
        process_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        executable_path TEXT NOT NULL,
        spec_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('RUNNING','EXITED','STOPPED','STALE_IDENTITY')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS process_recovery_state_idx
        ON process_recovery(state, updated_at);
    `);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  recordStarted(
    owner: GatewayAuthority,
    handle: ProcessHandle,
    spec: ProcessStartSpec,
    identity: ProcessInstanceIdentity,
  ): ProcessRecoveryRecord {
    this.#assertOpen();
    if (!PROCESS_ID.test(handle.processId)) throw new Error('Process recovery process id is invalid');
    if (!sameAuthorityTuple(handle.owner, owner)) throw new Error('Process recovery owner mismatch');
    if (handle.state !== 'RUNNING') throw new Error('Process recovery can record only a running process');
    validateIdentity(identity);
    if (handle.pid !== identity.pid) throw new Error('Process recovery pid does not match started handle');
    const specFingerprint = fingerprint(spec);
    const now = this.#now();

    this.#db.prepare(`
      INSERT INTO process_recovery (
        process_id, owner_id, session_id, adapter_id, pid, instance_id,
        executable_path, spec_fingerprint, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)
    `).run(
      handle.processId,
      owner.ownerId,
      owner.sessionId,
      owner.adapterId,
      identity.pid,
      identity.instanceId,
      identity.executablePath,
      specFingerprint,
      now,
      now,
    );
    return this.get(owner, handle.processId);
  }

  get(owner: GatewayAuthority, processId: string): ProcessRecoveryRecord {
    this.#assertOpen();
    const row = this.#get(processId);
    if (!row || !sameAuthorityTuple({
      ownerId: row.owner_id,
      sessionId: row.session_id,
      adapterId: row.adapter_id,
    }, owner)) {
      throw new Error('Process recovery record is not owned by caller');
    }
    return fromRow(row);
  }

  list(owner: GatewayAuthority): readonly ProcessRecoveryRecord[] {
    this.#assertOpen();
    const rows = this.#db.prepare(`
      SELECT * FROM process_recovery
      WHERE owner_id = ? AND session_id = ? AND adapter_id = ?
      ORDER BY created_at, process_id
    `).all(owner.ownerId, owner.sessionId, owner.adapterId) as unknown as RecoveryRow[];
    return Object.freeze(rows.map(fromRow));
  }

  listRunning(): readonly ProcessRecoveryRecord[] {
    this.#assertOpen();
    const rows = this.#db.prepare(
      "SELECT * FROM process_recovery WHERE state = 'RUNNING' ORDER BY created_at, process_id",
    ).all() as unknown as RecoveryRow[];
    return Object.freeze(rows.map(fromRow));
  }

  transition(
    processId: string,
    expected: ProcessRecoveryState,
    next: Exclude<ProcessRecoveryState, 'RUNNING'>,
  ): ProcessRecoveryRecord {
    this.#assertOpen();
    if (!PROCESS_ID.test(processId)) throw new Error('Process recovery process id is invalid');
    const now = this.#now();
    const result = this.#db.prepare(`
      UPDATE process_recovery
      SET state = ?, updated_at = ?
      WHERE process_id = ? AND state = ?
    `).run(next, now, processId, expected);
    if (Number(result.changes) !== 1) {
      const current = this.#get(processId);
      if (current?.state === next) return fromRow(current);
      throw new Error('Process recovery transition lost a race');
    }
    return fromRow(this.#get(processId)!);
  }

  #get(processId: string): RecoveryRow | undefined {
    if (!PROCESS_ID.test(processId)) throw new Error('Process recovery process id is invalid');
    return this.#db.prepare('SELECT * FROM process_recovery WHERE process_id = ?')
      .get(processId) as RecoveryRow | undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Process recovery ledger is closed');
  }
}
