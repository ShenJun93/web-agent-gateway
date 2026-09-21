import { z } from 'zod';

/**
 * The browser operator protocol: the v3 read and verify surface, plus proposals for the three
 * reviewed changes (ADR-0026).
 *
 * v3 is frozen. This is a separate revision with a separate adapter identity precisely so an
 * existing session cannot acquire proposal authority by talking a newer dialect.
 *
 * Every tool here either reads bounded data or creates a caller-owned durable proposal that a
 * local operator must approve before anything happens. There is deliberately no method that
 * approves, dispatches, runs, names a branch, or takes an argv or an environment.
 */
export const BROWSER_OPERATOR_PROTOCOL_VERSION = 4 as const;
export const BROWSER_OPERATOR_MAX_BYTES = 256 * 1024;

export type BrowserOperatorToolName =
  | 'health'
  | 'workspace.open'
  | 'repo.search'
  | 'repo.snapshot'
  | 'file.read'
  | 'verify.preview'
  | 'verify.result'
  | 'mutation.preview'
  | 'file.create'
  | 'mutation.result'
  | 'git.commit'
  | 'git.commit.result';

/** Exported so the native host can answer a refused frame without re-deriving the shape. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const requestId = z.string().min(8).max(128).regex(REQUEST_ID_PATTERN);
const sessionId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const workspaceId = z.string().min(1).max(256);
const pathValue = z.string().min(1).max(4096);
const profileName = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const verifyRequestId = z.string().min(1).max(256).regex(/^verifyreq_[A-Za-z0-9-]+$/);
const mutationId = z.string().min(1).max(256).regex(/^mut_[A-Za-z0-9-]+$/);
const commitId = z.string().min(1).max(256).regex(/^cmt_[A-Za-z0-9-]+$/);

/** Same bounds the private stdio surface enforces; the browser gets no wider input. */
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = (max: number) => z.string().refine(
  (value) => Buffer.byteLength(value, 'utf8') <= max,
  { message: 'Value exceeds its byte limit' },
);

const helloRequest = z.object({
  version: z.literal(BROWSER_OPERATOR_PROTOCOL_VERSION),
  type: z.literal('hello'),
  requestId,
}).strict();

const bindRequest = z.object({
  version: z.literal(BROWSER_OPERATOR_PROTOCOL_VERSION),
  type: z.literal('session.bind'),
  requestId,
  sessionId,
  provider: z.literal('chatgpt'),
  origin: z.literal('https://chatgpt.com'),
}).strict();

const sessionRequestBase = {
  version: z.literal(BROWSER_OPERATOR_PROTOCOL_VERSION),
  requestId,
  sessionId,
};

const unbindRequest = z.object({ ...sessionRequestBase, type: z.literal('session.unbind') }).strict();
const listToolsRequest = z.object({ ...sessionRequestBase, type: z.literal('tools.list') }).strict();
const pingRequest = z.object({ ...sessionRequestBase, type: z.literal('ping') }).strict();

const healthCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('health'),
  arguments: z.object({}).strict(),
}).strict();

const openWorkspaceCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('workspace.open'),
  arguments: z.object({ path: pathValue }).strict(),
}).strict();

const repoSearchCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('repo.search'),
  arguments: z.object({
    workspace_id: workspaceId,
    query: z.string().min(1).refine(
      (value) => !/[\0\r\n]/.test(value) && Buffer.byteLength(value, 'utf8') <= 256,
      { message: 'Query too long or contains invalid characters' },
    ),
    ignore_case: z.boolean().optional(),
    max_results: z.number().int().min(1).max(50).optional(),
    context_lines: z.number().int().min(0).max(2).optional(),
  }).strict(),
}).strict();

const repoSnapshotCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('repo.snapshot'),
  arguments: z.object({
    workspace_id: workspaceId,
    max_files: z.number().int().min(1).max(200).optional(),
  }).strict(),
}).strict();

const readFileCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('file.read'),
  arguments: z.object({ workspace_id: workspaceId, path: pathValue }).strict(),
}).strict();

const verifyPreviewCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('verify.preview'),
  arguments: z.object({ workspace_id: workspaceId, profile: profileName }).strict(),
}).strict();

const verifyResultCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('verify.result'),
  arguments: z.object({ request_id: verifyRequestId }).strict(),
}).strict();

const mutationPreviewCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('mutation.preview'),
  arguments: z.object({
    workspace_id: workspaceId,
    path: pathValue,
    base_sha256: sha256Hex,
    before: boundedText(32 * 1024).refine((value) => value.length > 0),
    after: boundedText(32 * 1024),
  }).strict(),
}).strict();

const fileCreateCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('file.create'),
  arguments: z.object({
    workspace_id: workspaceId,
    path: pathValue,
    content: boundedText(32 * 1024).refine((value) => value.length > 0),
  }).strict(),
}).strict();

const mutationResultCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('mutation.result'),
  arguments: z.object({ mutation_id: mutationId }).strict(),
}).strict();

const gitCommitCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('git.commit'),
  arguments: z.object({
    workspace_id: workspaceId,
    paths: z.array(z.string().min(1).max(1024)).min(1).max(64),
    message: boundedText(8 * 1024).refine((value) => value.length > 0),
  }).strict(),
}).strict();

const gitCommitResultCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('git.commit.result'),
  arguments: z.object({ commit_id: commitId }).strict(),
}).strict();

const requestSchema = z.union([
  helloRequest,
  bindRequest,
  unbindRequest,
  listToolsRequest,
  pingRequest,
  healthCall,
  openWorkspaceCall,
  repoSearchCall,
  repoSnapshotCall,
  readFileCall,
  verifyPreviewCall,
  verifyResultCall,
  mutationPreviewCall,
  fileCreateCall,
  mutationResultCall,
  gitCommitCall,
  gitCommitResultCall,
]);

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(jsonValue), z.record(z.string(), jsonValue),
]));

const resultResponse = z.object({
  version: z.literal(BROWSER_OPERATOR_PROTOCOL_VERSION),
  type: z.literal('result'),
  requestId,
  result: jsonValue,
}).strict();

const errorResponse = z.object({
  version: z.literal(BROWSER_OPERATOR_PROTOCOL_VERSION),
  type: z.literal('error'),
  requestId,
  error: z.object({
    code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
    message: z.string().min(1).max(8192),
  }).strict(),
}).strict();

const responseSchema = z.discriminatedUnion('type', [resultResponse, errorResponse]);

export type BrowserOperatorAdapterRequest = z.infer<typeof requestSchema>;
export type BrowserOperatorAdapterResponse = z.infer<typeof responseSchema>;

export function serializedOperatorBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Browser operator adapter value is not JSON serializable');
  return Buffer.byteLength(encoded, 'utf8');
}

function assertEnvelopeSize(value: unknown): void {
  if (serializedOperatorBytes(value) > BROWSER_OPERATOR_MAX_BYTES) {
    throw new Error('Browser operator adapter envelope exceeds size limit');
  }
}

export function parseBrowserOperatorRequest(value: unknown): BrowserOperatorAdapterRequest {
  assertEnvelopeSize(value);
  return requestSchema.parse(value);
}

export function parseBrowserOperatorResponse(value: unknown): BrowserOperatorAdapterResponse {
  assertEnvelopeSize(value);
  return responseSchema.parse(value);
}
