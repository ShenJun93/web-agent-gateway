export type V5StageEnvelope = {
  version: 5;
  type: 'run.stage';
  requestId: string;
  sessionId: string;
  delegationId?: string;
  tool: string;
  workspaceId: string;
  origin: string;
  arguments: unknown;
};
export type V5DispatchEnvelope = {
  version: 5;
  type: 'run.dispatch';
  requestId: string;
  sessionId: string;
  delegationId: string;
  proposalId: string;
};
export type V5ResultEnvelope = {
  version: 5;
  type: 'run.result';
  requestId: string;
  sessionId: string;
  proposalId: string;
  resultId: string;
};
export type V5ResponseEnvelope =
  | { version: 5; type: 'result'; requestId: string; result: unknown }
  | { version: 5; type: 'error'; requestId: string; error: { code: string; message: string } };

export type V5ReadOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

export interface StageAndDispatchInput {
  requestId: string;
  dispatchRequestId: string;
  sessionId: string;
  /** Opaque. A reference, never a credential: holding it grants nothing. */
  delegationId?: string;
  tool: string;
  workspaceId: string;
  origin: string;
  arguments: unknown;
}

export type StageAndDispatchOutcome =
  | { phase: 'stage'; ok: true; proposalId: string; dispatched: false }
  | { phase: 'stage'; ok: false; code: string; message: string }
  | { phase: 'dispatch'; ok: true; proposalId: string; dispatched: true; result: unknown }
  | { phase: 'dispatch'; ok: false; proposalId: string; code: string; message: string };

export const DELEGATED_DISPATCH_PROTOCOL_VERSION: 5;
export function buildStageEnvelope(input: StageAndDispatchInput): V5StageEnvelope;
export function buildDispatchEnvelope(input: {
  requestId: string; sessionId: string; delegationId: string; proposalId: string;
}): V5DispatchEnvelope;
export function buildResultEnvelope(input: {
  requestId: string; sessionId: string; proposalId: string; resultId: string;
}): V5ResultEnvelope;
export function readResponse(requestId: string, response: unknown): V5ReadOutcome;
export function stageAndDispatch(
  send: (envelope: unknown) => Promise<unknown>,
  input: StageAndDispatchInput,
): Promise<StageAndDispatchOutcome>;

export type V5HumanRunEnvelope = {
  version: 5;
  type: 'run.human';
  requestId: string;
  sessionId: string;
  proposalId: string;
};

export type HumanRunOutcome =
  | { phase: 'human'; ok: true; proposalId: string; result: unknown }
  | { phase: 'human'; ok: false; code: string; message: string };

export type BindOutcome =
  | {
    ok: true;
    /**
     * The authoritative session id WAG resolved from the correlation that was sent — a different
     * string, and the one every later envelope must carry.
     */
    sessionId: string | undefined;
    /** Opaque. A reference the caller may name to ask for the delegated path; never a grant. */
    delegationId: string | undefined;
  }
  | { ok: false; code: string; message: string };

export function buildHumanRunEnvelope(input: {
  requestId: string; sessionId: string; proposalId: string;
}): V5HumanRunEnvelope;

export function runAsHuman(
  send: (envelope: unknown) => Promise<unknown>,
  input: { requestId: string; sessionId: string; proposalId: string },
): Promise<HumanRunOutcome>;

export function bindSession(
  send: (envelope: unknown) => Promise<unknown>,
  input: { requestId: string; sessionId: string },
): Promise<BindOutcome>;
