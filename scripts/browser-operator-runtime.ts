import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { AdmittedWorkspaceService } from '../src/admitted-workspace.js';
import {
  BrowserAdmissionRegistry,
  BROWSER_OPERATOR_ADAPTER_ID,
  OPERATOR_CORRELATION_PATTERN,
} from '../src/adapter-admission.js';
import { BrowserVerifyRequestCoordinator } from '../src/browser-verify-request.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { DurableVerifyJobCoordinator } from '../src/durable-verify-job.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import { DevspaceFileMutationBackend } from '../src/executor/devspace-file-mutation.js';
import { DevspaceGitCommitBackend } from '../src/executor/devspace-git-commit.js';
import { DevspaceVerifyExecutionPort } from '../src/executor/devspace-verify.js';
import { startBrowserAdmissionHttpServer } from '../src/http-server.js';
import { startOperatorServer } from '../src/operator-server.js';
import { loadPrivateGatewayConfig } from '../src/private-config.js';
import { bootstrapPrivateGateway } from '../src/private-runtime.js';
import { createBrowserOperatorAdmittedMcpServer } from '../src/server.js';
import { DevspaceRepositoryInspectionBackend } from '../src/repository-inspection.js';
import { BROWSER_OPERATOR_PROTOCOL_VERSION } from '../src/browser-adapter/protocol-v4.js';

/**
 * The browser operator runtime (ADR-0026).
 *
 * A parallel assembly to `browser-adapter-runtime.ts` rather than a flag on it, because the two
 * expose different capability profiles under different adapter identities and must not be one
 * switch away from each other.
 *
 * The consequential coordinators here are the same classes the private stdio surface uses. The
 * browser reaches their *proposal* half; the operator server reaches their approval half. There
 * is no browser-shaped copy of the review contract, and no path from the browser to approval.
 */
export interface BrowserOperatorRuntime {
  admissionUrl: string;
  operatorOrigin: string;
  operatorBootstrapUrl: string;
  close(): Promise<void>;
}

export async function startBrowserOperatorRuntime(options: {
  configPath: string;
  discoveryPath: string;
  statePath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BrowserOperatorRuntime> {
  if (!isAbsolute(options.configPath)) throw new Error('Browser operator config path must be absolute');
  if (!isAbsolute(options.discoveryPath)) throw new Error('Browser operator discovery path must be absolute');
  if (!isAbsolute(options.statePath)) throw new Error('Browser operator state path must be absolute');

  const env = options.env ?? process.env;
  const config = await loadPrivateGatewayConfig(options.configPath);
  const bootstrapToken = randomBytes(32).toString('base64url');
  let store: SqliteDurableStore | undefined;
  let admission: BrowserAdmissionRegistry | undefined;
  let privateRuntime: Awaited<ReturnType<typeof bootstrapPrivateGateway>> | undefined;
  let http: Awaited<ReturnType<typeof startBrowserAdmissionHttpServer>> | undefined;
  let operator: Awaited<ReturnType<typeof startOperatorServer>> | undefined;

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

    const mutation = new DurableMutationCoordinator({
      store,
      backends: [new DevspaceFileMutationBackend(privateRuntime.executor)],
    });
    await mutation.reconcile();

    const commit = new DurableCommitCoordinator({
      store,
      backend: new DevspaceGitCommitBackend(privateRuntime.executor),
      ...(config.repositoryEngineering?.gitCommit?.protectedBranches === undefined
        ? {}
        : { protectedBranches: config.repositoryEngineering.gitCommit.protectedBranches }),
    });
    await commit.reconcile();

    // One review server for all three record kinds; the browser never learns its origin.
    operator = await startOperatorServer({
      coordinator: mutation,
      verifyCoordinator: verify,
      commitCoordinator: commit,
    });

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
      async close() {
        if (closed) return;
        closed = true;
        await rm(options.discoveryPath, { force: true });
        await http?.close();
        await operator?.close();
        admission?.close();
        await privateRuntime?.close();
        store?.close();
      },
    };
  } catch (error) {
    await rm(options.discoveryPath, { force: true }).catch(() => undefined);
    await http?.close().catch(() => undefined);
    await operator?.close().catch(() => undefined);
    admission?.close();
    await privateRuntime?.close().catch(() => undefined);
    store?.close();
    throw error;
  }
}
