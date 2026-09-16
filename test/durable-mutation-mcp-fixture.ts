import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type GatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { DevspaceFileMutationBackend } from '../src/executor/devspace-file-mutation.js';
import { startOperatorServer } from '../src/operator-server.js';
import { loadPrivateGatewayConfig } from '../src/private-config.js';
import { bootstrapPrivateGateway } from '../src/private-runtime.js';
import { createGatewayMcpServer } from '../src/server.js';

export interface DurableMutationMcpFixture {
  client: Client;
  operatorOrigin: string;
  operatorBootstrapUrl: string;
  close(): Promise<void>;
}

export async function startDurableMutationMcpFixture(options: {
  configPath: string;
  statePath: string;
  caller: GatewayCallerContext;
  env?: NodeJS.ProcessEnv;
}): Promise<DurableMutationMcpFixture> {
  const config = await loadPrivateGatewayConfig(options.configPath);
  const store = new SqliteDurableStore(options.statePath);
  let privateRuntime: Awaited<ReturnType<typeof bootstrapPrivateGateway>> | undefined;
  let operator: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
  let mcp: ReturnType<typeof createGatewayMcpServer> | undefined;
  let client: Client | undefined;
  try {
    privateRuntime = await bootstrapPrivateGateway(config, {
      env: options.env,
      openWorkspaceId: (canonicalRoot) => store.openWorkspaceRecord({
        ...options.caller,
        canonicalRoot,
        backendKind: 'devspace',
        createdAt: Date.now(),
      }).workspaceId,
    });
    const coordinator = new DurableMutationCoordinator({
      store,
      backends: [new DevspaceFileMutationBackend(privateRuntime.executor)],
    });
    await coordinator.reconcile();
    operator = await startOperatorServer({ coordinator });
    mcp = createGatewayMcpServer(privateRuntime.gateway, {
      mutationContext: { callerContext: options.caller, coordinator },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'durable-mutation-acceptance', version: '1.0.0' }, { capabilities: {} });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    let closed = false;
    return {
      client,
      operatorOrigin: operator.origin,
      operatorBootstrapUrl: operator.bootstrapUrl,
      async close() {
        if (closed) return;
        closed = true;
        await client?.close().catch(() => undefined);
        await mcp?.close().catch(() => undefined);
        await operator?.close().catch(() => undefined);
        await privateRuntime?.close().catch(() => undefined);
        store.close();
      },
    };
  } catch (error) {
    await client?.close().catch(() => undefined);
    await mcp?.close().catch(() => undefined);
    await operator?.close().catch(() => undefined);
    await privateRuntime?.close().catch(() => undefined);
    store.close();
    throw error;
  }
}
