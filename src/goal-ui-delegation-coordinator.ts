/**
 * The authority that answers "may this queued proposal be dispatched without a human click?"
 *
 * It sits outside the browser, on WAG's side of the native port. The extension asks; this
 * decides; the extension is never told anything it could use to decide for itself.
 *
 * Every fact judged is re-read here, immediately before the consequence:
 *
 *   - the delegation comes from the durable store and is re-parsed and re-validated per call, so
 *     one revoked or expired a millisecond ago is refused;
 *   - the session and adapter come from the *admitted connection*, not from the message, so a
 *     message claiming another session cannot borrow its delegation;
 *   - the nonce is consumed by a primary-key insert, so a replay loses the race rather than
 *     passing a check.
 *
 * The order matters and is deliberate: evaluate, then consume, then report. Consuming before
 * evaluating would burn a nonce on a refused request; reporting before consuming would leave a
 * window where two dispatches could both believe they were the first.
 */
import { randomBytes } from 'node:crypto';
import {
  evaluateUiDelegation,
  validateDelegationBindings,
  type DelegatedRunRequest,
  type DelegationDecision,
  type UiDelegationBindings,
} from './goal-ui-delegation.js';
import type { SqliteDurableStore } from './durable-store.js';

export interface DelegatedRunOutcome {
  readonly decision: DelegationDecision;
  /** Present only when admitted, so a caller cannot act on a refusal by ignoring `decision`. */
  readonly authorization?: {
    readonly delegationId: string;
    readonly goalId: string;
    readonly nonce: string;
    readonly tool: string;
    readonly dispatchedAt: number;
  };
}

/** A fresh single-use dispatch nonce. Generated here, never accepted from the browser. */
export function mintDispatchNonce(): string {
  return randomBytes(24).toString('base64url');
}

export class UiDelegationCoordinator {
  private readonly now: () => number;

  constructor(private readonly options: {
    store: SqliteDurableStore;
    now?: () => number;
    /** Consulted on every decision, before the delegation is loaded. */
    killSwitch?: () => boolean;
  }) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Register a bounded delegation.
   *
   * Out of band by construction: no browser-reachable surface calls this, and the bindings are
   * validated here as well as at use, because a row can change between the two moments.
   */
  grant(input: {
    goalId: string;
    controllerId: string;
    bindings: UiDelegationBindings;
    ttlMs: number;
    notBeforeMs?: number;
  }): { delegationId: string } {
    const malformed = validateDelegationBindings(input.bindings);
    if (malformed) throw new Error(`Refusing to grant a malformed UI delegation — ${malformed}`);
    if (input.bindings.goalId !== input.goalId) {
      throw new Error('a delegation must be bound to the goal it is granted for');
    }
    if (input.bindings.controllerId !== input.controllerId) {
      throw new Error('a delegation must be bound to the controller it is granted for');
    }
    const createdAt = this.now();
    const notBefore = createdAt + (input.notBeforeMs ?? 0);
    const delegationId = `uidel_${randomBytes(12).toString('hex')}`;
    this.options.store.insertUiDelegation({
      delegationId,
      goalId: input.goalId,
      controllerId: input.controllerId,
      createdAt,
      notBefore,
      expiresAt: notBefore + input.ttlMs,
      bindings: JSON.stringify(input.bindings),
    });
    return { delegationId };
  }

  revoke(delegationId: string): boolean {
    return this.options.store.revokeUiDelegation(delegationId, this.now());
  }

  /**
   * Decide one dispatch, and consume it if admitted.
   *
   * `connection` carries the identities WAG itself established at admission. They are passed
   * separately from `request` precisely so that the message cannot supply them: a request that
   * claims another session is compared against the session this connection actually holds.
   */
  authorizeRun(input: {
    request: Omit<DelegatedRunRequest, 'sessionId' | 'adapterId'>;
    connection: { sessionId: string; adapterId: string };
  }): DelegatedRunOutcome {
    const killSwitch = this.options.killSwitch?.() ?? false;
    const stored = this.options.store.getUiDelegationRow(input.request.delegationId);

    let bindings: UiDelegationBindings | undefined;
    if (stored) {
      try {
        bindings = JSON.parse(stored.bindings) as UiDelegationBindings;
      } catch {
        // Unparseable bindings deny; they are never treated as absent restrictions.
        return {
          decision: {
            admitted: false, code: 'DELEGATION_MALFORMED', detail: 'the stored bindings are not JSON',
          },
        };
      }
    }

    const request: DelegatedRunRequest = {
      ...input.request,
      sessionId: input.connection.sessionId,
      adapterId: input.connection.adapterId,
    };

    const decision = evaluateUiDelegation({
      delegation: stored && bindings
        ? {
          delegationId: stored.delegationId,
          createdAt: stored.createdAt,
          notBefore: stored.notBefore,
          expiresAt: stored.expiresAt,
          ...(stored.revokedAt === undefined ? {} : { revokedAt: stored.revokedAt }),
          bindings,
        }
        : undefined,
      now: this.now(),
      request,
      spend: this.options.store.uiDelegationSpend(request.delegationId, request.nonce),
      killSwitch,
    });
    if (!decision.admitted) return { decision };

    // Consume last, and let the database be the arbiter. Two callers that both passed the read
    // above cannot both insert this nonce; the loser is told it was a replay, which is true.
    const dispatchedAt = this.now();
    const consumed = this.options.store.recordDelegatedRun({
      delegationId: request.delegationId,
      nonce: request.nonce,
      dispatchedAt,
      tool: request.tool,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      origin: request.origin,
      proposalFingerprint: request.proposalFingerprint,
    });
    if (!consumed) {
      return {
        decision: {
          admitted: false, code: 'NONCE_REPLAYED', detail: 'this dispatch was already consumed',
        },
      };
    }

    return {
      decision: { admitted: true },
      authorization: {
        delegationId: request.delegationId,
        goalId: request.goalId,
        nonce: request.nonce,
        tool: request.tool,
        dispatchedAt,
      },
    };
  }
}
