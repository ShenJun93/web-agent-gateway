import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  createGatewayMcpServer,
  type CapabilityMcpContext,
  type CommandMcpContext,
  type GatewayApi,
  type GitCommitMcpContext,
  type MutationMcpContext,
} from './server.js';
import type { LocalMachineContext } from './local-machine-runtime.js';
import type { ToolUsageDiagnostics } from './tool-usage-diagnostics.js';

export interface GatewayStdioServerOptions {
  gateway: GatewayApi;
  input?: Readable;
  output?: Writable;
  inspect?: boolean;
  mutationContext?: MutationMcpContext;
  gitCommitContext?: GitCommitMcpContext;
  commandContext?: CommandMcpContext;
  capabilityContext?: CapabilityMcpContext;
  machineContext?: LocalMachineContext;
  diagnosticsContext?: ToolUsageDiagnostics;
}

export interface GatewayStdioServer {
  close(): Promise<void>;
}

export async function startGatewayStdioServer(
  options: GatewayStdioServerOptions,
): Promise<GatewayStdioServer> {
  const server = createGatewayMcpServer(options.gateway, {
    inspect: options.inspect,
    mutationContext: options.mutationContext,
    gitCommitContext: options.gitCommitContext,
    commandContext: options.commandContext,
    capabilityContext: options.capabilityContext,
    machineContext: options.machineContext,
    diagnosticsContext: options.diagnosticsContext,
  });
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
