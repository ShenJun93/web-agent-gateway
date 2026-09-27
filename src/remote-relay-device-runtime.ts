import type { PrivateGatewayConfig } from './private-config.js';
import type { PrivateGatewayRuntime } from './private-runtime.js';
import type { RepositoryEngineeringRuntime } from './repository-engineering-runtime.js';
import { createPrivateGatewayMcpServer } from './stdio-server.js';
import { McpRemoteRelayExecutionPort } from './remote-relay-mcp-execution.js';
import {
  RemoteRelayDeviceAgent,
  type RemoteRelayDeviceAgentMetadata,
} from './remote-relay-device-agent.js';
import {
  SupabaseRemoteRelayTransport,
  type RemoteRelayTransport,
} from './remote-relay-supabase-transport.js';

export interface RemoteRelayDeviceRuntime {
  run(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface StartRemoteRelayDeviceRuntimeOptions {
  config: PrivateGatewayConfig;
  gatewayRuntime: PrivateGatewayRuntime;
  engineering: RepositoryEngineeringRuntime;
  env?: NodeJS.ProcessEnv;
  transport?: RemoteRelayTransport;
  agentVersion?: string;
  onMetadata?: (event: RemoteRelayDeviceAgentMetadata) => void;
}

export function decodeRemoteRelayDeviceSecret(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43,171}$/.test(encoded)) {
    throw new Error('remote relay device secret must be unpadded base64url');
  }
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.length < 32 || secret.length > 128 || secret.toString('base64url') !== encoded) {
    throw new Error('remote relay device secret must decode to 32..128 bytes');
  }
  return secret;
}

export async function startRemoteRelayDeviceRuntime(
  options: StartRemoteRelayDeviceRuntimeOptions,
): Promise<RemoteRelayDeviceRuntime> {
  const settings = options.config.remoteRelayDevice;
  if (!settings) throw new Error('remote relay device is not configured');

  const env = options.env ?? process.env;
  const encodedSecret = env[settings.secretEnv];
  if (!encodedSecret) throw new Error('remote relay device secret environment variable is missing');
  const secret = decodeRemoteRelayDeviceSecret(encodedSecret);
  delete env[settings.secretEnv];

  const execution = new McpRemoteRelayExecutionPort(() => createPrivateGatewayMcpServer({
    gateway: options.gatewayRuntime.gateway,
    inspect: options.engineering.profile.inspect,
    mutationContext: options.engineering.mutationContext,
    gitCommitContext: options.engineering.gitCommitContext,
    remoteGitPushContext: options.engineering.remoteGitPushContext,
    commandContext: options.engineering.commandContext,
    capabilityContext: options.engineering.capabilityContext,
    machineContext: options.engineering.machineContext,
    diagnosticsContext: options.engineering.diagnosticsContext,
    browserContext: options.engineering.browserContext,
    desktopContext: options.engineering.desktopContext,
  }));

  try {
    const toolManifest = await execution.listToolManifest();
    const transport = options.transport ?? new SupabaseRemoteRelayTransport({
      url: settings.supabaseUrl,
      publishableKey: settings.publishableKey,
    });
    const agent = new RemoteRelayDeviceAgent({
      secret,
      deviceId: settings.deviceId,
      agentVersion: options.agentVersion ?? '0.1.0',
      toolManifest,
      executor: execution,
      transport,
      ...(options.onMetadata === undefined ? {} : { onMetadata: options.onMetadata }),
    });
    let closed = false;
    return {
      async run(signal: AbortSignal): Promise<void> {
        if (closed) throw new Error('remote relay device runtime is closed');
        await agent.run(signal);
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        secret.fill(0);
        await execution.close();
      },
    };
  } catch (error) {
    secret.fill(0);
    await execution.close();
    throw error;
  }
}
