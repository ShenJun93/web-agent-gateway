/**
 * The transport seam: one v5 envelope in, one v5 envelope out.
 *
 * This is the only place a browser message becomes a delegation call, and its whole job is to make
 * sure the message contributes **nothing but references**.
 *
 * ## The identity rule, which is the point of this file
 *
 * Every envelope carries a `sessionId`, because the native host framing needs one to route. This
 * router **never uses it as identity**. The identity handed to the dispatch plane comes from
 * `connection` — what the gateway established when it admitted the session — and the envelope's
 * `sessionId` is compared against it and refused on mismatch. So a message claiming another
 * session does not borrow that session's delegation; it gets `SESSION_MISMATCH` and nothing else.
 *
 * Without that comparison the field would be worse than useless: routable, plausible, and
 * attacker-chosen. With it, the field is a routing hint that must agree with a fact.
 *
 * ## What the router does not do
 *
 * It does not decide. Every refusal below is either a parse failure or a decision the dispatch
 * plane made; the router adds no policy of its own, and there is deliberately no branch here that
 * can admit something the plane refused. It also has no issuance verb to route, because the
 * protocol has none and the plane has none.
 */
import { BROWSER_DELEGATION_ADAPTER_ID } from './adapter-admission.js';
import {
  DELEGATED_DISPATCH_PROTOCOL_VERSION,
  DELEGATED_DISPATCH_VERBS,
  parseDelegatedDispatchRequest,
  type DelegatedDispatchRequestEnvelope,
  type DelegatedDispatchResponseEnvelope,
} from './browser-adapter/protocol-v5.js';
import type { ConnectionIdentity } from './goal-ui-delegation.js';
import type { UiDelegationDispatchPlane } from './goal-ui-delegation-dispatch.js';

/** A refusal code the transport itself can produce, as distinct from a policy decision. */
export type TransportRefusalCode =
  | 'ENVELOPE_MALFORMED'
  | 'SESSION_MISMATCH'
  | 'NOT_BOUND'
  | 'VERB_NOT_SUPPORTED';

export interface DelegatedDispatchRouterOptions {
  plane: UiDelegationDispatchPlane;
  /** The identity the gateway established at admission. Never read from an envelope. */
  connection: ConnectionIdentity;
}

const errorEnvelope = (requestId: string, code: string, message: string)
: DelegatedDispatchResponseEnvelope => ({
  version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
  type: 'error',
  requestId,
  // The protocol constrains error codes to `[A-Z0-9_]`; a policy code that somehow did not match
  // would produce an unparseable response, so it is normalised rather than trusted.
  error: { code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'REFUSED', message: message.slice(0, 8192) },
});

const resultEnvelope = (requestId: string, result: unknown): DelegatedDispatchResponseEnvelope => ({
  version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
  type: 'result',
  requestId,
  result: result as never,
});

/** A request id to answer a frame with when the frame was too malformed to have one. */
const UNKNOWN_REQUEST_ID = 'unknown.request';

export class DelegatedDispatchRouter {
  private bound = false;

  constructor(private readonly options: DelegatedDispatchRouterOptions) {
    // The ADR claimed "a v4 session cannot speak these verbs — the isolation is structural". It
    // was not: nothing compared the connection's adapter to v5's, so a review constructed a router
    // over a v4-identity connection and drove a full DELEGATED_RUN through it, with
    // `browser.chatgpt.native.operator.v4` written into the audit row. The only adapter check was
    // `connection.adapterId === bindings.adapterId`, which is self-referential — the bindings are
    // not constrained to any known identity either. Refusing here is what makes the claim true.
    if (options.connection.adapterId !== BROWSER_DELEGATION_ADAPTER_ID) {
      throw new Error(
        `Delegated dispatch refuses a ${options.connection.adapterId} connection; `
        + `only ${BROWSER_DELEGATION_ADAPTER_ID} may speak v5`,
      );
    }
  }

  /** For a reconnect: a fresh router starts unbound, exactly as a fresh native port does. */
  get isBound(): boolean { return this.bound; }

