/**
 * The production transport, end to end, with nothing stubbed between the native port and the store.
 *
 * The existing transport suite drives the router directly. That is the right level for policy, and
 * it is exactly why it could not catch what this file exists for.
 *
 * ## The defect this suite was written for
 *
 * The extension mints a **correlation** and sends it as `sessionId`. WAG hashes the correlation,
 * resolves a durable `adapter_sessions` row, and that row's id is a *different* `session_<uuid>`.
 * The two have the same shape and are never the same value.
 *
 * Every earlier test used **one value for both**, so `envelope.sessionId === connection.sessionId`
 * held trivially and the router's comparison always passed. In production the comparison would have
 * refused `session.bind` itself, and delegated Run would never have worked once — not intermittently,
 * not under load, never. A green suite would have shipped a surface that could not bind.
 *
 * So the rule for this file: **the correlation and the session id must be visibly different
 * strings, and the tests assert that they are.** A regression that conflates them fails here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BrowserAdmissionRegistry,
  BROWSER_DELEGATION_ADAPTER_ID,
} from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  UiDelegationControlPlane,
  createControllerPlaneKey,
} from '../src/goal-ui-delegation-control.js';
import {
  UiDelegationDispatchPlane,
  createDelegationDispatchPort,
} from '../src/goal-ui-delegation-dispatch.js';
import { DelegatedDispatchRouter } from '../src/delegated-dispatch-router.js';
import { DelegatedRunCoordinator } from '../src/delegated-run-executor.js';
import { startDelegationDispatchHttpServer } from '../src/delegation-dispatch-http.js';
import { HttpLocalDelegationAdapterLink } from '../src/browser-adapter/local-link-v5.js';
import { runNativeDelegationHost } from '../src/browser-adapter/native-host-v5.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';
import { NativeMessageDecoder, encodeNativeMessage } from '../src/browser-adapter/native-framing.js';

const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;
const PAGE_ORIGIN = 'https://chatgpt.com';
const WORKSPACE = 'ws_production_transport';
const TOOL = 'repo.search';

/** A correlation the extension would mint. Deliberately not a session id, and asserted not to be. */
const correlation = () => `session_${randomUUID()}`;

interface Harness {
  store: SqliteDurableStore;
  /** What the extension knows. */
  correlationId: string;
  /** What WAG resolved it to. A different string. */
  sessionId: string;
  delegationId: string;
  executed: { tool: string; arguments: unknown }[];
  toolOk: () => boolean;
  send(envelope: unknown): Promise<Record<string, unknown>>;
  cleanup(): Promise<void>;
  /** The loopback server, so its own route checks can be driven directly. */
  admissionUrl: string;
  dispatchUrl: string;
  /** The shared registry, for the case where a bearer is minted outside the HTTP route. */
  admission: BrowserAdmissionRegistry;
  closeServer(): Promise<void>;
  /** How many coordinators have been disposed — the executor leak is invisible without this. */
  disposed(): number;
}

/**
 * Stand up the whole stack: store, admission, v5 HTTP server, link, and a native host driven over
 * real streams with real length-prefixed framing.
 *
 * The only thing stubbed is the tool itself. Everything that carries identity — admission, the
 * bearer, the session resolution, the envelope round trip — is the production code.
 */
