import type { StageAndDispatchInput, StageAndDispatchOutcome } from './delegated-dispatch-core-v5.js';
import type { DelegatedDiagnostics } from './delegated-diagnostics-v5.js';

/** Identities the delegated path has already decided. See the module header for what that means. */
export interface DelegatedObservationMemory {
  /** Loaded once, awaited before the first decision so a restart does not re-run anything. */
  ready(): Promise<void>;
  has(identity: string): boolean;
  remember(identity: string): void;
  size(): number;
}

export interface DelegatedObservationStorage {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(entries: Record<string, unknown>): Promise<void> | undefined;
}

export const MAX_REMEMBERED_DELEGATED: number;

export function createDelegatedObservationMemory(
  storageSession?: DelegatedObservationStorage,
): DelegatedObservationMemory;

export interface DelegatedRunAttemptInput {
  /** `proposalIdentity(session, tab, messageId, tool, args)` — the v4 queue's, deliberately. */
  identity: string;
  /** The correlation the extension minted. WAG resolves it to a different session id. */
  correlationId: string;
  call: { tool: string; arguments: unknown };
  origin: string;
}

/**
 * `undefined` when the delegated path was never attempted — no host, no delegation offered, no
 * workspace to bind to. Those go to the human queue. Anything else is a decision and does not.
 */
export type DelegatedRunAttemptOutcome =
  | undefined
  | { alreadyDecided: true }
  | { phase: 'stage'; ok: false; code: string; message: string }
  | { phase: 'stage'; ok: true; proposalId: string; dispatched: false }
  | { phase: 'dispatch'; ok: true; proposalId: string; dispatched: true; result: unknown }
  | { phase: 'dispatch'; ok: false; proposalId: string; code: string; message: string; indeterminate?: true };

export function createDelegatedRunAttempt(options: {
  delegation: {
    ensureReady(correlationId: string): Promise<void>;
    delegationId(): string | undefined;
    boundSessionId(): string | null;
    send(envelope: unknown): Promise<unknown>;
  };
  memory: DelegatedObservationMemory;
  /** The dispatch core's own `stageAndDispatch`; injected so a test can substitute a transport. */
  stageAndDispatch: (
    send: (envelope: unknown) => Promise<unknown>,
    input: StageAndDispatchInput,
  ) => Promise<StageAndDispatchOutcome>;
  randomUUID(): string;
  /**
   * One record per decision. Optional, defaults to a no-op, and the return value is ignored at
   * every call site — a diagnostic may never change what this path decides.
   */
  diagnostics?: DelegatedDiagnostics;
}): (input: DelegatedRunAttemptInput) => Promise<DelegatedRunAttemptOutcome>;
