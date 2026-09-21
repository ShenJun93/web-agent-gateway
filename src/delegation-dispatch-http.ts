/**
 * The loopback transport for delegated dispatch (ADR-0029).
 *
 * A parallel server to `http-server.ts` rather than three more routes on it, and the reason is the
 * same one that made v5 a parallel protocol file: the two surfaces must not be one bug away from
 * each other. This server has its own `BrowserAdmissionRegistry`, bound to the v5 adapter identity,
 * so the token maps are disjoint — **a v4 bearer cannot reach a v5 route and a v5 bearer cannot
 * reach `/mcp`**, structurally, rather than because a check remembered to compare an adapter id.
 *
 * That matters more here than it looks. `/mcp` is the tool surface: anything holding a v4 bearer can
 * call `file.create` directly. If a v5 bearer could reach it, the entire staging round-trip would be
 * decoration — stage a candidate, get refused by the delegation, then call the tool anyway.
 *
 * ## Why the coordinator is keyed by bearer
 *
 * The router carries one piece of state, `bound`, and a reconnect must start unbound exactly as a
 * fresh native port does. Keying by session would survive a reconnect and hand the new connection
 * the old one's bound flag; keying by bearer cannot, because admitting a session mints a new token
 * and invalidates the previous one. So a service-worker restart gets a genuinely fresh router, and
 * `session.bind` means what it says.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { BrowserAdmissionRegistry } from './adapter-admission.js';
import type { GatewayCallerContext } from './caller-context.js';
import { DELEGATED_DISPATCH_MAX_BYTES } from './browser-adapter/protocol-v5.js';
import type { DelegatedRunCoordinator } from './delegated-run-executor.js';

/** One coordinator per live bearer. Bounded so a reconnect loop cannot grow this without limit. */
const MAX_LIVE_COORDINATORS = 64;

