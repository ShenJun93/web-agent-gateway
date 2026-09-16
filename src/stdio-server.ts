import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createGatewayMcpServer, type GatewayApi } from './server.js';

export interface GatewayStdioServerOptions {
  gateway: GatewayApi;
  input?: Readable;
  output?: Writable;
}

export interface GatewayStdioServer {
  close(): Promise<void>;
}

export async function startGatewayStdioServer(
  options: GatewayStdioServerOptions,
): Promise<GatewayStdioServer> {
  const server = createGatewayMcpServer(options.gateway);
  const transport = new StdioServerTransport(options.input, options.output);
  await server.connect(transport);
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await transport.close();
      await server.close();
    },
  };
}
