import { z } from 'zod';
import { parseBrowserOperatorRequest } from './protocol-v4.js';

/**
 * The delegated-dispatch protocol (ADR-0029): stage a candidate, ask for it to be dispatched.
 *
 * ## Why this is a new revision rather than two verbs added to v4
 *
 * v4 is frozen, and the freeze exists for exactly this case: "a v1, v2 or v3 session never gains
 * v4 authority". Adding delegated dispatch to v4 would give every existing v4 session a capability
 * it was never admitted for. So this is a parallel file with its own identity, as v4 was to v3.
 *
 * The identity earns its keep twice. A delegation binds `adapterId`, so a delegation issued for v5
 * cannot be used by a v4 session and a v4 session cannot speak these verbs — the isolation is
 * structural rather than a check someone has to remember.
 *
 * ## How this compares to v4, stated in both directions
 *
 * **Verbs: narrower.** There is no `tool.call` here. On v4 the browser names a tool and its
 * arguments and the gateway runs it; here it stages a candidate, which is inert, and later asks
 * for it by reference. The tool that runs is the one in the stored row, so the dispatch message
 * has no tool, no arguments, and no way to change what was staged.
 *
 * **Arguments: identical, and only because they are checked against v4's own schemas.** An earlier
 * draft accepted "any finite JSON" here, which removed every per-tool bound v4 had — and a review
 * measured a 5 KB query and a `max_results` of 99999 sailing through a surface where v4 caps them
 * at 256 bytes and 50. `validateStageableArguments` below closes that by requiring a staged
 * candidate to be an envelope **v4 itself would have accepted**.
 *
 * **New: the Run transition.** A v5 session can cause a proposal to come into existence without a
 * click, which v4 could not. That is the whole point of the revision and it is not a reduction.
 * What bounds it is not the verb count: it is that the authority comes from a human out of band,
 * is inert unless named in local configuration, and produces a proposal and never an effect —
 * Approve is untouched. The earlier version of this comment argued from "no `tool.call`" to "no
 * stronger-isolation decision needed", which was reasoning from the half of the comparison that
 * happened to be favourable.
 *
 * ## What the browser may not say
 *
 * `run.dispatch` carries **two opaque references and nothing else**. It has no goal, no controller,
 * no expiry, no budget, no fingerprint and no authority label — those fields are not in the schema,
 * so they cannot be forged in the message, and `.strict()` refuses a message that tries rather than
 * ignoring the extra. `run.stage` carries the candidate itself. Its `tool`, `workspaceId` and
 * `origin` are compared against the delegation's bindings; its `arguments` are bounded by v4's
 * per-tool schema and must name the same workspace the proposal is staged for. Neither can widen
 * what the delegation allows.
 *
 * Authority is resolved **server-side** from the staged row. A staged proposal that names the
 * configured delegation takes the delegated path; one that names none takes the human path. The
 * browser chooses which to stage, not which authority applies — and a delegation id it names that
 * is not the configured one is refused outright.
 */
export const DELEGATED_DISPATCH_PROTOCOL_VERSION = 5 as const;
export const DELEGATED_DISPATCH_MAX_BYTES = 256 * 1024;

/** Exported so the native host can answer a refused frame without re-deriving the shape. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const requestId = z.string().min(8).max(128).regex(REQUEST_ID_PATTERN);
const sessionId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const opaqueRef = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const workspaceId = z.string().min(1).max(256);
const toolName = z.string().min(1).max(128).regex(/^[a-z][a-z0-9.]*$/);

/**
 * Staged arguments, at the envelope layer: JSON, finite, and inside the size cap.
 *
 * This is **not** the whole check. `validateStageableArguments` below applies v4's own per-tool
 * schema, and the plane calls it before anything is stored. Both exist because they answer
 * different questions: this one decides whether the frame is parseable at all, that one decides
 * whether the candidate is something the frozen surface would have accepted.
 */
const stagedArguments: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(stagedArguments), z.record(z.string(), stagedArguments),
]));

const helloRequest = z.object({
  version: z.literal(DELEGATED_DISPATCH_PROTOCOL_VERSION),
  type: z.literal('hello'),
  requestId,
}).strict();

const bindRequest = z.object({
  version: z.literal(DELEGATED_DISPATCH_PROTOCOL_VERSION),
  type: z.literal('session.bind'),
  requestId,
  sessionId,
  provider: z.literal('chatgpt'),
  origin: z.literal('https://chatgpt.com'),
}).strict();

