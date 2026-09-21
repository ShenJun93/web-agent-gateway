/**
 * The dispatch plane: the only delegation surface anything on the browser path may reach.
 *
 * It can stage a candidate, ask for one to be dispatched, and record a Run that no delegation
 * authorised. It cannot issue, widen, renew or revoke a delegation.
 *
 * ## Why this file does not take the store
 *
 * An earlier draft took `SqliteDurableStore` and claimed the module split was the capability
 * boundary. An adversarial review demolished that in one line: `insertUiDelegation` is a public
 * method on the store, so the dispatch plane could mint a delegation with an arbitrary goal,
 * controller and eleven-hour window **without importing the control module at all** — and every
 * import-pinning test still passed, because they matched module specifiers and class names.
 *
 * So the boundary is now the object itself. `createDelegationDispatchPort` returns a frozen plain
 * object carrying only the methods below. Type erasure does not matter here: at runtime the plane
 * holds a thing that has no `insertUiDelegation` to call. That is checked dynamically, by calling
 * it, not only by grepping the tree.
 *
 * ## Where each fact in a decision comes from
 *
 *   the delegation record   loaded by the id in the request, and only honoured when it is the id
 *                           named in local configuration. The *id* is a reference, not a
 *                           credential: holding it grants nothing.
 *   the staged proposal     loaded from the store. Its arguments are the ones staged, not the ones
 *                           re-sent, so they cannot change between the ask and the act.
 *   the identity            from `connection`, which WAG established at admission. Passed
 *                           separately from `request` so a message cannot supply its own.
 *   the fingerprint         computed here, from the stored row, every time. Never accepted.
 *
 * ## Order of operations
 *
 * Evaluate, then claim, then dispatch. Evaluating first means a refusal spends nothing. The claim
 * is the documented moment a budget slot is spent; a refusal after it leaves the slot spent, which
 * is recorded in the refusal row so reading the audit back cannot get it wrong.
 */
import { randomBytes } from 'node:crypto';
import {
  evaluateDelegatedRun,
  MAX_DELEGATION_WINDOW_MS,
  parseDispatchRequest,
  validateDelegationBindings,
  type ConnectionIdentity,
  type DelegationDecision,
  type DelegationDenialCode,
  type StagedProposalRecord,
  type ProposalState,
  type UiDelegationBindings,
  type UiDelegationRecord,
} from './goal-ui-delegation.js';
import { validateStageableArguments } from './browser-adapter/protocol-v5.js';
import { canonicalProposalFingerprint, NonCanonicalValueError } from './proposal-fingerprint.js';
import { createProposalRateLimit, type ProposalRateLimit } from './proposal-rate-limit.js';
import type { CanonicalValue } from './proposal-fingerprint.js';
import type { SqliteDurableStore } from './durable-store.js';

/**
 * Exactly what the browser-reachable plane may do to the store.
 *
 * Nothing that issues, renews, revokes or supersedes a delegation appears here, and the object
 * handed over really does lack those methods at runtime.
 */
export interface DelegationDispatchPort {
  getUiDelegationRow: SqliteDurableStore['getUiDelegationRow'];
  getStagedProposalRow: SqliteDurableStore['getStagedProposalRow'];
  insertStagedProposal: SqliteDurableStore['insertStagedProposal'];
  countStagedProposals: SqliteDurableStore['countStagedProposals'];
  countOpenStagedProposals: SqliteDurableStore['countOpenStagedProposals'];
  countAllStagedProposals: SqliteDurableStore['countAllStagedProposals'];
  countDelegationClaims: SqliteDurableStore['countDelegationClaims'];
  hasDelegationClaimForFingerprint: SqliteDurableStore['hasDelegationClaimForFingerprint'];
  claimDelegatedDispatch: SqliteDurableStore['claimDelegatedDispatch'];
  markDelegatedDispatched: SqliteDurableStore['markDelegatedDispatched'];
  recordHumanRun: SqliteDurableStore['recordHumanRun'];
  recordDelegatedRunRefusal: SqliteDurableStore['recordDelegatedRunRefusal'];
  attachRunResult: SqliteDurableStore['attachRunResult'];
}

