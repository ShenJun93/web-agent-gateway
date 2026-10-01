import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';

import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';

export type BrowserTargetClaimState = 'ACTIVE' | 'RELEASED';

export interface BrowserTargetClaim {
  readonly targetId: string;
  readonly owner: GatewayAuthority;
  readonly browserSessionId: string;
  readonly claimEpoch: number;
  readonly claimedAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
  readonly state: BrowserTargetClaimState;
}

export interface BrowserTargetClaimPort {
  claim(owner: GatewayAuthority, targetId: string, browserSessionId: string): BrowserTargetClaim;
  heartbeat(
    owner: GatewayAuthority,
    targetId: string,
    browserSessionId: string,
    claimEpoch: number,
  ): BrowserTargetClaim;
  assertCurrent(
    owner: GatewayAuthority,
    targetId: string,
    browserSessionId: string,
    claimEpoch: number,
  ): BrowserTargetClaim;
  release(
    owner: GatewayAuthority,
    targetId: string,
    browserSessionId: string,
    claimEpoch: number,
  ): BrowserTargetClaim;
}

export class BrowserTargetClaimError extends Error {
  constructor(
    readonly code:
      | 'TARGET_OWNED_BY_OTHER_SESSION'
      | 'TARGET_FENCED'
      | 'TARGET_STALE',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserTargetClaimError';
  }
}

interface ClaimRow {
  target_id: string;
  owner_id: string;
  session_id: string;
  adapter_id: string;
  browser_session_id: string;
  claim_epoch: number;
  claimed_at: number;
  heartbeat_at: number;
  expires_at: number;
  state: BrowserTargetClaimState;
}

const TARGET_ID = /^tab_[0-9]+$/;
const BROWSER_SESSION_ID = /^browser_[0-9a-f-]{36}$/;
const DEFAULT_LEASE_MS = 30_000;

function view(row: ClaimRow): BrowserTargetClaim {
  return Object.freeze({
    targetId: row.target_id,
    owner: Object.freeze({
      ownerId: row.owner_id,
      sessionId: row.session_id,
      adapterId: row.adapter_id,
    }),
    browserSessionId: row.browser_session_id,
    claimEpoch: Number(row.claim_epoch),
    claimedAt: Number(row.claimed_at),
    heartbeatAt: Number(row.heartbeat_at),
    expiresAt: Number(row.expires_at),
    state: row.state,
  });
}

function validateIdentity(targetId: string, browserSessionId: string): void {
  if (!TARGET_ID.test(targetId)) throw new Error('Browser target claim target id is invalid');
  if (!BROWSER_SESSION_ID.test(browserSessionId)) {
    throw new Error('Browser target claim browser session id is invalid');
  }
}

export class BrowserTargetClaimStore implements BrowserTargetClaimPort {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #leaseMs: number;
  #closed = false;

