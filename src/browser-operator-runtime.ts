import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { AdmittedWorkspaceService } from './admitted-workspace.js';
import {
  BrowserAdmissionRegistry,
  BROWSER_DELEGATION_ADAPTER_ID,
  BROWSER_OPERATOR_ADAPTER_ID,
  OPERATOR_CORRELATION_PATTERN,
} from './adapter-admission.js';
import { BrowserVerifyRequestCoordinator } from './browser-verify-request.js';
import { SqliteDurableStore } from './durable-store.js';
import { DurableMutationCoordinator } from './durable-mutation.js';
import { DurableVerifyJobCoordinator } from './durable-verify-job.js';
import { DurableCommitCoordinator } from './git-commit.js';
import { DevspaceFileMutationBackend } from './executor/devspace-file-mutation.js';
import { DevspaceGitCommitBackend } from './executor/devspace-git-commit.js';
import { isKillSwitchEngaged } from './goal-lease-kill-switch.js';
import { DevspaceVerifyExecutionPort } from './executor/devspace-verify.js';
import { startBrowserAdmissionHttpServer } from './http-server.js';
import { operatorDenialsToStderr, startOperatorServer } from './operator-server.js';
import { loadPrivateGatewayConfig } from './private-config.js';
import { bootstrapPrivateGateway } from './private-runtime.js';
import { createBrowserOperatorAdmittedMcpServer } from './server.js';
import { DevspaceRepositoryInspectionBackend } from './repository-inspection.js';
import { BROWSER_OPERATOR_PROTOCOL_VERSION } from './browser-adapter/protocol-v4.js';
import { DELEGATED_DISPATCH_PROTOCOL_VERSION } from './browser-adapter/protocol-v5.js';
import { DelegatedDispatchRouter } from './delegated-dispatch-router.js';
import { DelegatedRunCoordinator } from './delegated-run-executor.js';
import { McpDelegatedToolExecutionPort } from './delegated-tool-execution.js';
import { DelegationClaimSweeper } from './delegation-claim-sweeper.js';
import { startDelegationDispatchHttpServer } from './delegation-dispatch-http.js';
import {
  UiDelegationDispatchPlane,
  createDelegationDispatchPort,
} from './goal-ui-delegation-dispatch.js';

/** How often a configured lease is offered the pending queue. Idle when nothing is pending. */
const LEASE_ADMISSION_INTERVAL_MS = 2_000;

/**
 * The browser operator runtime (ADR-0026).
 *
 * A parallel assembly to `scripts/browser-adapter-runtime.ts` rather than a flag on it, because
 * the two expose different capability profiles under different adapter identities and must not
 * be one switch away from each other. This one lives in `src` because the CLI serves it: the
 * v3 assembly is still only reached by tests.
 *
 * The consequential coordinators here are the same classes the private stdio surface uses. The
 * browser reaches their *proposal* half; the operator server reaches their approval half. There
 * is no browser-shaped copy of the review contract, and no path from the browser to approval.
 */
export interface BrowserOperatorRuntime {
  admissionUrl: string;
  operatorOrigin: string;
  operatorBootstrapUrl: string;
  /** Where the single-use bootstrap URL was written, 0600, removed on shutdown. */
  operatorUrlFile: string;
  /**
   * The Autonomous Goal Lease this runtime honours, if any (ADR-0028). Absent is the default and
   * means every effect still needs the operator's Approve. Surfaced so the CLI can say plainly
   * that autonomous admission is on, rather than it being invisible in a config file.
   */
  goalLeaseId?: string;
  /**
   * The Goal UI Delegation this runtime honours, if any (ADR-0029). Absent is the default and means
   * Run stays human for every proposal. Surfaced for the same reason the lease is: an authority that
   * is only visible by reading a config file is one an operator can be running without knowing.
   */
  goalUiDelegationId?: string;
  /** Where the v5 discovery was written, when a delegation is configured. Removed on shutdown. */
  delegationDiscoveryPath?: string;
  close(): Promise<void>;
}