/** The methods a dispatch port carries. Exported so a test can assert the surface exactly. */
export const DELEGATION_DISPATCH_PORT_METHODS = [
  'getUiDelegationRow', 'getStagedProposalRow', 'insertStagedProposal',
  'countStagedProposals', 'countOpenStagedProposals', 'countAllStagedProposals',
  'countDelegationClaims', 'hasDelegationClaimForFingerprint',
  'claimDelegatedDispatch', 'markDelegatedDispatched',
  'recordHumanRun', 'recordDelegatedRunRefusal', 'attachRunResult',
] as const;

/**
 * Narrow a store to the dispatch surface.
 *
 * Frozen, and built by enumerating the allowed names rather than by deleting the disallowed ones,
 * so a method added to the store in future is absent here until someone adds it deliberately.
 */
export function createDelegationDispatchPort(store: SqliteDurableStore): DelegationDispatchPort {
  const port: Record<string, unknown> = {};
  for (const method of DELEGATION_DISPATCH_PORT_METHODS) {
    port[method] = (store[method] as (...args: never[]) => unknown).bind(store);
  }
  return Object.freeze(port) as unknown as DelegationDispatchPort;
}

export interface DelegatedRunOutcome {
  readonly decision: DelegationDecision;
  /** Present only when the proposal really reached DISPATCHED, so a refusal cannot be acted on. */
  readonly authorization?: {
    readonly proposalId: string;
    readonly delegationId: string;
    readonly goalId: string;
    readonly controllerId: string;
    readonly fingerprint: string;
    readonly tool: string;
    readonly workspaceId: string;
    readonly dispatchedAt: number;
  };
  /** True when the refusal happened after the durable CLAIM, so a slot was spent. */
  readonly slotClaimed: boolean;
}

export type StageRefusalCode =
  | DelegationDenialCode
  | 'STAGING_LIMIT_REACHED'
  | 'STAGING_RATE_LIMITED'
  | 'STAGING_INPUT_INVALID';

export type StageOutcome =
  | { readonly staged: true; readonly proposalId: string; readonly fingerprint: string }
  | { readonly staged: false; readonly code: StageRefusalCode; readonly detail: string };

const refuseStage = (code: StageRefusalCode, detail: string): StageOutcome =>
  ({ staged: false, code, detail });

/**
 * How many un-Run proposals one browser context may be holding at once.
 *
 * A delegated proposal is already bounded by its delegation's `maxActions`. An *undelegated* one
 * answers to no delegation, so this is the only queue bound it has.
 */
export const MAX_OPEN_STAGED_PER_SESSION = 64;

/**
 * How many proposals one browser context may ever stage, in any state.
 *
 * The queue bound alone was not a bound: it counts open rows, and completing a Run frees a slot,
 * so a stage/run loop grew the tables without limit. A review measured that. This caps the total,
 * and the rate limit below caps how fast it can be approached.
 */
export const MAX_TOTAL_STAGED_PER_SESSION = 512;

/** Refusal rows kept per browser context. An audit the browser can drive needs a ceiling too. */
export const MAX_REFUSAL_ROWS_PER_SESSION = 256;

/** A claim that never reached a dispatch is retired after this long, and never run. */
export const CLAIM_TTL_MS = 60_000;

const MAX_TOOL_LENGTH = 128;
const MAX_WORKSPACE_LENGTH = 256;
const MAX_ORIGIN_LENGTH = 2048;

export class UiDelegationDispatchPlane {
  private readonly now: () => number;

  private readonly killSwitch: () => boolean;

  private readonly configuredDelegationId: string | undefined;

  private readonly port: DelegationDispatchPort;

  private readonly rateLimit: ProposalRateLimit;

  private readonly dispatchRateLimit: ProposalRateLimit;

  /**
   * The configured delegation id, for the transport to hand back at bind time.
   *
   * A reference, not a credential. The browser has to name a delegation to ask for the delegated
   * path, and it cannot invent an id that would be honoured — the plane compares every staged and
   * dispatched id against exactly this one, and everything else about the delegation is re-read
   * from durable rows. So telling the browser which id to name gives it nothing it could not
   * already have obtained by guessing, and saves it from asserting issuance state, which is the
   * thing it genuinely must never do.
   *
   * `undefined` when none is configured, and that is the honest answer: no delegation is offered,
   * so the browser should stay on the human path.
   */
  get offeredDelegationId(): string | undefined { return this.configuredDelegationId; }