  constructor(
    path: string,
    options: { now?: () => number; leaseMs?: number } = {},
  ) {
    if (!isAbsolute(path)) throw new Error('Browser target claim store requires an absolute path');
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(this.#leaseMs) || this.#leaseMs < 5_000 || this.#leaseMs > 10 * 60_000) {
      throw new Error('Browser target claim lease is invalid');
    }

    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS browser_target_claims (
        target_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        browser_session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 1),
        claimed_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ACTIVE','RELEASED'))
      );
      CREATE INDEX IF NOT EXISTS browser_target_claim_owner_idx
        ON browser_target_claims(owner_id, session_id, adapter_id, state);
      CREATE INDEX IF NOT EXISTS browser_target_claim_expiry_idx
        ON browser_target_claims(state, expires_at);
    `);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  claim(owner: GatewayAuthority, targetId: string, browserSessionId: string): BrowserTargetClaim {
    this.#assertOpen();
    validateIdentity(targetId, browserSessionId);
    const now = this.#now();
    const expiresAt = now + this.#leaseMs;

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#get(targetId);
      if (!current) {
        this.#db.prepare(`
          INSERT INTO browser_target_claims (
            target_id, owner_id, session_id, adapter_id, browser_session_id,
            claim_epoch, claimed_at, heartbeat_at, expires_at, state
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'ACTIVE')
        `).run(
          targetId,
          owner.ownerId,
          owner.sessionId,
          owner.adapterId,
          browserSessionId,
          now,
          now,
          expiresAt,
        );
        this.#db.exec('COMMIT');
        return this.#required(targetId);
      }

      const currentOwner = {
        ownerId: current.owner_id,
        sessionId: current.session_id,
        adapterId: current.adapter_id,
      };
      const exactCurrent = current.state === 'ACTIVE'
        && current.expires_at > now
        && sameAuthorityTuple(currentOwner, owner)
        && current.browser_session_id === browserSessionId;

      if (exactCurrent) {
        this.#db.prepare(`
          UPDATE browser_target_claims
          SET heartbeat_at = ?, expires_at = ?
          WHERE target_id = ? AND claim_epoch = ? AND state = 'ACTIVE'
        `).run(now, expiresAt, targetId, current.claim_epoch);
        this.#db.exec('COMMIT');
        return this.#required(targetId);
      }

      if (current.state === 'ACTIVE' && current.expires_at > now) {
        throw new BrowserTargetClaimError(
          'TARGET_OWNED_BY_OTHER_SESSION',
          'Browser target is owned by another active session',
        );
      }

      const nextEpoch = Number(current.claim_epoch) + 1;
      this.#db.prepare(`
        UPDATE browser_target_claims
        SET owner_id = ?, session_id = ?, adapter_id = ?, browser_session_id = ?,
            claim_epoch = ?, claimed_at = ?, heartbeat_at = ?, expires_at = ?, state = 'ACTIVE'
        WHERE target_id = ? AND claim_epoch = ?
      `).run(
        owner.ownerId,
        owner.sessionId,
        owner.adapterId,
        browserSessionId,
        nextEpoch,
        now,
        now,
        expiresAt,
        targetId,
        current.claim_epoch,
      );
      this.#db.exec('COMMIT');
      return this.#required(targetId);
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  heartbeat(
    owner: GatewayAuthority,
    targetId: string,
    browserSessionId: string,
    claimEpoch: number,
  ): BrowserTargetClaim {
    this.#assertOpen();
    validateIdentity(targetId, browserSessionId);
    const now = this.#now();
    const expiresAt = now + this.#leaseMs;

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#assertOwnedCurrent(
        owner,
        targetId,
        browserSessionId,
        claimEpoch,
        now,
      );
      const updated = this.#db.prepare(`
        UPDATE browser_target_claims
        SET heartbeat_at = ?, expires_at = ?
        WHERE target_id = ? AND claim_epoch = ? AND state = 'ACTIVE'
      `).run(now, expiresAt, targetId, current.claim_epoch);
      if (Number(updated.changes) !== 1) {
        throw new BrowserTargetClaimError('TARGET_FENCED', 'Browser target claim lost its epoch');
      }
      this.#db.exec('COMMIT');
      return this.#required(targetId);
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  assertCurrent(
    owner: GatewayAuthority,
    targetId: string,
    browserSessionId: string,
    claimEpoch: number,
  ): BrowserTargetClaim {
    this.#assertOpen();
    validateIdentity(targetId, browserSessionId);
    return view(this.#assertOwnedCurrent(
      owner,
      targetId,
      browserSessionId,
      claimEpoch,
      this.#now(),
    ));
  }

  release(
    owner: GatewayAuthority,
    targetId: string,
    browserSessionId: string,
    claimEpoch: number,
  ): BrowserTargetClaim {
    this.#assertOpen();
    validateIdentity(targetId, browserSessionId);
    const now = this.#now();

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#required(targetId);
      if (current.claimEpoch !== claimEpoch
          || current.browserSessionId !== browserSessionId
          || !sameAuthorityTuple(current.owner, owner)) {
        throw new BrowserTargetClaimError('TARGET_FENCED', 'Browser target claim is fenced');
      }
      if (current.state !== 'ACTIVE') {
        throw new BrowserTargetClaimError('TARGET_STALE', 'Browser target claim is not active');
      }
      const updated = this.#db.prepare(`
        UPDATE browser_target_claims
        SET state = 'RELEASED', heartbeat_at = ?, expires_at = ?
        WHERE target_id = ? AND claim_epoch = ? AND state = 'ACTIVE'
      `).run(now, now, targetId, claimEpoch);
      if (Number(updated.changes) !== 1) {
        throw new BrowserTargetClaimError('TARGET_FENCED', 'Browser target claim lost its epoch');
      }
      this.#db.exec('COMMIT');
      return this.#required(targetId);
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  #assertOwnedCurrent(
    owner: GatewayAuthority,
    targetId: string,
    browserSessionId: string,
    claimEpoch: number,
    now: number,
  ): ClaimRow {
    if (!Number.isInteger(claimEpoch) || claimEpoch < 1) {
      throw new Error('Browser target claim epoch is invalid');
    }
    const current = this.#get(targetId);
    if (!current) {
      throw new BrowserTargetClaimError('TARGET_STALE', 'Browser target claim does not exist');
    }
    const exact = current.claim_epoch === claimEpoch
      && current.browser_session_id === browserSessionId
      && sameAuthorityTuple({
        ownerId: current.owner_id,
        sessionId: current.session_id,
        adapterId: current.adapter_id,
      }, owner);
    if (!exact) {
      throw new BrowserTargetClaimError('TARGET_FENCED', 'Browser target claim is fenced');
    }
    if (current.state !== 'ACTIVE' || current.expires_at <= now) {
      throw new BrowserTargetClaimError('TARGET_STALE', 'Browser target claim has expired');
    }
    return current;
  }

  #get(targetId: string): ClaimRow | undefined {
    return this.#db.prepare(
      'SELECT * FROM browser_target_claims WHERE target_id = ?',
    ).get(targetId) as ClaimRow | undefined;
  }

  #required(targetId: string): BrowserTargetClaim {
    const row = this.#get(targetId);
    if (!row) throw new Error('Browser target claim disappeared');
    return view(row);
  }

  #rollback(): void {
    try { this.#db.exec('ROLLBACK'); } catch { /* no active transaction */ }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Browser target claim store is closed');
  }
}
