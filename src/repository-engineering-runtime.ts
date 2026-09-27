import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { adapterCorrelationDigest } from './adapter-admission.js';
import { sameAuthorityTuple } from './authority-tuple.js';
import { createGatewayCallerContext, type GatewayCallerContext } from './caller-context.js';
import { DurableMutationCoordinator } from './durable-mutation.js';
import { SqliteDurableStore } from './durable-store.js';
import { DevspaceFileMutationBackend } from './executor/devspace-file-mutation.js';
import { LocalMachineFileMutationBackend } from './executor/local-machine-file-mutation.js';
import { DevspaceGitCommitBackend } from './executor/devspace-git-commit.js';
import { observeDevspaceWorkspaceIdentity } from './executor/devspace-workspace-identity.js';
import { DurableCommitCoordinator } from './git-commit.js';
import { DurableRemoteGitPushCoordinator } from './remote-git-push.js';
import { LocalRemoteGitPushBackend } from './remote-git-push-backend.js';
import { RemoteGitPushStore } from './remote-git-push-store.js';
import { isKillSwitchEngaged } from './autonomy-kill-switch.js';
import type { DevspaceExecutor } from './executor/devspace.js';
import { startOperatorServer, type OperatorServer } from './operator-server.js';
import type { PrivateGatewayConfig } from './private-config.js';
import type { CapabilityMcpContext, CommandMcpContext, GitCommitMcpContext, MutationMcpContext, RemoteGitPushMcpContext } from './server.js';
import { WorkspaceIdentityRegistry } from './workspace-identity.js';
import {
  createLocalMachineContext,
  observeLocalMachineWorkspaceIdentity,
  type LocalMachineContext,
} from './local-machine-runtime.js';
import { ToolUsageDiagnostics } from './tool-usage-diagnostics.js';
import {
  createPrivateBrowserMcpContext,
  type BrowserMcpContext,
} from './browser-harness/browser-mcp-runtime.js';
import {
  createPrivateDesktopMcpContext,
  type DesktopMcpContext,
} from './desktop-harness/desktop-mcp-runtime.js';

/** Fixed adapter identity for the private stdio surface. Never client-supplied. */
export const PRIVATE_STDIO_ADAPTER_ID = 'private.stdio.v1';

export interface RepositoryEngineeringProfile {
  inspect: boolean;
  mutation: boolean;
  gitCommit: boolean;
  browser?: boolean;
  desktop?: boolean;
  /**
   * The durable session this surface will keep using, present only when a `sessionCorrelation`
   * makes it stable.
   *
   * It is reported for reconnect/audit continuity. A session id is an identity, not a credential:
   * private-local authority comes from the trusted runtime profile, while browser-facing authority
   * remains on its separate reviewed/delegated path.
   */
  stableSessionId?: string;
}

export interface RepositoryEngineeringRuntime {
  /** Resolved capability profile; safe to report locally. */
  profile: RepositoryEngineeringProfile;
  /** Present only when mutation is enabled; binds workspace.open to durable records. */
  openWorkspaceId?: (canonicalRoot: string) => string;
  /** Completes stable filesystem/repository identity binding before workspace.open returns. */
  bindWorkspaceIdentity?: (workspaceId: string, canonicalRoot: string, devspaceWorkspaceId: string) => Promise<void>;
  /** Builds the coordinator and operator review server once the executor exists. */
  attach(executor: DevspaceExecutor): Promise<void>;
  /** Present only after a successful attach with mutation enabled. */
  mutationContext?: MutationMcpContext;
  /** Present only after a successful attach with git commit enabled. */
  gitCommitContext?: GitCommitMcpContext;
  /** Human-gated exact remote Git push proposal/consume surface. */
  remoteGitPushContext?: RemoteGitPushMcpContext;
  /** Trusted autonomous-local argv execution, bound to caller-owned workspace identity. */
  commandContext?: CommandMcpContext;
  /** Effective preflight authority for an opened workspace. */
  capabilityContext?: CapabilityMcpContext;
  /** Trusted autonomous-local Windows operations independent of DevSpace roots. */
  machineContext?: LocalMachineContext;
  /** Bounded process-local MCP tool usage diagnostics; never stores arguments or output. */
  diagnosticsContext?: ToolUsageDiagnostics;
  /** Optional outbound BrowserPort surface. It shares identity, not filesystem/Git authority. */
  browserContext?: BrowserMcpContext;
  /** Optional native Windows DesktopPort surface, restricted to WAG-owned processes. */
  desktopContext?: DesktopMcpContext;
  /** Present only after a successful attach with mutation enabled. */
  operator?: { origin: string; bootstrapUrl: string; urlFile: string };
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
  const inspect = settings?.inspect === true;
  const mutationSettings = settings?.mutation;
  const gitCommitSettings = settings?.gitCommit;
  const remoteGitPushSettings = settings?.remoteGitPush;
  const browserSettings = settings?.browser;
  const desktopSettings = settings?.desktop;

