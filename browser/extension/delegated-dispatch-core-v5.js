/**
 * The extension side of delegated dispatch (ADR-0029), as a pure core.
 *
 * Parallel to `service-worker-core-v4.js` rather than an edit of it: v4 is frozen, and a v4
 * session must not gain dispatch authority by a file it already loads changing underneath it.
 *
 * ## What this deliberately does not do
 *
 * It does not decide anything. It builds two envelopes and reads the answers. Every question that
 * matters — is this delegation live, does it cover this tool, has the budget run out, did a human
 * authorise any of it — is answered on the other side of the native port, by WAG, from rows this
 * code cannot write. If this file were replaced wholesale by a hostile one, the worst it could do
 * is ask; the answers would not change.
 *
 * So there is no delegation state here, no expiry, no budget counter and no authority label. It
 * holds a delegation *id*, which is a reference and not a credential: possessing it grants nothing
 * because every binding is checked against facts the browser does not control.
 *
 * ## Why `run.stage` and `run.dispatch` are two calls
 *
 * Staging is inert and dispatch is the act. Splitting them is what lets WAG hold the candidate
 * itself: the arguments that eventually run are the ones in WAG's row, not the ones re-sent at
 * dispatch, so nothing about the proposal can change between the ask and the act. A single call
 * would have to carry the candidate *and* the request, and would have re-introduced exactly the
 * "trust what the browser sends" shape the whole design exists to avoid.
 *
 * ## Errors
 *
 * Every refusal comes back as an `error` envelope with a code. This core does not interpret them
 * beyond passing them on, and in particular it never retries a refusal: a refused dispatch means
 * WAG decided, and asking again is how a budget gets drained by a loop that thinks it knows better.
 */

/** The protocol revision this core speaks. A v4 port must not be handed these envelopes. */
export const DELEGATED_DISPATCH_PROTOCOL_VERSION = 5;

/**
 * Build the envelope that stages one parsed candidate.
 *
 * `delegationId` is optional and opaque. Naming one asks for the delegated path; omitting it
 * stages on the human path. The browser chooses which to *ask for*, never which applies: a
 * delegation id that is not the one named in WAG's local configuration is refused outright.
 */
export function buildStageEnvelope(input) {
  const envelope = {
    version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
    type: 'run.stage',
    requestId: input.requestId,
    sessionId: input.sessionId,
    tool: input.tool,
    workspaceId: input.workspaceId,
    origin: input.origin,
    arguments: input.arguments,
  };
  // Added only when present. An explicit `undefined` would be an own property, and the schema is
  // strict about the *set* of keys — so spelling it out would turn an absent delegation into a
  // malformed envelope.
  if (input.delegationId !== undefined) envelope.delegationId = input.delegationId;
  return envelope;
}

/**
 * Build the envelope that asks for a staged proposal to be dispatched.
 *
 * Two opaque references, and nothing else, by construction. There is no branch here that can add
 * a goal, a controller, an expiry, a budget or an authority label, because this function has no
 * such parameters — and the receiving schema would refuse them anyway rather than ignore them.
 */
export function buildDispatchEnvelope(input) {
  return {
    version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
    type: 'run.dispatch',
    requestId: input.requestId,
    sessionId: input.sessionId,
    delegationId: input.delegationId,
    proposalId: input.proposalId,
  };
}

/**
 * Build the envelope that runs a staged proposal on the **human** path.
 *
 * One reference. There is no `delegationId` parameter here and the schema has no such field, so
 * this envelope cannot become a delegated one by accident or by edit — and WAG refuses it outright
 * for a proposal that *was* staged under a delegation, inside the transaction, so it can never be
 * used to run delegated work without spending a slot.
 *
 * Sending it is not what makes a Run human. A person clicking Run in the side panel is; this is
 * how the panel tells WAG that happened, exactly as v4's `tool.call` was. The gateway cannot see
 * the click on either protocol.
 */
export function buildHumanRunEnvelope(input) {
  return {
    version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
    type: 'run.human',
    requestId: input.requestId,
    sessionId: input.sessionId,
    proposalId: input.proposalId,
  };
}

/** Build the envelope that records a dispatched proposal's result id. Also two references. */
export function buildResultEnvelope(input) {
  return {
    version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
    type: 'run.result',
    requestId: input.requestId,
    sessionId: input.sessionId,
    proposalId: input.proposalId,
    resultId: input.resultId,
  };
}

/**
 * Read one response envelope into a plain outcome.
 *
 * Anything that is not a well-formed `result` for the request we asked about is a refusal. A
 * response naming a different `requestId` is refused rather than matched loosely: on a shared
 * port, accepting the wrong answer is how one request's refusal becomes another's success.
 */
