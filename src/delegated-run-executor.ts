/**
 * What happens *after* a delegated Run is admitted (ADR-0029).
 *
 * The dispatch plane decides and records; it does not run anything. That split is deliberate — the
 * decision is pure, synchronous and testable without a gateway — but it leaves a gap that this file
 * closes: something has to actually execute the staged candidate, and where that happens determines
 * whether the design's central claim survives contact with a transport.
 *
 * ## Why execution is server-side, and not a second browser call
 *
 * The obvious alternative is for the extension to call `run.dispatch`, see `admitted`, and then
 * call the tool itself. That would be wrong twice over:
 *
 *   - v5 would need `tool.call` back. It was removed so that the tool which runs is the one in the
 *     stored row, decided at staging and compared against the delegation's bindings. Handing the
 *     browser a second call re-opens exactly the gap the staging round-trip exists to close.
 *   - the two halves could diverge. A browser could dispatch and never call (a spent slot and no
 *     work), or call without dispatching (work with no authority). Neither is detectable from
 *     either half alone.
 *
 * So the gateway runs it, in the same turn, from the row it already holds. The browser's dispatch
 * message stays two opaque references and gains no new power from the fact that work now happens.
 *
 * ## The ordering, and what a crash means
 *
 * `authorizeDelegatedRun` claims the budget slot and reaches `DISPATCHED` before this file runs a
 * thing. That order is not an accident and it is not free: a crash between the transition and the
 * result leaves a row that says *dispatched, no result*, and the slot is spent.
 *
 * That is the honest reading of what happened — the work may or may not have run, and nothing
 * local can tell which. The alternative, running first and recording after, would leave a crash
 * looking like nothing happened while the effect existed, and would let a redelivery run it again.
 * Single-assignment state means a `DISPATCHED` row can never return to `STAGED`, so the second
 * attempt is refused rather than silently repeated. Unfinished rows are visible, never re-run, and
 * `abandonExpiredClaims` does not touch them — abandonment is for claims that never reached
 * dispatch at all.
 */
import { createHash } from 'node:crypto';
import { validateStageableArguments } from './browser-adapter/protocol-v5.js';
import type { DelegatedDispatchRouter } from './delegated-dispatch-router.js';
import type { DelegatedDispatchResponseEnvelope } from './browser-adapter/protocol-v5.js';
import type { DelegationDispatchPort } from './goal-ui-delegation-dispatch.js';

/** Domain separator, so a result id can never collide with a digest computed for another purpose. */
const RESULT_ID_DOMAIN = 'WAG/delegated-run-result/v1';

/**
 * How WAG runs a staged candidate. One method, because that is the whole seam.
 *
 * Deliberately not the MCP client, the coordinators, or the store: the executor must be able to run
 * a tool and nothing else. A port that could also approve, or could reach issuance, would make this
 * file the widest thing in the delegated path rather than the narrowest.
 */
export interface DelegatedToolExecutionPort {
  callTool(input: { tool: string; arguments: unknown }): Promise<{
    ok: boolean;
    structuredContent?: unknown;
  }>;
}

export interface DelegatedRunCoordinatorOptions {
  router: DelegatedDispatchRouter;
  /** Read-only here: the coordinator reads the staged row, and writes only through the router. */
  port: DelegationDispatchPort;
  executor: DelegatedToolExecutionPort;
  /** The admitted session, used only to answer `run.result` on the coordinator's own behalf. */
  sessionId: string;
  /**
   * Release whatever this coordinator holds when its connection goes away.
   *
   * The executor keeps a connected MCP client, a server and a linked transport pair for the life of
   * the connection, so something has to close them. A review measured what happens without it: the
   * transport dropped coordinators on release but nothing touched their executors, and every
   * admit/release cycle — one per tab switch, because the controller holds a single bound session —
   * leaked a whole MCP pair for the lifetime of the process.
   */
  dispose?(): Promise<void>;
}

/**
 * Mint the canonical result id for one delegated run.
 *
 * Derived rather than random so that the same dispatched proposal and the same result always name
 * the same id — which makes the audit row reproducible from the evidence rather than from a value
 * only this process ever saw. It covers the proposal's identity *and* the content, so two runs that
 * produced different results cannot be conflated, and it is domain-separated and length-prefixed
 * for the reason every other digest here is.
 *
 * It is a name, not a capability: it carries no secret, and holding one grants nothing.
 */
export function delegatedRunResultId(input: {
  proposalId: string;
  fingerprint: string;
  result: unknown;
}): string {
  // `JSON.stringify` returns undefined for a value that is not serialisable; a tool result that
  // cannot be named is still a result, so it is named by its absence rather than throwing.
  let encoded: string;
  try {
    encoded = JSON.stringify(input.result) ?? 'undefined';
  } catch {
    encoded = 'unserializable';
  }
  const hash = createHash('sha256').update(RESULT_ID_DOMAIN, 'utf8').update('\0');
  for (const field of [input.proposalId, input.fingerprint, encoded]) {
    hash.update(`${Buffer.byteLength(field, 'utf8')}:`, 'utf8').update(field, 'utf8').update('\0');
  }
  return `res_${hash.digest('hex').slice(0, 32)}`;
}