  if (!mutationSettings) {
    if (browserSettings) throw new Error('Repository engineering browser requires mutation identity');
    if (desktopSettings) throw new Error('Repository engineering desktop requires mutation identity');
    return {
      profile: { inspect, mutation: false, gitCommit: false },
      async attach() { /* nothing to attach */ },
      async close() { /* nothing to close */ },
    };
  }

  /*
   * Private stdio is the trusted autonomous-local execution plane. sessionCorrelation is only
   * stable identity/audit continuity; it grants no execution authority and no Goal Lease is
   * consulted by this runtime.
   */

  const store = new SqliteDurableStore(mutationSettings.statePath);
  let remotePushStore: RemoteGitPushStore | undefined;
  let workspaceIdentities: WorkspaceIdentityRegistry;
  try {
    remotePushStore = new RemoteGitPushStore(mutationSettings.statePath + '.remote-git-push.sqlite');
    workspaceIdentities = new WorkspaceIdentityRegistry(mutationSettings.statePath);
  } catch (error) {
    remotePushStore?.close();
    store.close();
    throw error;
  }
  if (!remotePushStore) throw new Error('Remote Git push store initialization failed');
  const pushStore = remotePushStore;
  const urlFile = `${mutationSettings.statePath}.operator-url`;

  /**
   * The session this surface acts as.
   *
   * Without a correlation, fresh per process — ADR-0020 §5, and the default for every deployment
   * that predates this field. With one, resolved through the same durable adapter-session path a
   * browser adapter uses, so the same correlation is the same session across restarts and a lease
   * issued for it keeps applying through a tunnel client's reconnects.
   *
   * The correlation comes from local configuration only. `adapterCorrelationDigest` puts
   * `ownerId` and `adapterId` inside the digest, and `adapterId` here is the fixed stdio literal,
   * so this can only ever resolve a `private.stdio.v1` session: an identical correlation string
   * configured for another owner, or used by any browser adapter, is a different session and
   * cannot inherit this one's lease.
   */
  const sessionId = mutationSettings.sessionCorrelation === undefined
    ? `sid_${randomUUID()}`
    : store.getOrCreateAdapterSession({
      ownerId: mutationSettings.ownerId,
      adapterId: PRIVATE_STDIO_ADAPTER_ID,
      correlationSha256: adapterCorrelationDigest(
        mutationSettings.ownerId, PRIVATE_STDIO_ADAPTER_ID, mutationSettings.sessionCorrelation,
      ),
      createdAt: Date.now(),
    }).sessionId;

  const callerContext: GatewayCallerContext = createGatewayCallerContext({
    ownerId: mutationSettings.ownerId,
    sessionId,
    adapterId: PRIVATE_STDIO_ADAPTER_ID,
  });

  /** Read on every consequential decision so the kill switch remains immediate. */
  const killSwitch = () => isKillSwitchEngaged(dirname(mutationSettings.statePath));
  const autonomousPushUrls = new Set(
    remoteGitPushSettings?.autonomous.allowedPushUrls ?? [],
  );
  const autonomousPushRefs = new Set(
    remoteGitPushSettings?.autonomous.allowedDestinationRefs ?? [],
  );

