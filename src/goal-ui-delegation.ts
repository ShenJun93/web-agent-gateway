/**
 * Goal UI Delegation v1 — letting an active, bounded goal drive Run without a human click.
 *
 * ## The problem, stated precisely
 *
 * Run is the transition from untrusted page text into a WAG proposal, and today it is a click in
 * the extension's side panel. That means **the human gate currently lives inside the browser**:
 * the gateway receives `native.postTool(request)` and cannot tell a human-clicked dispatch from
 * one the extension originated. Anything that made the extension dispatch on its own would
 * therefore be indistinguishable, in the durable record, from bypassing the gate.
 *
 * So this is not implemented as "the extension clicks its own button". It is implemented as a
 * second authority that **WAG** evaluates, outside the browser, from a durable record the browser
 * cannot write:
 *
 *   controller  -> registers a bounded delegation with WAG, out of band
 *   extension   -> asks WAG to dispatch a queued proposal under that delegation
 *   WAG         -> evaluates every binding, deterministically, and admits or refuses
 *   audit       -> records DELEGATED_RUN with the delegation and goal, distinctly from HUMAN_RUN
 *
 * The extension is transport. It cannot grant itself anything, and neither can the page: a
 * proposal originating from page content can only ever be *checked against* bounds that were
 * granted elsewhere, and a proposal outside them fails closed.
 *
 * ## What this deliberately does not do
 *
 * It does not weaken the PreToolUse guard, the browser read tier, or any WAG authority check.
 * Those refuse Claude driving the *UI*; this creates a different path that never touches the UI.
 * Nothing here is reachable by clicking, and the guard's refusals are unchanged.
 *
 * ## A pre-existing limitation this makes visible rather than fixes
 *
 * Because the gateway cannot distinguish a human-clicked dispatch from an extension-originated
 * one, an extension that *lied* — claiming a human ran something that no human ran — would not be
 * caught by this module. That was true before Goal UI Delegation and remains true. What changes
 * is that the honest path is now explicit and separately recorded, so DELEGATED_RUN is a fact in
 * the store rather than an inference. ADR-0029 states the residue.
 */

/** Every reason a delegated Run can be refused. Exhaustive; each is a denial. */
export type DelegationDenialCode =
  | 'NO_DELEGATION'
  | 'DELEGATION_MALFORMED'
  | 'DELEGATION_NOT_YET_VALID'
  | 'DELEGATION_EXPIRED'
  | 'DELEGATION_REVOKED'
  | 'KILL_SWITCH_ENGAGED'
  | 'GOAL_MISMATCH'
  | 'CONTROLLER_MISMATCH'
  | 'SESSION_MISMATCH'
  | 'ADAPTER_MISMATCH'
  | 'ORIGIN_NOT_ALLOWED'
  | 'TOOL_NOT_DELEGATED'
  | 'WORKSPACE_MISMATCH'
  | 'ACTION_LIMIT_REACHED'
  | 'NONCE_REPLAYED'
  | 'NONCE_MALFORMED'
  | 'PROPOSAL_IDENTITY_MISMATCH';

export type DelegationDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly code: DelegationDenialCode; readonly detail: string };

/**
 * Exactly what a delegation grants. Nothing is implied and no field has a permissive default.
 *
 * `allowedTools` is a subset of the adapter's surface, not the whole of it: a delegation for a
 * read benchmark has no business carrying `git.commit` merely because the surface exposes it.
 */
export interface UiDelegationBindings {
  /** The active goal this delegation belongs to. One goal, one delegation. */
  readonly goalId: string;
  /** The local controller permitted to use it — Claude's local identity, not a browser value. */
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
  /** How many dispatches this delegation may ever authorise. */
  readonly maxActions: number;
}

export interface UiDelegationRecord {
  readonly delegationId: string;
  readonly createdAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
  readonly bindings: UiDelegationBindings;
}

/** What the extension is asking WAG to dispatch, as WAG re-derives it — not as the page claims. */
export interface DelegatedRunRequest {
  readonly goalId: string;
  readonly controllerId: string;
  readonly delegationId: string;
  /** Single-use, per dispatch. A repeat is a replay and is refused. */
  readonly nonce: string;
  readonly tool: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  /** The page origin the proposal was observed on, derived from the sender by the extension. */
  readonly origin: string;
  /**
   * The proposal's identity as WAG computed it, and as the controller stated it when asking.
   * They must match: this is what stops a delegation being pointed at a different proposal than
   * the one the controller intended.
   */
  readonly proposalFingerprint: string;
  readonly expectedProposalFingerprint: string;
}

/** Facts the caller must have read from durable state immediately before asking. */
export interface DelegationSpend {
  /** Dispatches this delegation has already authorised, counted from durable rows. */
  readonly actionsUsed: number;
  /** Whether this exact nonce has already been consumed under this delegation. */
  readonly nonceAlreadyUsed: boolean;
}

const deny = (code: DelegationDenialCode, detail: string): DelegationDecision =>
  ({ admitted: false, code, detail });

