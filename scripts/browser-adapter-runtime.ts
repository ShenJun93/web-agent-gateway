import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { startGatewayHttpServer } from '../src/http-server.js';
import { loadPrivateGatewayConfig } from '../src/private-config.js';
import { bootstrapPrivateGateway } from '../src/private-runtime.js';

export interface BrowserAdapterRuntime {
  mcpUrl: string;
  close(): Promise<void>;
}

export async function startBrowserAdapterRuntime(options: {
  configPath: string;
  discoveryPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BrowserAdapterRuntime> {
  if (!isAbsolute(options.configPath)) throw new Error('Browser adapter config path must be absolute');
  if (!isAbsolute(options.discoveryPath)) throw new Error('Browser adapter discovery path must be absolute');

  const env = options.env ?? process.env;
  const config = await loadPrivateGatewayConfig(options.configPath);
  const bearerToken = randomBytes(32).toString('base64url');
  let privateRuntime: Awaited<ReturnType<typeof bootstrapPrivateGateway>> | undefined;
  let http: Awaited<ReturnType<typeof startGatewayHttpServer>> | undefined;

  try {
    privateRuntime = await bootstrapPrivateGateway(config, { env });
    http = await startGatewayHttpServer({
      gateway: privateRuntime.gateway,
      bearerToken,
    });

    await mkdir(dirname(options.discoveryPath), { recursive: true });
    await writeFile(options.discoveryPath, JSON.stringify({
      mcpUrl: http.mcpUrl,
      bearerToken,
    }), { encoding: 'utf8', mode: 0o600 });

    let closed = false;
    return {
      mcpUrl: http.mcpUrl,
      async close() {
        if (closed) return;
        closed = true;
        await rm(options.discoveryPath, { force: true });
        await http?.close();
        await privateRuntime?.close();
      },
    };
  } catch (error) {
    await rm(options.discoveryPath, { force: true }).catch(() => undefined);
    await http?.close().catch(() => undefined);
    await privateRuntime?.close().catch(() => undefined);
    throw error;
  }
}
