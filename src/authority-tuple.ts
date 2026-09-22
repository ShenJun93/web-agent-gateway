/**
 * Are these the same authority? One definition, because there were already four.
 *
 * ## Why this module exists
 *
 * Owner, session and adapter together are *the* identity WAG compares before letting anything act
 * on a durable record. Adding the delegated path's workspace-ownership check needed that comparison
 * in two more places, and a reuse audit found the tree already carried four hand-written copies of
 * it:
 *
 * ```text
 * src/admitted-workspace.ts    sameAuthority(record, caller)
 * src/browser-verify-request.ts sameAuthority(expected, actual)
 * src/durable-verify-job.ts     sameAuthority(expected, actual)
 * src/durable-store.ts          sameAuthorityTuple(expected, actual)
 * ```
 *
 * Identical bodies, four names between them. That is how a rule ends up honoured in three places
 * and missed in the fourth — the same reason `delegationLivenessDenial` was consolidated after the
 * same audit found four copies of *it*. So the new call sites compose this instead of adding a
 * fifth and a sixth.
 *
 * ## What it deliberately does not do yet
 *
 * It does not migrate those four. They sit on the verify, mutation and workspace paths, outside the
 * blocker this milestone is allowed to touch, and each would need its own evidence. They are
 * recorded as a residual rather than quietly left unmentioned: this module is the place they should
 * converge on, and converging them is cheap and separable.
 *
 * ## Why it has no runtime imports
 *
 * `goal-ui-delegation.ts` is a pure, synchronous, I/O-free policy over durable records, and a
 * predicate this small should not be the thing that gives it a dependency on the caller-context
 * schema, the store or the DevSpace executor. The type comes from `caller-context.ts` as a
 * type-only import, which costs nothing at runtime; the comparison is three string equalities.
 */
import type { GatewayAuthority } from './caller-context.js';

export type { GatewayAuthority };

/**
 * True only when all three fields match.
 *
 * Every field is load-bearing and none is redundant. A session id is unique, but a delegated caller
 * and a v4 caller can hold *different* sessions over the same records, and two local principals can
 * exist on one machine — so "the same session" is not "the same authority", and neither is "the
 * same owner". The whole tuple, every time.
 */
export function sameAuthorityTuple(a: GatewayAuthority, b: GatewayAuthority): boolean {
  return a.ownerId === b.ownerId
    && a.sessionId === b.sessionId
    && a.adapterId === b.adapterId;
}