async function harness(t: test.TestContext, options: { maxActions?: number; tools?: string[] } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'wag-prod-transport-'));
  const store = new SqliteDurableStore(join(directory, 'state.sqlite'));
  const admission = new BrowserAdmissionRegistry(BROWSER_DELEGATION_ADAPTER_ID, store);

  // Admit once up front, purely to discover the durable session id — exactly the bootstrap a human
  // performs with `delegation-control --sessions` before issuing.
  const correlationId = correlation();
  const discovered = admission.admit(correlationId);
  const sessionId = discovered.callerContext.sessionId;
  assert.notEqual(
    sessionId, correlationId,
    'the durable session id must differ from the correlation, or this suite proves nothing',
  );

  const control = new UiDelegationControlPlane({
    store, key: createControllerPlaneKey('local.operator.cli'),
  });
  const { delegationId } = control.issue({
    goalId: 'goal_production_transport',
    ttlMs: 60 * 60_000,
    bindings: {
      goalId: 'goal_production_transport',
      controllerId: 'local.operator.cli',
      allowedOrigins: [PAGE_ORIGIN],
      allowedTools: options.tools ?? [TOOL],
      workspaceId: WORKSPACE,
      sessionId,
      adapterId: BROWSER_DELEGATION_ADAPTER_ID,
      maxActions: options.maxActions ?? 4,
    },
  });

  const executed: { tool: string; arguments: unknown }[] = [];
  let toolOk = true;
  let disposed = 0;
  const port = createDelegationDispatchPort(store);

  const server = await startDelegationDispatchHttpServer({
    context: {
      bootstrapToken: 'x'.repeat(48),
      admission,
      coordinatorFor: (caller) => {
        const plane = new UiDelegationDispatchPlane({
          port, killSwitch: () => false, configuredDelegationId: delegationId,
        });
        const router = new DelegatedDispatchRouter({
          plane,
          connection: {
            ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId,
          },
        });
        return new DelegatedRunCoordinator({
          router,
          port,
          sessionId: caller.sessionId,
          dispose: async () => { disposed += 1; },
          executor: {
            async callTool(input) {
              executed.push(input);
              return toolOk
                ? { ok: true, structuredContent: { matches: [], tool: input.tool } }
                : { ok: false };
            },
          },
        });
      },
    },
  });

  // The native host, over real streams and real framing.
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const decoder = new NativeMessageDecoder();
  const waiting = new Map<string, (value: Record<string, unknown>) => void>();
  fromHost.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      const record = message as Record<string, unknown>;
      const resolve = waiting.get(String(record.requestId));
      if (resolve) { waiting.delete(String(record.requestId)); resolve(record); }
    }
  });

  const hostRun = runNativeDelegationHost({
    input: toHost,
    output: fromHost,
    expectedOrigin: EXTENSION_ORIGIN,
    linkFactory: (id) => HttpLocalDelegationAdapterLink.admit({
      admissionUrl: server.admissionUrl,
      bootstrapToken: 'x'.repeat(48),
      protocolVersion: 5,
      adapterId: BROWSER_DELEGATION_ADAPTER_ID,
    }, id),
  }).catch(() => undefined);

  const send = (envelope: unknown): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const requestId = String((envelope as { requestId?: unknown }).requestId);
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`timeout ${requestId}`)); }, 5_000);
    waiting.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
    toHost.write(encodeNativeMessage(envelope));
  });

  // One ordered cleanup, registered once. Windows holds the sqlite file open until the handle is
  // closed, and `t.after` hooks run in registration order — so several hooks unlinking a directory
  // before the store closes is how this suite used to fail with EBUSY.
  t.after(async () => {
    toHost.end();
    await hostRun;
    await server.close();
    admission.close();
    store.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });

  return {
    store, correlationId, sessionId, delegationId, executed,
    toolOk: () => toolOk,
    send,
    cleanup: async () => { toolOk = false; },
    admissionUrl: server.admissionUrl,
    dispatchUrl: server.dispatchUrl,
    admission,
    closeServer: () => server.close(),
    disposed: () => disposed,
  };
}

const bind = async (h: Harness): Promise<Record<string, unknown>> => {
  const hello = await h.send({ version: 5, type: 'hello', requestId: `req_${randomUUID()}` });
  assert.equal(hello.type, 'result', JSON.stringify(hello));
  const bound = await h.send({
    version: 5, type: 'session.bind', requestId: `req_${randomUUID()}`,
    sessionId: h.correlationId, provider: 'chatgpt', origin: PAGE_ORIGIN,
  });
  assert.equal(bound.type, 'result', JSON.stringify(bound));
  return bound.result as Record<string, unknown>;
};

const stage = (h: Harness, sessionId: string, over: Record<string, unknown> = {}) => h.send({
  version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
  sessionId, delegationId: h.delegationId, tool: TOOL, workspaceId: WORKSPACE,
  origin: PAGE_ORIGIN, arguments: { workspace_id: WORKSPACE, query: 'needle' },
  ...over,
});

