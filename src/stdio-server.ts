import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  createGatewayMcpServer,
  type BrowserReleaseMcpContext,
  type CapabilityMcpContext,
  type ChangeSetMcpContext,
  type CommandMcpContext,
  type GatewayApi,
  type GitCommitMcpContext,
  type MutationMcpContext,
  type RemoteGitPushMcpContext,
} from './server.js';
import type { LocalMachineContext } from './local-machine-runtime.js';
import type { ToolUsageDiagnostics } from './tool-usage-diagnostics.js';
import type { ProductMcpContext } from './product-ux.js';
import type { BrowserMcpContext } from './browser-harness/browser-mcp-runtime.js';
import type { DesktopMcpContext } from './desktop-harness/desktop-mcp-runtime.js';

export interface GatewayStdioServerOptions {
  gateway: GatewayApi;
  input?: Readable;
  output?: Writable;
  inspect?: boolean;
  mutationContext?: MutationMcpContext;
  changeSetContext?: ChangeSetMcpContext;
  gitCommitContext?: GitCommitMcpContext;
  remoteGitPushContext?: RemoteGitPushMcpContext;
  commandContext?: CommandMcpContext;
  capabilityContext?: CapabilityMcpContext;
  machineContext?: LocalMachineContext;
  diagnosticsContext?: ToolUsageDiagnostics;
  productContext?: ProductMcpContext;
  browserContext?: BrowserMcpContext;
  browserReleaseContext?: BrowserReleaseMcpContext;
  desktopContext?: DesktopMcpContext;
}

export interface GatewayStdioServer {
  close(): Promise<void>;
}

export function createPrivateGatewayMcpServer(
  options: GatewayStdioServerOptions,
) {
  return createGatewayMcpServer(options.gateway, {
    inspect: options.inspect,
    mutationContext: options.mutationContext,
    changeSetContext: options.changeSetContext,
    gitCommitContext: options.gitCommitContext,
    remoteGitPushContext: options.remoteGitPushContext,
    commandContext: options.commandContext,
    capabilityContext: options.capabilityContext,
    machineContext: options.machineContext,
    diagnosticsContext: options.diagnosticsContext,
    productContext: options.productContext,
    browserContext: options.browserContext,
    browserReleaseContext: options.browserReleaseContext,
    desktopContext: options.desktopContext,
  });
}

export async function startGatewayStdioServer(
  options: GatewayStdioServerOptions,
): Promise<GatewayStdioServer> {
  const server = createPrivateGatewayMcpServer(options);
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
