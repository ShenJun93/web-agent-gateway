import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import type { GatewayAuthority } from './caller-context.js';
import { sameAuthorityTuple } from './authority-tuple.js';
import { canonicalEncoding, type CanonicalValue } from './proposal-fingerprint.js';

export type HarnessEffectState =
  | 'RESERVED'
  | 'EXECUTING'
  | 'SUCCEEDED'
  | 'FAILED_NO_EFFECT'
  | 'OUTCOME_UNKNOWN';

export interface HarnessEffectPlan {
  readonly kind: string;
  readonly resourceId: string;
  readonly arguments: CanonicalValue;
}

export interface HarnessEffectRecord extends GatewayAuthority {
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly resourceId: string;
  readonly planFingerprint: string;
  readonly state: HarnessEffectState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attemptId?: string;
  readonly resultDigest?: string;
  readonly errorClass?: string;
}

interface EffectRow {
  effect_id: string;
  owner_id: string;
  session_id: string;
  adapter_id: string;
  idempotency_key: string;
  effect_kind: string;
  resource_id: string;
  plan_fingerprint: string;
  state: HarnessEffectState;
  created_at: number;
  updated_at: number;
  attempt_id: string | null;
  result_digest: string | null;
  error_class: string | null;
}

const KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const KIND = /^[A-Za-z0-9._:-]{1,100}$/;
const RESOURCE = /^[A-Za-z0-9._:/-]{1,300}$/;
const DIGEST = /^[A-Za-z0-9._:-]{1,200}$/;
const PLAN_DOMAIN = 'WAG/harness-effect-plan/v1';

function assertPlan(plan: HarnessEffectPlan): void {
  if (!KIND.test(plan.kind)) throw new Error('Harness effect kind is invalid');
  if (!RESOURCE.test(plan.resourceId)) throw new Error('Harness effect resource is invalid');
}

function planFingerprint(plan: HarnessEffectPlan): string {
  assertPlan(plan);
  const preimage = canonicalEncoding({
    domain: PLAN_DOMAIN,
    kind: plan.kind,
    resourceId: plan.resourceId,
    arguments: plan.arguments,
  });
  return `effectfp_${createHash('sha256').update(preimage, 'utf8').digest('hex')}`;
}

function record(row: EffectRow): HarnessEffectRecord {
  return Object.freeze({
    effectId: row.effect_id,
    ownerId: row.owner_id,
    sessionId: row.session_id,
    adapterId: row.adapter_id,
    idempotencyKey: row.idempotency_key,
    kind: row.effect_kind,
    resourceId: row.resource_id,
    planFingerprint: row.plan_fingerprint,
    state: row.state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    ...(row.result_digest === null ? {} : { resultDigest: row.result_digest }),
    ...(row.error_class === null ? {} : { errorClass: row.error_class }),
  });
}

export class HarnessEffectLedger {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #uuid: () => string;
  #closed = false;