// -------------------------------------------------------------------------------------------
// The binding, which is where the defect lived
// -------------------------------------------------------------------------------------------

test('bind answers with the authoritative session id, which is not the correlation sent', async (t) => {
  const h = await harness(t);
  const result = await bind(h);

  assert.equal(result.bound, true);
  assert.equal(result.sessionId, h.sessionId, 'bind must answer with the durable session id');
  assert.notEqual(result.sessionId, h.correlationId, 'and it is not the value the extension sent');
  // The offered delegation is a reference the extension may name, and nothing more.
  assert.equal(result.delegationId, h.delegationId);
  assert.deepEqual(
    Object.keys(result).sort(), ['bound', 'delegationId', 'sessionId'],
    'bind discloses the reference and the id, never an expiry, a budget or a goal',
  );
});

test('a delegated Run crosses the whole transport and lands as DELEGATED_RUN', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h) as { sessionId: string };

  const staged = await stage(h, sessionId);
  assert.equal(staged.type, 'result', JSON.stringify(staged));
  const proposalId = (staged.result as { proposalId: string }).proposalId;

  const dispatched = await h.send({
    version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
    sessionId, delegationId: h.delegationId, proposalId,
  });
  assert.equal(dispatched.type, 'result', JSON.stringify(dispatched));
  const result = dispatched.result as Record<string, unknown>;
  assert.equal(result.authority, 'DELEGATED_RUN');
  assert.equal(result.goalId, 'goal_production_transport');
  assert.match(String(result.resultId), /^res_[0-9a-f]{32}$/);

  // The tool ran, with the arguments from the stored row.
  assert.deepEqual(h.executed, [{ tool: TOOL, arguments: { workspace_id: WORKSPACE, query: 'needle' } }]);

  // And the durable record says so, under the durable session id.
  const row = h.store.getStagedProposalRow(proposalId);
  assert.equal(row?.state, 'RESULTED');
  assert.equal(row?.sessionId, h.sessionId);
  const authority = h.store.getRunAuthority(proposalId);
  assert.equal(authority?.authority, 'DELEGATED_RUN');
  assert.equal(authority?.delegationId, h.delegationId);
  assert.equal(h.store.countDelegationClaims(h.delegationId), 1, 'exactly one slot spent');
});

test('an envelope naming the correlation instead of the session id is refused after bind', async (t) => {
  // The mirror of the bind exemption: `sessionId` is not compared at bind because it is the
  // correlation; it is compared everywhere else, and the correlation is exactly the wrong value.
  //
  // Refused as `SESSION_NOT_BOUND` rather than `SESSION_MISMATCH`, and by the *host* rather than
  // the router — the host recorded the authoritative id from the bind answer, so a frame naming
  // anything else never reaches the gateway at all. Two layers refuse this, and the outer one wins;
  // the router's own `SESSION_MISMATCH` is pinned in the transport suite, which drives it directly.
  const h = await harness(t);
  await bind(h);

  const staged = await stage(h, h.correlationId);
  assert.equal(staged.type, 'error');
  assert.equal((staged.error as { code: string }).code, 'SESSION_NOT_BOUND');
  assert.equal(h.store.countStagedProposals(h.delegationId), 0, 'and nothing was queued');
  assert.equal(h.executed.length, 0, 'and nothing ran');
});

test('a human Run over v5 lands as HUMAN_RUN and spends no delegation slot', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h) as { sessionId: string };

  // Staged with no delegation named: the human path.
  const staged = await stage(h, sessionId, { delegationId: undefined });
  assert.equal(staged.type, 'result', JSON.stringify(staged));
  const proposalId = (staged.result as { proposalId: string }).proposalId;

  const ran = await h.send({
    version: 5, type: 'run.human', requestId: `req_${randomUUID()}`, sessionId, proposalId,
  });
  assert.equal(ran.type, 'result', JSON.stringify(ran));
  assert.equal((ran.result as { authority: string }).authority, 'HUMAN_RUN');

  assert.equal(h.executed.length, 1, 'a human Run runs the tool too');
  const authority = h.store.getRunAuthority(proposalId);
  assert.equal(authority?.authority, 'HUMAN_RUN');
  assert.equal(authority?.delegationId, undefined);
  assert.equal(h.store.countDelegationClaims(h.delegationId), 0, 'and no budget was touched');
});

