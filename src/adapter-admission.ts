import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createGatewayCallerContext, type GatewayCallerContext } from './caller-context.js';
import { SqliteDurableStore } from './durable-store.js';

export const BROWSER_ADAPTER_V1_ID = 'browser.chatgpt.native.v1' as const;
export const BROWSER_INSPECT_ADAPTER_ID = 'browser.chatgpt.native.inspect.v2' as const;
export const BROWSER_VERIFY_ADAPTER_ID = 'browser.chatgpt.native.verify.v3' as const;
/** The operator successor (ADR-0026). Distinct so no v1/v2/v3 session gains proposal authority. */
export const BROWSER_OPERATOR_ADAPTER_ID = 'browser.chatgpt.native.operator.v4' as const;
/**
 * The delegated-dispatch successor (ADR-0029). Distinct so no v4 session gains dispatch authority,
 * and so a delegation — which binds `adapterId` — cannot be used by a session of any other kind.
 *
 * Narrower than v4 in verbs — it has no `tool.call`; the browser stages a candidate and later asks
 * for it by reference, so the tool that runs is the one in the stored row. Its arguments are bounded
 * by v4's own per-tool schemas, so it is not wider there either. What it *does* add is the Run
 * transition itself, which is the point of the revision and is bounded by the delegation, not by
 * the verb count.
 */
export const BROWSER_DELEGATION_ADAPTER_ID = 'browser.chatgpt.native.delegation.v5' as const;

/**
 * The correlation shape the operator adapter requires.
 *
 * A correlation is what maps a browser session to a durable WAG session: two admissions with the
 * same string are the same session, which is what makes a service-worker restart reconnect
 * rather than orphan its workspaces. That also means a caller who can choose the string can join
 * an existing session — so for the adapter that can propose changes, the string must be a
 * server-minted UUID rather than anything a page could pick or guess.
 *
 * The accepted v1/v2/v3 adapters keep their permissive shape: this constrains the successor
 * only, and changing them would alter a frozen contract.
 */
export const OPERATOR_CORRELATION_PATTERN = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same shape, required of the delegation adapter — and required *by default*, not by whoever
 * remembers to pass it.
 *
 * The reasoning above applies here with more force, and a review found it unapplied. A delegation
 * binds `sessionId`, and `sessionId` is derived from the correlation; so a caller who can choose
 * the correlation can join the exact session a delegation is bound to. The constructor's pattern
 * argument is optional, and an omitted one means the permissive v1/v2/v3 shape — so the adapter
 * that can cause a Run would have had the weakest correlation shape of any of them, because of a
 * default rather than a decision.
 */
export const DELEGATION_CORRELATION_PATTERN = OPERATOR_CORRELATION_PATTERN;

const correlationId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export interface AdmitBrowserSessionResult {
  mcpToken: string;
  callerContext: GatewayCallerContext;
}

export class BrowserAdmissionRegistry {
  private readonly contextsByTokenDigest = new Map<string, GatewayCallerContext>();
  private readonly activeDigestBySession = new Map<string, string>();

  constructor(
    private readonly adapterId: string,
    private readonly store: SqliteDurableStore,
    private readonly now: () => number = Date.now,
    private readonly correlationPattern?: RegExp,
  ) {
    // Defaulted rather than demanded, so the strict shape cannot be lost by forgetting an
    // argument. An explicit pattern still wins, for a caller that means something narrower.
    if (adapterId === BROWSER_DELEGATION_ADAPTER_ID && correlationPattern === undefined) {
      this.correlationPattern = DELEGATION_CORRELATION_PATTERN;
    }
  }

  admit(rawCorrelation: string): AdmitBrowserSessionResult {
    const validatedCorrelation = correlationId.parse(rawCorrelation);
    if (this.correlationPattern && !this.correlationPattern.test(validatedCorrelation)) {
      throw new Error('Browser adapter correlation shape rejected');
    }
    const principal = this.store.getOrCreateLocalPrincipal(this.now());
    const session = this.store.getOrCreateAdapterSession({
      ownerId: principal.ownerId,
      adapterId: this.adapterId,
      correlationSha256: correlationSha256(principal.ownerId, this.adapterId, validatedCorrelation),
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
