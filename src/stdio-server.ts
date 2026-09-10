import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGatewayMcpServer, type GatewayApi } from './server.js';
import { NonCancellingTaskStore } from './task-store.js';

export interface GatewayStdioServerOptions {
  gateway: GatewayApi;
  input?: Readable;
  output?: Writable;
  taskStore?: NonCancellingTaskStore;
}

export interface GatewayStdioServer {
  close(): Promise<void>;
}

export async function startGatewayStdioServer(
  options: GatewayStdioServerOptions,
): Promise<GatewayStdioServer> {
  const taskStore = options.taskStore ?? new NonCancellingTaskStore();
  const server = createGatewayMcpServer(options.gateway, { taskStore });
  const transport = new StdioServerTransport(options.input, options.output);
  await server.connect(transport);
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      try {
        await transport.close();
        await server.close();
      } finally {
        taskStore.cleanup();
      }
    },
  };
}