export function readResponse(requestId, response) {
  if (!response || typeof response !== 'object') {
    return { ok: false, code: 'NO_RESPONSE', message: 'no response envelope' };
  }
  if (response.version !== DELEGATED_DISPATCH_PROTOCOL_VERSION) {
    return { ok: false, code: 'VERSION_MISMATCH', message: 'response is not v5' };
  }
  if (response.requestId !== requestId) {
    return { ok: false, code: 'REQUEST_ID_MISMATCH', message: 'response answers another request' };
  }
  if (response.type === 'error') {
    const error = response.error || {};
    return { ok: false, code: String(error.code || 'REFUSED'), message: String(error.message || '') };
  }
  if (response.type !== 'result') {
    return { ok: false, code: 'UNEXPECTED_TYPE', message: `unexpected ${String(response.type)}` };
  }
  return { ok: true, result: response.result };
}

/**
 * Stage a candidate and, if it was staged under a delegation, ask for it to be dispatched.
 *
 * `send` is the caller's native-port round trip. Sequencing the two calls here keeps the
 * side-panel code from having to know that dispatch follows staging — and keeps the decision about
 * whether it *may* follow entirely on WAG's side.
 */
export async function stageAndDispatch(send, input) {
  // The two calls must be distinguishable, or the response guard below is not a guard: with both
  // ids equal, a transport that answered only the first call had its answer accepted as the
  // second's, and this function reported a dispatch that never happened. Refused before anything
  // is sent, because the alternative is a state lie that looks exactly like success.
  if (input.requestId === input.dispatchRequestId) {
    return {
      phase: 'stage', ok: false, code: 'REQUEST_IDS_NOT_DISTINCT',
      message: 'the stage and dispatch request ids must differ',
    };
  }
  const stageEnvelope = buildStageEnvelope(input);
  const staged = readResponse(stageEnvelope.requestId, await send(stageEnvelope));
  if (!staged.ok) return { phase: 'stage', ...staged };

  const proposalId = staged.result && staged.result.proposalId;
  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    return { phase: 'stage', ok: false, code: 'NO_PROPOSAL_ID', message: 'staging returned no id' };
  }
  // No delegation named means the human path: the proposal is queued and waits for a person. This
  // core does not press anything, and there is no branch here that could.
  if (input.delegationId === undefined) {
    return { phase: 'stage', ok: true, proposalId, dispatched: false };
  }

  const dispatchEnvelope = buildDispatchEnvelope({
    requestId: input.dispatchRequestId,
    sessionId: input.sessionId,
    delegationId: input.delegationId,
    proposalId,
  });
  const dispatched = readResponse(dispatchEnvelope.requestId, await send(dispatchEnvelope));
  if (!dispatched.ok) return { phase: 'dispatch', proposalId, ...dispatched };
  return { phase: 'dispatch', ok: true, proposalId, dispatched: true, result: dispatched.result };
}

/**
 * Run a proposal that was already staged, on the human path.
 *
 * Separate from `stageAndDispatch` because the two are reached at different moments by different
 * causes. A delegated run happens when the candidate is observed; a human run happens later, when
 * someone clicks. Folding them into one function would mean one call site had to hold a flag for
 * "has a person acted yet", and that flag would be the most security-relevant boolean in the
 * extension — which is precisely the kind of thing that must not live in the browser.
 */
export async function runAsHuman(send, input) {
  const envelope = buildHumanRunEnvelope(input);
  const answered = readResponse(envelope.requestId, await send(envelope));
  if (!answered.ok) return { phase: 'human', ...answered };
  return { phase: 'human', ok: true, proposalId: input.proposalId, result: answered.result };
}

/**
 * Bind a session and report which delegation, if any, WAG offered for it.
 *
 * The id that comes back is opaque and is the only thing the extension ever learns about the
 * delegation: no expiry, no budget, no goal, no authority label. It exists so the extension knows
 * which reference to name when it asks for the delegated path, and naming it is an *ask* — WAG
 * re-reads every binding from durable rows and refuses anything that does not match.
 *
 * `delegationId` absent means no delegation is offered and every proposal waits for a person.
 */
export async function bindSession(send, input) {
  const envelope = {
    version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
    type: 'session.bind',
    requestId: input.requestId,
    sessionId: input.sessionId,
    provider: 'chatgpt',
    origin: 'https://chatgpt.com',
  };
  const answered = readResponse(envelope.requestId, await send(envelope));
  if (!answered.ok) return { ok: false, code: answered.code, message: answered.message };
  const offered = answered.result && answered.result.delegationId;
  const authoritative = answered.result && answered.result.sessionId;
  return {
    ok: true,
    // The session id WAG resolved from the correlation we sent. It is *not* the value we sent —
    // the correlation is hashed and names a durable row whose id is a different string — and every
    // later envelope must carry this one, because this is what the gateway compares against.
    sessionId: typeof authoritative === 'string' && authoritative.length > 0 ? authoritative : undefined,
    // Normalised to undefined rather than passed through, so a malformed value cannot become a
    // delegation id the extension goes on to name.
    delegationId: typeof offered === 'string' && offered.length > 0 ? offered : undefined,
  };
}