/** The longest a UI delegation may live: shorter than a Goal Lease, because it drives the gate. */
export const MAX_DELEGATION_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Nonces are opaque but must be long enough that a collision is not a plausible accident. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Plain DNS labels only: letters, digits and internal hyphens, separated by dots.
 *
 * Anchored and non-backtracking in shape — each label is a bounded character class with a single
 * quantifier, so there is no nested repetition for a pathological input to exploit.
 */
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

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
    // The hostname is checked against real DNS label syntax, because `new URL` is more
    // permissive than a hostname is: `https://*.chatgpt.com` parses, and its `.origin` round
    // trips, so the round-trip check above accepts it. It would never *match* at dispatch —
    // comparison is exact — but storing a binding that reads as a wildcard and is not one is
    // how a hole gets introduced by someone later who trusts the appearance.
    if (!HOSTNAME_PATTERN.test(parsed.hostname)) {
      return `allowedOrigin ${origin} has a hostname that is not a plain DNS name`;
    }
  }
  if (!Number.isInteger(bindings.maxActions) || bindings.maxActions <= 0) {
    return 'maxActions must be a positive integer';
  }
  return undefined;
}

/**
 * The whole decision. Default-deny: nothing below returns an admission early, and every unknown
 * or malformed input lands in the deny arm.
 */
export function evaluateUiDelegation(input: {
  readonly delegation: UiDelegationRecord | undefined;
  readonly now: number;
  readonly request: DelegatedRunRequest;
  readonly spend: DelegationSpend;
  readonly killSwitch: boolean;
}): DelegationDecision {
  const { delegation, now, request, spend } = input;

  // Checked first, before the delegation is even loaded, so the local stop is unconditional.
  if (input.killSwitch) return deny('KILL_SWITCH_ENGAGED', 'the local kill switch is engaged');
  if (!delegation) return deny('NO_DELEGATION', 'no delegation, so Run remains a human gesture');

  const malformed = validateDelegationBindings(delegation.bindings);
  if (malformed) return deny('DELEGATION_MALFORMED', malformed);

  if (typeof delegation.revokedAt === 'number') {
    return deny('DELEGATION_REVOKED', `revoked at ${delegation.revokedAt}`);
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
  if (now < delegation.notBefore) return deny('DELEGATION_NOT_YET_VALID', `valid from ${delegation.notBefore}`);
  if (now >= delegation.expiresAt) return deny('DELEGATION_EXPIRED', `expired at ${delegation.expiresAt}`);

  const b = delegation.bindings;

  // Identity, in the order that makes a refusal most informative to the local operator.
  if (request.goalId !== b.goalId) return deny('GOAL_MISMATCH', 'this delegation belongs to another goal');
  if (request.controllerId !== b.controllerId) {
    return deny('CONTROLLER_MISMATCH', 'another controller may not use this delegation');
  }
  if (request.sessionId !== b.sessionId) {
    return deny('SESSION_MISMATCH', 'the adapter session is not the one delegated');
  }
  if (request.adapterId !== b.adapterId) {
    return deny('ADAPTER_MISMATCH', `adapter ${request.adapterId} is not the one delegated`);
  }
  if (request.workspaceId !== b.workspaceId) {
    return deny('WORKSPACE_MISMATCH', 'the workspace is not the one delegated');
  }

  // The origin is compared as an exact origin. A delegation for one provider page must not
  // authorise a proposal observed anywhere else, however similar the string looks.
  let origin: string;
  try { origin = new URL(request.origin).origin; }
  catch { return deny('ORIGIN_NOT_ALLOWED', 'the observed origin is not a URL'); }
  if (!b.allowedOrigins.includes(origin)) {
    return deny('ORIGIN_NOT_ALLOWED', `${origin} is not a delegated origin`);
  }

  if (!b.allowedTools.includes(request.tool)) {
    return deny('TOOL_NOT_DELEGATED', `${request.tool} is not delegated, whatever the surface exposes`);
  }

  // The proposal the controller meant must be the proposal WAG is about to run. Without this a
  // delegation could be pointed at a different queued proposal than the one it was asked for.
  if (typeof request.proposalFingerprint !== 'string' || request.proposalFingerprint.length === 0) {
    return deny('PROPOSAL_IDENTITY_MISMATCH', 'the proposal has no identity');
  }
  if (request.proposalFingerprint !== request.expectedProposalFingerprint) {
    return deny('PROPOSAL_IDENTITY_MISMATCH', 'the queued proposal is not the one delegated for');
  }

  if (!NONCE_PATTERN.test(request.nonce)) {
    return deny('NONCE_MALFORMED', 'the dispatch nonce is missing or malformed');
  }
  if (spend.nonceAlreadyUsed) {
    return deny('NONCE_REPLAYED', 'this dispatch was already authorised once');
  }

  if (!Number.isInteger(spend.actionsUsed) || spend.actionsUsed < 0) {
    return deny('DELEGATION_MALFORMED', 'the recorded action count is not a non-negative integer');
  }
  if (spend.actionsUsed + 1 > b.maxActions) {
    return deny('ACTION_LIMIT_REACHED', `the delegation has already authorised ${spend.actionsUsed} actions`);
  }

  return { admitted: true };
}
