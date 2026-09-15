import { isAbsolute } from 'node:path';
import { DevspaceFileMutationBackend } from '../src/executor/devspace-file-mutation.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableMutationCoordinator, type MutationCaller } from '../src/durable-mutation.js';
import { startGatewayHttpServer } from '../src/http-server.js';
import { startOperatorServer } from '../src/operator-server.js';
import { loadPrivateGatewayConfig } from '../src/private-config.js';
import { bootstrapPrivateGateway } from '../src/private-runtime.js';

const TOKEN_ENV = 'WAG_DURABLE_MUTATION_SPIKE_TOKEN';

export interface DurableMutationSpikeRuntime {
  mcpUrl: string;
  operatorOrigin: string;
  operatorBootstrapUrl: string;
  close(): Promise<void>;
}

export async function startDurableMutationBrowserSpike(options: {
  configPath: string;
  statePath: string;
  caller: MutationCaller;
  env?: NodeJS.ProcessEnv;
}): Promise<DurableMutationSpikeRuntime> {
  if (!isAbsolute(options.configPath)) throw new Error('Spike config path must be absolute');
  if (!isAbsolute(options.statePath)) throw new Error('Spike state path must be absolute');
  const env = options.env ?? process.env;
  const bearerToken = env[TOKEN_ENV];
  if (!bearerToken || Buffer.byteLength(bearerToken) < 32) {
    throw new Error(`${TOKEN_ENV} must be at least 32 bytes`);
  }
  delete env[TOKEN_ENV];

  const config = await loadPrivateGatewayConfig(options.configPath);
  const store = new SqliteDurableStore(options.statePath);
  let privateRuntime: Awaited<ReturnType<typeof bootstrapPrivateGateway>> | undefined;
  let operator: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
  let http: Awaited<ReturnType<typeof startGatewayHttpServer>> | undefined;
  try {
    privateRuntime = await bootstrapPrivateGateway(config, {
      env,
      openWorkspaceId: (canonicalRoot) => store.openWorkspaceRecord({
        ...options.caller,
        canonicalRoot,
        backendKind: 'devspace',
        createdAt: Date.now(),
      }).workspaceId,
    });
    const backend = new DevspaceFileMutationBackend(privateRuntime.executor);
    const coordinator = new DurableMutationCoordinator({ store, backends: [backend] });
    await coordinator.reconcile();
    operator = await startOperatorServer({ coordinator });
    http = await startGatewayHttpServer({
      gateway: privateRuntime.gateway,
      bearerToken,
      mutationContext: { callerContext: options.caller, coordinator },
    });
    let closed = false;
    return {
      mcpUrl: http.mcpUrl,
      operatorOrigin: operator.origin,
      operatorBootstrapUrl: operator.bootstrapUrl,
      async close() {
        if (closed) return;
        closed = true;
        await http?.close();
        await operator?.close();
        await privateRuntime?.close();
        store.close();
      },
    };
  } catch (error) {
    await http?.close().catch(() => undefined);
    await operator?.close().catch(() => undefined);
    await privateRuntime?.close().catch(() => undefined);
    store.close();
    throw error;
  }
}