test('run.human cannot launder a proposal that was staged under a delegation', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h) as { sessionId: string };
  const staged = await stage(h, sessionId);
  const proposalId = (staged.result as { proposalId: string }).proposalId;

  const laundered = await h.send({
    version: 5, type: 'run.human', requestId: `req_${randomUUID()}`, sessionId, proposalId,
  });
  assert.equal(laundered.type, 'error');
  assert.equal((laundered.error as { code: string }).code, 'PROPOSAL_IS_DELEGATED');
  assert.equal(h.executed.length, 0, 'and nothing ran');
});

test('a second dispatch of the same proposal is refused, and runs nothing twice', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h) as { sessionId: string };
  const staged = await stage(h, sessionId);
  const proposalId = (staged.result as { proposalId: string }).proposalId;

  const first = await h.send({
    version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
    sessionId, delegationId: h.delegationId, proposalId,
  });
  assert.equal(first.type, 'result');

  const replay = await h.send({
    version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
    sessionId, delegationId: h.delegationId, proposalId,
  });
  assert.equal(replay.type, 'error', JSON.stringify(replay));
  assert.equal(h.executed.length, 1, 'the tool ran exactly once');
  assert.equal(h.store.countDelegationClaims(h.delegationId), 1, 'and one slot was spent, not two');
});

test('the host refuses frames for a session it has not bound', async (t) => {
  const h = await harness(t);
  const unbound = await h.send({
    version: 5, type: 'ping', requestId: `req_${randomUUID()}`, sessionId: h.sessionId,
  });
  assert.equal(unbound.type, 'error');
  assert.equal((unbound.error as { code: string }).code, 'SESSION_NOT_BOUND');
});

test('a malformed frame is answered and the session survives it', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h) as { sessionId: string };

  const requestId = `req_${randomUUID()}`;
  const refused = await h.send({ version: 5, type: 'run.stage', requestId, sessionId, nonsense: true });
  assert.equal(refused.type, 'error');
  assert.equal((refused.error as { code: string }).code, 'MALFORMED_REQUEST');

  // The admitted session is still usable — one bad page-derived frame must not kill a live
  // workspace, which is the lesson the v4 host learned and this one inherited.
  const staged = await stage(h, sessionId);
  assert.equal(staged.type, 'result', JSON.stringify(staged));
});

// -------------------------------------------------------------------------------------------
// The loopback route itself
// -------------------------------------------------------------------------------------------

test('a bearer the registry knows but this server never admitted is refused', async (t) => {
  // The registry and the coordinator map are two different things, and only the second records
  // that *this* server built a connection for that bearer. Checking the registry alone would let a
  // token minted anywhere else — another server sharing the registry, a direct `admit` — drive the
  // dispatch route with no coordinator behind it.
  const h = await harness(t);
  const smuggled = h.admission.admit(`session_${randomUUID()}`);

  const response = await fetch(h.dispatchUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${smuggled.mcpToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ version: 5, type: 'ping', requestId: `req_${randomUUID()}`, sessionId: h.sessionId }),
  });
  assert.equal(response.status, 401);
});

test('the dispatch route refuses anything carrying a browser Origin', async (t) => {
  // A page's `fetch` always carries one. The route is loopback-only and is meant to be reachable
  // by the native host and nothing else, so the presence of the header is disqualifying on its own.
  const h = await harness(t);
  const admitted = await fetch(h.admissionUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${'x'.repeat(48)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ correlation_id: h.correlationId }),
  });
  assert.equal(admitted.status, 200);
  const { bearer_token: bearer } = await admitted.json() as { bearer_token: string };

  for (const origin of [PAGE_ORIGIN, 'null', EXTENSION_ORIGIN]) {
    const response = await fetch(h.dispatchUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', origin },
      body: JSON.stringify({ version: 5, type: 'ping', requestId: `req_${randomUUID()}`, sessionId: h.sessionId }),
    });
    assert.equal(response.status, 403, origin);
  }
});

