/**
 * Goal UI Delegation v1 — letting one bounded goal drive Run without a human click.
 *
 * ## The problem, stated precisely
 *
 * Run is the transition from untrusted page text into a WAG proposal, and today it is a click in
 * the extension's side panel. That means **the human gate currently lives inside the browser**:
 * the gateway receives `native.postTool(request)` and cannot tell a human-clicked dispatch from
 * one the extension originated. Anything that made the extension click its own button would be
 * indistinguishable, in the durable record, from bypassing the gate.
 *
 * So this is not "the extension clicks Run". It is a second authority that **WAG** evaluates,
 * outside the browser, over records the browser cannot write:
 *
 *   human       issues one bounded delegation out of band, and names it in local configuration
 *   extension   stages a parsed candidate, inert, and later asks for it to be dispatched
 *   WAG         loads both records, derives every fact itself, admits or refuses
 *   audit       DELEGATED_RUN / DELEGATED_RUN_REFUSED / HUMAN_RUN, all durable and distinct
 *
 * ## The three trust classes, which are the whole design
 *
 * Exactly three things feed a decision, and they are deliberately different kinds of thing:
 *
 *   1. the delegation record   — written only by the control plane. *Authority.*
 *   2. the staged proposal     — written by the browser, then immutable and inert. *Bounded data.*
 *   3. the connection identity — established by WAG at admission. *Authority, unforgeable.*
 *
 * The dispatch request itself carries **two opaque references and nothing else**. It has no goal,
 * no controller, no expiry, no budget, no fingerprint and no authority label, because a field
 * that is not in the message cannot be forged in the message. `parseDispatchRequest` refuses a
 * request carrying extra fields rather than ignoring them, so an attempt is visible instead of
 * silently discarded.
 *
 * ## Who may issue, which is the question that actually matters
 *
 * A delegation removes a human gesture, so issuing one is exactly as consequential as granting a
 * Goal Lease, and it follows the same rule (ADR-0028, `human-presence-boundary.md`):
 *
 *   **issuance, renewal and revocation are human-only and out of band. Claude may use a
 *   delegation and must report on one; it may not create, widen, renew or self-authorize one.**
 *
 * Local configuration may *name* a delegation. Naming grants nothing: the delegation's own
 * bindings, window and revocation still decide, an id absent from the store is refused rather
 * than treated as unrestricted, and — the point of `configuredDelegationId` here — a delegation
 * that exists in the store but is **not named in configuration is inert**. So a row minted by
 * anything other than the human's out-of-band path authorises nothing on its own.
 *
 * ## One parent, many children
 *
 * One human `/goal` is one **parent** delegation. It authorises many in-scope Run transitions
 * without a fresh grant per proposal — that is the point of it. What is single-use is the child:
 * each staged proposal may be dispatched at most once, and the budget slot is consumed by a
 * durable CLAIM transition rather than by a check (see `durable-store.ts`).
 *
 * ## What this deliberately does not do
 *
 * It does not weaken the PreToolUse guard, the browser read tier, or any WAG authority check.
 *
 * ## The residue, stated rather than hidden
 *
 * WAG still cannot verify that a human clicked. `HUMAN_RUN` therefore means exactly "no
 * delegation authorised this", which is what WAG can actually know — not "a person was present".
 * ADR-0029 states this.
 */
import { canonicalProposalFingerprint, NonCanonicalValueError } from './proposal-fingerprint.js';
import type { CanonicalValue } from './proposal-fingerprint.js';

/**
 * Every reason a delegated Run can be refused.
 *
 * Exhaustive over *decisions*. It is not exhaustive over outcomes: genuine write contention
 * raises out of the store rather than returning a code, which the contention test pins
 * deliberately — a lost write must be loud, not a quiet denial that reads like a policy answer.
 */
