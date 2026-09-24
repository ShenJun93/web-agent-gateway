/**
 * Result of the trusted private-local autonomous policy.
 *
 * Goal Lease is retired from the execution plane. These codes describe only current local
 * runtime state and durable-record provenance; none imply a per-goal grant.
 */
export type PolicyDenialCode =
  | 'AUTONOMOUS_DISABLED'
  | 'KILL_SWITCH_ENGAGED'
  | 'RECORD_NOT_FOUND'
  | 'RECORD_NOT_PENDING'
  | 'WORKSPACE_NOT_GRANTED'
  | 'AUTHORITY_MISSING'
  | 'LEGACY_AUTHORITY_RETIRED';

export type PolicyDecision =
  | { admitted: true }
  | { admitted: false; code: PolicyDenialCode; detail: string };
