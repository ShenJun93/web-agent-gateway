/**
 * The control plane: where delegations are issued, renewed and revoked.
 *
 * ## Who is allowed to call this
 *
 * A delegation removes a human gesture. Issuing one is therefore exactly as consequential as
 * granting a Goal Lease, and it carries the same rule (ADR-0028, `human-presence-boundary.md`):
 *
 *   **UI delegation issuance, renewal and revocation are human-only and out of band.**
 *   **Claude may use a delegation and must report on one. Claude may not create, widen, renew,**
 *   **or self-authorize one, and neither may anything Claude reads.**
 *
 * This module is the operator's tooling, not Claude's. It is reached from a local command a
 * person runs; it is not wired into any runtime that serves a browser, and a test asserts that.
 * Nothing here is a substitute for that rule — code cannot tell whose hands are on the keyboard,
 * which is precisely why the rule is written down rather than merely implemented.
 *
 * Two things do enforce a shape around it:
 *
 *  - a delegation is **inert unless named in local configuration**. The dispatch plane honours
 *    exactly the configured id, so a row that appeared by any other route authorises nothing.
 *  - nothing on the browser path can reach this module *or* the store methods behind it: the
 *    dispatch plane is handed a narrow port object that has no issuance method on it at runtime.
 *
 * ## What the runtime key is, and what it is not
 *
 * `ControllerPlaneKey` is minted by `createControllerPlaneKey` and recognised by identity through
 * a module-private `WeakSet`, so an object literal of the same shape is refused. That catches the
 * failure that actually threatens this design: a future wiring change handing a control plane to
 * something on the browser path.
 *
 * It is **not** a defence against a same-user attacker in this process, and it is **not** proof
 * that a human called it. Anything running here can call the factory. ADR-0019 already places
 * that adversary outside the containment claim.
 *
 * ## Immutability, and what "renew" therefore means
 *
 * A delegation is immutable once inserted, exactly as a Goal Lease is. Only revocation and the
 * supersession link mutate it, and both are one-way. So renewal is not an edit: it issues a
 * successor and retires the predecessor, in **one transaction** — see `renewUiDelegation` in the
 * store for why three separate statements were wrong.
 */
import { randomBytes } from 'node:crypto';
import {
  MAX_DELEGATION_WINDOW_MS,
  validateDelegationBindings,
  type UiDelegationBindings,
} from './goal-ui-delegation.js';
import type { SqliteDurableStore } from './durable-store.js';

/** Proof that the holder was constructed on the local controller path. Not forgeable by shape. */
export interface ControllerPlaneKey {
  readonly controllerId: string;
}

const mintedKeys = new WeakSet<object>();

/**
 * Mint a controller-plane key. Called where the operator's local tooling is assembled — never in
 * response to a message, and never from a protocol handler.
 */
export function createControllerPlaneKey(controllerId: string): ControllerPlaneKey {
  if (typeof controllerId !== 'string' || controllerId.length === 0) {
    throw new Error('a controller plane key needs a controller identity');
  }
  const key: ControllerPlaneKey = Object.freeze({ controllerId });
  mintedKeys.add(key);
  return key;
}

export class UiDelegationControlPlane {
  private readonly now: () => number;

  private readonly controllerId: string;

  constructor(private readonly options: {
    store: SqliteDurableStore;
    key: ControllerPlaneKey;
    now?: () => number;
  }) {
    // Identity, not shape. `{ controllerId: 'claude.local' }` is not a key, however it reads.
    if (typeof options.key !== 'object' || options.key === null || !mintedKeys.has(options.key)) {
      throw new Error('the control plane refuses a key it did not mint');
    }
    this.controllerId = options.key.controllerId;
    this.now = options.now ?? Date.now;
  }

