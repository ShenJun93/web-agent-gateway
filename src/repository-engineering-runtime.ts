import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterCorrelationDigest } from './adapter-admission.js';
import { sameAuthorityTuple } from './authority-tuple.js';
import { createGatewayCallerContext, type GatewayCallerContext } from './caller-context.js';
import { DurableMutationCoordinator } from './durable-mutation.js';
import { SqliteDurableStore } from './durable-store.js';
import { DevspaceFileMutationBackend } from './executor/devspace-file-mutation.js';
import { DevspaceGitCommitBackend } from './executor/devspace-git-commit.js';
import { observeDevspaceWorkspaceIdentity } from './executor/devspace-workspace-identity.js';
import { DurableCommitCoordinator } from './git-commit.js';
import type { GoalLeaseBindings } from './goal-lease.js';
import { resolveGoalLease } from './goal-lease-resolver.js';
import { installGoalLeaseAtomicBudgetGuard } from './goal-lease-atomic-budget.js';
import { isKillSwitchEngaged } from './goal-lease-kill-switch.js';
import type { DevspaceExecutor } from './executor/devspace.js';
import { startOperatorServer, type OperatorServer } from './operator-server.js';
import type { PrivateGatewayConfig } from './private-config.js';
import type { CapabilityMcpContext, CommandMcpContext, GitCommitMcpContext, MutationMcpContext } from './server.js';
import { WorkspaceIdentityRegistry } from './workspace-identity.js';

/** Fixed adapter identity for the private stdio surface. Never client-supplied. */
export const PRIVATE_STDIO_ADAPTER_ID = 'private.stdio.v1';

