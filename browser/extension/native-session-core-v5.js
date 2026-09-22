/**
 * The v5 native port controller (ADR-0029).
 *
 * Parallel to `native-session-core-v4.js`, and it connects to a **different native host** —
 * `com.openai.web_agent_gateway_v5` — because the two admit into different adapter identities and a
 * delegation binds one of them. One port with a mode flag would be one bug away from sending v5
 * envelopes to a v4 session, and v4 has no schema that would refuse them politely.
 *
 * ## Why this one is request/response and v4's is not
 *
 * v4's `postTool` is fire-and-forget: the tool result arrives later, on the same port, and the
 * worker matches it up. Every v5 verb is a round trip — stage returns the id you dispatch, dispatch
 * returns whether it was admitted — so a caller that could not await an answer could not use the
 * protocol at all. `send` here returns the response envelope and does not interpret it; reading it
 * is `readResponse`'s job in the dispatch core, which is also where the request-id comparison lives.
 *
 * ## What it knows about authority
 *
 * The delegation id WAG offers at bind time, and nothing else. No expiry, no budget, no goal, no
 * label. It stores that id so the caller can name it when asking for the delegated path, and if WAG
 * offers none it stays `undefined` and every proposal waits for a person.
 */
import { bindSession } from './delegated-dispatch-core-v5.js';
import { DELEGATED_REASONS } from './delegated-diagnostics-v5.js';

/**
 * Tag a failure with the class it belongs to, so the caller can report *which* silence this was.
 *
 * The error is still thrown and still caught in the same place, so control flow is untouched; the
 * tag only survives onto the object so a diagnostic can read it.
 */
function tagged(message, reason, code) {
  const error = new Error(message);
  error.wagReason = reason;
  if (typeof code === 'string') error.wagCode = code;
  return error;
}

const BROWSER_DELEGATION_PROTOCOL_VERSION = 5;

