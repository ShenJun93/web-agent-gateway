/**
 * Which goal, if any, is currently authorised to Run without a click on a given browser context.
 *
 * ## The question this exists to answer, and why it is asked at the effect and not at the Run
 *
 * ADR-0028 lifts **Approve** inside a Goal Lease. ADR-0029 lifts **Run** inside a Goal UI
 * Delegation. Each is bounded, each is issued by a human out of band, and — before this file —
 * neither knew the other existed. Composed, they are the only route from an untrusted page's text
 * to a durable effect with no human gesture at any step.
 *
 * That route should exist. What must not exist is the route arising *by accident*: a lease issued
 * on Tuesday for one purpose admitting work that a delegation issued on Wednesday for an unrelated
 * purpose proposed, because both happened to name the same session. Before this, the two grants
 * composed on coincidence — and the resulting authority was one no human had described.
 *
 * So `evaluateGoalLease` now asks which delegated goal is in force, and refuses a delegated adapter
 * whose goal the lease does not name. This module is the *only* thing that answers that question,
 * and it answers it the way every other fact in this design is obtained: by re-reading durable rows
 * immediately before the consequence.
 *
 * ## What it will not do
 *
 * It will not read a goal from a proposal, a message, a tool argument or anything the browser
 * supplied. The delegation row is written only by the control plane a human drives; the session and
 * adapter come from the durable mutation record, which the ordinary validation already produced.
 *
 * It returns `undefined` rather than throwing when anything is missing, unparseable, expired,
 * revoked, superseded or bound elsewhere. That is not a soft failure: on a delegated adapter the
 * policy treats `undefined` as `DELEGATED_GOAL_UNKNOWN` and denies. Fail-closed lives there, so
 * that this function can stay a total lookup with no way to raise on the effect path.
 */
import { MAX_DELEGATION_WINDOW_MS, type UiDelegationBindings } from './goal-ui-delegation.js';
import type { SqliteDurableStore } from './durable-store.js';

/** The narrowest read the resolution needs. Deliberately not the whole store. */
export interface DelegationProvenancePort {
  getUiDelegationRow: SqliteDurableStore['getUiDelegationRow'];
}

/**
 * Resolve the goal of the live configured delegation bound to this browser context.
 *
 * Every condition below is the same one the dispatch plane applies at Run, re-checked here because
 * the two happen at different moments and the row can change between them. A delegation revoked
 * after the proposal was staged must not still be able to unlock a lease.
 */
export function resolveDelegatedGoal(input: {
  readonly port: DelegationProvenancePort;
  /** The delegation named in local configuration. Absent means delegated Run is off entirely. */
  readonly configuredDelegationId: string | undefined;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly now: number;
}): string | undefined {
  if (input.configuredDelegationId === undefined) return undefined;

  const row = input.port.getUiDelegationRow(input.configuredDelegationId);
  if (!row) return undefined;
  if (row.revokedAt !== undefined) return undefined;
  if (row.supersededBy !== undefined) return undefined;
  if (!Number.isFinite(row.notBefore) || !Number.isFinite(row.expiresAt)) return undefined;
  if (row.expiresAt <= row.notBefore) return undefined;
  // The ceiling is re-applied because a row inserted by anything other than the control plane never
  // passed the control plane's check, and this is a consequence path.
  if (row.expiresAt - row.notBefore > MAX_DELEGATION_WINDOW_MS) return undefined;
  if (!(input.now >= row.notBefore)) return undefined;
  if (!(input.now < row.expiresAt)) return undefined;

  let bindings: UiDelegationBindings;
  try { bindings = JSON.parse(row.bindings) as UiDelegationBindings; }
  catch { return undefined; }
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) return undefined;

  // The binding must be to *this* context. A delegation held by another session or another adapter
  // says nothing about work that reached the effect path from here.
  if (bindings.sessionId !== input.sessionId) return undefined;
  if (bindings.adapterId !== input.adapterId) return undefined;

  const goalId = bindings.goalId;
  return typeof goalId === 'string' && goalId.length > 0 ? goalId : undefined;
}
