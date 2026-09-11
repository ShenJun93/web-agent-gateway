import { createDevspaceOAuthSession, type DevspaceOAuthSession } from './executor/devspace-oauth.js';
import { DevspaceExecutor } from './executor/devspace.js';
import type { PrivateGatewayConfig } from './private-config.js';
import { createGateway, type GatewayApi } from './server.js';
import type { TelemetrySink } from './telemetry.js';
import type { PatchApprovalStore } from './patch-approval.js';

export type PrivateRuntimeErrorCode =
  | 'DEVSPACE_OWNER_TOKEN_MISSING'
  | 'DEVSPACE_AUTH_FAILED'
  | 'DEVSPACE_COMPAT_FAILED';

export class PrivateRuntimeError extends Error {
  constructor(
    readonly code: PrivateRuntimeErrorCode,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = 'PrivateRuntimeError';
  }
}

export interface PrivateRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  telemetry?: TelemetrySink;
  oauthFactory?: typeof createDevspaceOAuthSession;
  patchApprovals?: PatchApprovalStore;
}
export interface PrivateGatewayRuntime {
  gateway: GatewayApi;
  health: Awaited<ReturnType<GatewayApi['health']>>;
  close(): Promise<void>;
}

export async function bootstrapPrivateGateway(
  config: PrivateGatewayConfig,
  options: PrivateRuntimeOptions = {},
): Promise<PrivateGatewayRuntime> {
  const env = options.env ?? process.env;
  const ownerToken = env.DEVSPACE_OAUTH_OWNER_TOKEN;
  if (!ownerToken) throw new PrivateRuntimeError('DEVSPACE_OWNER_TOKEN_MISSING');

  const oauthFactory = options.oauthFactory ?? createDevspaceOAuthSession;
  let session: DevspaceOAuthSession;
  try {
    session = await oauthFactory({
      baseUrl: config.devspace.baseUrl,
      resourceUrl: config.devspace.resourceUrl,
      ownerToken,
    });
  } catch (error) {
    throw new PrivateRuntimeError('DEVSPACE_AUTH_FAILED', { cause: error });
  }
  delete env.DEVSPACE_OAUTH_OWNER_TOKEN;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await session.close();
  };
  const gateway = createGateway({
    executor: new DevspaceExecutor({ baseUrl: config.devspace.baseUrl, tokenSource: session }),
    allowedRoots: config.allowedRoots,
    verifyProfiles: config.verifyProfiles,
    telemetry: options.telemetry,
    patchApprovals: options.patchApprovals,
  });

  try {
    const health = await gateway.health();
    return { gateway, health, close };
  } catch (error) {
    await close();
    throw new PrivateRuntimeError('DEVSPACE_COMPAT_FAILED', { cause: error });
  }
}
