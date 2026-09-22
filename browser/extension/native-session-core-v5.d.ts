/**
 * The v5 native port controller. See the module header for why it is a separate host from v4 and
 * why every verb is a round trip.
 */
export interface NativeDelegationSessionController {
  /**
   * Connect, handshake and bind. Takes the **correlation** the extension minted — not a session
   * id. WAG resolves it to a durable session, and `boundSessionId()` returns that.
   */
  ensureReady(correlationId: string): Promise<void>;
  /** One envelope out, its matching response back. Uninterpreted in both directions. */
  send(envelope: unknown): Promise<unknown>;
  isConnected(): boolean;
  /** The reference WAG offered at bind time, or undefined when no delegation is configured. */
  delegationId(): string | undefined;
  /** The authoritative session id WAG answered with. Not the correlation. */
  boundSessionId(): string | null;
}

export function createNativeDelegationSessionController(options: {
  connectNative(): chrome.runtime.Port;
  randomUUID(): string;
}): NativeDelegationSessionController;