  constructor(path: string, options: { now?: () => number; randomUUID?: () => string } = {}) {
    if (!isAbsolute(path)) throw new Error('Harness effect ledger requires an absolute path');
    this.#now = options.now ?? Date.now;
    this.#uuid = options.randomUUID ?? randomUUID;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS harness_effects (
        effect_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        effect_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        plan_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'RESERVED','EXECUTING','SUCCEEDED','FAILED_NO_EFFECT','OUTCOME_UNKNOWN'
        )),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        attempt_id TEXT,
        result_digest TEXT,
        error_class TEXT,
        UNIQUE(owner_id, session_id, adapter_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS harness_effect_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        effect_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        detail TEXT,
        FOREIGN KEY(effect_id) REFERENCES harness_effects(effect_id)
      );
      CREATE INDEX IF NOT EXISTS harness_effect_state_idx
        ON harness_effects(state, updated_at);
    `);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  reserve(owner: GatewayAuthority, idempotencyKey: string, plan: HarnessEffectPlan): HarnessEffectRecord {
    this.#assertOpen();
    if (!KEY.test(idempotencyKey)) throw new Error('Harness idempotency key is invalid');
    const fingerprint = planFingerprint(plan);
    const now = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#db.prepare(`
        SELECT * FROM harness_effects
        WHERE owner_id = ? AND session_id = ? AND adapter_id = ? AND idempotency_key = ?
      `).get(owner.ownerId, owner.sessionId, owner.adapterId, idempotencyKey) as EffectRow | undefined;
      if (existing) {
        if (existing.effect_kind !== plan.kind
            || existing.resource_id !== plan.resourceId
            || existing.plan_fingerprint !== fingerprint) {
          throw new Error('Harness idempotency key conflicts with a different effect plan');
        }
        this.#db.exec('COMMIT');
        return record(existing);
      }

      const effectId = `effect_${this.#uuid()}`;
      this.#db.prepare(`
        INSERT INTO harness_effects (
          effect_id, owner_id, session_id, adapter_id, idempotency_key,
          effect_kind, resource_id, plan_fingerprint, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?)
      `).run(
        effectId, owner.ownerId, owner.sessionId, owner.adapterId, idempotencyKey,
        plan.kind, plan.resourceId, fingerprint, now, now,
      );
      this.#event(effectId, now, null, 'RESERVED', 'reserved');
      this.#db.exec('COMMIT');
      return this.#getOwned(owner, effectId);
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  claim(owner: GatewayAuthority, effectId: string): { claimed: boolean; record: HarnessEffectRecord } {
    this.#assertOpen();
    const now = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#getOwned(owner, effectId);
      if (current.state === 'SUCCEEDED') {
        this.#db.exec('COMMIT');
        return { claimed: false, record: current };
      }
      if (current.state !== 'RESERVED') {
        throw new Error(`Harness effect is not claimable from ${current.state}`);
      }
      const attemptId = `attempt_${this.#uuid()}`;
      const updated = this.#db.prepare(`
        UPDATE harness_effects
        SET state = 'EXECUTING', attempt_id = ?, updated_at = ?
        WHERE effect_id = ? AND state = 'RESERVED'
      `).run(attemptId, now, effectId);
      if (Number(updated.changes) !== 1) throw new Error('Harness effect claim lost a race');
      this.#event(effectId, now, 'RESERVED', 'EXECUTING', attemptId);
      this.#db.exec('COMMIT');
      return { claimed: true, record: this.#getOwned(owner, effectId) };
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  confirmSuccess(owner: GatewayAuthority, effectId: string, resultDigest: string): HarnessEffectRecord {
    this.#assertOpen();
    if (!DIGEST.test(resultDigest)) throw new Error('Harness effect result digest is invalid');
    const now = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#getOwned(owner, effectId);
      if (current.state === 'SUCCEEDED') {
        if (current.resultDigest !== resultDigest) throw new Error('Harness effect success digest conflicts');
        this.#db.exec('COMMIT');
        return current;
      }
      if (current.state !== 'EXECUTING' && current.state !== 'OUTCOME_UNKNOWN') {
        throw new Error(`Harness effect success cannot follow ${current.state}`);
      }
      const updated = this.#db.prepare(`
        UPDATE harness_effects
        SET state = 'SUCCEEDED', result_digest = ?, error_class = NULL, updated_at = ?
        WHERE effect_id = ? AND state = ?
      `).run(resultDigest, now, effectId, current.state);
      if (Number(updated.changes) !== 1) throw new Error('Harness effect success lost a race');
      this.#event(effectId, now, current.state, 'SUCCEEDED', resultDigest);
      this.#db.exec('COMMIT');
      return this.#getOwned(owner, effectId);
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  failNoEffect(owner: GatewayAuthority, effectId: string, errorClass: string): HarnessEffectRecord {
    this.#assertOpen();
    if (!KIND.test(errorClass)) throw new Error('Harness effect error class is invalid');
    return this.#terminalTransition(owner, effectId, 'FAILED_NO_EFFECT', errorClass);
  }

  markOutcomeUnknown(owner: GatewayAuthority, effectId: string, errorClass = 'OUTCOME_UNKNOWN'): HarnessEffectRecord {
    this.#assertOpen();
    if (!KIND.test(errorClass)) throw new Error('Harness effect error class is invalid');
    return this.#terminalTransition(owner, effectId, 'OUTCOME_UNKNOWN', errorClass);
  }

  get(owner: GatewayAuthority, effectId: string): HarnessEffectRecord {
    this.#assertOpen();
    return this.#getOwned(owner, effectId);
  }

  reconcileExecuting(errorClass = 'RUNTIME_RESTART'): number {
    this.#assertOpen();
    if (!KIND.test(errorClass)) throw new Error('Harness effect error class is invalid');
    const now = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.#db.prepare(
        "SELECT effect_id FROM harness_effects WHERE state = 'EXECUTING'",
      ).all() as Array<{ effect_id: string }>;
      const update = this.#db.prepare(`
        UPDATE harness_effects
        SET state = 'OUTCOME_UNKNOWN', error_class = ?, updated_at = ?
        WHERE effect_id = ? AND state = 'EXECUTING'
      `);
      let changed = 0;
      for (const row of rows) {
        const result = update.run(errorClass, now, row.effect_id);
        if (Number(result.changes) === 1) {
          changed += 1;
          this.#event(row.effect_id, now, 'EXECUTING', 'OUTCOME_UNKNOWN', errorClass);
        }
      }
      this.#db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  #terminalTransition(
    owner: GatewayAuthority,
    effectId: string,
    to: 'FAILED_NO_EFFECT' | 'OUTCOME_UNKNOWN',
    detail: string,
  ): HarnessEffectRecord {
    const now = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#getOwned(owner, effectId);
      if (current.state !== 'EXECUTING') {
        throw new Error(`Harness effect transition cannot follow ${current.state}`);
      }
      const result = this.#db.prepare(`
        UPDATE harness_effects
        SET state = ?, error_class = ?, updated_at = ?
        WHERE effect_id = ? AND state = 'EXECUTING'
      `).run(to, detail, now, effectId);
      if (Number(result.changes) !== 1) throw new Error('Harness effect transition lost a race');
      this.#event(effectId, now, 'EXECUTING', to, detail);
      this.#db.exec('COMMIT');
      return this.#getOwned(owner, effectId);
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  #getOwned(owner: GatewayAuthority, effectId: string): HarnessEffectRecord {
    if (!/^effect_[0-9a-f-]{36}$/.test(effectId)) throw new Error('Harness effect id is invalid');
    const row = this.#db.prepare('SELECT * FROM harness_effects WHERE effect_id = ?')
      .get(effectId) as EffectRow | undefined;
    if (!row || !sameAuthorityTuple({
      ownerId: row.owner_id,
      sessionId: row.session_id,
      adapterId: row.adapter_id,
    }, owner)) {
      throw new Error('Harness effect is not owned by caller');
    }
    return record(row);
  }

  #event(
    effectId: string,
    observedAt: number,
    fromState: HarnessEffectState | null,
    toState: HarnessEffectState,
    detail: string,
  ): void {
    this.#db.prepare(`
      INSERT INTO harness_effect_events(effect_id, observed_at, from_state, to_state, detail)
      VALUES (?, ?, ?, ?, ?)
    `).run(effectId, observedAt, fromState, toState, detail);
  }

  #rollback(): void {
    try { this.#db.exec('ROLLBACK'); } catch { /* no active transaction */ }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Harness effect ledger is closed');
  }
}
