import { z } from 'zod';

export const BROWSER_ADAPTER_PROTOCOL_VERSION = 1 as const;
export const BROWSER_ADAPTER_MAX_BYTES = 256 * 1024;

export type BrowserToolName = 'health' | 'workspace.open' | 'file.read';

const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const sessionId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const workspaceId = z.string().min(1).max(256);
const pathValue = z.string().min(1).max(4096);

const helloRequest = z.object({
  version: z.literal(BROWSER_ADAPTER_PROTOCOL_VERSION),
  type: z.literal('hello'),
  requestId,
}).strict();

const bindRequest = z.object({
  version: z.literal(BROWSER_ADAPTER_PROTOCOL_VERSION),
  type: z.literal('session.bind'),
  requestId,
  sessionId,
  provider: z.literal('chatgpt'),
  origin: z.literal('https://chatgpt.com'),
}).strict();

const sessionRequestBase = {
  version: z.literal(BROWSER_ADAPTER_PROTOCOL_VERSION),
  requestId,
  sessionId,
};

const unbindRequest = z.object({
  ...sessionRequestBase,
  type: z.literal('session.unbind'),
}).strict();

const listToolsRequest = z.object({
  ...sessionRequestBase,
  type: z.literal('tools.list'),
}).strict();

const pingRequest = z.object({
  ...sessionRequestBase,
  type: z.literal('ping'),
}).strict();

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

const readFileCall = z.object({
  ...sessionRequestBase,
  type: z.literal('tool.call'),
  tool: z.literal('file.read'),
  arguments: z.object({ workspace_id: workspaceId, path: pathValue }).strict(),
}).strict();

const requestSchema = z.union([
  helloRequest,
  bindRequest,
  unbindRequest,
  listToolsRequest,
  pingRequest,
  healthCall,
  openWorkspaceCall,
  readFileCall,
]);

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(jsonValue), z.record(z.string(), jsonValue),
]));

const resultResponse = z.object({
  version: z.literal(BROWSER_ADAPTER_PROTOCOL_VERSION),
  type: z.literal('result'),
  requestId,
  result: jsonValue,
}).strict();

const errorResponse = z.object({
  version: z.literal(BROWSER_ADAPTER_PROTOCOL_VERSION),
  type: z.literal('error'),
  requestId,
  error: z.object({
    code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
    message: z.string().min(1).max(8192),
  }).strict(),
}).strict();

const responseSchema = z.discriminatedUnion('type', [resultResponse, errorResponse]);

export type BrowserAdapterRequest = z.infer<typeof requestSchema>;
export type BrowserAdapterResponse = z.infer<typeof responseSchema>;

export function serializedBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Browser adapter value is not JSON serializable');
  return Buffer.byteLength(encoded, 'utf8');
}

function assertEnvelopeSize(value: unknown): void {
  if (serializedBytes(value) > BROWSER_ADAPTER_MAX_BYTES) {
    throw new Error('Browser adapter envelope exceeds size limit');
  }
}

export function parseBrowserAdapterRequest(value: unknown): BrowserAdapterRequest {
  assertEnvelopeSize(value);
  return requestSchema.parse(value);
}

export function parseBrowserAdapterResponse(value: unknown): BrowserAdapterResponse {
  assertEnvelopeSize(value);
  return responseSchema.parse(value);
}
