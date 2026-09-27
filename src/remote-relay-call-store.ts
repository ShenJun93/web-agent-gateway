import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type RemoteRelayStoredCallState = 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';

export interface RemoteRelayStoredCall {
  state: RemoteRelayStoredCallState;
  result?: Buffer;
  expiresAt: number;
}

export interface RemoteRelayCallStore {
  claim(callId: string, expiresAt: number): { claimed: boolean; record: RemoteRelayStoredCall };
  complete(callId: string, state: 'COMPLETED' | 'FAILED', result: Uint8Array): RemoteRelayStoredCall;
  get(callId: string): RemoteRelayStoredCall | undefined;
  close(): void;
}

const MAX_RESULT_BYTES = 256 * 1024;
const CALL_ID = /^[A-Za-z0-9._:-]{8,160}$/;

function callHash(callId: string): string {
  if (!CALL_ID.test(callId)) throw new Error('remote relay call id is invalid');
  return createHash('sha256').update('wag-relay-v1:call:').update(callId).digest('hex');
}

function storeKey(secret: Uint8Array): Buffer {
  const value = Buffer.from(secret);
  if (value.length < 32 || value.length > 128) {
    throw new Error('remote relay call store secret must be 32..128 bytes');
  }
  return Buffer.from(hkdfSync(
    'sha256',
    value,
    Buffer.from('wag-relay-v1:call-store:salt', 'utf8'),
    Buffer.from('wag-relay-v1:call-store:key', 'utf8'),
    32,
  ));
}

function aad(hash: string, expiresAt: number, state: 'COMPLETED' | 'FAILED'): Buffer {
  return Buffer.from(JSON.stringify(['wag-relay-v1', hash, expiresAt, state]), 'utf8');
}

