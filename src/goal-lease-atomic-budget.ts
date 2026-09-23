import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LeaseDecision } from './goal-lease.js';

const FILE_BUDGET = 'WAG_GOAL_LEASE_ATOMIC_FILE_BUDGET';
const BYTE_BUDGET = 'WAG_GOAL_LEASE_ATOMIC_BYTE_BUDGET';
const DIFF_BUDGET = 'WAG_GOAL_LEASE_ATOMIC_DIFF_BUDGET';
const STALE_AUTHORITY = 'WAG_GOAL_LEASE_ATOMIC_STALE_AUTHORITY';
const MALFORMED_AUTHORITY = 'WAG_GOAL_LEASE_ATOMIC_MALFORMED_AUTHORITY';

/**
 * Durable, cross-process Goal Lease budget guard.
 *
 * The resolver is deliberately a read-before-write decision: it answers which lease may admit a
 * request. That is not enough for the final budget slot when two WAG processes share one durable
 * store — both can read the same spend before either process reserves it.
 *
 * `policyAdmitMutation` already inserts the POLICY_APPROVED authority row inside the store's
 * `BEGIN IMMEDIATE` transition. This trigger executes inside that same transaction, after SQLite
 * has serialized writers, and therefore turns the authority row into the atomic budget reservation.
 *
 * The guard lives in its own small module because the durable-store implementation is intentionally
 * large and is also the generic persistence primitive for non-Goal-Lease features. Installing this
 * schema invariant from the Goal Lease runtime keeps the security policy explicit at composition
 * time without reaching into the store's private DatabaseSync handle.
 */
const INSTALL_SQL = `
CREATE TRIGGER IF NOT EXISTS wag_goal_lease_atomic_budget_v1
BEFORE INSERT ON mutation_authority
WHEN NEW.authority = 'POLICY_APPROVED' AND NEW.lease_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM goal_leases WHERE lease_id = NEW.lease_id
    )
    THEN RAISE(ABORT, 'WAG_GOAL_LEASE_ATOMIC_STALE_AUTHORITY')
  END;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM goal_leases
      WHERE lease_id = NEW.lease_id
        AND (
          revoked_at IS NOT NULL
          OR NEW.admitted_at < not_before
          OR NEW.admitted_at >= expires_at
        )
    )
    THEN RAISE(ABORT, 'WAG_GOAL_LEASE_ATOMIC_STALE_AUTHORITY')
  END;

  SELECT CASE
    WHEN (
      SELECT json_valid(bindings)
      FROM goal_leases
      WHERE lease_id = NEW.lease_id
    ) <> 1
    THEN RAISE(ABORT, 'WAG_GOAL_LEASE_ATOMIC_MALFORMED_AUTHORITY')
  END;

  SELECT CASE
    WHEN (
      SELECT
        json_type(bindings, '$.maxFiles') IS NOT 'integer'
        OR json_type(bindings, '$.maxBytes') IS NOT 'integer'
        OR json_type(bindings, '$.maxDiffBytes') IS NOT 'integer'
        OR CAST(json_extract(bindings, '$.maxFiles') AS INTEGER) <= 0
        OR CAST(json_extract(bindings, '$.maxBytes') AS INTEGER) <= 0
        OR CAST(json_extract(bindings, '$.maxDiffBytes') AS INTEGER) <= 0
      FROM goal_leases
      WHERE lease_id = NEW.lease_id
    )
    THEN RAISE(ABORT, 'WAG_GOAL_LEASE_ATOMIC_MALFORMED_AUTHORITY')
  END;

  SELECT CASE
    WHEN NEW.diff_bytes < 0
      OR NEW.diff_bytes > (
        SELECT CAST(json_extract(bindings, '$.maxDiffBytes') AS INTEGER)
        FROM goal_leases
        WHERE lease_id = NEW.lease_id
      )
    THEN RAISE(ABORT, 'WAG_GOAL_LEASE_ATOMIC_DIFF_BUDGET')
  END;

  SELECT CASE
    WHEN (
      SELECT COUNT(DISTINCT workspace_id || char(10) || path)
      FROM mutation_authority
      WHERE lease_id = NEW.lease_id
    ) + 1 > (
      SELECT CAST(json_extract(bindings, '$.maxFiles') AS INTEGER)
      FROM goal_leases
      WHERE lease_id = NEW.lease_id
    )
    THEN RAISE(ABORT, 'WAG_GOAL_LEASE_ATOMIC_FILE_BUDGET')
  END;

  SELECT CASE
    WHEN (
      SELECT COALESCE(SUM(diff_bytes), 0)
      FROM mutation_authority
      WHERE lease_id = NEW.lease_id
    ) + NEW.diff_bytes > (
      SELECT CAST(json_extract(bindings, '$.maxBytes') AS INTEGER)
      FROM goal_leases
      WHERE lease_id = NEW.lease_id
    )
    THEN RAISE(ABORT, 'WAG_GOAL_LEASE_ATOMIC_BYTE_BUDGET')
  END;
END;
`;

/**
 * Install the persistent guard after SqliteDurableStore has created its base schema.
 *
 * Production Goal Lease state paths are absolute. Refusing anything else prevents a typo here from
 * silently creating a second SQLite database and leaving the real authority store unguarded.
 */
export function installGoalLeaseAtomicBudgetGuard(statePath: string): void {
  if (!isAbsolute(statePath)) {
    throw new Error('Goal Lease atomic budget guard requires an absolute state path');
  }

  const db = new DatabaseSync(statePath);
  try {
    // Schema installation is startup-only. A short busy wait makes two runtimes starting against
    // one store converge on the same IF NOT EXISTS trigger instead of racing DDL.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(INSTALL_SQL);
  } finally {
    db.close();
  }
}

/**
 * Translate only our closed trigger sentinels. Unknown SQLite failures still throw rather than
 * being mislabeled as a policy denial.
 */
export function goalLeaseAtomicBudgetDenial(error: unknown): LeaseDecision | undefined {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes(FILE_BUDGET)) {
    return {
      admitted: false,
      code: 'FILE_BUDGET_EXHAUSTED',
      detail: 'the durable Goal Lease file budget was exhausted before atomic reservation',
    };
  }
  if (message.includes(BYTE_BUDGET)) {
    return {
      admitted: false,
      code: 'BYTE_BUDGET_EXHAUSTED',
      detail: 'the durable Goal Lease byte budget was exhausted before atomic reservation',
    };
  }
  if (message.includes(DIFF_BUDGET)) {
    return {
      admitted: false,
      code: 'DIFF_TOO_LARGE',
      detail: 'the durable Goal Lease per-proposal budget was exceeded before atomic reservation',
    };
  }
  if (message.includes(STALE_AUTHORITY) || message.includes(MALFORMED_AUTHORITY)) {
    return {
      admitted: false,
      code: 'NO_LEASE',
      detail: 'the durable Goal Lease was no longer eligible at atomic reservation',
    };
  }
  return undefined;
}