  const machineContext = createLocalMachineContext({
    store,
    callerContext,
    workspaceIdentities,
    killSwitch,
    processRegistryPath: mutationSettings.statePath + '.machine-processes.' + sessionId + '.json',
    terminalRegistryPath: mutationSettings.statePath + '.machine-terminals.' + sessionId,
  });
  const diagnosticsContext = new ToolUsageDiagnostics({
    ...(mutationSettings.sessionCorrelation === undefined
      ? {}
      : { statePath: mutationSettings.statePath + '.tool-usage.' + sessionId + '.json' }),
  });
  let browserContext: BrowserMcpContext | undefined;
  let desktopContext: DesktopMcpContext | undefined;
  try {
    browserContext = browserSettings === undefined ? undefined : createPrivateBrowserMcpContext({
      owner: callerContext,
      edgeExecutablePath: browserSettings.edgeExecutablePath,
      profileRoot: browserSettings.profileRoot,
      effectStatePath: mutationSettings.statePath + '.harness-effects.sqlite',
      killSwitch,
    });
    desktopContext = desktopSettings === undefined ? undefined : createPrivateDesktopMcpContext({
      owner: callerContext,
      machineContext,
      effectStatePath: mutationSettings.statePath + '.desktop-effects.sqlite',
      killSwitch,
    });
  } catch (error) {
    await browserContext?.closeAll().catch(() => undefined);
    workspaceIdentities.close();
    pushStore.close();
    store.close();
    throw error;
  }

  async function freshWorkspaceFingerprint(workspaceId: string): Promise<string | undefined> {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return undefined;
    // Migration compatibility: records created before workspace-identity v1 have no durable
    // identity to revalidate. New production workspace.open calls bindWorkspaceIdentity before
    // returning the handle, so every new handle takes the live-observation path below.
    if (workspaceIdentities.fingerprint(workspaceId) === undefined) return undefined;

    if (workspace.backendKind === 'local-machine') {
      const observation = await observeLocalMachineWorkspaceIdentity(workspace.canonicalRoot);
      const observedRoot = process.platform === 'win32'
        ? observation.canonicalRoot.toLowerCase() : observation.canonicalRoot;
      const expectedRoot = process.platform === 'win32'
        ? workspace.canonicalRoot.toLowerCase() : workspace.canonicalRoot;
      if (observedRoot !== expectedRoot) throw new Error('Gateway denied workspace identity drift');
      return workspaceIdentities.record(workspaceId, observation).fingerprint;
    }

    if (workspace.backendKind !== 'devspace') {
      throw new Error('Gateway denied workspace identity backend');
    }
    if (attachedExecutor === undefined) {
      throw new Error('Gateway workspace identity runtime is not attached');
    }

    const devspaceWorkspaceId = await attachedExecutor.openWorkspace(workspace.canonicalRoot);
    const observation = await observeDevspaceWorkspaceIdentity(
      attachedExecutor, devspaceWorkspaceId, workspace.canonicalRoot,
    );
    const observedRoot = process.platform === 'win32'
      ? observation.canonicalRoot.toLowerCase() : observation.canonicalRoot;
    const expectedRoot = process.platform === 'win32'
      ? workspace.canonicalRoot.toLowerCase() : workspace.canonicalRoot;
    if (observedRoot !== expectedRoot) throw new Error('Gateway denied workspace identity drift');
    return workspaceIdentities.record(workspaceId, observation).fingerprint;
  }