function encryptResult(
  key: Buffer,
  hash: string,
  expiresAt: number,
  state: 'COMPLETED' | 'FAILED',
  result: Uint8Array,
): Buffer {
  const bytes = Buffer.from(result);
  if (bytes.length === 0 || bytes.length > MAX_RESULT_BYTES) {
    throw new Error('remote relay stored result exceeds bounded size');
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(hash, expiresAt, state));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptResult(
  key: Buffer,
  hash: string,
  expiresAt: number,
  state: 'COMPLETED' | 'FAILED',
  packed: Uint8Array,
): Buffer {
  const bytes = Buffer.from(packed);
  if (bytes.length < 29 || bytes.length > MAX_RESULT_BYTES + 28) {
    throw new Error('remote relay stored result is corrupt');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(aad(hash, expiresAt, state));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  } catch {
    throw new Error('remote relay stored result authentication failed');
  }
}

export class InMemoryRemoteRelayCallStore implements RemoteRelayCallStore {
  readonly #records = new Map<string, RemoteRelayStoredCall>();

  claim(callId: string, expiresAt: number) {
    const hash = callHash(callId);
    const existing = this.#records.get(hash);
    if (existing) return { claimed: false, record: clone(existing) };
    const record: RemoteRelayStoredCall = { state: 'EXECUTING', expiresAt };
    this.#records.set(hash, record);
    return { claimed: true, record: clone(record) };
  }

  complete(callId: string, state: 'COMPLETED' | 'FAILED', result: Uint8Array) {
    if (result.byteLength === 0 || result.byteLength > MAX_RESULT_BYTES) {
      throw new Error('remote relay stored result exceeds bounded size');
    }
    const hash = callHash(callId);
    const current = this.#records.get(hash);
    if (!current || current.state !== 'EXECUTING') {
      throw new Error('remote relay call is not executing');
    }
    const record: RemoteRelayStoredCall = {
      state,
      expiresAt: current.expiresAt,
      result: Buffer.from(result),
    };
    this.#records.set(hash, record);
    return clone(record);
  }

  get(callId: string) {
    const record = this.#records.get(callHash(callId));
    return record ? clone(record) : undefined;
  }

  close(): void {
    this.#records.clear();
  }
}

export class SqliteRemoteRelayCallStore implements RemoteRelayCallStore {
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  readonly #now: () => number;
  #closed = false;

  constructor(path: string, options: { secret: Uint8Array; now?: () => number }) {
    if (!isAbsolute(path)) throw new Error('remote relay call store path must be absolute');
    this.#key = storeKey(options.secret);
    this.#now = options.now ?? Date.now;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS remote_relay_calls (
        call_id_hash TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('EXECUTING','COMPLETED','FAILED','UNKNOWN')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        result_bytes INTEGER,
        result_ciphertext BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_remote_relay_calls_expiry
        ON remote_relay_calls(expires_at);
    `);
    // An interrupted process must never execute the same call again after restart.
    this.#db.prepare(`
      UPDATE remote_relay_calls
      SET state = 'UNKNOWN', updated_at = ?
      WHERE state = 'EXECUTING'
    `).run(this.#now());
    this.#cleanup();
  }

  claim(callId: string, expiresAt: number) {
    this.#assertOpen();
    const now = this.#now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      throw new Error('remote relay call store expiry is invalid');
    }
    this.#cleanup();
    const hash = callHash(callId);
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO remote_relay_calls (
        call_id_hash, state, created_at, updated_at, expires_at
      ) VALUES (?, 'EXECUTING', ?, ?, ?)
    `).run(hash, now, now, expiresAt);
    return {
      claimed: Number(result.changes) === 1,
      record: this.#getByHash(hash)!,
    };
  }

  complete(callId: string, state: 'COMPLETED' | 'FAILED', result: Uint8Array) {
    this.#assertOpen();
    const hash = callHash(callId);
    const current = this.#getByHash(hash);
    if (!current || current.state !== 'EXECUTING') {
      throw new Error('remote relay call is not executing');
    }
    const packed = encryptResult(this.#key, hash, current.expiresAt, state, result);
    const changed = this.#db.prepare(`
      UPDATE remote_relay_calls
      SET state = ?, updated_at = ?, result_bytes = ?, result_ciphertext = ?
      WHERE call_id_hash = ? AND state = 'EXECUTING'
    `).run(state, this.#now(), result.byteLength, packed, hash);
    if (Number(changed.changes) !== 1) throw new Error('remote relay call completion race');
    return this.#getByHash(hash)!;
  }

  get(callId: string) {
    this.#assertOpen();
    this.#cleanup();
    return this.#getByHash(callHash(callId));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#key.fill(0);
    this.#db.close();
  }

  #getByHash(hash: string): RemoteRelayStoredCall | undefined {
    const row = this.#db.prepare(`
      SELECT state, expires_at, result_bytes, result_ciphertext
      FROM remote_relay_calls WHERE call_id_hash = ?
    `).get(hash) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const state = String(row.state) as RemoteRelayStoredCallState;
    const expiresAt = Number(row.expires_at);
    if (!Number.isSafeInteger(expiresAt)) throw new Error('remote relay call store row is corrupt');
    if (state === 'COMPLETED' || state === 'FAILED') {
      if (!(row.result_ciphertext instanceof Uint8Array)) {
        throw new Error('remote relay call store result is missing');
      }
      const result = decryptResult(this.#key, hash, expiresAt, state, row.result_ciphertext);
      if (Number(row.result_bytes) !== result.length) {
        throw new Error('remote relay call store result length mismatch');
      }
      return { state, expiresAt, result };
    }
    return { state, expiresAt };
  }

  #cleanup(): void {
    const now = this.#now();
    this.#db.prepare('DELETE FROM remote_relay_calls WHERE expires_at <= ?').run(now);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('remote relay call store is closed');
  }
}

function clone(record: RemoteRelayStoredCall): RemoteRelayStoredCall {
  return {
    state: record.state,
    expiresAt: record.expiresAt,
    ...(record.result === undefined ? {} : { result: Buffer.from(record.result) }),
  };
}
