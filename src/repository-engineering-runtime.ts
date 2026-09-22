import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { adapterCorrelationDigest } from './adapter-admission.js';
import { createGatewayCallerContext, type GatewayCallerContext } from './caller-context.js';
import { DurableMutationCoordinator } from './durable-mutation.js';
import { SqliteDurableStore } from './durable-store.js';
import { DevspaceFileMutationBackend } from './executor/devspace-file-mutation.js';
import { DevspaceGitCommitBackend } from './executor/devspace-git-commit.js';
import { DurableCommitCoordinator } from './git-commit.js';
import { isKillSwitchEngaged } from './goal-lease-kill-switch.js';
import type { DevspaceExecutor } from './executor/devspace.js';
import { startOperatorServer, type OperatorServer } from './operator-server.js';
import type { PrivateGatewayConfig } from './private-config.js';
import type { GitCommitMcpContext, MutationMcpContext } from './server.js';

/** Fixed adapter identity for the private stdio surface. Never client-supplied. */
export const PRIVATE_STDIO_ADAPTER_ID = 'private.stdio.v1';

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
  /** Builds the coordinator and operator review server once the executor exists. */
  attach(executor: DevspaceExecutor): Promise<void>;
  /** Present only after a successful attach with mutation enabled. */
  mutationContext?: MutationMcpContext;
  /** Present only after a successful attach with git commit enabled. */
  gitCommitContext?: GitCommitMcpContext;
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

  /**
   * A lease admits only the sessions its own row lists, so a session that changes on every start
   * can never be one of them. Naming a lease without a stable session is therefore not a working
   * configuration that happens to be strict — it is one that can never admit anything, while the
   * profile reports autonomous admission as enabled.
   *
   * This project has shipped that shape twice now (a coordinator nothing called; a rule nothing
   * could satisfy), so it fails at startup rather than at the first silent denial.
   *
   * Checked before the store is opened, so a refused configuration leaves no handle behind.
   */
  if (mutationSettings.goalLeaseId !== undefined && mutationSettings.sessionCorrelation === undefined) {
    throw new Error(
      'Private gateway names a goalLeaseId without a sessionCorrelation: this surface mints a new '
      + 'session every start, so the lease could never admit. Add repositoryEngineering.mutation'
      + '.sessionCorrelation, or remove the lease and use local operator approval.',
    );
  }

  const store = new SqliteDurableStore(mutationSettings.statePath);
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

  /**
   * The Autonomous Goal Lease this surface honours, if the config names one (ADR-0028).
   *
   * This is the surface where a lease actually removes *both* gestures. There is no Run here —
   * Run is a browser-adapter concept, the act of turning an untrusted page's text into a
   * proposal — so a caller on this stdio surface proposes directly, and a lease admits. On the
   * browser operator runtime a lease removes only Approve, because a human pressing Run is what
   * creates the proposal in the first place.
   *
   * Absent unless configured, which is every existing deployment.
   */
  const goalLease = mutationSettings.goalLeaseId === undefined ? undefined : {
    leaseId: mutationSettings.goalLeaseId,
    killSwitch: () => isKillSwitchEngaged(dirname(mutationSettings.statePath)),
  };

  let operator: OperatorServer | undefined;
  let mutationCoordinator: DurableMutationCoordinator | undefined;
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
    async attach(executor) {
      if (attached) throw new Error('Repository engineering runtime is already attached');
      attached = true;
      try {
        const coordinator = new DurableMutationCoordinator({
          store,
          backends: [new DevspaceFileMutationBackend(executor)],
          ...(goalLease === undefined ? {} : { goalLease }),
        });
        await coordinator.reconcile();
        mutationCoordinator = coordinator;

        // The admission pass. Without a caller, configuring a lease attaches an option nothing
        // consults — which is exactly the gap a review found on the browser runtime, so it is
        // not repeated here. Interval-driven rather than fired from the proposal path, so the
        // tool's contract is unchanged and records left pending across a restart are picked up.
        // `unref` so it never holds the process open; errors swallowed per tick so a failing
        // admission cannot take down a gateway whose human review path is working.
        // Declared before the timer so the same pass can drive it. Commits were missing from this
        // pass entirely — a lease granting `git.commit` left its records at PENDING_APPROVAL while
        // the runtime reported autonomous admission as enabled, which is the same gap this comment
        // says was "not repeated here", repeated here for the other record kind.
        let commitCoordinator: DurableCommitCoordinator | undefined;

        if (goalLease) {
          leaseTimer = setInterval(() => {
            void coordinator.admitPendingUnderLease().catch(() => undefined);
            void commitCoordinator?.admitPendingUnderLease().catch(() => undefined);
          }, LEASE_ADMISSION_INTERVAL_MS);
          leaseTimer.unref?.();
        }

        if (gitCommitSettings) {
          commitCoordinator = new DurableCommitCoordinator({
            store,
            backend: new DevspaceGitCommitBackend(executor),
            ...(gitCommitSettings.protectedBranches === undefined
              ? {}
              : { protectedBranches: gitCommitSettings.protectedBranches }),
            ...(goalLease === undefined ? {} : { goalLease }),
          });
          await commitCoordinator.reconcile();
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
        if (commitCoordinator) runtime.gitCommitContext = { callerContext, coordinator: commitCoordinator };
        // The single-use bootstrap token is written beside the state database rather than
        // printed, because a stdio gateway's stderr belongs to whatever spawned it — for the
        // supported deployment that is the remote-facing tunnel client, which is permitted to
        // log or forward child stderr. The file carries the same exposure as the state
        // database itself and is removed on shutdown.
        await writeFile(urlFile, `${operator.bootstrapUrl}\n`, { encoding: 'utf8', mode: 0o600 });
        runtime.mutationContext = { callerContext, coordinator };
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
      finally { store.close(); }
    },
  };
  return runtime;
}
