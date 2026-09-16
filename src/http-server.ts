import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { BrowserAdmissionRegistry } from './adapter-admission.js';
import type { GatewayCallerContext } from './caller-context.js';
import { createGatewayMcpServer, type GatewayApi, type MutationMcpContext } from './server.js';
import { NonCancellingTaskStore } from './task-store.js';

export interface BrowserAdmissionHttpContext {
  bootstrapToken: string;
  admission: BrowserAdmissionRegistry;
  browserMcp(caller: GatewayCallerContext): McpServer;
}

export interface GatewayHttpServerOptions {
  gateway: GatewayApi;
  bearerToken: string;
  host?: string;
  port?: number;
  enableFilePatch?: boolean;
  mutationContext?: MutationMcpContext;
}
export interface BrowserAdmissionHttpServerOptions {
  gateway: GatewayApi;
  browserAdmission: BrowserAdmissionHttpContext;
  host?: string;
  port?: number;
}
export interface GatewayHttpServer {
  host: string;
  port: number;
  mcpUrl: string;
  admissionUrl?: string;
  close(): Promise<void>;
}

const admissionBodySchema = z.object({
  correlation_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

export async function startGatewayHttpServer(options: GatewayHttpServerOptions): Promise<GatewayHttpServer> {
  return startHttpServer(options);
}

export async function startBrowserAdmissionHttpServer(options: BrowserAdmissionHttpServerOptions): Promise<GatewayHttpServer> {
  return startHttpServer(options);
}

async function startHttpServer(options: GatewayHttpServerOptions | BrowserAdmissionHttpServerOptions): Promise<GatewayHttpServer> {
  const generic = 'bearerToken' in options ? options : undefined;
  const browserAdmission = 'browserAdmission' in options ? options.browserAdmission : undefined;
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Gateway HTTP server must bind loopback in V0');
  if (browserAdmission && host !== '127.0.0.1') throw new Error('Browser admission HTTP must bind IPv4 loopback');
  if (generic && Buffer.byteLength(generic.bearerToken) < 32) throw new Error('Gateway bearer token must be at least 32 bytes');
  if (browserAdmission && Buffer.byteLength(browserAdmission.bootstrapToken) < 32) {
    throw new Error('Browser admission bootstrap token must be at least 32 bytes');
  }

  const taskStore = new NonCancellingTaskStore();
  let listenerPort = 0;
  const server = createServer(browserAdmission ? { requireHostHeader: false } : {}, async (req, res) => {
    res.setHeader('x-request-id', randomUUID());
    try {
      if (browserAdmission) {
        if (req.headers.host !== `${host}:${listenerPort}` || req.headers.origin !== undefined) {
          json(res, 403, { error: 'forbidden' });
          return;
        }
        await handleBrowserRequest(req, res, browserAdmission, host, listenerPort);
        return;
      }

      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      if (!generic || !authorized(req, generic.bearerToken)) {
        res.setHeader('www-authenticate', 'Bearer');
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method_not_allowed' });
        return;
      }

      const mcp = createGatewayMcpServer(options.gateway, {
        taskStore,
        enableFilePatch: generic.enableFilePatch,
        mutationContext: generic.mutationContext,
      });
      await handleMcp(req, res, mcp);
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
    }
  });
  listenerPort = await listen(server, host, options.port ?? 0);
  const mcpUrl = `http://${host}:${listenerPort}/mcp`;
  return {
    host,
    port: listenerPort,
    mcpUrl,
    ...(browserAdmission ? { admissionUrl: `http://${host}:${listenerPort}/adapter/admit` } : {}),
    close: async () => { taskStore.cleanup(); await closeServer(server); },
  };
}

async function handleBrowserRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: BrowserAdmissionHttpContext,
  host: string,
  port: number,
): Promise<void> {
  if (req.url === '/adapter/admit') {
    await handleAdmission(req, res, context, host, port);
    return;
  }
  if (req.url === '/adapter/release') {
    handleRelease(req, res, context);
    return;
  }
  if (req.url === '/mcp') {
    await handleAdmittedMcp(req, res, context);
    return;
  }
  res.writeHead(404).end();
}
async function handleAdmission(req: IncomingMessage, res: ServerResponse, context: BrowserAdmissionHttpContext, host: string, port: number) {
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }
  if (req.headers['content-type'] !== 'application/json') { json(res, 415, { error: 'unsupported_media_type' }); return; }
  if (!authorized(req, context.bootstrapToken)) {
    res.setHeader('www-authenticate', 'Bearer');
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  let raw: string;
  try { raw = await readBody(req, 4096); }
  catch (error) { json(res, error instanceof BodyTooLargeError ? 413 : 400, { error: 'invalid_request' }); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { json(res, 400, { error: 'invalid_request' }); return; }
  const body = admissionBodySchema.safeParse(parsed);
  if (!body.success) { json(res, 400, { error: 'invalid_request' }); return; }
  const admitted = context.admission.admit(body.data.correlation_id);
  json(res, 200, { mcp_url: `http://${host}:${port}/mcp`, bearer_token: admitted.mcpToken });
}

function handleRelease(req: IncomingMessage, res: ServerResponse, context: BrowserAdmissionHttpContext) {
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }
  const token = bearerToken(req);
  if (!token || !context.admission.releaseMcpToken(token)) {
    res.setHeader('www-authenticate', 'Bearer');
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  json(res, 200, { released: true });
}
async function handleAdmittedMcp(req: IncomingMessage, res: ServerResponse, context: BrowserAdmissionHttpContext) {
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }
  const token = bearerToken(req);
  const caller = token ? context.admission.resolveMcpToken(token) : undefined;
  if (!caller) {
    res.setHeader('www-authenticate', 'Bearer');
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  await handleMcp(req, res, context.browserMcp(caller));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, mcp: McpServer): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    await transport.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return undefined;
  return value.slice(7);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const suppliedToken = bearerToken(req);
  if (suppliedToken === undefined) return false;
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.length;
    if (total > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new BodyTooLargeError();
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, value: object): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

async function listen(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(port, host, resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Gateway HTTP server has no TCP address');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
