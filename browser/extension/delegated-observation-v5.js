/**
 * Deciding one observed candidate on the delegated path, and remembering that it was decided.
 *
 * Extracted from `service-worker.js` so it can be *executed* in a test rather than asserted against
 * as source text. That distinction is not cosmetic here: the defect this module exists to fix was
 * invisible to source assertions, because the missing call looked exactly like the code around it.
 *
 * ## The defect
 *
 * `queueProviderRequest` dedupes by `proposalIdentity(session, tab, messageId, tool, args)`, and its
 * header says why: "a rescan, a page reload, a worker restart, an extension reload and a side-panel
 * reopen all re-observe the same assistant message… which is why the live dogfood filled the panel
 * with duplicates."
 *
 * The delegated path ran *before* that call and was handed no `messageId`, so it inherited none of
 * it. Measured consequence: opening the side panel calls `attachAndRescan`, the content script
 * clears its own suppression map by design, and every completed turn is re-emitted — so every
 * in-scope proposal in the conversation staged, claimed, dispatched and **executed again**, spending
 * a budget slot each time. A conversation with ten proposals drained a `maxActions: 20` delegation
 * in two panel opens.
 *
 * `maxActions` held arithmetically throughout — every run really did spend a slot — which is exactly
 * why it did not look wrong from the store's side. The bound that failed was the one the extension
 * rule asserts: "reattachment and rescan are the extension's own job and are idempotent by proposal
 * identity."
 *
 * ## What counts as decided
 *
 * An identity is remembered once the delegated path reached a decision: it ran, WAG refused it, or
 * the dispatch was sent and the answer was lost. **Not** when the path was never attempted — no
 * host, no delegation offered, no workspace to bind to — because those are states that change, and
 * a candidate skipped today should be offerable when delegation is enabled tomorrow.
 *
 * Refusals are remembered deliberately. The dispatch core "never retries a refusal: a refused
 * dispatch means WAG decided, and asking again is how a budget gets drained by a loop that thinks it
 * knows better." A rescan is such a loop.
 */

import { DELEGATED_REASONS, NO_DIAGNOSTICS } from './delegated-diagnostics-v5.js';

/**
 * Which reason one `stageAndDispatch` outcome is.
 *
 * Reads the outcome the dispatch core already produces; it derives nothing new and decides
 * nothing. A shape it does not recognise reports as a stage refusal, which is the conservative
 * reading — the caller's own branching is unchanged either way.
 */
function classify(outcome) {
  if (outcome.ok) return DELEGATED_REASONS.DISPATCHED;
  if (outcome.code === 'STAGE_TRANSPORT_FAILED') return DELEGATED_REASONS.STAGE_TRANSPORT_FAILED;
  if (outcome.indeterminate === true) return DELEGATED_REASONS.DISPATCH_INDETERMINATE;
  if (outcome.phase === 'dispatch') return DELEGATED_REASONS.DISPATCH_REFUSED;
  return DELEGATED_REASONS.STAGE_REFUSED;
}

const DELEGATED_SEEN_KEY = 'wag.delegation.seen.v5';
/** Bounded like the v4 queue's own memory, and evicted in first-seen order. */
export const MAX_REMEMBERED_DELEGATED = 256;

/**
 * Identities the delegated path has already decided.
 *
 * Backed by `chrome.storage.session` for the same reason the queue is: MV3 suspends an idle worker
 * after about thirty seconds, and an identity that did not survive that would be no identity at all.
 * `storageSession` is optional so a test can exercise the pure behaviour.
 */