export function createNativeDelegationSessionController({ connectNative, randomUUID }) {
  let port = null;
  let helloVerified = false;
  // The authoritative session id WAG answered with, and the correlation that produced it. Two
  // values because they are two things: the extension knows the correlation, the gateway compares
  // the session id, and conflating them is what made an earlier draft refuse every real connection.
  let boundSession = null;
  let correlationForSession = null;
  let offeredDelegationId;
  const pending = new Map();
  let handshakeInProgress = null;

  function handleMessage(message) {
    const requestId = message?.requestId;
    if (typeof requestId !== 'string' || !pending.has(requestId)) return;
    const { resolve } = pending.get(requestId);
    pending.delete(requestId);
    // Resolved rather than rejected even for an error envelope: a refusal is an answer, and the
    // dispatch core reads the code out of it. Turning every refusal into a thrown exception would
    // lose the reason, which is the only part an operator can act on.
    resolve(message);
  }

  function handleDisconnect() {
    port = null;
    helloVerified = false;
    boundSession = null;
    correlationForSession = null;
    offeredDelegationId = undefined;
    const waiting = [...pending.values()];
    pending.clear();
    for (const { reject } of waiting) reject(new Error('Native messaging host disconnected'));
  }

  /** One round trip. The envelope goes out as given; the matching response comes back as given. */
  function send(envelope) {
    return new Promise((resolve, reject) => {
      if (!port) { reject(new Error('Native port not connected')); return; }
      const requestId = envelope?.requestId;
      if (typeof requestId !== 'string') { reject(new Error('envelope has no request id')); return; }
      if (pending.has(requestId)) { reject(new Error('duplicate request id in flight')); return; }
      pending.set(requestId, { resolve, reject });
      try { port.postMessage(envelope); }
      catch (error) { pending.delete(requestId); reject(error); }
    });
  }

  async function ensureReady(correlationId) {
    if (port && helloVerified && correlationForSession === correlationId) return;

    if (!port) {
      try { port = connectNative(); }
      catch (error) {
        throw tagged(
          `native host unavailable: ${error && error.message}`,
          DELEGATED_REASONS.HOST_UNAVAILABLE,
        );
      }
      port.onMessage.addListener(handleMessage);
      port.onDisconnect.addListener(handleDisconnect);
      helloVerified = false;
      boundSession = null;
      correlationForSession = null;
      offeredDelegationId = undefined;
    }

    if (handshakeInProgress) {
      await handshakeInProgress;
      if (port && helloVerified && correlationForSession === correlationId) return;
    }

    const handshake = (async () => {
      if (!helloVerified) {
        const hello = await send({
          version: BROWSER_DELEGATION_PROTOCOL_VERSION,
          type: 'hello',
          requestId: `ctl_hello_${randomUUID()}`,
        });
        if (hello?.type !== 'result' || hello?.result?.version !== BROWSER_DELEGATION_PROTOCOL_VERSION) {
          throw tagged(
            'Native host hello protocol mismatch',
            DELEGATED_REASONS.HANDSHAKE_FAILED,
            typeof hello?.error?.code === 'string' ? hello.error.code : undefined,
          );
        }
        helloVerified = true;
      }

      if (boundSession && correlationForSession !== correlationId) {
        await send({
          version: BROWSER_DELEGATION_PROTOCOL_VERSION,
          type: 'session.unbind',
          requestId: `ctl_unbind_${randomUUID()}`,
          sessionId: boundSession,
        });
        boundSession = null;
        correlationForSession = null;
        offeredDelegationId = undefined;
      }

      if (correlationForSession !== correlationId) {
        // `sessionId` here is the *correlation* this extension minted. WAG hashes it, resolves the
        // durable session it names, and answers with that session's authoritative id — a different
        // string. Every later envelope must carry the authoritative one, because that is what the
        // gateway compares against. Keeping the correlation would mean `SESSION_MISMATCH` on
        // everything after the bind.
        const bound = await bindSession(send, {
          requestId: `ctl_bind_${randomUUID()}`,
          sessionId: correlationId,
        });
        if (!bound.ok) {
          // A refused bind and an unreachable gateway look the same from here unless the code is
          // carried: the host answers both as an error envelope. `NO_RESPONSE` and a transport
          // code mean the link is gone; anything else is the gateway deciding.
          // Every code the dispatch core raises without the gateway having decided anything.
          // `VERSION_MISMATCH` belongs here and was missing: a responder that is not speaking v5
          // is a broken link, not a policy answer, and conflating the two is exactly the
          // indistinguishability this whole change exists to remove.
          const linkGone = bound.code === 'NO_RESPONSE' || bound.code === 'VERSION_MISMATCH'
            || bound.code === 'REQUEST_ID_MISMATCH' || bound.code === 'UNEXPECTED_TYPE';
          throw tagged(
            `session.bind refused: ${bound.code}`,
            linkGone ? DELEGATED_REASONS.LINK_UNAVAILABLE : DELEGATED_REASONS.BIND_REFUSED,
            bound.code,
          );
        }
        if (typeof bound.sessionId !== 'string' || bound.sessionId.length === 0) {
          throw tagged(
            'session.bind returned no session id',
            DELEGATED_REASONS.BIND_REFUSED,
            'NO_SESSION_ID',
          );
        }
        boundSession = bound.sessionId;
        correlationForSession = correlationId;
        offeredDelegationId = bound.delegationId;
      }
    })();

    handshakeInProgress = handshake;
    try {
      await handshake;
    } catch (error) {
      if (port && typeof port.disconnect === 'function') port.disconnect();
      handleDisconnect();
      throw error;
    } finally {
      if (handshakeInProgress === handshake) handshakeInProgress = null;
    }
  }

  return {
    ensureReady,
    send,
    isConnected: () => Boolean(port && helloVerified && boundSession !== null),
    /** The reference WAG offered, or undefined when no delegation is configured. */
    delegationId: () => offeredDelegationId,
    boundSessionId: () => boundSession,
  };
}