const sessionRequestBase = {
  version: z.literal(DELEGATED_DISPATCH_PROTOCOL_VERSION),
  requestId,
  sessionId,
};

const unbindRequest = z.object({ ...sessionRequestBase, type: z.literal('session.unbind') }).strict();
const pingRequest = z.object({ ...sessionRequestBase, type: z.literal('ping') }).strict();
const listVerbsRequest = z.object({ ...sessionRequestBase, type: z.literal('verbs.list') }).strict();

/**
 * Stage one parsed candidate. Inert: nothing runs, nothing is authorised, no budget is spent.
 *
 * `delegationId` is optional and opaque. Naming one asks for the delegated path; naming one that
 * is not the configured delegation is refused. Omitting it stages on the human path.
 */
const stageRequest = z.object({
  ...sessionRequestBase,
  type: z.literal('run.stage'),
  delegationId: opaqueRef.optional(),
  tool: toolName,
  workspaceId,
  origin: z.string().min(1).max(2048),
  arguments: stagedArguments,
}).strict();

/**
 * Ask for a staged proposal to be dispatched.
 *
 * Two opaque references. There is nothing else in this message by construction — see the header.
 */
const dispatchRequest = z.object({
  ...sessionRequestBase,
  type: z.literal('run.dispatch'),
  delegationId: opaqueRef,
  proposalId: opaqueRef,
}).strict();

/**
 * Ask for a staged proposal to be run on the **human** path — the click, not the delegation.
 *
 * This verb is what keeps v5 from being delegated-only. Without it, a v5 session could stage a
 * proposal and then had no way to run anything a delegation did not admit, so every ordinary Run
 * needed a v4 session too; a measured gap, listed in the ADR as unbuilt wiring.
 *
 * It grants nothing v4 did not already grant. On v4 a human clicks Run and the extension sends
 * `tool.call`; here a human clicks Run and the extension sends `run.stage` then `run.human`. The
 * gateway cannot tell a clicked Run from an unclicked one on either protocol — the human gate lives
 * in the side panel and always has — so this is parity, not a widening. What it adds is a durable
 * `HUMAN_RUN` row, which v4 never wrote.
 *
 * It carries no `delegationId`, because it is not the delegated path and must not be able to
 * become it: the store refuses `PROPOSAL_IS_DELEGATED` for a proposal staged under a delegation,
 * inside the transaction, so this verb can never launder delegated work into an unbudgeted run.
 */
const humanRunRequest = z.object({
  ...sessionRequestBase,
  type: z.literal('run.human'),
  proposalId: opaqueRef,
}).strict();

/** Ask for a dispatched proposal's result id to be recorded. Also two references. */
const attachResultRequest = z.object({
  ...sessionRequestBase,
  type: z.literal('run.result'),
  proposalId: opaqueRef,
  resultId: opaqueRef,
}).strict();

const requestSchema = z.union([
  helloRequest,
  bindRequest,
  unbindRequest,
  pingRequest,
  listVerbsRequest,
  stageRequest,
  dispatchRequest,
  humanRunRequest,
  attachResultRequest,
]);

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(jsonValue), z.record(z.string(), jsonValue),
]));

const resultResponse = z.object({
  version: z.literal(DELEGATED_DISPATCH_PROTOCOL_VERSION),
  type: z.literal('result'),
  requestId,
  result: jsonValue,
}).strict();

const errorResponse = z.object({
  version: z.literal(DELEGATED_DISPATCH_PROTOCOL_VERSION),
  type: z.literal('error'),
  requestId,
  error: z.object({
    code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
    message: z.string().min(1).max(8192),
  }).strict(),
}).strict();

const responseSchema = z.discriminatedUnion('type', [resultResponse, errorResponse]);

export type DelegatedDispatchRequestEnvelope = z.infer<typeof requestSchema>;
export type DelegatedDispatchResponseEnvelope = z.infer<typeof responseSchema>;

/** Every verb a v5 session may speak. Exported so a test can assert the surface exactly. */
export const DELEGATED_DISPATCH_VERBS = [
  'hello', 'session.bind', 'session.unbind', 'ping', 'verbs.list',
  'run.stage', 'run.dispatch', 'run.human', 'run.result',
] as const;

export function serializedDispatchBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Delegated dispatch value is not JSON serializable');
  return Buffer.byteLength(encoded, 'utf8');
}