  handle(raw: unknown): DelegatedDispatchResponseEnvelope {
    let envelope: DelegatedDispatchRequestEnvelope;
    try {
      envelope = parseDelegatedDispatchRequest(raw);
    } catch (error) {
      // Includes every extra-field rejection: `.strict()` refuses a message carrying a goal, a
      // controller, an expiry, a budget or an authority label rather than ignoring it.
      const requestId = typeof (raw as { requestId?: unknown })?.requestId === 'string'
        && /^[A-Za-z0-9._:-]{8,128}$/.test((raw as { requestId: string }).requestId)
        ? (raw as { requestId: string }).requestId
        : UNKNOWN_REQUEST_ID;
      return errorEnvelope(
        requestId, 'ENVELOPE_MALFORMED',
        error instanceof Error ? error.message : 'the envelope is not a v5 request',
      );
    }

    if (envelope.type === 'hello') {
      return resultEnvelope(envelope.requestId, {
        version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
        adapterId: this.options.connection.adapterId,
      });
    }

    // `session.bind` is the one verb whose `sessionId` is deliberately *not* compared, and the
    // reason took a production wiring pass to notice.
    //
    // The extension mints a **correlation** and sends it as `sessionId`. The gateway hashes that
    // correlation and looks up — or creates — a durable session whose id is a *different*
    // `session_<uuid>`. The two have the same shape and are never the same value. Comparing them
    // at bind would refuse every real connection, and the fixture could not have caught it: it
    // used one value for both sides, so the comparison always held.
    //
    // Nothing is weakened by skipping it. Identity here comes from the bearer the gateway admitted,
    // not from the envelope — by the time this runs, admission has already happened and `connection`
    // is fixed. The bind response hands back the authoritative id, and every verb after this one is
    // compared against it. So the envelope's session goes from meaningless-at-bind to
    // checked-thereafter, rather than from forgeable to trusted.
    if (envelope.type === 'session.bind') {
      this.bound = true;
      // The offered id goes back so the extension knows *which* reference to name when it wants
      // the delegated path. It is a reference and not a grant: the plane honours exactly this id
      // and re-reads every binding, window and budget from durable rows, so a browser holding it
      // can ask and nothing more. Absent when none is configured — which is the browser learning
      // that it should stay on the human path, not learning anything about issuance.
      const offered = this.options.plane.offeredDelegationId;
      return resultEnvelope(envelope.requestId, {
        bound: true,
        // The authoritative session id, which the caller must use on every later envelope. It is
        // not a secret and not a capability: it names the connection the caller already holds.
        sessionId: this.options.connection.sessionId,
        ...(offered === undefined ? {} : { delegationId: offered }),
      });
    }

    // Identity: from the admitted connection, compared against what the envelope claims. A message
    // naming another session does not borrow that session's delegation — it gets SESSION_MISMATCH.
    if (envelope.sessionId !== this.options.connection.sessionId) {
      return errorEnvelope(
        envelope.requestId, 'SESSION_MISMATCH',
        'the envelope names a session this connection does not hold',
      );
    }

    if (envelope.type === 'session.unbind') {
      this.bound = false;
      return resultEnvelope(envelope.requestId, { bound: false });
    }
    if (!this.bound) {
      return errorEnvelope(envelope.requestId, 'NOT_BOUND', 'bind the session before using it');
    }
    if (envelope.type === 'ping') return resultEnvelope(envelope.requestId, { pong: true });
    if (envelope.type === 'verbs.list') {
      return resultEnvelope(envelope.requestId, { verbs: [...DELEGATED_DISPATCH_VERBS] });
    }

    if (envelope.type === 'run.stage') {
      const outcome = this.options.plane.stageProposal({
        connection: this.options.connection,
        ...(envelope.delegationId === undefined ? {} : { delegationId: envelope.delegationId }),
        tool: envelope.tool,
        workspaceId: envelope.workspaceId,
        origin: envelope.origin,
        arguments: envelope.arguments as never,
      });
      if (!outcome.staged) return errorEnvelope(envelope.requestId, outcome.code, outcome.detail);
      // The fingerprint goes back because the extension may want to show it; it is derived from
      // the stored row and is not accepted as input anywhere, so returning it grants nothing.
      return resultEnvelope(envelope.requestId, {
        proposalId: outcome.proposalId, fingerprint: outcome.fingerprint,
      });
    }

    if (envelope.type === 'run.dispatch') {
      // Exactly the two references, handed over as the plane's own request shape. Nothing else
      // from the envelope reaches it — not the session id, not the version, not the request id.
      const outcome = this.options.plane.authorizeDelegatedRun({
        connection: this.options.connection,
        request: { delegationId: envelope.delegationId, proposalId: envelope.proposalId },
      });
      if (!outcome.decision.admitted) {
        return errorEnvelope(envelope.requestId, outcome.decision.code, outcome.decision.detail);
      }
      const authorization = outcome.authorization;
      if (!authorization) {
        return errorEnvelope(envelope.requestId, 'REFUSED', 'admitted without an authorization');
      }
      // Deliberately narrow. The extension learns that its proposal was dispatched and under which
      // goal; it learns nothing it could replay, and nothing it did not already know.
      return resultEnvelope(envelope.requestId, {
        proposalId: authorization.proposalId,
        goalId: authorization.goalId,
        authority: 'DELEGATED_RUN',
        dispatchedAt: authorization.dispatchedAt,
      });
    }

    if (envelope.type === 'run.human') {
      // No delegation is consulted and no budget is touched. The store refuses a proposal staged
      // under a delegation, inside the transaction, so this verb cannot be used to run delegated
      // work off the books — which was a measured hole before that check existed.
      const outcome = this.options.plane.recordHumanRun({
        connection: this.options.connection,
        proposalId: envelope.proposalId,
      });
      if (!outcome.ok) return errorEnvelope(envelope.requestId, outcome.code, outcome.detail);
      return resultEnvelope(envelope.requestId, {
        proposalId: envelope.proposalId,
        authority: 'HUMAN_RUN',
      });
    }

    if (envelope.type === 'run.result') {
      const outcome = this.options.plane.attachResult({
        connection: this.options.connection,
        proposalId: envelope.proposalId,
        resultId: envelope.resultId,
      });
      if (!outcome.ok) return errorEnvelope(envelope.requestId, outcome.code, outcome.detail);
      return resultEnvelope(envelope.requestId, { attached: true });
    }

    // Unreachable while the union above is exhaustive; a new verb lands here rather than falling
    // through to something permissive.
    return errorEnvelope(UNKNOWN_REQUEST_ID, 'VERB_NOT_SUPPORTED', 'no such verb');
  }
}
