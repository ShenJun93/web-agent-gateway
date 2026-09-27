import { createHash, randomUUID } from 'node:crypto';

export const RELAY_MESSAGE_MAX_BYTES = 256 * 1024;
/**
 * Leave room for JSON-RPC framing, connector metadata, and transport bookkeeping around one
 * serialized MCP tool result. Any larger result is converted to an in-memory chunk sequence.
 */
export const RELAY_DIRECT_RESULT_MAX_BYTES = 192 * 1024;
/**
 * Raw chunk bytes are base64-encoded in the envelope. 56 KiB expands to about 75 KiB; even the
 * normal MCP text + structuredContent duplication remains comfortably below 256 KiB.
 */
export const RELAY_RESULT_CHUNK_BYTES = 56 * 1024;

const RESULT_ID = /^result_[0-9a-f-]{36}$/;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_STORED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 16;

interface StoredResult {
  readonly resultId: string;
  readonly payload: Buffer;
  readonly sha256: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RelayResultChunk {
  readonly chunked: true;
  readonly result_id: string;
  readonly encoding: 'base64-json';
  readonly chunk_index: number;
  readonly chunk_count: number;
  readonly data_base64: string;
  readonly serialized_bytes: number;
  readonly sha256: string;
  readonly expires_at: number;
}

export interface RelayResultChunkStoreOptions {
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly ttlMs?: number;
  readonly maxStoredBytes?: number;
  readonly maxResults?: number;
}

export class RelayResultChunkStore {
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #ttlMs: number;
  readonly #maxStoredBytes: number;
  readonly #maxResults: number;
  readonly #records = new Map<string, StoredResult>();
  #storedBytes = 0;

  constructor(options: RelayResultChunkStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxStoredBytes = options.maxStoredBytes ?? DEFAULT_MAX_STORED_BYTES;
    this.#maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    if (!Number.isInteger(this.#ttlMs) || this.#ttlMs < 1_000 || this.#ttlMs > 60 * 60_000) {
      throw new Error('Gateway rejected relay result chunk TTL');
    }
    if (!Number.isInteger(this.#maxStoredBytes) || this.#maxStoredBytes < RELAY_RESULT_CHUNK_BYTES
      || this.#maxStoredBytes > 256 * 1024 * 1024) {
      throw new Error('Gateway rejected relay result chunk memory budget');
    }
    if (!Number.isInteger(this.#maxResults) || this.#maxResults < 1 || this.#maxResults > 128) {
      throw new Error('Gateway rejected relay result chunk record budget');
    }
  }

  wrap<T>(value: T): T | RelayResultChunk {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    if (payload.length <= RELAY_DIRECT_RESULT_MAX_BYTES) return value;
    if (payload.length > this.#maxStoredBytes) {
      throw new Error('Gateway tool result exceeds relay chunk memory budget');
    }
    this.#sweep();
    while (this.#records.size >= this.#maxResults || this.#storedBytes + payload.length > this.#maxStoredBytes) {
      const oldest = this.#records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#delete(oldest);
    }
    if (this.#storedBytes + payload.length > this.#maxStoredBytes) {
      throw new Error('Gateway relay result chunk memory budget exhausted');
    }
    const now = this.#now();
    const record: StoredResult = {
      resultId: `result_${this.#randomUUID()}`,
      payload,
      sha256: createHash('sha256').update(payload).digest('hex'),
      createdAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#records.set(record.resultId, record);
    this.#storedBytes += payload.length;
    return this.#chunk(record, 0);
  }

  get(resultId: string, chunkIndex: number): RelayResultChunk {
    if (!RESULT_ID.test(resultId)) throw new Error('Gateway denied relay result id');
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 1_000_000) {
      throw new Error('Gateway denied relay result chunk index');
    }
    this.#sweep();
    const record = this.#records.get(resultId);
    if (!record) throw new Error('Gateway relay result chunk is unavailable or expired');
    return this.#chunk(record, chunkIndex);
  }

  close(): void {
    this.#records.clear();
    this.#storedBytes = 0;
  }

  #chunk(record: StoredResult, chunkIndex: number): RelayResultChunk {
    const chunkCount = Math.ceil(record.payload.length / RELAY_RESULT_CHUNK_BYTES);
    if (chunkIndex >= chunkCount) throw new Error('Gateway denied relay result chunk index');
    const start = chunkIndex * RELAY_RESULT_CHUNK_BYTES;
    const end = Math.min(start + RELAY_RESULT_CHUNK_BYTES, record.payload.length);
    return Object.freeze({
      chunked: true,
      result_id: record.resultId,
      encoding: 'base64-json',
      chunk_index: chunkIndex,
      chunk_count: chunkCount,
      data_base64: record.payload.subarray(start, end).toString('base64'),
      serialized_bytes: record.payload.length,
      sha256: record.sha256,
      expires_at: record.expiresAt,
    });
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, record] of this.#records) {
      if (record.expiresAt <= now) this.#delete(id);
    }
  }

  #delete(id: string): void {
    const record = this.#records.get(id);
    if (!record) return;
    this.#records.delete(id);
    this.#storedBytes -= record.payload.length;
  }
}