function assertEnvelopeSize(value: unknown): void {
  if (serializedDispatchBytes(value) > DELEGATED_DISPATCH_MAX_BYTES) {
    throw new Error('Delegated dispatch envelope exceeds size limit');
  }
}

export function parseDelegatedDispatchRequest(value: unknown): DelegatedDispatchRequestEnvelope {
  assertEnvelopeSize(value);
  return requestSchema.parse(value);
}

export function parseDelegatedDispatchResponse(value: unknown): DelegatedDispatchResponseEnvelope {
  assertEnvelopeSize(value);
  return responseSchema.parse(value);
}

/**
 * A staged candidate must be an envelope the **frozen v4 surface would have accepted**.
 *
 * This exists because an earlier draft had none, and a review measured the cost. v5 dropped
 * `tool.call` and with it every per-tool argument schema v4 had — `repo.search` bounding `query`
 * to 256 bytes and `max_results` to 1..50, `file.create` bounding its text to 32 KiB,
 * `mutation.preview` requiring a base hash. In their place was "any finite JSON up to 256 KB". So
 * the claim that v5 was narrower than v4 was true about verbs and false about arguments, and the
 * conclusion drawn from it — that no stronger-isolation decision was needed — rested on the false
 * half.
 *
 * Reusing v4's schemas rather than restating them is deliberate: a second copy of eleven argument
 * schemas is a second copy to drift, and the property worth having is not "bounded" but "bounded
 * *identically to v4*". Building a v4 envelope and parsing it is the only way to say that without
 * being able to say it twice.
 *
 * It also closes a field-name trap the review measured. Every WAG tool resolves its workspace from
 * `arguments.workspace_id`; the delegation binds the staged `workspaceId`. Those are different
 * fields, so a proposal bound to one workspace could carry arguments naming another — and did,
 * end to end, with the foreign id preserved verbatim into the audit row. They must agree.
 */
export function validateStageableArguments(input: {
  tool: string;
  workspaceId: string;
  arguments: unknown;
  /**
   * Set when the candidate is being staged **under a delegation**, which makes the workspace
   * binding mandatory rather than merely checked-if-present.
   *
   * The difference is not cosmetic. A delegation binds one `workspaceId`, and the only thing that
   * makes that binding mean anything is that the tool resolves its workspace from
   * `arguments.workspace_id` and the two must agree. A tool with **no** `workspace_id` argument —
   * `health`, and far more consequentially `workspace.open`, which takes a `path` — has nothing to
   * compare, so the binding constrains nothing at all.
   *
   * Left permissive that would mean: a delegation naming `workspace.open` in `allowedTools` lets
   * the browser open *any* path the config's `allowedRoots` permits, while the audit row records it
   * as acting in the bound workspace. The delegation would look narrow and be wide.
   *
   * So on the delegated path a tool that cannot be bound to a workspace cannot be staged. The human
   * path keeps the old behaviour, because there are no bindings there to satisfy — a person opening
   * a workspace is the gesture the whole design defers to.
   */
  requireWorkspaceBinding?: boolean;
}): string | undefined {
  // A tool the frozen surface does not define cannot be staged at all. Fail closed: the executor
  // that would eventually run it is the v4 surface, and it knows only these names.
  let envelope: unknown;
  try {
    envelope = {
      version: 4,
      type: 'tool.call',
      requestId: 'staged.candidate',
      sessionId: 'staged.candidate',
      tool: input.tool,
      arguments: input.arguments,
    };
  } catch { return 'the staged candidate could not be framed'; }

  try {
    parseBrowserOperatorRequest(envelope);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid arguments';
    return `arguments are not valid for ${input.tool} on the frozen v4 surface: ${detail.slice(0, 400)}`;
  }

  // The workspace the tool will resolve must be the workspace the delegation bound.
  const args = input.arguments as { workspace_id?: unknown } | null;
  const hasWorkspaceArgument = args !== null && typeof args === 'object' && 'workspace_id' in args;
  if (hasWorkspaceArgument) {
    if ((args as { workspace_id: unknown }).workspace_id !== input.workspaceId) {
      return 'arguments.workspace_id must be the workspace the proposal is staged for';
    }
  } else if (input.requireWorkspaceBinding === true) {
    return `${input.tool} resolves no workspace from its arguments, so a delegation's workspace `
      + 'binding cannot constrain it; it may only be run on the human path';
  }
  return undefined;
}
