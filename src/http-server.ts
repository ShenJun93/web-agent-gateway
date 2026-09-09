import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createGatewayMcpServer, type GatewayApi } from './server.js';

export interface GatewayHttpServerOptions {
  gateway: GatewayApi;
  bearerToken: string;
  host?: string;
  port?: number;
}

export interface GatewayHttpServer {
  host: string;
  port: number;
  mcpUrl: string;
  close(): Promise<void>;
}

export async function startGatewayHttpServer(options: GatewayHttpServerOptions): Promise<GatewayHttpServer> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Gateway HTTP server must bind loopback in V0');
  if (Buffer.byteLength(options.bearerToken) < 32) throw new Error('Gateway bearer token must be at least 32 bytes');

  const server = createServer(async (req, res) => {
    res.setHeader('x-request-id', randomUUID());
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (!authorized(req, options.bearerToken)) {
      res.setHeader('www-authenticate', 'Bearer');
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const mcp = createGatewayMcpServer(options.gateway);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'internal_error' }));
      }
    } finally {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  });

  const port = await listen(server, host, options.port ?? 0);
  return {
    host,
    port,
    mcpUrl: `http://${host}:${port}/mcp`,
    close: () => closeServer(server),
  };
}

function authorized(req: IncomingMessage, token: string): boolean {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
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
