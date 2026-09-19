import { randomUUID } from 'node:crypto';
import { createGatewayCallerContext, type GatewayCallerContext } from './caller-context.js';
import { DurableMutationCoordinator } from './durable-mutation.js';
import { SqliteDurableStore } from './durable-store.js';
import { DevspaceFileMutationBackend } from './executor/devspace-file-mutation.js';
import type { DevspaceExecutor } from './executor/devspace.js';
import { startOperatorServer, type OperatorServer } from './operator-server.js';
import type { PrivateGatewayConfig } from './private-config.js';
import type { MutationMcpContext } from './server.js';

/** Fixed adapter identity for the private stdio surface. Never client-supplied. */
export const PRIVATE_STDIO_ADAPTER_ID = 'private.stdio.v1';

export interface RepositoryEngineeringProfile {
  repoSearch: boolean;
  mutation: boolean;
}

export interface RepositoryEngineeringRuntime {
  /** Resolved capability profile; safe to report locally. */
  profile: RepositoryEngineeringProfile;
  /** Present only when mutation is enabled; binds workspace.open to durable records. */
  openWorkspaceId?: (canonicalRoot: string) => string;
  /** Builds the coordinator and operator review server once the executor exists. */
  attach(executor: DevspaceExecutor): Promise<void>;
  /** Present only after a successful attach with mutation enabled. */
  mutationContext?: MutationMcpContext;
  /** Present only after a successful attach with mutation enabled. */
  operator?: { origin: string; bootstrapUrl: string };
  close(): Promise<void>;
}

export interface RepositoryEngineeringRuntimeOptions {
  /** Injected only by tests; production always uses the real loopback operator server. */
  startOperatorServer?: typeof startOperatorServer;
}

/**
 * Assembles the DC-replacement repository-engineering capabilities for the private stdio
 * surface. Absent `repositoryEngineering` config this opens no database, binds no port and
 * builds no caller context, so the shipped default surface is unchanged.
 *
 * Ordering is forced by existing contracts: the durable store must exist before
 * `workspace.open` runs (mutation previews resolve workspaces from the store), but the
 * mutation backend needs the executor that only exists after the gateway bootstraps.
 * `attach` is therefore a second phase rather than constructor work.
 */
export async function startRepositoryEngineeringRuntime(
  config: PrivateGatewayConfig,
  options: RepositoryEngineeringRuntimeOptions = {},
): Promise<RepositoryEngineeringRuntime> {
  const settings = config.repositoryEngineering;
  const repoSearch = settings?.search === true;
  const mutationSettings = settings?.mutation;

  if (!mutationSettings) {
    return {
      profile: { repoSearch, mutation: false },
      async attach() { /* nothing to attach */ },
      async close() { /* nothing to close */ },
    };
  }

  const callerContext: GatewayCallerContext = createGatewayCallerContext({
    ownerId: mutationSettings.ownerId,
    sessionId: `sid_${randomUUID()}`,
    adapterId: PRIVATE_STDIO_ADAPTER_ID,
  });
  const store = new SqliteDurableStore(mutationSettings.statePath);

  let operator: OperatorServer | undefined;
  let attached = false;
  let closed = false;
  const runtime: RepositoryEngineeringRuntime = {
    profile: { repoSearch, mutation: true },
    openWorkspaceId: (canonicalRoot) => store.openWorkspaceRecord({
      ownerId: callerContext.ownerId,
      sessionId: callerContext.sessionId,
      adapterId: callerContext.adapterId,
      canonicalRoot,
      backendKind: 'devspace',
      createdAt: Date.now(),
    }).workspaceId,
    async attach(executor) {
      if (attached) throw new Error('Repository engineering runtime is already attached');
      attached = true;
      try {
        const coordinator = new DurableMutationCoordinator({
          store,
          backends: [new DevspaceFileMutationBackend(executor)],
        });
        await coordinator.reconcile();
        operator = await (options.startOperatorServer ?? startOperatorServer)({ coordinator });
        runtime.mutationContext = { callerContext, coordinator };
        runtime.operator = { origin: operator.origin, bootstrapUrl: operator.bootstrapUrl };
      } catch (error) {
        await runtime.close();
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await operator?.close(); }
      finally { store.close(); }
    },
  };
  return runtime;
}