export function createDelegatedObservationMemory(storageSession) {
  const seen = new Set();
  let restored;

  const restore = async () => {
    if (!storageSession) return;
    try {
      const stored = await storageSession.get(DELEGATED_SEEN_KEY);
      const list = stored?.[DELEGATED_SEEN_KEY];
      if (Array.isArray(list)) {
        for (const key of list) if (typeof key === 'string' && key.length <= 4096) seen.add(key);
      }
    } catch {
      // A memory that cannot be read is an empty memory, which re-offers rather than suppresses.
      // That is the safe direction: a duplicate costs a slot, a wrongly suppressed one costs the work.
    }
  };

  const persist = () => {
    if (!storageSession) return;
    void storageSession.set({ [DELEGATED_SEEN_KEY]: [...seen] })?.catch?.(() => undefined);
  };

  return {
    /** Loaded once, and awaited before the first decision so a restart does not re-run anything. */
    ready() { restored ??= restore(); return restored; },
    has(identity) { return seen.has(identity); },
    remember(identity) {
      if (seen.has(identity)) return;
      seen.add(identity);
      if (seen.size > MAX_REMEMBERED_DELEGATED) seen.delete(seen.values().next().value);
      persist();
    },
    size() { return seen.size; },
  };
}

/**
 * Attempt one candidate on the delegated path.
 *
 * Returns an outcome when the path reached a decision, and `undefined` when it was never attempted.
 * Those are not the same thing and the caller must treat them differently: an undecided candidate
 * goes to the human queue, a decided one does not go there at all.
 *
 * Nothing here decides anything itself. It names a delegation id WAG handed it at bind time and
 * asks; WAG re-reads the row, the window, the budget and every binding, and answers.
 */
export function createDelegatedRunAttempt({
  delegation, memory, stageAndDispatch, randomUUID, diagnostics = NO_DIAGNOSTICS,
}) {
  return async function attempt({ identity, correlationId, call, origin }) {
    // Already decided once — a rescan, a panel open, a worker restart or an extension reload.
    if (memory.has(identity)) {
      diagnostics(DELEGATED_REASONS.ALREADY_DECIDED, {});
      return { alreadyDecided: true };
    }

    // The delegation binds one workspace, and a staged candidate must name the same one in its
    // arguments. A tool that resolves no workspace — `health`, and `workspace.open`, which takes a
    // path — cannot be matched against the binding at all, so it is left for a person. WAG refuses
    // these on the delegated path too; not asking is simply cheaper than being refused.
    const workspaceId = call.arguments && call.arguments.workspace_id;
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      diagnostics(DELEGATED_REASONS.CANDIDATE_NOT_ELIGIBLE, { tool: call.tool });
      return undefined;
    }

    try {
      await delegation.ensureReady(correlationId);
    } catch (error) {
      // No v5 native host installed, the link is gone, the handshake failed, or the bind was
      // refused. The ordinary state of a machine that has not enabled delegated Run, and
      // deliberately not remembered — but no longer indistinguishable: `ensureReady` classifies
      // which of the four it was and the record says so.
      diagnostics(
        (error && error.wagReason) || DELEGATED_REASONS.HOST_UNAVAILABLE,
        { code: error && error.wagCode, tool: call.tool },
      );
      return undefined;
    }

    const delegationId = delegation.delegationId();
    // WAG offered none, so none is configured and every proposal waits for a person.
    if (delegationId === undefined) {
      diagnostics(DELEGATED_REASONS.NO_DELEGATION_OFFERED, { tool: call.tool });
      return undefined;
    }

    const outcome = await stageAndDispatch(delegation.send, {
      requestId: `req_${randomUUID()}`,
      // Distinct by construction. Equal ids would let a stage answer be read as a dispatch answer,
      // and the core refuses that outright — but not generating them equal is cheaper than relying
      // on being refused.
      dispatchRequestId: `dsp_${randomUUID()}`,
      sessionId: delegation.boundSessionId(),
      delegationId,
      tool: call.tool,
      workspaceId,
      origin,
      arguments: call.arguments,
    });

    diagnostics(classify(outcome), {
      code: outcome.code,
      phase: outcome.phase,
      tool: call.tool,
      workspaceId,
      delegationId,
      proposalId: outcome.proposalId,
    });

    // A candidate that only failed to *reach* WAG is not decided, and may be offered to a person:
    // staging is inert, so nothing was spent and nothing ran.
    if (outcome.code === 'STAGE_TRANSPORT_FAILED') return outcome;
    memory.remember(identity);
    return outcome;
  };
}
