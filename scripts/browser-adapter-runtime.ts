import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { AdmittedWorkspaceService } from '../src/admitted-workspace.js';
import { BrowserAdmissionRegistry, BROWSER_INSPECT_ADAPTER_ID } from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { startBrowserAdmissionHttpServer } from '../src/http-server.js';
import { loadPrivateGatewayConfig } from '../src/private-config.js';
import { bootstrapPrivateGateway } from '../src/private-runtime.js';
import { createBrowserAdmittedMcpServer } from '../src/server.js';
import { DevspaceRepositoryInspectionBackend } from '../src/repository-inspection.js';
import { BROWSER_ADAPTER_PROTOCOL_VERSION } from '../src/browser-adapter/protocol.js';

export interface BrowserAdapterRuntime {
  admissionUrl: string;
  close(): Promise<void>;
}

export async function startBrowserAdapterRuntime(options: {
  configPath: string;
  discoveryPath: string;
  statePath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BrowserAdapterRuntime> {
  if (!isAbsolute(options.configPath)) throw new Error('Browser adapter config path must be absolute');
  if (!isAbsolute(options.discoveryPath)) throw new Error('Browser adapter discovery path must be absolute');
  if (!isAbsolute(options.statePath)) throw new Error('Browser adapter state path must be absolute');

  const env = options.env ?? process.env;
  const config = await loadPrivateGatewayConfig(options.configPath);
  const bootstrapToken = randomBytes(32).toString('base64url');
  let store: SqliteDurableStore | undefined;
  let admission: BrowserAdmissionRegistry | undefined;
  let privateRuntime: Awaited<ReturnType<typeof bootstrapPrivateGateway>> | undefined;
  let http: Awaited<ReturnType<typeof startBrowserAdmissionHttpServer>> | undefined;

  try {
    await mkdir(dirname(options.statePath), { recursive: true });
    await mkdir(dirname(options.discoveryPath), { recursive: true });
    store = new SqliteDurableStore(options.statePath);
    admission = new BrowserAdmissionRegistry(BROWSER_INSPECT_ADAPTER_ID, store);
    privateRuntime = await bootstrapPrivateGateway(config, { env });
    const inspection = new DevspaceRepositoryInspectionBackend(privateRuntime.executor);
    const workspaces = new AdmittedWorkspaceService({
      store,
      executor: privateRuntime.executor,
      inspection,
      allowedRoots: config.allowedRoots,
    });

    http = await startBrowserAdmissionHttpServer({
      gateway: privateRuntime.gateway,
      browserAdmission: {
        bootstrapToken,
        admission,
        browserMcp: (caller) => createBrowserAdmittedMcpServer(
          privateRuntime!.gateway,
          { callerContext: caller, workspaces },
        ),
      },
    });

    if (!http.admissionUrl) throw new Error('Browser admission URL missing');
    await writeFile(options.discoveryPath, JSON.stringify({
      admissionUrl: http.admissionUrl,
      bootstrapToken,
      protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION,
      adapterId: BROWSER_INSPECT_ADAPTER_ID,
    }), { encoding: 'utf8', mode: 0o600 });

    let closed = false;
    return {
      admissionUrl: http.admissionUrl,
      async close() {
        if (closed) return;
        closed = true;
        await rm(options.discoveryPath, { force: true });
        await http?.close();
        admission?.close();
        await privateRuntime?.close();
        store?.close();
      },
    };
  } catch (error) {
    await rm(options.discoveryPath, { force: true }).catch(() => undefined);
    await http?.close().catch(() => undefined);
    admission?.close();
    await privateRuntime?.close().catch(() => undefined);
    store?.close();
    throw error;
  }
}