  async function effectiveCommandGrant(workspaceId: string) {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace || !sameAuthorityTuple(workspace, callerContext)) {
      return { granted: false as const, reason: 'WORKSPACE_NOT_GRANTED' };
    }
    await freshWorkspaceFingerprint(workspaceId);
    if (killSwitch()) {
      return { granted: false as const, reason: 'KILL_SWITCH_ENGAGED', workspace };
    }
    return {
      granted: true as const,
      reason: 'AUTONOMOUS_LOCAL_PROFILE',
      workspace,
    };
  }

  let operator: OperatorServer | undefined;
  let mutationCoordinator: DurableMutationCoordinator | undefined;
  let attachedExecutor: DevspaceExecutor | undefined;
  let attached = false;
  let closed = false;
  const runtime: RepositoryEngineeringRuntime = {
    profile: {
      inspect,
      mutation: true,
      gitCommit: gitCommitSettings !== undefined,
      ...(browserSettings === undefined ? {} : { browser: true }),
      ...(desktopSettings === undefined ? {} : { desktop: true }),
      ...(mutationSettings.sessionCorrelation === undefined ? {} : { stableSessionId: sessionId }),
    },
    machineContext,
    diagnosticsContext,
    ...(browserContext === undefined ? {} : { browserContext }),
    ...(desktopContext === undefined ? {} : { desktopContext }),
    openWorkspaceId: (canonicalRoot) => store.openWorkspaceRecord({
      ownerId: callerContext.ownerId,
      sessionId: callerContext.sessionId,
      adapterId: callerContext.adapterId,
      canonicalRoot,
      backendKind: 'devspace',
      createdAt: Date.now(),
    }).workspaceId,
    async bindWorkspaceIdentity(workspaceId, canonicalRoot, devspaceWorkspaceId) {
      if (attachedExecutor === undefined) throw new Error('Gateway workspace identity runtime is not attached');
      const observation = await observeDevspaceWorkspaceIdentity(
        attachedExecutor, devspaceWorkspaceId, canonicalRoot,
      );
      const observedRoot = process.platform === 'win32'
        ? observation.canonicalRoot.toLowerCase() : observation.canonicalRoot;
      const expectedRoot = process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot;
      if (observedRoot !== expectedRoot) throw new Error('Gateway denied workspace identity drift');
      workspaceIdentities.record(workspaceId, observation);
    },
    capabilityContext: {
      async describe(workspaceId) {
        const command = await effectiveCommandGrant(workspaceId);
        const workspace = command.workspace ?? store.getWorkspace(workspaceId);
        if (!workspace || !sameAuthorityTuple(workspace, callerContext)) {
          throw new Error('Gateway denied capability workspace');
        }
        const executionEnabled = !killSwitch();
        return {
          workspace_id: workspaceId,
          root: workspace.canonicalRoot,
          authority: {
            mode: 'AUTONOMOUS_LOCAL',
            kill_switch: executionEnabled ? 'CLEAR' : 'ENGAGED',
          },
          capabilities: {
            REPOSITORY_READ: {
              granted: true, denied: false, grantable: true, requires_human: false, reason: 'WORKSPACE_OWNED',
            },
            FILE_READ: {
              granted: true, denied: false, grantable: true, requires_human: false, reason: 'WORKSPACE_OWNED',
            },
            VERIFY: {
              granted: true, denied: false, grantable: true, requires_human: false, reason: 'PROFILE_SCOPED',
            },
            FILE_WRITE: {
              granted: executionEnabled,
              denied: !executionEnabled,
              grantable: true,
              requires_human: false,
              reason: executionEnabled ? 'AUTONOMOUS_LOCAL_PROFILE' : 'KILL_SWITCH_ENGAGED',
            },
            GIT_COMMIT: {
              granted: gitCommitSettings !== undefined && executionEnabled,
              denied: gitCommitSettings === undefined || !executionEnabled,
              grantable: gitCommitSettings !== undefined,
              requires_human: false,
              reason: gitCommitSettings === undefined
                ? 'CAPABILITY_UNAVAILABLE'
                : executionEnabled ? 'AUTONOMOUS_LOCAL_PROFILE' : 'KILL_SWITCH_ENGAGED',
            },
            LOCAL_COMMAND: {
              granted: command.granted,
              denied: !command.granted,
              grantable: true,
              requires_human: false,
              reason: command.reason,
            },
            GIT_PUSH: remoteGitPushSettings === undefined
              ? {
                granted: false,
                denied: true,
                grantable: true,
                requires_human: true,
                reason: executionEnabled ? 'REMOTE_EFFECT_GRANT_REQUIRED' : 'KILL_SWITCH_ENGAGED',
              }
              : {
                granted: executionEnabled,
                denied: !executionEnabled,
                grantable: true,
                requires_human: false,
                reason: executionEnabled ? 'AUTONOMOUS_REMOTE_POLICY' : 'KILL_SWITCH_ENGAGED',
              },
          },
        };
      },
    },
    async attach(executor) {
      if (attached) throw new Error('Repository engineering runtime is already attached');
      attached = true;
      attachedExecutor = executor;
      try {
        const coordinator = new DurableMutationCoordinator({
          store,
          backends: [
            new DevspaceFileMutationBackend(executor),
            new LocalMachineFileMutationBackend(),
          ],
          autonomous: { killSwitch },
          effectBoundary: {
            async revalidateWorkspace(workspaceId) {
              await freshWorkspaceFingerprint(workspaceId);
            },
          },
        });
        await coordinator.reconcile();
        mutationCoordinator = coordinator;

        let commitCoordinator: DurableCommitCoordinator | undefined;

        const remotePushCoordinator = new DurableRemoteGitPushCoordinator({
          store: pushStore,
          workspaceStore: store,
          backend: new LocalRemoteGitPushBackend({
            hooksDir: mutationSettings.statePath + '.remote-git-hooks',
          }),
          ...(remoteGitPushSettings === undefined ? {} : {
            autonomous: {
              permits(target) {
                return autonomousPushUrls.has(target.resolvedPushUrl)
                  && autonomousPushRefs.has(target.destinationRef);
              },
              denyUnmatched: true,
            },
          }),
          killSwitch,
          effectBoundary: {
            async revalidateWorkspace(workspaceId, canonicalRoot) {
              const workspace = store.getWorkspace(workspaceId);
              if (!workspace || workspace.canonicalRoot !== canonicalRoot) {
                throw new Error('Gateway denied remote Git push workspace drift');
              }
              await freshWorkspaceFingerprint(workspaceId);
            },
          },
        });
        await remotePushCoordinator.reconcile();

        if (gitCommitSettings) {
          commitCoordinator = new DurableCommitCoordinator({
            store,
            backend: new DevspaceGitCommitBackend(executor),
            ...(gitCommitSettings.protectedBranches === undefined
              ? {}
              : { protectedBranches: gitCommitSettings.protectedBranches }),
            ...(mutationSettings.reviewTtlMs === undefined
              ? {} : { reviewTtlMs: mutationSettings.reviewTtlMs }),
            autonomous: { killSwitch },
            effectBoundary: {
              async revalidateWorkspace(workspaceId) {
                await freshWorkspaceFingerprint(workspaceId);
              },
            },
          });
          await commitCoordinator.reconcile();
        }

        // The command surface is part of the trusted private-local profile. Workspace ownership
        // and the emergency kill switch are revalidated for every call.
        if (inspect && commitCoordinator) {
          runtime.commandContext = {
            async authorize(workspaceId) {
              const grant = await effectiveCommandGrant(workspaceId);
              if (!grant.granted) throw new Error(`Gateway denied command: ${grant.reason}`);
            },
          };
        }

        // No `onDeny` here, deliberately. The browser-operator runtime sends refusals to stderr so
        // the local operator can see which check failed, but this is the stdio gateway, and its
        // stderr belongs to whatever spawned it — for the supported deployment a remote-facing
        // tunnel client that is permitted to log or forward it (see the note below). A denial
        // event carries the record's path, so routing it here would put review identifiers
        // somewhere the rest of this file is careful not to.
        operator = await (options.startOperatorServer ?? startOperatorServer)({
          coordinator,
          ...(commitCoordinator === undefined ? {} : { commitCoordinator }),
          pushCoordinator: remotePushCoordinator,
        });
        if (commitCoordinator) {
          runtime.gitCommitContext = { callerContext, coordinator: commitCoordinator, autonomous: true };
        }
        runtime.remoteGitPushContext = { callerContext, coordinator: remotePushCoordinator };
        // The single-use bootstrap token is written beside the state database rather than
        // printed, because a stdio gateway's stderr belongs to whatever spawned it — for the
        // supported deployment that is the remote-facing tunnel client, which is permitted to
        // log or forward child stderr. The file carries the same exposure as the state
        // database itself and is removed on shutdown.
        await writeFile(urlFile, `${operator.bootstrapUrl}\n`, { encoding: 'utf8', mode: 0o600 });
        runtime.mutationContext = { callerContext, coordinator, autonomous: true };
        runtime.operator = { origin: operator.origin, bootstrapUrl: operator.bootstrapUrl, urlFile };
      } catch (error) {
        await runtime.close();
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      let failure: unknown;
      try {
        await desktopContext?.closeAll();
      } catch (error) {
        failure = error;
      }
      try {
        await browserContext?.closeAll();
      } catch (error) {
        failure ??= error;
      }
      try {
        await rm(urlFile, { force: true }).catch(() => undefined);
        await operator?.close();
      } catch (error) {
        failure ??= error;
      } finally {
        workspaceIdentities.close();
        pushStore.close();
        store.close();
      }
      if (failure) throw failure;
    },
  };
  return runtime;
}