export type DelegationDenialCode =
  | 'REQUEST_MALFORMED'
  | 'NO_DELEGATION'
  | 'DELEGATION_NOT_CONFIGURED'
  | 'DELEGATION_MALFORMED'
  | 'DELEGATION_NOT_YET_VALID'
  | 'DELEGATION_EXPIRED'
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_SUPERSEDED'
  | 'KILL_SWITCH_ENGAGED'
  | 'DISPATCH_RATE_LIMITED'
  | 'NO_PROPOSAL'
  | 'PROPOSAL_MALFORMED'
  | 'PROPOSAL_INCONSISTENT'
  | 'PROPOSAL_NOT_STAGED'
  | 'PROPOSAL_NOT_FOR_THIS_DELEGATION'
  /**
   * The same logical action was already claimed under this delegation.
   *
   * Raised by the CLAIM transaction, over durable rows, so it holds when the extension's own
   * suppression memory is gone — an extension reload, a cleared `chrome.storage.session`, an
   * eviction, or a storage read that failed and read as empty. See `durable-store.ts`.
   */
  | 'PROPOSAL_REPLAY'
  | 'PROPOSAL_NOT_OWNED'
  | 'SESSION_MISMATCH'
  | 'ADAPTER_MISMATCH'
  | 'ORIGIN_NOT_ALLOWED'
  | 'TOOL_NOT_DELEGATED'
  | 'WORKSPACE_MISMATCH'
  | 'ACTION_LIMIT_REACHED';

export type DelegationDecision =
  | { readonly admitted: true; readonly fingerprint: string }
  | { readonly admitted: false; readonly code: DelegationDenialCode; readonly detail: string };

/**
 * The lifecycle of a staged proposal. Every transition is single-assignment in the store.
 *
 * ```text
 *   STAGED ──claim──▶ CLAIMED ──dispatch──▶ DISPATCHED ──result──▶ RESULTED
 *      │                  │
 *      │                  └──abandon (claim TTL elapsed)──▶ ABANDONED   [terminal]
 *      └──human run──▶ DISPATCHED ──result──▶ RESULTED
 * ```
 *
 * `CLAIMED` is the documented point at which a budget slot is spent. A refusal *before* the claim
 * leaves nothing behind at all; a refusal *after* it leaves the slot consumed, which is the
 * deliberate cost of making a crash between claim and dispatch un-resurrectable. `ABANDONED` is
 * terminal and is never dispatched: recovery releases nothing and re-runs nothing.
 */
export type ProposalState = 'STAGED' | 'CLAIMED' | 'DISPATCHED' | 'RESULTED' | 'ABANDONED';

/**
 * Exactly what a delegation grants. Nothing is implied and no field has a permissive default.
 *
 * `allowedTools` is a subset of the adapter's surface, not the whole of it: a delegation for a
 * read benchmark has no business carrying `git.commit` merely because the surface exposes it.
 */
export interface UiDelegationBindings {
  /** The active goal this delegation belongs to. One goal, one parent delegation. */
  readonly goalId: string;
  /** The local controller permitted to hold it — a local identity, never a browser value. */
  readonly controllerId: string;
  /** Page origins whose proposals may be dispatched. Exact origins, never patterns. */
  readonly allowedOrigins: readonly string[];
  /** Tool names, exact. A tool absent here is refused even if the adapter exposes it. */
  readonly allowedTools: readonly string[];
  /** The one workspace this delegation can act in. */
  readonly workspaceId: string;
  /** The admitted adapter session. A different session is a different browser context. */
  readonly sessionId: string;
  readonly adapterId: string;
  /** How many dispatches this parent delegation may ever authorise, across all its children. */
  readonly maxActions: number;
}

export interface UiDelegationRecord {
  readonly delegationId: string;
  readonly createdAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
  /** Set when a successor replaced this one. A superseded delegation authorises nothing. */
  readonly supersededBy?: string;
  readonly bindings: UiDelegationBindings;
}

/**
 * A candidate parsed from a page and handed to WAG, where it sits inert.
 *
 * Staging has no effect of any kind. It exists so that the thing dispatched later is a record WAG
 * holds rather than a payload the browser re-sends: the arguments cannot change between the ask
 * and the act, and the fingerprint is WAG's own derivation from these fields.
 */
export interface StagedProposalRecord {
  readonly proposalId: string;
  /**
   * The parent delegation this proposal was staged under, when it was staged under one.
   *
   * Absent for an ordinary proposal on the human path. Cross-goal use is refused by this field: a
   * second goal's delegation cannot pick up work staged under the first, and an undelegated
   * proposal matches no delegation at all.
   */
  readonly delegationId?: string;
  readonly tool: string;
  readonly workspaceId: string;
  readonly origin: string;
  readonly arguments: CanonicalValue;
  /** The identity WAG established for the connection that staged it. */
  readonly sessionId: string;
  readonly adapterId: string;
  readonly stagedAt: number;
  /** WAG's own fingerprint, stored at staging and re-derived at dispatch. */
  readonly fingerprint: string;
  readonly state: ProposalState;
}

