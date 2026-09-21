/**
 * Why the delegated path declined — the smallest thing that makes the failure classes distinct.
 *
 * ## Why this exists
 *
 * A live production attempt stalled here. The payload parsed, the native transport answered
 * `hello`, `session.bind` returned the right session and the right delegation, and the durable
 * store recorded nothing at all — because every failure on this path returns `undefined` and the
 * caller treats `undefined` as "not attempted". Four causes produced identical silence:
 *
 * ```text
 * no native host installed   -> undefined
 * handshake failed           -> undefined
 * no delegation offered      -> undefined
 * stale port, send rejected  -> STAGE_TRANSPORT_FAILED, not remembered
 * ```
 *
 * That silence is correct behaviour — the candidate goes to a person, which is the safe direction
 * — and it is also undiagnosable from outside. A path that cannot say why it declined is a path
 * whose failures are indistinguishable from its correct refusals.
 *
 * ## What this is not
 *
 * Not a new subsystem, not a control surface, and not a channel anything can act on. It is a
 * function that formats one record and hands it to `console`, which is the extension's existing
 * local log. `emit` returns nothing, is never awaited, and every call site ignores it — so a
 * diagnostic cannot change what the delegated path decides. That property is asserted by a test
 * rather than asserted here.
 *
 * ## What may appear in a record
 *
 * Reason codes, and identifiers that are already references rather than secrets: a delegation id
 * (which the gateway itself offers to the browser at bind), a proposal id, a session id, a tool
 * name, a workspace id. Nothing else — and `safeDetail` below truncates and strips anything that
 * is not one of those, because a record that quoted a refusal message could carry page text into
 * a log. Never included: bootstrap tokens, bearer tokens, operator credentials, file contents,
 * proposal arguments, or any part of a conversation.
 */

/** Every reason the delegated path can decline, as one closed set. */
export const DELEGATED_REASONS = Object.freeze({
  /** `chrome.runtime.connectNative` threw or the port closed immediately: host not installed. */
  HOST_UNAVAILABLE: 'HOST_UNAVAILABLE',
  /** The host is there but its discovery file is missing or names a gateway that is gone. */
  LINK_UNAVAILABLE: 'LINK_UNAVAILABLE',
  /** `hello` did not answer with the expected protocol version. */
  HANDSHAKE_FAILED: 'HANDSHAKE_FAILED',
  /** `session.bind` was refused by the gateway. */
  BIND_REFUSED: 'BIND_REFUSED',
  /** Bound, but the gateway offered no delegation: none is configured, so Run stays human. */
  NO_DELEGATION_OFFERED: 'NO_DELEGATION_OFFERED',
  /** The candidate cannot be staged under a delegation — for example it names no workspace. */
  CANDIDATE_NOT_ELIGIBLE: 'CANDIDATE_NOT_ELIGIBLE',
  /** The gateway refused to stage it. Carries the gateway's own reason code. */
  STAGE_REFUSED: 'STAGE_REFUSED',
  /** Staging never reached the gateway. Nothing was spent and the candidate may be retried. */
  STAGE_TRANSPORT_FAILED: 'STAGE_TRANSPORT_FAILED',
  /** The gateway refused the dispatch. Carries the gateway's own reason code. */
  DISPATCH_REFUSED: 'DISPATCH_REFUSED',
  /** Dispatched, and the answer was lost. May already have run; never offered to a person. */
  DISPATCH_INDETERMINATE: 'DISPATCH_INDETERMINATE',
  /** It ran. */
  DISPATCHED: 'DISPATCHED',
  /** Decided on an earlier observation; nothing was asked again. */
  ALREADY_DECIDED: 'ALREADY_DECIDED',
});

const REASONS = new Set(Object.values(DELEGATED_REASONS));

/** Identifier-shaped and short. Anything else is dropped rather than truncated into the log. */
const SAFE_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Keep only the fields that are references, and only when they look like references.
 *
 * Allow-list rather than deny-list: a field added to an outcome later is absent from a record
 * until someone adds it here deliberately, which is the same shape as the dispatch port.
 */
function safeDetail(detail) {
  const out = {};
  if (typeof detail !== 'object' || detail === null) return out;
  for (const key of ['code', 'sessionId', 'delegationId', 'proposalId', 'tool', 'workspaceId', 'phase']) {
    const value = detail[key];
    if (typeof value === 'string' && SAFE_VALUE.test(value)) out[key] = value;
  }
  return out;
}

/**
 * Build the console-backed emitter.
 *
 * `sink` is injectable so a test can capture records without a console, and so the default can
 * stay exactly one line. Failures inside the sink are swallowed: a diagnostic that threw would
 * change the outcome of the path it is reporting on, which is the one thing it must never do.
 */
export function createDelegatedDiagnostics(sink) {
  const write = sink ?? ((record) => {
    // eslint-disable-next-line no-console
    console.info('wag.delegation', JSON.stringify(record));
  });
  return function emit(reason, detail) {
    try {
      if (!REASONS.has(reason)) return;
      write({ at: Date.now(), reason, ...safeDetail(detail) });
    } catch {
      // A diagnostic may not affect the decision it describes.
    }
  };
}

/** Used where no diagnostics are wired, so call sites never branch on their presence. */
export const NO_DIAGNOSTICS = () => {};