  constructor(options: {
    port: DelegationDispatchPort;
    /**
     * Required, not optional. The Goal Lease paths make their stop callback mandatory for the
     * reason a review found here: an optional one read as `?? false`, so a construction site that
     * forgot it silently disabled the local stop for the whole delegated path, and no test pinned
     * the default. An emergency stop that can be omitted is not an emergency stop.
     */
    killSwitch: () => boolean;
    /**
     * The delegation named in local configuration, if any.
     *
     * Absent means delegated Run is off entirely and every proposal stays on the human path.
     * Naming one grants nothing on its own — the row's own bindings, window, supersession and
     * revocation still decide — but a delegation that is *not* named here is inert whatever its
     * row says, which is what keeps issuance a human act.
     */
    configuredDelegationId?: string;
    now?: () => number;
    rateLimit?: ProposalRateLimit;
    /** Separate from `rateLimit` so staging and dispatch have legible, independent budgets. */
    dispatchRateLimit?: ProposalRateLimit;
  }) {
    if (typeof options.killSwitch !== 'function') {
      throw new Error('the dispatch plane requires a kill switch; an omitted stop is not a stop');
    }
    this.port = options.port;
    this.killSwitch = options.killSwitch;
    this.configuredDelegationId = options.configuredDelegationId;
    this.now = options.now ?? Date.now;
    this.rateLimit = options.rateLimit ?? createProposalRateLimit({
      message: 'Gateway denied staging: too many attempts',
    });
    this.dispatchRateLimit = options.dispatchRateLimit ?? createProposalRateLimit({
      message: 'Gateway denied dispatch: too many attempts',
    });
  }

  /** Load a delegation and re-parse its bindings, per call — never cached. */
  private loadDelegation(delegationId: string):
  { ok: true; record: UiDelegationRecord } | { ok: false; code: DelegationDenialCode; detail: string } {
    const stored = this.port.getUiDelegationRow(delegationId);
    if (!stored) return { ok: false, code: 'NO_DELEGATION', detail: 'no delegation with that id' };
    let bindings: UiDelegationBindings;
    try { bindings = JSON.parse(stored.bindings) as UiDelegationBindings; }
    catch {
      // Unparseable bindings deny. They are never read as an absence of restrictions.
      return { ok: false, code: 'DELEGATION_MALFORMED', detail: 'the stored bindings are not JSON' };
    }
    return {
      ok: true,
      record: {
        delegationId: stored.delegationId,
        createdAt: stored.createdAt,
        notBefore: stored.notBefore,
        expiresAt: stored.expiresAt,
        ...(stored.revokedAt === undefined ? {} : { revokedAt: stored.revokedAt }),
        ...(stored.supersededBy === undefined ? {} : { supersededBy: stored.supersededBy }),
        bindings,
      },
    };
  }

  private loadProposal(proposalId: string): StagedProposalRecord | undefined {
    const row = this.port.getStagedProposalRow(proposalId);
    if (!row) return undefined;
    let args: CanonicalValue;
    try { args = JSON.parse(row.argumentsJson) as CanonicalValue; }
    catch {
      // A record whose arguments will not parse cannot be fingerprinted, so it cannot match its
      // stored identity, so the policy refuses it. Representing that as `null` keeps this total.
      args = null;
    }
    return {
      proposalId: row.proposalId,
      ...(row.delegationId === undefined ? {} : { delegationId: row.delegationId }),
      tool: row.tool,
      workspaceId: row.workspaceId,
      origin: row.origin,
      arguments: args,
      sessionId: row.sessionId,
      adapterId: row.adapterId,
      stagedAt: row.stagedAt,
      fingerprint: row.fingerprint,
      state: row.state as ProposalState,
    };
  }