/** Checkout/runtime this authority implementation was loaded from; never caller-selected. */
const GATEWAY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export interface RepositoryEngineeringProfile {
  inspect: boolean;
  mutation: boolean;
  gitCommit: boolean;
  /**
   * The durable session this surface will keep using, present only when a `sessionCorrelation`
   * makes it stable.
   *
   * It is reported for one reason: a lease binds a session id, and a human issuing a lease out of
   * band has to be able to find out which one to bind. The browser path solved the same bootstrap
   * problem with `listAdapterSessions`; this is its stdio equivalent. A session id is an identity,
   * not a credential — it grants nothing without a lease row a human wrote.
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
  /**
   * Present only when the full local-development profile also names a Goal Lease.
   * Each command call still re-evaluates that lease against its exact workspace.
   */
  commandContext?: CommandMcpContext;
  /** Effective preflight authority for an opened workspace. */
  capabilityContext?: CapabilityMcpContext;
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
/** How often a configured lease is offered the pending queue. Idle when nothing is pending. */
const LEASE_ADMISSION_INTERVAL_MS = 1_000;

export async function startRepositoryEngineeringRuntime(
  config: PrivateGatewayConfig,
  options: RepositoryEngineeringRuntimeOptions = {},
): Promise<RepositoryEngineeringRuntime> {
  const settings = config.repositoryEngineering;
  const inspect = settings?.inspect === true;
  const mutationSettings = settings?.mutation;
  const gitCommitSettings = settings?.gitCommit;

  if (!mutationSettings) {
    return {
      profile: { inspect, mutation: false, gitCommit: false },
      async attach() { /* nothing to attach */ },
      async close() { /* nothing to close */ },
    };
  }

  /*
   * Lease activation is resolved from durable rows per consequential request. A stable
   * sessionCorrelation remains the supported way for a human to issue a lease for this direct
   * surface, but no configured lease id is required or consulted as an activation selector.
   */

  const store = new SqliteDurableStore(mutationSettings.statePath);
  let workspaceIdentities: WorkspaceIdentityRegistry;
  try {
    installGoalLeaseAtomicBudgetGuard(mutationSettings.statePath);
    workspaceIdentities = new WorkspaceIdentityRegistry(mutationSettings.statePath);
  } catch (error) {
    store.close();
    throw error;
  }
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

  async function freshWorkspaceFingerprint(workspaceId: string): Promise<string | undefined> {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return undefined;
    // Migration compatibility: records created before workspace-identity v1 have no durable
    // identity to revalidate. New production workspace.open calls bindWorkspaceIdentity before
    // returning the handle, so every new handle takes the live-observation path below.
    if (workspaceIdentities.fingerprint(workspaceId) === undefined) return undefined;
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

    const workspaceFingerprint = await freshWorkspaceFingerprint(workspaceId);
    const resolution = resolveGoalLease(store, {
      now: Date.now(),
      requests: [{
        tool: 'command.run',
        sessionId: callerContext.sessionId,
        adapterId: callerContext.adapterId,
        workspaceRoot: workspace.canonicalRoot,
        ...(workspaceFingerprint === undefined ? {} : { workspaceFingerprint }),
        path: '.',
        diffBytes: 0,
      }],
      killSwitch: killSwitch(),
      gatewayRoot: GATEWAY_ROOT,
    });
    if (!resolution.admitted) {
      return {
        granted: false as const,
        reason: resolution.code,
        workspace,
      };
    }

    const lease = resolution.resolved.lease;
    const bindings: GoalLeaseBindings = lease.bindings;
    return {
      granted: true as const,
      reason: 'GRANTED',
      workspace,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
      bindings,
    };
  }

  let operator: OperatorServer | undefined;
  let mutationCoordinator: DurableMutationCoordinator | undefined;
  let attachedExecutor: DevspaceExecutor | undefined;
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let attached = false;
  let closed = false;
  const runtime: RepositoryEngineeringRuntime = {
    profile: {
      inspect,
      mutation: true,
      gitCommit: gitCommitSettings !== undefined,
      ...(mutationSettings.sessionCorrelation === undefined ? {} : { stableSessionId: sessionId }),
    },
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

        const bindings = command.bindings;
        const leaseAllows = (tool: string) => command.leaseId !== undefined
          && bindings !== undefined
          && Array.isArray(bindings.workspaceRoots)
          && bindings.workspaceRoots.includes(workspace.canonicalRoot)
          && Array.isArray(bindings.admittedSessions)
          && bindings.admittedSessions.includes(callerContext.sessionId)
          && Array.isArray(bindings.admittedAdapters)
          && bindings.admittedAdapters.includes(callerContext.adapterId)
          && Array.isArray(bindings.allowedTools)
          && bindings.allowedTools.includes(tool);

        const leaseState = command.granted
          ? 'ACTIVE'
          : command.reason === 'AMBIGUOUS_LEASE'
            ? 'AMBIGUOUS'
            : 'NONE';

        const mutationAutonomous = leaseAllows('mutation.preview');
        const commitAutonomous = gitCommitSettings !== undefined && leaseAllows('git.commit');
        return {
          workspace_id: workspaceId,
          root: workspace.canonicalRoot,
          lease: {
            state: leaseState,
            ...(command.leaseId === undefined ? {} : { lease_id: command.leaseId }),
            ...(command.expiresAt === undefined ? {} : { expires_at: command.expiresAt }),
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
              granted: mutationAutonomous,
              denied: !mutationAutonomous,
              grantable: true,
              requires_human: false,
              reason: mutationAutonomous ? 'GOAL_LEASE_GRANTED' : 'GOAL_LEASE_REQUIRED',
              ...(bindings?.pathPatterns === undefined ? {} : { path_patterns: bindings.pathPatterns }),
            },
            GIT_COMMIT: {
              granted: gitCommitSettings !== undefined && commitAutonomous,
              denied: gitCommitSettings === undefined || !commitAutonomous,
              grantable: gitCommitSettings !== undefined,
              requires_human: false,
              reason: gitCommitSettings === undefined
                ? 'CAPABILITY_UNAVAILABLE'
                : commitAutonomous ? 'GOAL_LEASE_GRANTED' : 'GOAL_LEASE_REQUIRED',
            },
            LOCAL_COMMAND: {
              granted: command.granted,
              denied: !command.granted,
              grantable: true,
              requires_human: !command.granted,
              reason: command.reason,
              ...(command.leaseId === undefined ? {} : { lease_id: command.leaseId }),
              ...(command.expiresAt === undefined ? {} : { expires_at: command.expiresAt }),
            },
            GIT_PUSH: {
              granted: false, denied: true, grantable: false, requires_human: true, reason: 'REMOTE_EFFECT_NOT_GRANTED',
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
        const goalLeaseResolver = {
          killSwitch,
          workspaceFingerprint: (workspaceId: string) => workspaceIdentities.fingerprint(workspaceId),
          liveWorkspaceFingerprint: (workspaceId: string, _canonicalRoot: string) =>
            freshWorkspaceFingerprint(workspaceId),
        };
        const coordinator = new DurableMutationCoordinator({
          store,
          backends: [new DevspaceFileMutationBackend(executor)],
          goalLeaseResolver,
        });
        await coordinator.reconcile();
        mutationCoordinator = coordinator;

        let commitCoordinator: DurableCommitCoordinator | undefined;

        // Always drive the bounded pending queues. With no matching durable lease each record stays
        // pending for human review; issuing or revoking a lease therefore takes effect without a
        // config edit or gateway restart.
        leaseTimer = setInterval(() => {
          void coordinator.admitPendingUnderLease().catch(() => undefined);
          void commitCoordinator?.admitPendingUnderLease().catch(() => undefined);
        }, LEASE_ADMISSION_INTERVAL_MS);
        leaseTimer.unref?.();

        if (gitCommitSettings) {
          commitCoordinator = new DurableCommitCoordinator({
            store,
            backend: new DevspaceGitCommitBackend(executor),
            ...(gitCommitSettings.protectedBranches === undefined
              ? {}
              : { protectedBranches: gitCommitSettings.protectedBranches }),
            ...(mutationSettings.reviewTtlMs === undefined
              ? {} : { reviewTtlMs: mutationSettings.reviewTtlMs }),
            goalLeaseResolver,
          });
          await commitCoordinator.reconcile();
        }

        // The command surface is a capability of the full local-development profile. Authority is
        // resolved for every call, so publishing the tool does not activate any lease.
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
        });
        if (commitCoordinator) {
          runtime.gitCommitContext = { callerContext, coordinator: commitCoordinator, leaseOnly: true };
        }
        // The single-use bootstrap token is written beside the state database rather than
        // printed, because a stdio gateway's stderr belongs to whatever spawned it — for the
        // supported deployment that is the remote-facing tunnel client, which is permitted to
        // log or forward child stderr. The file carries the same exposure as the state
        // database itself and is removed on shutdown.
        await writeFile(urlFile, `${operator.bootstrapUrl}\n`, { encoding: 'utf8', mode: 0o600 });
        runtime.mutationContext = { callerContext, coordinator, leaseOnly: true };
        runtime.operator = { origin: operator.origin, bootstrapUrl: operator.bootstrapUrl, urlFile };
      } catch (error) {
        await runtime.close();
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      // Before the store closes: an admission tick firing against a closed handle would throw
      // inside a timer, where nothing is waiting to catch it.
      if (leaseTimer) clearInterval(leaseTimer);
      try {
        await rm(urlFile, { force: true }).catch(() => undefined);
        await operator?.close();
      }
      finally {
        workspaceIdentities.close();
        store.close();
      }
    },
  };
  return runtime;
}
