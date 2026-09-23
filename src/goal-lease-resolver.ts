import type { SqliteDurableStore } from './durable-store.js';
import {
  evaluateGoalLease,
  type GoalLeaseBindings,
  type GoalLeaseRecord,
  type LeaseDenialCode,
  type LeaseRequest,
  type LeaseSpend,
} from './goal-lease.js';

export interface ResolvedGoalLease {
  readonly lease: GoalLeaseRecord;
  readonly spend: LeaseSpend;
}

export type GoalLeaseResolution =
  | { readonly admitted: true; readonly resolved: ResolvedGoalLease }
  | { readonly admitted: false; readonly code: LeaseDenialCode | 'AMBIGUOUS_LEASE'; readonly detail: string };

function parseLease(
  store: SqliteDurableStore,
  leaseId: string,
  spendOverride?: LeaseSpend,
): ResolvedGoalLease | undefined {
  const row = store.getGoalLeaseRow(leaseId);
  if (!row) return undefined;
  let bindings: GoalLeaseBindings;
  try {
    bindings = JSON.parse(row.bindings) as GoalLeaseBindings;
  } catch {
    return undefined;
  }
  return {
    lease: {
      leaseId: row.leaseId,
      createdAt: row.createdAt,
      notBefore: row.notBefore,
      expiresAt: row.expiresAt,
      ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
      bindings,
    },
    spend: spendOverride ?? store.goalLeaseSpend(row.leaseId),
  };
}

/**
 * Resolve autonomous authority from every durable Goal Lease at the moment of consequence.
 *
 * One candidate must admit every request in the set. This matters for multi-path commits: authority
 * from lease A may never be combined with authority from lease B to admit one commit. Zero matching
 * leases deny, one authorizes, and more than one is denied as ambiguous.
 */
export function resolveGoalLease(
  store: SqliteDurableStore,
  input: {
    readonly now: number;
    readonly requests: readonly LeaseRequest[];
    readonly killSwitch: boolean;
    readonly gatewayRoot?: string;
    /**
     * Narrow execution-boundary override used when an effect already has a durable authority row.
     * It lets the caller re-check the exact authority envelope without double-counting that same
     * effect. Ordinary admission must omit this and always uses durable spend.
     */
    readonly spendOverrides?: ReadonlyMap<string, LeaseSpend>;
  },
): GoalLeaseResolution {
  if (input.requests.length === 0) {
    return { admitted: false, code: 'NO_LEASE', detail: 'no consequential request to authorize' };
  }

  const matches: ResolvedGoalLease[] = [];

  for (const leaseId of store.listGoalLeaseIds()) {
    const candidate = parseLease(store, leaseId, input.spendOverrides?.get(leaseId));
    if (!candidate) continue;

    let admitsAll = true;
    for (const request of input.requests) {
      const decision = evaluateGoalLease({
        lease: candidate.lease,
        now: input.now,
        request,
        spend: candidate.spend,
        killSwitch: input.killSwitch,
        ...(input.gatewayRoot === undefined ? {} : { gatewayRoot: input.gatewayRoot }),
      });
      if (!decision.admitted) {
        admitsAll = false;
        break;
      }
    }
    if (admitsAll) matches.push(candidate);
  }

  if (matches.length === 1) return { admitted: true, resolved: matches[0]! };
  if (matches.length > 1) {
    return {
      admitted: false,
      code: 'AMBIGUOUS_LEASE',
      detail: `${matches.length} durable Goal Leases admit the same consequential request`,
    };
  }
  return {
    admitted: false,
    code: 'NO_LEASE',
    detail: 'no durable Goal Lease admits the complete consequential request',
  };
}