  private recordRefusal(input: {
    connection: ConnectionIdentity; code: string; delegationId?: string; proposalId?: string;
    goalId?: string; slotClaimed: boolean;
  }): void {
    this.port.recordDelegatedRunRefusal({
      ...(input.delegationId === undefined ? {} : { requestedDelegationId: input.delegationId }),
      ...(input.proposalId === undefined ? {} : { requestedProposalId: input.proposalId }),
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      sessionId: input.connection.sessionId,
      adapterId: input.connection.adapterId,
      refusedAt: this.now(),
      reasonCode: input.code,
      slotClaimed: input.slotClaimed,
      maxRowsPerScope: MAX_REFUSAL_ROWS_PER_SESSION,
    });
  }

  /**
   * Stage a parsed candidate. Inert: nothing runs, nothing is authorised, no slot is spent.
   *
   * Everything here arrives from the browser, so everything here is validated at runtime rather
   * than trusted to a TypeScript parameter type.
   */
  stageProposal(input: {
    connection: ConnectionIdentity;
    delegationId?: string;
    tool: string;
    workspaceId: string;
    origin: string;
    arguments: CanonicalValue;
  }): StageOutcome {
    // The stop applies to autonomy, not to the human route. Checking it before the delegated
    // branch refused *undelegated* staging too — and since staging is how a human Run's proposal
    // comes into existence, engaging the stop would have bricked the path a person uses to take
    // over. `human-presence-boundary.md` is explicit that it must not.
    if (input.delegationId !== undefined && this.killSwitch()) {
      return refuseStage('KILL_SWITCH_ENGAGED', 'the local kill switch is engaged');
    }

    for (const [field, value, max] of [
      ['tool', input.tool, MAX_TOOL_LENGTH],
      ['workspaceId', input.workspaceId, MAX_WORKSPACE_LENGTH],
      ['origin', input.origin, MAX_ORIGIN_LENGTH],
    ] as Array<[string, unknown, number]>) {
      if (typeof value !== 'string' || value.length === 0 || value.length > max) {
        return refuseStage('STAGING_INPUT_INVALID', `${field} must be a string of 1..${max} characters`);
      }
    }
    // The origin is validated on both branches. It was previously checked only when a delegation
    // was named, so an undelegated stage carried an arbitrary browser string into the audit table.
    let origin: string;
    try { origin = new URL(input.origin).origin; }
    catch { return refuseStage('STAGING_INPUT_INVALID', 'origin is not a URL'); }
    if (origin !== input.origin) {
      return refuseStage('STAGING_INPUT_INVALID', 'origin must be an exact origin');
    }

    // A staged candidate must be something the frozen v4 surface would have accepted, and its
    // arguments must name the workspace it is staged for. Without this, v5's argument surface was
    // strictly *wider* than v4's — measured: a 5 KB query and a `max_results` of 99999 where v4
    // caps them at 256 bytes and 50 — and `arguments.workspace_id`, which is what every tool
    // actually resolves its workspace from, could name a workspace the delegation never bound.
    //
    // `requireWorkspaceBinding` is set exactly when a delegation is named, because that is when the
    // workspace binding has to mean something. A tool with no `workspace_id` argument cannot be
    // constrained by it — `workspace.open` takes a `path` — so allowing one would produce a
    // delegation that reads as narrow and behaves as wide.
    const argumentsInvalid = validateStageableArguments({
      tool: input.tool,
      workspaceId: input.workspaceId,
      arguments: input.arguments,
      requireWorkspaceBinding: input.delegationId !== undefined,
    });
    if (argumentsInvalid) return refuseStage('STAGING_INPUT_INVALID', argumentsInvalid);

    try { this.rateLimit.charge({ ...input.connection }, this.now()); }
    catch (error) {
      return refuseStage('STAGING_RATE_LIMITED', error instanceof Error ? error.message : 'rate limited');
    }

    let fingerprint: string;
    try {
      fingerprint = canonicalProposalFingerprint({
        tool: input.tool,
        workspaceId: input.workspaceId,
        origin: input.origin,
        sessionId: input.connection.sessionId,
        adapterId: input.connection.adapterId,
        arguments: input.arguments,
      });
    } catch (error) {
      if (error instanceof NonCanonicalValueError) {
        return refuseStage('PROPOSAL_MALFORMED', `arguments have no canonical form: ${error.message}`);
      }
      throw error;
    }

    if (input.delegationId !== undefined) {
      if (this.configuredDelegationId === undefined
        || this.configuredDelegationId !== input.delegationId) {
        return refuseStage('DELEGATION_NOT_CONFIGURED', 'that delegation is not the configured one');
      }
      const loaded = this.loadDelegation(input.delegationId);
      if (!loaded.ok) return refuseStage(loaded.code, loaded.detail);
      const bindings = loaded.record.bindings;
      const malformed = validateDelegationBindings(bindings);
      if (malformed) return refuseStage('DELEGATION_MALFORMED', malformed);
      if (loaded.record.revokedAt !== undefined) {
        return refuseStage('DELEGATION_REVOKED', 'that delegation is revoked');
      }
      if (loaded.record.supersededBy !== undefined) {
        return refuseStage('DELEGATION_SUPERSEDED', 'that delegation was superseded');
      }
      const now = this.now();
      if (now < loaded.record.notBefore) {
        return refuseStage('DELEGATION_NOT_YET_VALID', 'that delegation is not yet valid');
      }
      if (now >= loaded.record.expiresAt) {
        return refuseStage('DELEGATION_EXPIRED', 'that delegation has expired');
      }
      // Fail fast on the bounds dispatch will check anyway. This is convenience, not authority:
      // the decision that matters is made again, from the stored row, at dispatch.
      if (input.connection.sessionId !== bindings.sessionId) {
        return refuseStage('SESSION_MISMATCH', 'this session does not hold that delegation');
      }
      if (input.connection.adapterId !== bindings.adapterId) {
        return refuseStage('ADAPTER_MISMATCH', 'this adapter does not hold that delegation');
      }
      if (input.workspaceId !== bindings.workspaceId) {
        return refuseStage('WORKSPACE_MISMATCH', 'the workspace is not the one delegated');
      }
      if (!bindings.allowedTools.includes(input.tool)) {
        return refuseStage('TOOL_NOT_DELEGATED', `${input.tool} is not delegated`);
      }
      if (!bindings.allowedOrigins.includes(origin)) {
        return refuseStage('ORIGIN_NOT_ALLOWED', `${input.origin} is not a delegated origin`);
      }
      // Refuse a re-observed action before a row exists. This is a cost saving, not the bound:
      // the guarantee is the CLAIM transaction, which repeats the check inside the write lock.
      // Without it a rescan of a long conversation writes one staged row per proposal per rescan,
      // all of them destined to be refused at dispatch.
      if (this.port.hasDelegationClaimForFingerprint(input.delegationId, fingerprint)) {
        return refuseStage('PROPOSAL_REPLAY', 'this delegation already claimed that exact action');
      }
      if (this.port.countStagedProposals(input.delegationId) >= bindings.maxActions) {
        return refuseStage(
          'STAGING_LIMIT_REACHED',
          `a delegation may not queue more than its ${bindings.maxActions} actions`,
        );
      }
    }

    const open = this.port.countOpenStagedProposals(
      input.connection.sessionId, input.connection.adapterId,
    );
    if (open >= MAX_OPEN_STAGED_PER_SESSION) {
      return refuseStage('STAGING_LIMIT_REACHED', `this context already holds ${open} un-Run proposals`);
    }
    const total = this.port.countAllStagedProposals(
      input.connection.sessionId, input.connection.adapterId,
    );
    if (total >= MAX_TOTAL_STAGED_PER_SESSION) {
      return refuseStage('STAGING_LIMIT_REACHED', `this context has staged ${total} proposals in total`);
    }

    const proposalId = `prop_${randomBytes(12).toString('hex')}`;
    this.port.insertStagedProposal({
      proposalId,
      ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }),
      tool: input.tool,
      workspaceId: input.workspaceId,
      origin: input.origin,
      argumentsJson: JSON.stringify(input.arguments),
      sessionId: input.connection.sessionId,
      adapterId: input.connection.adapterId,
      stagedAt: this.now(),
      fingerprint,
    });
    return { staged: true, proposalId, fingerprint };
  }

  /**
   * Decide one delegated dispatch: evaluate, claim, dispatch.
   *
   * `request` is `unknown` on purpose. It arrives from the browser, so it is parsed rather than
   * trusted, and a request carrying anything beyond the two references is refused rather than
   * having the extras ignored — an attempt to assert authority should be visible.
   */
  authorizeDelegatedRun(input: {
    request: unknown;
    connection: ConnectionIdentity;
  }): DelegatedRunOutcome {
    const parsed = parseDispatchRequest(input.request);
    if (!parsed.ok) {
      this.recordRefusal({ connection: input.connection, code: 'REQUEST_MALFORMED', slotClaimed: false });
      return {
        decision: { admitted: false, code: 'REQUEST_MALFORMED', detail: parsed.detail },
        slotClaimed: false,
      };
    }
    const { delegationId, proposalId } = parsed.request;

    const refused = (code: DelegationDenialCode, detail: string, slotClaimed: boolean)
    : DelegatedRunOutcome => {
      this.recordRefusal({ connection: input.connection, code, delegationId, proposalId, slotClaimed });
      return { decision: { admitted: false, code, detail }, slotClaimed };
    };

    // Charged before anything is written, and a refusal here writes **nothing**.
    //
    // The refusal log is bounded in rows, which a review correctly pointed out is not the same as
    // bounded in writes: every attempt, including one with no delegation configured at all, was a
    // full transaction. 400 attempts measured as 400 write transactions. The row cap held and the
    // disk did not, which is the wrong half of the problem to solve. Staging got this limit as
    // part of an earlier finding; dispatch is the path that finding did not cover.
    try { this.dispatchRateLimit.charge({ ...input.connection }, this.now()); }
    catch (error) {
      return {
        decision: {
          admitted: false,
          code: 'DISPATCH_RATE_LIMITED',
          detail: error instanceof Error ? error.message : 'rate limited',
        },
        slotClaimed: false,
      };
    }

    // The stop is consulted before anything is loaded, so it works even when the delegation row
    // is missing or unreadable. The same fact is handed to the policy below, which checks it
    // first in turn — two layers agreeing costs nothing and means neither alone is load-bearing.
    const killSwitch = this.killSwitch();
    if (killSwitch) {
      return refused('KILL_SWITCH_ENGAGED', 'the local kill switch is engaged', false);
    }

    const loaded = this.loadDelegation(delegationId);
    if (!loaded.ok) return refused(loaded.code, loaded.detail, false);

    const proposal = this.loadProposal(proposalId);

    const decision = evaluateDelegatedRun({
      killSwitch,
      configuredDelegationId: this.configuredDelegationId,
      delegation: loaded.record,
      proposal,
      connection: input.connection,
      now: this.now(),
      spend: { actionsUsed: this.port.countDelegationClaims(delegationId) },
    });
    if (!decision.admitted) return refused(decision.code, decision.detail, false);
    if (!proposal) {
      // Unreachable: the policy denies `NO_PROPOSAL` when this is absent. Written as a denial
      // rather than a non-null assertion because a wrong assumption on the one path that ends in
      // a consequence should refuse, not throw.
      return refused('NO_PROPOSAL', 'the proposal vanished', false);
    }

    // The claim spends the slot, inside a transaction that re-reads everything time-varying.
    const claim = this.port.claimDelegatedDispatch({
      delegationId, proposalId, now: this.now(),
      expectedFingerprint: decision.fingerprint, maxWindowMs: MAX_DELEGATION_WINDOW_MS,
    });
    if (!claim.ok) return refused(claim.code as DelegationDenialCode, claim.detail, false);

    // Past this line a slot is spent and will not be returned. A refusal here is recorded with
    // `slotClaimed: true`, because an audit that could not distinguish the two would make the
    // budget unreadable after the fact.
    //
    // The `catch` is not decoration. Contention *raises* out of the store rather than returning a
    // code — deliberately, and pinned by a test — so without this an exception between the claim
    // and the dispatch would escape having spent a slot and written nothing at all: no refusal
    // row, no `slot_claimed` flag, and a CLAIMED row left for recovery to retire. The throw still
    // propagates; it simply stops being silent about what it cost.
    const dispatchedAt = this.now();
    try {
      const dispatched = this.port.markDelegatedDispatched({ proposalId, now: dispatchedAt });
      if (!dispatched.ok) {
        this.recordRefusal({
          connection: input.connection, code: dispatched.code, delegationId, proposalId,
          goalId: claim.goalId, slotClaimed: true,
        });
        return {
          decision: {
            admitted: false,
            code: dispatched.code as DelegationDenialCode,
            detail: dispatched.detail,
          },
          slotClaimed: true,
        };
      }
    } catch (error) {
      try {
        this.recordRefusal({
          connection: input.connection, code: 'DISPATCH_FAILED_AFTER_CLAIM',
          delegationId, proposalId, goalId: claim.goalId, slotClaimed: true,
        });
      } catch { /* the original failure is the one worth propagating */ }
      throw error;
    }

    return {
      decision,
      slotClaimed: true,
      authorization: {
        proposalId,
        delegationId,
        goalId: claim.goalId,
        controllerId: claim.controllerId,
        fingerprint: decision.fingerprint,
        tool: proposal.tool,
        workspaceId: proposal.workspaceId,
        dispatchedAt,
      },
    };
  }

  /**
   * Record a Run that no delegation authorised — the ordinary human path.
   *
   * It spends no slot, consults no delegation, and is deliberately **not** subject to the
   * autonomy stop: `npm run lease:stop` pauses automation, and someone stopping runaway
   * automation must still be able to act themselves.
   *
   * A proposal staged under a delegation is refused, in the store, inside the transaction. Letting
   * it through was a measured hole: the browser-reachable plane could run delegated work while
   * spending no slot and writing an audit row saying nothing delegated it.
   */
  recordHumanRun(input: { connection: ConnectionIdentity; proposalId: string }):
  { ok: true } | { ok: false; code: string; detail: string } {
    const proposal = this.port.getStagedProposalRow(input.proposalId);
    if (!proposal) return { ok: false, code: 'NO_PROPOSAL', detail: 'no staged proposal with that id' };
    if (proposal.sessionId !== input.connection.sessionId
      || proposal.adapterId !== input.connection.adapterId) {
      return { ok: false, code: 'PROPOSAL_NOT_OWNED', detail: 'staged by a different browser context' };
    }
    return this.port.recordHumanRun({ proposalId: input.proposalId, now: this.now() });
  }

  /**
   * Attach the canonical result id, advancing `DISPATCHED -> RESULTED`.
   *
   * Ownership is checked here for the same reason `recordHumanRun` checks it, and because a review
   * measured what its absence bought: a second browser context could attach a result id to another
   * context's audit row, and — since the attach is single-use — permanently deny the legitimate
   * one. This was the only method on the browser-reachable plane without an identity check.
   */
  attachResult(input: { connection: ConnectionIdentity; proposalId: string; resultId: string }):
  { ok: true } | { ok: false; code: string; detail: string } {
    const proposal = this.port.getStagedProposalRow(input.proposalId);
    if (!proposal) return { ok: false, code: 'NO_PROPOSAL', detail: 'no staged proposal with that id' };
    if (proposal.sessionId !== input.connection.sessionId
      || proposal.adapterId !== input.connection.adapterId) {
      return { ok: false, code: 'PROPOSAL_NOT_OWNED', detail: 'staged by a different browser context' };
    }
    // Distinguish the two reasons the store can refuse. It returns false both when a result is
    // already attached and when there is no audit row at all — and reporting the first for the
    // second told an operator the opposite of the truth: nothing was attached, and no Run ever
    // happened.
    if (this.port.getStagedProposalRow(input.proposalId)?.state === 'STAGED') {
      return {
        ok: false, code: 'PROPOSAL_NOT_DISPATCHED',
        detail: 'that proposal has not been dispatched, so there is no result to attach',
      };
    }
    const attached = this.port.attachRunResult(input.proposalId, input.resultId, this.now());
    if (!attached) {
      return { ok: false, code: 'RESULT_ALREADY_ATTACHED', detail: 'a result is not re-pointed' };
    }
    return { ok: true };
  }
}