/**
 * Identity WAG established when it admitted the connection. Never read from a message.
 *
 * All three come from admission. `sessionId` and `adapterId` are the ones a delegation binds;
 * `ownerId` is the local principal, carried so that per-caller limits key on the same tuple the
 * rest of the gateway already uses rather than on a second, subtly different notion of "caller".
 */
export interface ConnectionIdentity {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly adapterId: string;
}

/** Facts the caller read from durable state immediately before asking. */
export interface DelegationSpend {
  /** Slots this delegation has already claimed, counted from durable rows. */
  readonly actionsUsed: number;
}

/**
 * The entire vocabulary the browser may speak on this path: two opaque references.
 *
 * There is no goal here, no controller, no expiry, no budget and no authority label — by
 * construction, not by validation.
 */
export interface DelegatedDispatchRequest {
  readonly delegationId: string;
  readonly proposalId: string;
}

const deny = (code: DelegationDenialCode, detail: string): DelegationDecision =>
  ({ admitted: false, code, detail });

/** The longest a UI delegation may live: shorter than a Goal Lease, because it drives the gate. */
export const MAX_DELEGATION_WINDOW_MS = 4 * 60 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Plain DNS labels only: letters, digits and internal hyphens, separated by dots.
 *
 * Anchored, and each label is a bounded character class with a single quantifier, so there is no
 * nested repetition for a pathological input to exploit.
 */
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * Parse a dispatch request, refusing anything that carries more than the two references.
 *
 * Refusing rather than ignoring is deliberate. A request that tries to assert `goalId`,
 * `controllerId`, `expiresAt`, `maxActions`, `authority` or a fingerprint is an attempt to supply
 * authority from the untrusted side, and the operator should see a denial rather than have it
 * quietly dropped on the floor.
 */
export function parseDispatchRequest(value: unknown):
{ ok: true; request: DelegatedDispatchRequest } | { ok: false; detail: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, detail: 'a dispatch request must be an object' };
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.length !== 2 || keys[0] !== 'delegationId' || keys[1] !== 'proposalId') {
    return {
      ok: false,
      detail: `a dispatch request carries exactly delegationId and proposalId, saw [${keys.join(', ')}]`,
    };
  }
  const { delegationId, proposalId } = value as Record<string, unknown>;
  if (typeof delegationId !== 'string' || !ID_PATTERN.test(delegationId)) {
    return { ok: false, detail: 'delegationId is not a well-formed identifier' };
  }
  if (typeof proposalId !== 'string' || !ID_PATTERN.test(proposalId)) {
    return { ok: false, detail: 'proposalId is not a well-formed identifier' };
  }
  return { ok: true, request: { delegationId, proposalId } };
}

export function validateDelegationBindings(bindings: UiDelegationBindings): string | undefined {
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) {
    return 'bindings must be an object';
  }
  for (const field of ['goalId', 'controllerId', 'workspaceId', 'sessionId', 'adapterId'] as const) {
    if (typeof bindings[field] !== 'string' || bindings[field].length === 0) {
      return `${field} must be a non-empty string`;
    }
  }
  for (const field of ['allowedOrigins', 'allowedTools'] as const) {
    const value = bindings[field];
    // An empty list grants nothing. Reading it as "no restriction" is the classic way an
    // allowlist fails open, and it is refused here rather than at the point of use.
    if (!Array.isArray(value) || value.length === 0) return `${field} must list at least one entry`;
    if (value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      return `${field} entries must all be non-empty strings`;
    }
  }
  for (const origin of bindings.allowedOrigins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return `allowedOrigin ${origin} is not a URL`; }
    if (parsed.origin !== origin) return `allowedOrigin ${origin} must be an exact origin`;
    if (parsed.protocol !== 'https:') return `allowedOrigin ${origin} must be https`;
    // The hostname is checked against real DNS label syntax, because `new URL` is more permissive
    // than a hostname is: `https://*.chatgpt.com` parses and its `.origin` round-trips, so the
    // check above accepts it. It would never *match* at dispatch — comparison is exact — but
    // storing a binding that reads as a wildcard and is not one is how a hole gets introduced
    // later by someone who trusts the appearance.
    if (!HOSTNAME_PATTERN.test(parsed.hostname)) {
      return `allowedOrigin ${origin} has a hostname that is not a plain DNS name`;
    }
  }
  if (!Number.isInteger(bindings.maxActions) || bindings.maxActions <= 0) {
    return 'maxActions must be a positive integer';
  }
  return undefined;
}