export async function startBrowserOperatorRuntime(options: {
  configPath: string;
  discoveryPath: string;
  /**
   * Where the v5 discovery goes, when a delegation is configured. Its own file, never the v4 one:
   * sharing a path would let whichever runtime started last delete the other's discovery, and — far
   * worse — would let a v4 host read a v5 bootstrap and admit into the wrong identity.
   */
  delegationDiscoveryPath?: string;
  statePath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BrowserOperatorRuntime> {
  if (!isAbsolute(options.configPath)) throw new Error('Browser operator config path must be absolute');
  if (!isAbsolute(options.discoveryPath)) throw new Error('Browser operator discovery path must be absolute');
  if (!isAbsolute(options.statePath)) throw new Error('Browser operator state path must be absolute');
  if (options.delegationDiscoveryPath !== undefined && !isAbsolute(options.delegationDiscoveryPath)) {
    throw new Error('Delegation discovery path must be absolute');
  }

  const env = options.env ?? process.env;
  const operatorUrlFile = `${options.statePath}.operator-url`;
  const config = await loadPrivateGatewayConfig(options.configPath);
  // The capability profile is asked for in the config, exactly as the stdio surface requires,
  // rather than being implied by which command was run. `gitCommit` needs `mutation` for the
  // same reason there: they share one durable store and one review server, so half of the pair
  // is a configuration mistake, not a quieter capability.
  const engineering = config.repositoryEngineering;
  if (!engineering?.mutation) {
    throw new Error('Browser operator requires repositoryEngineering.mutation in the config');
  }
  if (!engineering.gitCommit) {
    throw new Error('Browser operator requires repositoryEngineering.gitCommit in the config');
  }
  const bootstrapToken = randomBytes(32).toString('base64url');
  let store: SqliteDurableStore | undefined;
  let admission: BrowserAdmissionRegistry | undefined;
  let privateRuntime: Awaited<ReturnType<typeof bootstrapPrivateGateway>> | undefined;
  let http: Awaited<ReturnType<typeof startBrowserAdmissionHttpServer>> | undefined;
  let operator: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let delegationAdmission: BrowserAdmissionRegistry | undefined;
  let delegationHttp: Awaited<ReturnType<typeof startDelegationDispatchHttpServer>> | undefined;
  let claimSweeper: DelegationClaimSweeper | undefined;
  let delegationDiscoveryWritten: string | undefined;
  const delegationExecutors = new Set<McpDelegatedToolExecutionPort>();

  /** Tear down the delegation surface. Shared by the close path and the failure path. */
  const closeDelegation = async (): Promise<void> => {
    claimSweeper?.stop();
    await delegationHttp?.close().catch(() => undefined);
    for (const executor of delegationExecutors) await executor.close().catch(() => undefined);
    delegationExecutors.clear();
    delegationAdmission?.close();
    if (delegationDiscoveryWritten !== undefined) {
      await rm(delegationDiscoveryWritten, { force: true }).catch(() => undefined);
    }
  };

  try {
    await mkdir(dirname(options.statePath), { recursive: true });
    await mkdir(dirname(options.discoveryPath), { recursive: true });
    store = new SqliteDurableStore(options.statePath);
    // The correlation is the session key, so on the adapter that can propose changes it must be
    // a server-minted UUID rather than any string a caller chose.
    admission = new BrowserAdmissionRegistry(
      BROWSER_OPERATOR_ADAPTER_ID, store, Date.now, OPERATOR_CORRELATION_PATTERN,
    );
    privateRuntime = await bootstrapPrivateGateway(config, { env });

    const inspection = new DevspaceRepositoryInspectionBackend(privateRuntime.executor);
    const workspaces = new AdmittedWorkspaceService({
      store,
      executor: privateRuntime.executor,
      inspection,
      allowedRoots: config.allowedRoots,
    });

    const jobs = new DurableVerifyJobCoordinator({
      store,
      profiles: () => config.verifyProfiles,
      ports: [new DevspaceVerifyExecutionPort(privateRuntime.executor)],
    });
    await jobs.reconcile();

    const verify = new BrowserVerifyRequestCoordinator({
      store,
      profiles: () => config.verifyProfiles,
      browserProfiles: () => config.browserVerifyProfiles ?? [],
      jobs,
    });
    verify.reconcile();

    // One review window for both record kinds, so the operator does not have to learn two.
    const reviewTtlMs = engineering.mutation.reviewTtlMs;

    /**
     * The Autonomous Goal Lease, if this runtime was configured with one (ADR-0028).
     *
     * Absent unless the config names a lease, so autonomous admission is off by default and the
     * only route to an effect stays the operator's Approve button. Naming one grants nothing on
     * its own: the lease's bindings, expiry and revocation still decide every action, and an id
     * that is not in the store is refused rather than read as unrestricted.
     *
     * The kill switch is read from disk on every admission rather than captured here, so
     * engaging it stops this already-running process without restarting it.
     */
    const leaseId = engineering.mutation.goalLeaseId;
    const killSwitchDir = dirname(options.statePath);
    const goalLease = leaseId === undefined ? undefined : {
      leaseId,
      killSwitch: () => isKillSwitchEngaged(killSwitchDir),
    };

    const mutation = new DurableMutationCoordinator({
      store,
      backends: [new DevspaceFileMutationBackend(privateRuntime.executor)],
      ...(reviewTtlMs === undefined ? {} : { reviewTtlMs }),
      ...(goalLease === undefined ? {} : { goalLease }),
    });
    await mutation.reconcile();

    const commit = new DurableCommitCoordinator({
      store,
      backend: new DevspaceGitCommitBackend(privateRuntime.executor),
      ...(engineering.gitCommit.protectedBranches === undefined
        ? {}
        : { protectedBranches: engineering.gitCommit.protectedBranches }),
      ...(reviewTtlMs === undefined ? {} : { reviewTtlMs }),
      ...(goalLease === undefined ? {} : { goalLease }),
    });
    await commit.reconcile();

    /**
     * The admission pass, which is the thing that makes a configured lease do anything.
     *
     * Driven by a modest interval rather than fired from the proposal path, so that a proposal's
     * contract is unchanged and so that records left pending across a restart are picked up too.
     * It exists only when a lease is configured — with none, no timer is created and nothing on
     * this path runs at all.
     *
     * `unref` so it never holds the process open, and errors are swallowed per tick: a failing
     * admission must not take down a runtime whose human review path is working fine.
     */
    if (goalLease) {
      leaseTimer = setInterval(() => {
        void mutation.admitPendingUnderLease().catch(() => undefined);
      }, LEASE_ADMISSION_INTERVAL_MS);
      leaseTimer.unref?.();
    }

    // One review server for all three record kinds; the browser never learns its origin.
    operator = await startOperatorServer({
      coordinator: mutation,
      verifyCoordinator: verify,
      commitCoordinator: commit,
      // The operator is answered in a browser, where every refusal looks the same. This is the
      // channel that tells *this machine* which check failed.
      onDeny: operatorDenialsToStderr(),
    });
    // The single-use bootstrap goes to a file beside the state database, never to stderr, for
    // the same reason the stdio surface does it: whoever launched this process may log or
    // forward its stderr. The file carries the same exposure as the state database and is
    // removed on shutdown.
    await writeFile(operatorUrlFile, `${operator.bootstrapUrl}\n`, { encoding: 'utf8', mode: 0o600 });

    http = await startBrowserAdmissionHttpServer({
      gateway: privateRuntime.gateway,
      browserAdmission: {
        bootstrapToken,
        admission,
        browserMcp: (caller) => createBrowserOperatorAdmittedMcpServer(
          privateRuntime!.gateway,
          { callerContext: caller, workspaces, verify, mutation, commit },
        ),
      },
    });

    /**
     * The Goal UI Delegation surface (ADR-0029), if this runtime was configured with one.
     *
     * Everything below exists only when `goalUiDelegationId` is named in the config. With none —
     * the default, and the only behaviour before this field existed — no v5 server is started, no
     * v5 discovery is written, no sweeper runs, and Run stays human exactly as ADR-0026 says.
     *
     * Naming an id grants nothing by itself. The row still has to exist, be unrevoked, be inside
     * its window and its 4h ceiling, and bind this session, adapter, workspace, tool and origin.
     * An id naming no row is refused rather than read as unrestricted, and it is `evaluateDelegatedRun`
     * that decides — not this file, which only assembles.
     */
    const delegationId = engineering.mutation.goalUiDelegationId;
    if (delegationId !== undefined) {
      const delegationDiscoveryPath = options.delegationDiscoveryPath
        ?? `${options.statePath}.delegation-discovery.json`;
      const delegationBootstrap = randomBytes(32).toString('base64url');

      // Its own registry, on the v5 identity. Disjoint token maps are what make "a v4 bearer
      // cannot reach a v5 route" structural rather than a comparison someone remembers to write.
      // The strict correlation shape is defaulted by the registry for this adapter, because a
      // caller who can choose the correlation can join the session a delegation is bound to.
      delegationAdmission = new BrowserAdmissionRegistry(BROWSER_DELEGATION_ADAPTER_ID, store, Date.now);

      const dispatchPort = createDelegationDispatchPort(store);

      // Retires claims that never reached dispatch. Without a caller, a crash in that window
      // stranded a CLAIMED row forever — the slot stayed spent and the row never reached a
      // terminal state. It sweeps once on start, because the rows that most need retiring are
      // the ones already on disk after a crash.
      claimSweeper = new DelegationClaimSweeper({
        port: { abandonExpiredClaims: (now, ttl) => store!.abandonExpiredClaims(now, ttl) },
        onSwept: (abandoned) => process.stderr.write(`${JSON.stringify({
          type: 'gateway.delegation.claimsAbandoned', abandoned,
        })}\n`),
      });
      claimSweeper.start();

      delegationHttp = await startDelegationDispatchHttpServer({
        context: {
          bootstrapToken: delegationBootstrap,
          admission: delegationAdmission,
          coordinatorFor: (caller) => {
            // One plane and one router per admitted connection, carrying the identity the gateway
            // established — never anything an envelope claimed. The router refuses outright if the
            // connection is not the v5 identity.
            const plane = new UiDelegationDispatchPlane({
              port: dispatchPort,
              killSwitch: () => isKillSwitchEngaged(killSwitchDir),
              configuredDelegationId: delegationId,
            });
            const router = new DelegatedDispatchRouter({
              plane,
              connection: {
                ownerId: caller.ownerId,
                sessionId: caller.sessionId,
                adapterId: caller.adapterId,
              },
            });
            const executorPort = new McpDelegatedToolExecutionPort(
              () => createBrowserOperatorAdmittedMcpServer(
                privateRuntime!.gateway,
                { callerContext: caller, workspaces, verify, mutation, commit },
              ),
            );
            delegationExecutors.add(executorPort);
            return new DelegatedRunCoordinator({
              router, port: dispatchPort, executor: executorPort, sessionId: caller.sessionId,
            });
          },
        },
      });

      // Same contents and same 0600 mode as the v4 discovery, and the same omissions: the
      // admission URL and a one-time bootstrap, never the operator origin or its credential.
      await writeFile(delegationDiscoveryPath, JSON.stringify({
        admissionUrl: delegationHttp.admissionUrl,
        bootstrapToken: delegationBootstrap,
        protocolVersion: DELEGATED_DISPATCH_PROTOCOL_VERSION,
        adapterId: BROWSER_DELEGATION_ADAPTER_ID,
      }), { encoding: 'utf8', mode: 0o600 });
      delegationDiscoveryWritten = delegationDiscoveryPath;
    }

    if (!http.admissionUrl) throw new Error('Browser admission URL missing');
    // Discovery carries the admission URL and its one-time bootstrap only. No operator origin,
    // no operator credential: the browser must never be able to reach the approval channel.
    await writeFile(options.discoveryPath, JSON.stringify({
      admissionUrl: http.admissionUrl,
      bootstrapToken,
      protocolVersion: BROWSER_OPERATOR_PROTOCOL_VERSION,
      adapterId: BROWSER_OPERATOR_ADAPTER_ID,
    }), { encoding: 'utf8', mode: 0o600 });

    let closed = false;
    return {
      admissionUrl: http.admissionUrl,
      operatorOrigin: operator.origin,
      operatorBootstrapUrl: operator.bootstrapUrl,
      operatorUrlFile,
      ...(leaseId === undefined ? {} : { goalLeaseId: leaseId }),
      ...(engineering.mutation.goalUiDelegationId === undefined
        ? {}
        : { goalUiDelegationId: engineering.mutation.goalUiDelegationId }),
      ...(delegationDiscoveryWritten === undefined
        ? {}
        : { delegationDiscoveryPath: delegationDiscoveryWritten }),
      async close() {
        if (closed) return;
        closed = true;
        if (leaseTimer) clearInterval(leaseTimer);
        await closeDelegation();
        await rm(options.discoveryPath, { force: true });
        await rm(operatorUrlFile, { force: true }).catch(() => undefined);
        await http?.close();
        await operator?.close();
        admission?.close();
        await privateRuntime?.close();
        store?.close();
      },
    };
  } catch (error) {
    await closeDelegation();
    await rm(options.discoveryPath, { force: true }).catch(() => undefined);
    await rm(operatorUrlFile, { force: true }).catch(() => undefined);
    await http?.close().catch(() => undefined);
    await operator?.close().catch(() => undefined);
    admission?.close();
    await privateRuntime?.close().catch(() => undefined);
    store?.close();
    throw error;
  }
}