/**
 * The async half of the v5 surface: the router, plus execution for the one verb that needs it.
 *
 * Everything except `run.dispatch` is passed straight through. The coordinator adds no policy and
 * has no branch that can admit what the router refused — it can only fail to execute something the
 * router already allowed.
 */
export class DelegatedRunCoordinator {
  constructor(private readonly options: DelegatedRunCoordinatorOptions) {}

  /** Idempotent, and never throws: a connection going away must not fail the request that ended it. */
  async close(): Promise<void> {
    await this.options.dispose?.().catch(() => undefined);
  }

  async handle(raw: unknown): Promise<DelegatedDispatchResponseEnvelope> {
    const response = this.options.router.handle(raw);

    // Only a *successful* Run runs anything. A refusal is returned exactly as the router produced
    // it — no rewording, no second chance, no execution.
    //
    // Both Run verbs execute, and through the same code: `run.human` and `run.dispatch` differ in
    // what authorised them and in which audit row was written, not in what happens afterwards. A
    // second execution path for the human route would be a second place for the two to drift.
    const verb = typeof raw === 'object' && raw !== null
      ? (raw as { type?: unknown }).type
      : undefined;
    const isRun = verb === 'run.dispatch' || verb === 'run.human';
    if (!isRun || response.type !== 'result') return response;

    const dispatched = response.result as { proposalId?: unknown };
    const proposalId = typeof dispatched.proposalId === 'string' ? dispatched.proposalId : undefined;
    if (proposalId === undefined) return response;

    return this.execute(proposalId, response);
  }

  private async execute(
    proposalId: string,
    dispatchResponse: Extract<DelegatedDispatchResponseEnvelope, { type: 'result' }>,
  ): Promise<DelegatedDispatchResponseEnvelope> {
    // Read from the row, never from the message. This is the sentence the whole design rests on,
    // so it is also the only place the tool and its arguments are obtained.
    const row = this.options.port.getStagedProposalRow(proposalId);
    if (!row) return this.failed(dispatchResponse, 'EXECUTION_ROW_MISSING', 'the dispatched row vanished');
    if (row.state !== 'DISPATCHED') {
      return this.failed(dispatchResponse, 'EXECUTION_STATE_UNEXPECTED', `row is ${row.state}, not DISPATCHED`);
    }

    let args: unknown;
    try {
      args = JSON.parse(row.argumentsJson);
    } catch {
      return this.failed(dispatchResponse, 'EXECUTION_ARGUMENTS_UNREADABLE', 'stored arguments are not JSON');
    }

    // Re-validated here even though staging already did it. The row is WAG's own and should not
    // have changed, so this is defence in depth rather than doubt — but "should not have changed"
    // is an assumption about a file on disk, and this is the last moment it can be checked before
    // a tool runs. A row that fails is refused rather than run.
    const invalid = validateStageableArguments({
      tool: row.tool, workspaceId: row.workspaceId, arguments: args,
    });
    if (invalid !== undefined) {
      return this.failed(dispatchResponse, 'EXECUTION_ARGUMENTS_INVALID', invalid);
    }

    let outcome: { ok: boolean; structuredContent?: unknown };
    try {
      outcome = await this.options.executor.callTool({ tool: row.tool, arguments: args });
    } catch (error) {
      return this.failed(
        dispatchResponse, 'EXECUTION_FAILED',
        error instanceof Error ? error.message : 'the staged tool failed',
      );
    }
    if (!outcome.ok) return this.failed(dispatchResponse, 'EXECUTION_FAILED', 'the staged tool reported an error');

    const resultId = delegatedRunResultId({
      proposalId, fingerprint: row.fingerprint, result: outcome.structuredContent,
    });

    // Recorded through the router, so the attach passes the same ownership checks any other
    // `run.result` would. The coordinator does not get a privileged path to the audit row.
    const attached = this.options.router.handle({
      version: 5,
      type: 'run.result',
      requestId: `wag.exec.${resultId.slice(4, 20)}`,
      sessionId: this.options.sessionId,
      proposalId,
      resultId,
    });
    if (attached.type === 'error') {
      return this.failed(dispatchResponse, 'RESULT_NOT_RECORDED', attached.error.message);
    }

    return {
      ...dispatchResponse,
      result: {
        ...(dispatchResponse.result as Record<string, unknown>),
        resultId,
        // The same shape a v4 `tool.call` returns, so the browser learns nothing new from the fact
        // that a delegation rather than a click caused the run.
        result: (outcome.structuredContent ?? null) as never,
      } as never,
    };
  }

  /**
   * A dispatch that was admitted and then could not be completed.
   *
   * Reported as an error so the extension never treats it as a run that produced something, and
   * **the slot stays spent** — because it was, at `CLAIM`, before this file was reached. Pretending
   * otherwise would mean either refunding a budget that a partially-executed effect may already
   * have consumed, or re-running work that may already have happened.
   */
  private failed(
    dispatchResponse: Extract<DelegatedDispatchResponseEnvelope, { type: 'result' }>,
    code: string,
    message: string,
  ): DelegatedDispatchResponseEnvelope {
    return {
      version: 5,
      type: 'error',
      requestId: dispatchResponse.requestId,
      error: { code, message: message.slice(0, 8192) },
    };
  }
}