  /**
   * Issue one bounded parent delegation for a goal.
   *
   * The window is validated here as well as at every use, and a third time inside the claim
   * transaction. Validating at use alone would leave the ceiling depending on a row nobody checked
   * when it was written; validating here alone would trust a row a same-user edit could change.
   */
  issue(input: {
    goalId: string;
    bindings: UiDelegationBindings;
    ttlMs: number;
    notBeforeMs?: number;
  }): { delegationId: string } {
    const prepared = this.prepare(input);
    // "One goal, one parent delegation" was a convention until a review pointed out that `issue`
    // enforced nothing: calling it twice produced two live rows for one goal and two full budgets.
    // `renew` is the way to replace one, because it retires the predecessor in the same
    // transaction and refuses a revoked or superseded one — checks this path would bypass.
    if (this.options.store.countLiveDelegationsForGoal(input.goalId, prepared.createdAt) > 0) {
      throw new Error(
        `Refusing to issue a second live delegation for ${input.goalId} — revoke or renew the existing one`,
      );
    }
    this.options.store.insertUiDelegation(prepared);
    return { delegationId: prepared.delegationId };
  }

  /** Everything a new delegation row needs, validated. Shared by `issue` and `renew`. */
  private prepare(input: {
    goalId: string; bindings: UiDelegationBindings; ttlMs: number; notBeforeMs?: number;
  }): {
    delegationId: string; goalId: string; controllerId: string;
    createdAt: number; notBefore: number; expiresAt: number; bindings: string;
  } {
    const malformed = validateDelegationBindings(input.bindings);
    if (malformed) throw new Error(`Refusing to issue a malformed UI delegation — ${malformed}`);
    if (input.bindings.goalId !== input.goalId) {
      throw new Error('a delegation must be bound to the goal it is issued for');
    }
    if (input.bindings.controllerId !== this.controllerId) {
      throw new Error('a delegation must be bound to the controller issuing it');
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error('a delegation needs a positive, finite lifetime');
    }
    if (input.ttlMs > MAX_DELEGATION_WINDOW_MS) {
      throw new Error(`a delegation may not exceed ${MAX_DELEGATION_WINDOW_MS}ms`);
    }
    const notBeforeMs = input.notBeforeMs ?? 0;
    if (!Number.isFinite(notBeforeMs) || notBeforeMs < 0) {
      throw new Error('a delegation start offset must be finite and not negative');
    }
    // Bounded by the same ceiling as the window. Unbounded, a four-hour delegation could be
    // scheduled to begin years away — harmless today, since issuing and naming are both human
    // acts, but a ceiling that only covers duration is half a ceiling.
    if (notBeforeMs > MAX_DELEGATION_WINDOW_MS) {
      throw new Error(`a delegation may not start more than ${MAX_DELEGATION_WINDOW_MS}ms from now`);
    }
    const createdAt = this.now();
    const notBefore = createdAt + notBeforeMs;
    return {
      delegationId: `uidel_${randomBytes(12).toString('hex')}`,
      goalId: input.goalId,
      controllerId: this.controllerId,
      createdAt,
      notBefore,
      expiresAt: notBefore + input.ttlMs,
      bindings: JSON.stringify(input.bindings),
    };
  }

  /**
   * Replace a delegation with a successor, in one transaction.
   *
   * A revoked or already-superseded predecessor is refused: renewing one would turn a deliberate
   * stop into a fresh full budget. The store enforces that inside the transaction, so this cannot
   * be raced.
   *
   * The caller still has to name the successor in local configuration for it to do anything. A
   * renewal that nobody configures is a row, not an authority.
   */
  renew(input: {
    delegationId: string;
    goalId: string;
    bindings: UiDelegationBindings;
    ttlMs: number;
  }): { ok: true; delegationId: string; superseded: string }
    | { ok: false; code: string; detail: string } {
    const successor = this.prepare(input);
    const outcome = this.options.store.renewUiDelegation({
      predecessorId: input.delegationId, successor, now: this.now(),
    });
    if (!outcome.ok) return outcome;
    return { ok: true, delegationId: successor.delegationId, superseded: input.delegationId };
  }

  /** One-way. Revoking twice is idempotent and reports false the second time, not an error. */
  revoke(delegationId: string): boolean {
    return this.options.store.revokeUiDelegation(delegationId, this.now());
  }
}
