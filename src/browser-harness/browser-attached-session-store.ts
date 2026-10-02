import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';

import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';
import type {
  BrowserControlState,
  BrowserExecutionMode,
  BrowserSessionState,
} from './browser-port.js';

export interface DurableAttachedBrowserSession {
  readonly browserSessionId: string;
  readonly profileId: string;
  readonly owner: GatewayAuthority;
  readonly executionMode: Extract<BrowserExecutionMode, 'ATTACH_EXISTING' | 'AI_TAB_GROUP'>;
  readonly controlState: BrowserControlState;
  readonly rootTargetId: string;
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly claimEpoch: number;
  readonly claimExpiresAt: number;
  readonly groupId?: string;
  readonly groupTitle?: string;
  readonly aiOwned: boolean;
  readonly claims: ReadonlyMap<string, number>;
  readonly groupedTargets: ReadonlySet<string>;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly state: Extract<BrowserSessionState, 'ACTIVE' | 'RECOVERABLE' | 'CLOSED' | 'FAILED'>;
}

interface SessionRow {
  browser_session_id: string;
  profile_id: string;
  owner_id: string;
  session_id: string;
  adapter_id: string;
  execution_mode: 'ATTACH_EXISTING' | 'AI_TAB_GROUP';
  control_state: BrowserControlState;
  root_target_id: string;
  target_id: string;
  target_generation: number;
  claim_epoch: number;
  claim_expires_at: number;
  group_id: string | null;
  group_title: string | null;
  ai_owned: number;
  claims_json: string;
  grouped_targets_json: string;
  created_at: number;
  last_seen_at: number;
  state: 'ACTIVE' | 'RECOVERABLE' | 'CLOSED' | 'FAILED';
}

const SESSION_ID = /^browser_[0-9a-f-]{36}$/;
const TARGET_ID = /^tab_[0-9]+$/;
const MAX_CLAIMS = 32;
const MAX_GROUP_TITLE = 64;

function validateSessionId(value: string): void {
  if (!SESSION_ID.test(value)) throw new Error('Durable browser session id is invalid');
}

function parseClaims(value: string): ReadonlyMap<string, number> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Durable browser session claims are invalid'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_CLAIMS) {
    throw new Error('Durable browser session claims are invalid');
  }
  const result = new Map<string, number>();
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length !== 2
        || typeof item[0] !== 'string' || !TARGET_ID.test(item[0])
        || !Number.isInteger(item[1]) || item[1] < 1
        || result.has(item[0])) {
      throw new Error('Durable browser session claims are invalid');
    }
    result.set(item[0], item[1]);
  }
  return result;
}

function parseGroupedTargets(value: string): ReadonlySet<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Durable browser session groups are invalid'); }
  if (!Array.isArray(parsed) || parsed.length > MAX_CLAIMS) {
    throw new Error('Durable browser session groups are invalid');
  }
  const result = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'string' || !TARGET_ID.test(item) || result.has(item)) {
      throw new Error('Durable browser session groups are invalid');
    }
    result.add(item);
  }
  return result;
}

function view(row: SessionRow): DurableAttachedBrowserSession {
  const claims = parseClaims(row.claims_json);
  const groupedTargets = parseGroupedTargets(row.grouped_targets_json);
  if (!claims.has(row.root_target_id) || !claims.has(row.target_id)
      || claims.get(row.target_id) !== Number(row.claim_epoch)) {
    throw new Error('Durable browser session claim binding is inconsistent');
  }
  return Object.freeze({
    browserSessionId: row.browser_session_id,
    profileId: row.profile_id,
    owner: Object.freeze({
      ownerId: row.owner_id,
      sessionId: row.session_id,
      adapterId: row.adapter_id,
    }),
    executionMode: row.execution_mode,
    controlState: row.control_state,
    rootTargetId: row.root_target_id,
    targetId: row.target_id,
    targetGeneration: Number(row.target_generation),
    claimEpoch: Number(row.claim_epoch),
    claimExpiresAt: Number(row.claim_expires_at),
    ...(row.group_id === null ? {} : { groupId: row.group_id }),
    ...(row.group_title === null ? {} : { groupTitle: row.group_title }),
    aiOwned: row.ai_owned === 1,
    claims,
    groupedTargets,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    state: row.state,
  });
}