test('a transport failure is reported as unreachable, never as a decision', async (t) => {
  // The host must not invent a refusal. An extension told "REFUSED" would believe WAG decided
  // something, when WAG was never reached — and the honest answer changes what an operator does.
  const h = await harness(t);
  await bind(h);
  await h.closeServer();

  const answered = await h.send({
    version: 5, type: 'ping', requestId: `req_${randomUUID()}`, sessionId: h.sessionId,
  });
  assert.equal(answered.type, 'error');
  assert.equal((answered.error as { code: string }).code, 'LOCAL_WAG_UNREACHABLE');
});

// -------------------------------------------------------------------------------------------
// Connection lifecycle
//
// Keying coordinators by bearer is right — a reconnect must start unbound, and only a new bearer
// guarantees that. It also creates a lifecycle the first draft did not handle, and a review
// measured all of it: `admit()` invalidates the session's previous token as a side effect, so the
// old bearer 401s while its coordinator stays in the map forever. Every reconnect that did not
// cleanly unbind — an MV3 worker killed without warning, a browser crash, a best-effort release
// that did not land — leaked one entry, and 64 of them bricked the surface until WAG restarted.
//
// Worse, the capacity check ran *after* `admit()`, so hitting the cap took a working session's
// bearer away and gave it nothing back: a reconnect at the cap killed the session it was
// restoring.
// -------------------------------------------------------------------------------------------

test('re-admitting a session drops the coordinator its previous bearer held', async (t) => {
  const h = await harness(t);
  const admit = async () => {
    const response = await fetch(h.admissionUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${'x'.repeat(48)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ correlation_id: h.correlationId }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { bearer_token: string }).bearer_token;
  };
  const ping = (bearer: string) => fetch(h.dispatchUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 5, type: 'ping', requestId: `req_${randomUUID()}`, sessionId: h.sessionId }),
  });

  const first = await admit();
  assert.equal((await ping(first)).status, 200);

  // The reconnect. Same correlation, so the same durable session — and a fresh bearer.
  const second = await admit();
  assert.notEqual(second, first);
  assert.equal((await ping(second)).status, 200, 'the new bearer works');
  assert.equal(
    (await ping(first)).status, 401,
    'and the old one is gone from both the registry and the coordinator map',
  );

  // Sixty-four reconnects must not exhaust anything, because each drops its predecessor.
  for (let i = 0; i < 70; i += 1) {
    const bearer = await admit();
    assert.equal((await ping(bearer)).status, 200, `reconnect ${i}`);
  }
});

test('releasing a connection closes what its coordinator held', async (t) => {
  // The executor keeps a connected MCP client, server and transport pair for the life of the
  // connection. Nothing downstream notices them leaking; the machine does.
  const h = await harness(t);
  const admitted = await fetch(h.admissionUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${'x'.repeat(48)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ correlation_id: h.correlationId }),
  });
  const bearer = (await admitted.json() as { bearer_token: string }).bearer_token;
  assert.equal(h.disposed(), 0);

  const released = await fetch(new URL('/adapter/release', h.dispatchUrl), {
    method: 'POST', headers: { authorization: `Bearer ${bearer}` },
  });
  assert.equal(released.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.disposed(), 1, 'the coordinator was disposed, not merely forgotten');

  const afterRelease = await fetch(h.dispatchUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 5, type: 'ping', requestId: `req_${randomUUID()}`, sessionId: h.sessionId }),
  });
  assert.equal(afterRelease.status, 401);
});

test('closing the server disposes every live coordinator', async (t) => {
  const h = await harness(t);
  await bind(h);
  assert.equal(h.disposed(), 0);
  await h.closeServer();
  assert.equal(h.disposed(), 1);
});
