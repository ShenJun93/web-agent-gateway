/** Every reason the delegated path can decline, as one closed set. See the module header. */
export declare const DELEGATED_REASONS: {
  readonly HOST_UNAVAILABLE: 'HOST_UNAVAILABLE';
  readonly LINK_UNAVAILABLE: 'LINK_UNAVAILABLE';
  readonly HANDSHAKE_FAILED: 'HANDSHAKE_FAILED';
  readonly BIND_REFUSED: 'BIND_REFUSED';
  readonly NO_DELEGATION_OFFERED: 'NO_DELEGATION_OFFERED';
  readonly CANDIDATE_NOT_ELIGIBLE: 'CANDIDATE_NOT_ELIGIBLE';
  readonly STAGE_REFUSED: 'STAGE_REFUSED';
  readonly STAGE_TRANSPORT_FAILED: 'STAGE_TRANSPORT_FAILED';
  readonly DISPATCH_REFUSED: 'DISPATCH_REFUSED';
  readonly DISPATCH_INDETERMINATE: 'DISPATCH_INDETERMINATE';
  readonly DISPATCHED: 'DISPATCHED';
  readonly ALREADY_DECIDED: 'ALREADY_DECIDED';
};

export type DelegatedReason = (typeof DELEGATED_REASONS)[keyof typeof DELEGATED_REASONS];

/**
 * One record. Only reference-shaped fields ever appear; see `safeDetail` in the module for the
 * allow-list and why it is an allow-list.
 */
export interface DelegatedDiagnosticRecord {
  at: number;
  reason: DelegatedReason;
  code?: string;
  sessionId?: string;
  delegationId?: string;
  proposalId?: string;
  tool?: string;
  workspaceId?: string;
  phase?: string;
}

export type DelegatedDiagnostics = (reason: string, detail?: Record<string, unknown>) => void;

export declare function createDelegatedDiagnostics(
  sink?: (record: DelegatedDiagnosticRecord) => void,
): DelegatedDiagnostics;

export declare const NO_DIAGNOSTICS: DelegatedDiagnostics;