export class BrowserAttachedSessionStore {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('Browser attached-session store requires an absolute path');
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS browser_attached_sessions (
        browser_session_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('ATTACH_EXISTING','AI_TAB_GROUP')),
        control_state TEXT NOT NULL CHECK (control_state IN ('RUNNING','PAUSED_FOR_USER','USER_CONTROL','RESUMING','STOPPED')),
        root_target_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL CHECK (target_generation >= 0),
        claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 1),
        claim_expires_at INTEGER NOT NULL,
        group_id TEXT,
        group_title TEXT,
        ai_owned INTEGER NOT NULL DEFAULT 0 CHECK (ai_owned IN (0,1)),
        claims_json TEXT NOT NULL,
        grouped_targets_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ACTIVE','RECOVERABLE','CLOSED','FAILED'))
      );
      CREATE INDEX IF NOT EXISTS browser_attached_session_owner_idx
        ON browser_attached_sessions(owner_id, session_id, adapter_id, state);
      CREATE INDEX IF NOT EXISTS browser_attached_session_target_idx
        ON browser_attached_sessions(target_id, state);
    `);
    const columns = this.#db.prepare('PRAGMA table_info(browser_attached_sessions)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'ai_owned')) {
      this.#db.exec(
        'ALTER TABLE browser_attached_sessions ADD COLUMN ai_owned INTEGER NOT NULL DEFAULT 0 CHECK (ai_owned IN (0,1))',
      );
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  save(value: DurableAttachedBrowserSession): DurableAttachedBrowserSession {
    this.#assertOpen();
    validateSessionId(value.browserSessionId);
    if (!TARGET_ID.test(value.rootTargetId) || !TARGET_ID.test(value.targetId)
        || !Number.isInteger(value.targetGeneration) || value.targetGeneration < 0
        || !Number.isInteger(value.claimEpoch) || value.claimEpoch < 1
        || !Number.isInteger(value.claimExpiresAt)
        || !Number.isInteger(value.createdAt) || !Number.isInteger(value.lastSeenAt)
        || typeof value.aiOwned !== 'boolean'
        || value.claims.size < 1 || value.claims.size > MAX_CLAIMS
        || value.groupedTargets.size > MAX_CLAIMS
        || (value.groupTitle !== undefined && value.groupTitle.length > MAX_GROUP_TITLE)) {
      throw new Error('Durable browser session is invalid');
    }
    const claims = [...value.claims.entries()];
    for (const [targetId, epoch] of claims) {
      if (!TARGET_ID.test(targetId) || !Number.isInteger(epoch) || epoch < 1) {
        throw new Error('Durable browser session claims are invalid');
      }
    }
    if (!value.claims.has(value.rootTargetId)
        || value.claims.get(value.targetId) !== value.claimEpoch) {
      throw new Error('Durable browser session claim binding is inconsistent');
    }
    const groupedTargets = [...value.groupedTargets];
    if (groupedTargets.some((targetId) => !TARGET_ID.test(targetId))) {
      throw new Error('Durable browser session groups are invalid');
    }

    this.#db.prepare(`
      INSERT INTO browser_attached_sessions (
        browser_session_id, profile_id, owner_id, session_id, adapter_id,
        execution_mode, control_state, root_target_id, target_id, target_generation,
        claim_epoch, claim_expires_at, group_id, group_title, ai_owned, claims_json,
        grouped_targets_json, created_at, last_seen_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(browser_session_id) DO UPDATE SET
        profile_id = excluded.profile_id,
        owner_id = excluded.owner_id,
        session_id = excluded.session_id,
        adapter_id = excluded.adapter_id,
        execution_mode = excluded.execution_mode,
        control_state = excluded.control_state,
        root_target_id = excluded.root_target_id,
        target_id = excluded.target_id,
        target_generation = excluded.target_generation,
        claim_epoch = excluded.claim_epoch,
        claim_expires_at = excluded.claim_expires_at,
        group_id = excluded.group_id,
        group_title = excluded.group_title,
        ai_owned = excluded.ai_owned,
        claims_json = excluded.claims_json,
        grouped_targets_json = excluded.grouped_targets_json,
        last_seen_at = excluded.last_seen_at,
        state = excluded.state
    `).run(
      value.browserSessionId,
      value.profileId,
      value.owner.ownerId,
      value.owner.sessionId,
      value.owner.adapterId,
      value.executionMode,
      value.controlState,
      value.rootTargetId,
      value.targetId,
      value.targetGeneration,
      value.claimEpoch,
      value.claimExpiresAt,
      value.groupId ?? null,
      value.groupTitle ?? null,
      value.aiOwned ? 1 : 0,
      JSON.stringify(claims),
      JSON.stringify(groupedTargets),
      value.createdAt,
      value.lastSeenAt,
      value.state,
    );
    return this.required(value.owner, value.browserSessionId);
  }

  get(
    owner: GatewayAuthority,
    browserSessionId: string,
  ): DurableAttachedBrowserSession | undefined {
    this.#assertOpen();
    validateSessionId(browserSessionId);
    const row = this.#db.prepare(
      'SELECT * FROM browser_attached_sessions WHERE browser_session_id = ?',
    ).get(browserSessionId) as SessionRow | undefined;
    if (!row) return undefined;
    if (!sameAuthorityTuple({
      ownerId: row.owner_id,
      sessionId: row.session_id,
      adapterId: row.adapter_id,
    }, owner)) {
      throw new Error('Durable browser session is owned by another authority');
    }
    return view(row);
  }

  findRecoverable(
    owner: GatewayAuthority,
    profileId: string,
    executionMode: Extract<BrowserExecutionMode, 'ATTACH_EXISTING' | 'AI_TAB_GROUP'>,
    rootTargetId: string,
  ): DurableAttachedBrowserSession | undefined {
    this.#assertOpen();
    if (!TARGET_ID.test(rootTargetId)) throw new Error('Durable browser session root target is invalid');
    const row = this.#db.prepare(`
      SELECT * FROM browser_attached_sessions
      WHERE owner_id = ? AND session_id = ? AND adapter_id = ?
        AND profile_id = ? AND execution_mode = ? AND root_target_id = ?
        AND state IN ('ACTIVE','RECOVERABLE')
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(
      owner.ownerId,
      owner.sessionId,
      owner.adapterId,
      profileId,
      executionMode,
      rootTargetId,
    ) as SessionRow | undefined;
    return row ? view(row) : undefined;
  }

  findRecoverableOwned(
    owner: GatewayAuthority,
    profileId: string,
  ): DurableAttachedBrowserSession | undefined {
    this.#assertOpen();
    const row = this.#db.prepare(`
      SELECT * FROM browser_attached_sessions
      WHERE owner_id = ? AND session_id = ? AND adapter_id = ?
        AND profile_id = ? AND execution_mode = 'AI_TAB_GROUP' AND ai_owned = 1
        AND state IN ('ACTIVE','RECOVERABLE')
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(
      owner.ownerId,
      owner.sessionId,
      owner.adapterId,
      profileId,
    ) as SessionRow | undefined;
    return row ? view(row) : undefined;
  }

  findRecoverableByTarget(
    owner: GatewayAuthority,
    executionMode: Extract<BrowserExecutionMode, 'ATTACH_EXISTING' | 'AI_TAB_GROUP'>,
    rootTargetId: string,
  ): DurableAttachedBrowserSession | undefined {
    this.#assertOpen();
    if (!TARGET_ID.test(rootTargetId)) throw new Error('Durable browser session root target is invalid');
    const row = this.#db.prepare(`
      SELECT * FROM browser_attached_sessions
      WHERE owner_id = ? AND session_id = ? AND adapter_id = ?
        AND execution_mode = ? AND root_target_id = ?
        AND state IN ('ACTIVE','RECOVERABLE')
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(
      owner.ownerId,
      owner.sessionId,
      owner.adapterId,
      executionMode,
      rootTargetId,
    ) as SessionRow | undefined;
    return row ? view(row) : undefined;
  }

  markRecoverable(owner: GatewayAuthority, browserSessionId: string, lastSeenAt: number): void {
    this.#assertOpen();
    const current = this.required(owner, browserSessionId);
    if (current.state === 'CLOSED' || current.state === 'FAILED') return;
    this.#db.prepare(`
      UPDATE browser_attached_sessions
      SET state = 'RECOVERABLE', last_seen_at = ?
      WHERE browser_session_id = ?
    `).run(lastSeenAt, browserSessionId);
  }

  markClosed(
    owner: GatewayAuthority,
    browserSessionId: string,
    state: 'CLOSED' | 'FAILED',
    lastSeenAt: number,
  ): void {
    this.#assertOpen();
    this.required(owner, browserSessionId);
    this.#db.prepare(`
      UPDATE browser_attached_sessions
      SET state = ?, control_state = 'STOPPED', last_seen_at = ?
      WHERE browser_session_id = ?
    `).run(state, lastSeenAt, browserSessionId);
  }

  required(owner: GatewayAuthority, browserSessionId: string): DurableAttachedBrowserSession {
    const value = this.get(owner, browserSessionId);
    if (!value) throw new Error('Durable browser session was not found');
    return value;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Browser attached-session store is closed');
  }
}