function validateStagedProposal(proposal: StagedProposalRecord): string | undefined {
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    return 'a staged proposal must be an object';
  }
  for (const field of ['proposalId', 'tool', 'workspaceId', 'origin', 'sessionId', 'adapterId'] as const) {
    if (typeof proposal[field] !== 'string' || proposal[field].length === 0) {
      return `${field} must be a non-empty string`;
    }
  }
  if (typeof proposal.fingerprint !== 'string' || proposal.fingerprint.length === 0) {
    return 'the stored fingerprint is missing';
  }
  return undefined;
}

/**
 * The whole decision, over records rather than claims.
 *
 * Default-deny: every unknown, malformed or mismatched input lands in a deny arm, and the only
 * admission is the final line. Note what is *absent* from the parameters — there is no request
 * object here at all. The caller uses the request's two references to load these records; the
 * policy then judges the records, so nothing the browser said reaches this function except by
 * having been written into a row WAG itself wrote.
 */
export function evaluateDelegatedRun(input: {
  readonly killSwitch: boolean;
  /** The delegation named in local configuration. Absent means delegation is off entirely. */
  readonly configuredDelegationId: string | undefined;
  readonly delegation: UiDelegationRecord | undefined;
  readonly proposal: StagedProposalRecord | undefined;
  readonly connection: ConnectionIdentity;
  readonly now: number;
  readonly spend: DelegationSpend;
}): DelegationDecision {
  const { delegation, proposal, connection, now, spend } = input;

  // Checked first, before anything is loaded, so the local stop is unconditional.
  if (input.killSwitch) return deny('KILL_SWITCH_ENGAGED', 'the local kill switch is engaged');

  if (!delegation) return deny('NO_DELEGATION', 'no delegation, so Run remains a human gesture');

  // A delegation the human did not name in local configuration is inert, however valid its row
  // looks. This is what stops a delegation row that arrived by any route other than the human's
  // out-of-band one from authorising anything: the row alone is not the grant.
  if (input.configuredDelegationId !== delegation.delegationId) {
    return deny('DELEGATION_NOT_CONFIGURED', input.configuredDelegationId === undefined
      ? 'no delegation is configured, so autonomy is off'
      : 'that delegation is not the configured one');
  }

  const malformed = validateDelegationBindings(delegation.bindings);
  if (malformed) return deny('DELEGATION_MALFORMED', malformed);

  if (typeof delegation.revokedAt === 'number') {
    return deny('DELEGATION_REVOKED', `revoked at ${delegation.revokedAt}`);
  }
  if (typeof delegation.supersededBy === 'string' && delegation.supersededBy.length > 0) {
    // A renewed delegation is finished even if its revocation did not land. Two live delegations
    // for one goal would be two budgets, which is the opposite of what a ceiling is for.
    return deny('DELEGATION_SUPERSEDED', `superseded by ${delegation.supersededBy}`);
  }
  if (!Number.isFinite(now)) return deny('DELEGATION_MALFORMED', 'the clock is not finite');
  if (!Number.isFinite(delegation.notBefore) || !Number.isFinite(delegation.expiresAt)) {
    return deny('DELEGATION_MALFORMED', 'the validity window is not two finite numbers');
  }
  if (delegation.expiresAt <= delegation.notBefore) {
    return deny('DELEGATION_MALFORMED', 'the delegation expires before it begins');
  }
  if (delegation.expiresAt - delegation.notBefore > MAX_DELEGATION_WINDOW_MS) {
    return deny('DELEGATION_MALFORMED', `a delegation may not exceed ${MAX_DELEGATION_WINDOW_MS}ms`);
  }
  if (now < delegation.notBefore) {
    return deny('DELEGATION_NOT_YET_VALID', `valid from ${delegation.notBefore}`);
  }
  if (now >= delegation.expiresAt) return deny('DELEGATION_EXPIRED', `expired at ${delegation.expiresAt}`);

  if (!proposal) return deny('NO_PROPOSAL', 'there is no staged proposal with that id');
  const proposalMalformed = validateStagedProposal(proposal);
  if (proposalMalformed) return deny('PROPOSAL_MALFORMED', proposalMalformed);

  // Only a STAGED proposal may be claimed. Everything else — already claimed, already dispatched,
  // resulted, or abandoned after a crash — is terminal for this path and named exactly, so the
  // operator can tell "someone else got there first" from "this died and was reaped".
  if (proposal.state !== 'STAGED') {
    return deny('PROPOSAL_NOT_STAGED', `the proposal is ${proposal.state}, not STAGED`);
  }

  // A proposal belongs to the parent delegation it was staged under. This is what closes
  // cross-goal use: a second goal's delegation cannot pick up this goal's queued work.
  if (proposal.delegationId !== delegation.delegationId) {
    return deny('PROPOSAL_NOT_FOR_THIS_DELEGATION', 'that proposal was staged under another delegation');
  }

  const b = delegation.bindings;

  // The connection is WAG's own fact about who is talking. Both the delegation and the proposal
  // must agree with it — the delegation because it was granted for one browser context, the
  // proposal because a context may only run what it staged itself.
  if (connection.sessionId !== b.sessionId) {
    return deny('SESSION_MISMATCH', 'the adapter session is not the one delegated');
  }
  if (connection.adapterId !== b.adapterId) {
    return deny('ADAPTER_MISMATCH', `adapter ${connection.adapterId} is not the one delegated`);
  }
  if (proposal.sessionId !== connection.sessionId || proposal.adapterId !== connection.adapterId) {
    return deny('PROPOSAL_NOT_OWNED', 'that proposal was staged by a different browser context');
  }

  if (proposal.workspaceId !== b.workspaceId) {
    return deny('WORKSPACE_MISMATCH', 'the workspace is not the one delegated');
  }

  // Compared as an exact origin. A delegation for one provider page must not authorise a proposal
  // observed anywhere else, however similar the string looks.
  let origin: string;
  try { origin = new URL(proposal.origin).origin; }
  catch { return deny('ORIGIN_NOT_ALLOWED', 'the recorded origin is not a URL'); }
  if (origin !== proposal.origin || !b.allowedOrigins.includes(origin)) {
    return deny('ORIGIN_NOT_ALLOWED', `${proposal.origin} is not a delegated origin`);
  }

  if (!b.allowedTools.includes(proposal.tool)) {
    return deny('TOOL_NOT_DELEGATED', `${proposal.tool} is not delegated, whatever the surface exposes`);
  }

  // WAG's own derivation, recomputed now rather than trusted from the row.
  //
  // What this is: an internal-consistency check. It catches a partial write, and it catches a
  // future code path that edits a staged row and forgets the fingerprint column.
  //
  // What this is **not**: tamper evidence. The stored fingerprint is an unkeyed digest sitting in
  // the same row as the data it covers, computed by an exported function — so anyone who can
  // `UPDATE staged_proposals SET arguments = ?` can set `fingerprint = ?` in the same statement.
  // An earlier draft of this comment claimed the edit was "made visible". It is not, and ADR-0019
  // already places that adversary outside the containment claim.
  let fingerprint: string;
  try {
    fingerprint = canonicalProposalFingerprint({
      tool: proposal.tool,
      workspaceId: proposal.workspaceId,
      origin: proposal.origin,
      sessionId: proposal.sessionId,
      adapterId: proposal.adapterId,
      arguments: proposal.arguments,
    });
  } catch (error) {
    if (error instanceof NonCanonicalValueError) {
      return deny('PROPOSAL_MALFORMED', `the stored arguments have no canonical form: ${error.message}`);
    }
    throw error;
  }
  if (fingerprint !== proposal.fingerprint) {
    return deny('PROPOSAL_INCONSISTENT', 'the staged record no longer hashes to its stored identity');
  }

  if (!Number.isInteger(spend.actionsUsed) || spend.actionsUsed < 0) {
    return deny('DELEGATION_MALFORMED', 'the recorded action count is not a non-negative integer');
  }
  if (spend.actionsUsed + 1 > b.maxActions) {
    return deny('ACTION_LIMIT_REACHED', `the delegation has already claimed ${spend.actionsUsed} actions`);
  }

  return { admitted: true, fingerprint };
}