const admissionBodySchema = z.object({
  correlation_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

export interface DelegationDispatchHttpContext {
  bootstrapToken: string;
  admission: BrowserAdmissionRegistry;
  /** Build the coordinator for one admitted connection. Called once per bearer. */
  coordinatorFor(caller: GatewayCallerContext): DelegatedRunCoordinator;
}

export interface DelegationDispatchHttpServer {
  host: string;
  port: number;
  admissionUrl: string;
  dispatchUrl: string;
  close(): Promise<void>;
}

export async function startDelegationDispatchHttpServer(options: {
  context: DelegationDispatchHttpContext;
  host?: string;
  port?: number;
}): Promise<DelegationDispatchHttpServer> {
  const context = options.context;
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('Delegated dispatch HTTP must bind IPv4 loopback');
  if (Buffer.byteLength(context.bootstrapToken) < 32) {
    throw new Error('Delegated dispatch bootstrap token must be at least 32 bytes');
  }

  // Keyed by the raw bearer. The native host is the only holder, it is loopback-only, and the
  // token dies with the admission — see the header for why session would be the wrong key.
  const coordinators = new Map<string, DelegatedRunCoordinator>();
  /**
   * The bearer currently live for each session, so the previous one can be evicted.
   *
   * Keying by bearer is right and it creates a lifecycle problem the first draft did not handle:
   * `admission.admit()` invalidates the *previous* token for that session, so the old bearer starts
   * 401ing — but nothing removed its coordinator. Every reconnect that did not cleanly unbind (an
   * MV3 worker killed without warning, a browser crash, a host killed, a best-effort release that
   * did not land) leaked one entry, and after `MAX_LIVE_COORDINATORS` of them the surface refused
   * every new session until WAG restarted.
   */
  const liveBearerBySession = new Map<string, string>();
  let listenerPort = 0;

  const server = createServer({ requireHostHeader: false }, async (req, res) => {
    res.setHeader('x-request-id', randomUUID());
    try {
      // Same two checks the v4 admission server makes, for the same reason: a browser page must
      // never be able to reach this, and a page's fetch always carries an `Origin`.
      if (req.headers.host !== `${host}:${listenerPort}` || req.headers.origin !== undefined) {
        json(res, 403, { error: 'forbidden' });
        return;
      }
      await route(req, res);
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
    }
  });

  listenerPort = await listen(server, host, options.port ?? 0);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === '/adapter/admit') return handleAdmission(req, res);
    if (req.url === '/adapter/release') return handleRelease(req, res);
    if (req.url === '/adapter/dispatch') return handleDispatch(req, res);
    res.writeHead(404).end();
  }

  async function handleAdmission(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }
    if (req.headers['content-type'] !== 'application/json') {
      json(res, 415, { error: 'unsupported_media_type' });
      return;
    }
    if (!authorized(req, context.bootstrapToken)) {
      res.setHeader('www-authenticate', 'Bearer');
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await readBody(req, 4096)); }
    catch (error) {
      json(res, error instanceof BodyTooLargeError ? 413 : 400, { error: 'invalid_request' });
      return;
    }
    const body = admissionBodySchema.safeParse(parsed);
    if (!body.success) { json(res, 400, { error: 'invalid_request' }); return; }

    // Checked **before** admitting, not after. `admit()` invalidates the session's previous token
    // as a side effect, so refusing afterwards took a working session's bearer away and gave it
    // nothing back — a reconnect at the cap killed the very session it was trying to restore.
    if (coordinators.size >= MAX_LIVE_COORDINATORS) {
      json(res, 503, { error: 'too_many_sessions' });
      return;
    }

    // The registry refuses a correlation that is not a server-minted UUID, because the delegation
    // adapter defaults to the strict shape. A caller who could choose it could join the exact
    // session a delegation is bound to.
    let admitted: { mcpToken: string; callerContext: GatewayCallerContext };
    try { admitted = context.admission.admit(body.data.correlation_id); }
    catch { json(res, 400, { error: 'invalid_request' }); return; }

    // The previous bearer for this session is dead the moment `admit` returns, so its coordinator
    // goes with it. This is what keeps a reconnect loop from filling the map with corpses.
    dropCoordinator(liveBearerBySession.get(admitted.callerContext.sessionId));
    liveBearerBySession.set(admitted.callerContext.sessionId, admitted.mcpToken);
    coordinators.set(admitted.mcpToken, context.coordinatorFor(admitted.callerContext));
    json(res, 200, {
      dispatch_url: `http://${host}:${listenerPort}/adapter/dispatch`,
      bearer_token: admitted.mcpToken,
    });
  }

  /** Forget one bearer's coordinator and release what it holds. Safe on an unknown bearer. */
  function dropCoordinator(token: string | undefined): void {
    if (token === undefined) return;
    const coordinator = coordinators.get(token);
    coordinators.delete(token);
    // Fire-and-forget: closing an MCP pair is best effort, and nothing downstream waits on it.
    void coordinator?.close().catch(() => undefined);
  }

  function handleRelease(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }
    const token = bearerToken(req);
    const caller = token ? context.admission.resolveMcpToken(token) : undefined;
    if (!token || !context.admission.releaseMcpToken(token)) {
      res.setHeader('www-authenticate', 'Bearer');
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    if (caller && liveBearerBySession.get(caller.sessionId) === token) {
      liveBearerBySession.delete(caller.sessionId);
    }
    dropCoordinator(token);
    json(res, 200, { released: true });
  }

  async function handleDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }
    if (req.headers['content-type'] !== 'application/json') {
      json(res, 415, { error: 'unsupported_media_type' });
      return;
    }
    const token = bearerToken(req);
    // Resolved through the registry *and* found in the coordinator map. Both, because a token the
    // registry still knows but this server never admitted is not a connection this server holds.
    const caller = token ? context.admission.resolveMcpToken(token) : undefined;
    const coordinator = token ? coordinators.get(token) : undefined;
    if (!caller || !coordinator) {
      res.setHeader('www-authenticate', 'Bearer');
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    let parsed: unknown;
    try { parsed = JSON.parse(await readBody(req, DELEGATED_DISPATCH_MAX_BYTES)); }
    catch (error) {
      json(res, error instanceof BodyTooLargeError ? 413 : 400, { error: 'invalid_request' });
      return;
    }
    // Everything past here is the protocol's business. A malformed envelope is answered with a v5
    // error frame rather than an HTTP status, because the caller is a relay that must forward a
    // protocol answer to the extension — an HTTP 400 carries no request id to correlate.
    json(res, 200, await coordinator.handle(parsed));
  }

  return {
    host,
    port: listenerPort,
    admissionUrl: `http://${host}:${listenerPort}/adapter/admit`,
    dispatchUrl: `http://${host}:${listenerPort}/adapter/dispatch`,
    close: async () => {
      const open = [...coordinators.values()];
      coordinators.clear();
      liveBearerBySession.clear();
      await Promise.all(open.map((coordinator) => coordinator.close().catch(() => undefined)));
      await closeServer(server);
    },
  };
}

class BodyTooLargeError extends Error {}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

function authorized(req: IncomingMessage, expected: string): boolean {
  const token = bearerToken(req);
  if (token === undefined) return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Length is compared first because `timingSafeEqual` throws on a mismatch; the length of a
  // bootstrap token is not the secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new BodyTooLargeError('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, value: object): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

async function listen(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Delegated dispatch listen failed');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
}
