import { z } from 'zod';

export const BROWSER_VERIFY_PROTOCOL_VERSION = 3 as const;
export const BROWSER_VERIFY_MAX_BYTES = 256 * 1024;

export type BrowserVerifyToolName =
  | 'health'
  | 'workspace.open'
  | 'repo.search'
  | 'repo.snapshot'
  | 'file.read'
  | 'verify.preview'
  | 'verify.result';

const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const sessionId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const workspaceId = z.string().min(1).max(256);
const pathValue = z.string().min(1).max(4096);
const profileName = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const verifyRequestId = z.string().min(1).max(256).regex(/^verifyreq_[A-Za-z0-9-]+$/);

const helloRequest = z.object({
  version: z.literal(BROWSER_VERIFY_PROTOCOL_VERSION),
  type: z.literal('hello'),
  requestId,
}).strict();

const bindRequest = z.object({
  version: z.literal(BROWSER_VERIFY_PROTOCOL_VERSION),
  type: z.literal('session.bind'),
  requestId,
  sessionId,
  provider: z.literal('chatgpt'),
  origin: z.literal('https://chatgpt.com'),
}).strict();

const sessionRequestBase = {
  version: z.literal(BROWSER_VERIFY_PROTOCOL_VERSION),
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
]);

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(jsonValue), z.record(z.string(), jsonValue),
]));

const resultResponse = z.object({
  version: z.literal(BROWSER_VERIFY_PROTOCOL_VERSION),
  type: z.literal('result'),
  requestId,
  result: jsonValue,
}).strict();

const errorResponse = z.object({
  version: z.literal(BROWSER_VERIFY_PROTOCOL_VERSION),
  type: z.literal('error'),
  requestId,
  error: z.object({
    code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
    message: z.string().min(1).max(8192),
  }).strict(),
}).strict();

const responseSchema = z.discriminatedUnion('type', [resultResponse, errorResponse]);

export type BrowserVerifyAdapterRequest = z.infer<typeof requestSchema>;
export type BrowserVerifyAdapterResponse = z.infer<typeof responseSchema>;

export function serializedVerifyBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Browser verify adapter value is not JSON serializable');
  return Buffer.byteLength(encoded, 'utf8');
}

function assertEnvelopeSize(value: unknown): void {
  if (serializedVerifyBytes(value) > BROWSER_VERIFY_MAX_BYTES) {
    throw new Error('Browser verify adapter envelope exceeds size limit');
  }
}

export function parseBrowserVerifyRequest(value: unknown): BrowserVerifyAdapterRequest {
  assertEnvelopeSize(value);
  return requestSchema.parse(value);
}

export function parseBrowserVerifyResponse(value: unknown): BrowserVerifyAdapterResponse {
  assertEnvelopeSize(value);
  return responseSchema.parse(value);
}
