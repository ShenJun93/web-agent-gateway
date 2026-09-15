import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createGatewayCallerContext, type GatewayCallerContext } from './caller-context.js';
import { SqliteDurableStore } from './durable-store.js';

export const BROWSER_ADAPTER_ID = 'browser.chatgpt.native.v1' as const;

const correlationId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export interface AdmitBrowserSessionResult {
  mcpToken: string;
  callerContext: GatewayCallerContext;
}

export class BrowserAdmissionRegistry {
  private readonly contextsByTokenDigest = new Map<string, GatewayCallerContext>();
  private readonly activeDigestBySession = new Map<string, string>();

  constructor(
    private readonly store: SqliteDurableStore,
    private readonly now: () => number = Date.now,
  ) {}

  admit(rawCorrelation: string): AdmitBrowserSessionResult {
    const validatedCorrelation = correlationId.parse(rawCorrelation);
    const principal = this.store.getOrCreateLocalPrincipal(this.now());
    const session = this.store.getOrCreateAdapterSession({
      ownerId: principal.ownerId,
      adapterId: BROWSER_ADAPTER_ID,
      correlationSha256: correlationSha256(principal.ownerId, BROWSER_ADAPTER_ID, validatedCorrelation),
      createdAt: this.now(),
    });
    const callerContext = createGatewayCallerContext({
      ownerId: session.ownerId,
      sessionId: session.sessionId,
      adapterId: session.adapterId,
    });

    const previousDigest = this.activeDigestBySession.get(session.sessionId);
    if (previousDigest !== undefined) this.contextsByTokenDigest.delete(previousDigest);

    const mcpToken = randomBytes(32).toString('base64url');
    const tokenDigest = mcpTokenSha256(mcpToken);
    this.contextsByTokenDigest.set(tokenDigest, callerContext);
    this.activeDigestBySession.set(session.sessionId, tokenDigest);
    return { mcpToken, callerContext };
  }

  resolveMcpToken(rawToken: string): GatewayCallerContext | undefined {
    return this.contextsByTokenDigest.get(mcpTokenSha256(rawToken));
  }

  releaseMcpToken(rawToken: string): boolean {
    const digest = mcpTokenSha256(rawToken);
    const context = this.contextsByTokenDigest.get(digest);
    if (context === undefined) return false;
    this.contextsByTokenDigest.delete(digest);
    if (this.activeDigestBySession.get(context.sessionId) === digest) {
      this.activeDigestBySession.delete(context.sessionId);
    }
    return true;
  }

  close(): void {
    this.contextsByTokenDigest.clear();
    this.activeDigestBySession.clear();
  }
}

function correlationSha256(ownerId: string, adapterId: string, raw: string): string {
  return createHash('sha256')
    .update('wag.adapter-correlation.v1\0', 'utf8')
    .update(ownerId, 'utf8').update('\0')
    .update(adapterId, 'utf8').update('\0')
    .update(raw, 'utf8')
    .digest('hex');
}

function mcpTokenSha256(token: string): string {
  return createHash('sha256')
    .update('wag.mcp-session-token.v1\0', 'utf8')
    .update(token, 'utf8')
    .digest('hex');
}
