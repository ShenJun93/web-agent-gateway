/**
 * Replay protection across the loss of every piece of ephemeral extension state.
 *
 * ## Why the previous answer was not an answer
 *
 * `delegated-observation-idempotence.test.ts` proves the extension does not re-run a candidate it
 * already decided. That memory lives in `chrome.storage.session`, and the module says so plainly.
 * Which means the bound it establishes is exactly as durable as `chrome.storage.session` — and
 * that is not durable at all:
 *
 *   - an **extension reload** clears it;
 *   - it is capped at `MAX_REMEMBERED_DELEGATED` (256) and evicts in first-seen order, so a long
 *     conversation forgets its own beginning;
 *   - a failed read is treated as an empty memory, deliberately, because the alternative is
 *     suppressing work that never ran.
 *
 * Every one of those re-offers the same provider message. Before the change these tests pin, that
 * staged a **new proposal id** carrying the **same WAG-computed fingerprint**, claimed a second
 * budget slot, and executed a second effect — with `maxActions` holding arithmetically throughout,
 * which is precisely why the store's own numbers looked correct while the bound was broken.
 *
 * ## Where the bound lives now
 *
 * In `claimDelegatedDispatch`, inside the transaction that spends the slot, over a row the browser
 * cannot write. Two claims under one delegation may not share a fingerprint. The extension's memory
 * is demoted to what it always should have been: an optimisation that saves a round trip.
 *
 * So these tests are written to **destroy** the extension's memory in each of the ways production
 * can, and then assert against the store — the number of claims, the number of executions, and the
 * durable state of the row — rather than against anything the extension believes.
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
import { giveWorkspace } from './support/workspace-fixture.js';
import { startDelegationDispatchHttpServer } from '../src/delegation-dispatch-http.js';
import { HttpLocalDelegationAdapterLink } from '../src/browser-adapter/local-link-v5.js';
import { runNativeDelegationHost } from '../src/browser-adapter/native-host-v5.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';
import { NativeMessageDecoder, encodeNativeMessage } from '../src/browser-adapter/native-framing.js';
import {
  createDelegatedObservationMemory,
  createDelegatedRunAttempt,
} from '../browser/extension/delegated-observation-v5.js';
import { stageAndDispatch } from '../browser/extension/delegated-dispatch-core-v5.js';
import { proposalIdentity } from '../browser/extension/service-worker-core-v4.js';

const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;
const PAGE_ORIGIN = 'https://chatgpt.com';
const WORKSPACE = 'ws_replay_durability';
const TOOL = 'repo.search';

/** The one assistant message every test in this file re-observes. */
const MESSAGE_ID = 'msg_the_same_one';
const CALL = { tool: TOOL, arguments: { workspace_id: WORKSPACE, query: 'needle' } };

/**
 * One native-messaging connection, as Chrome gives an extension: its own host process, its own
 * stdio pair, its own router. An extension reload takes the whole thing down and builds another.
 */
interface Connection {
  send(envelope: unknown): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface Harness {
  store: SqliteDurableStore;
  correlationId: string;
  sessionId: string;
  delegationId: string;
  executed: { tool: string; arguments: unknown }[];
  /** The connection the extension held before whatever the test is about to destroy. */
  send(envelope: unknown): Promise<Record<string, unknown>>;
  /**
   * What an extension reload actually is: the old native port dies, a new host is spawned, and a
   * freshly minted correlation is sent, because `chrome.storage.session` no longer holds one.
   */
  reloadExtension(): Promise<{ connection: Connection; correlationId: string }>;
  claims(): number;
}

async function harness(
  t: test.TestContext,
  options: { maxActions?: number } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'wag-replay-durability-'));
  const store = new SqliteDurableStore(join(directory, 'state.sqlite'));
  const admission = new BrowserAdmissionRegistry(BROWSER_DELEGATION_ADAPTER_ID, store);

  const correlationId = `session_${randomUUID()}`;
  const admitted = admission.admit(correlationId).callerContext;
  const sessionId = admitted.sessionId;
  assert.notEqual(sessionId, correlationId, 'correlation and session id must be different strings');
  // The delegated workspace is a row this admitted context owns. A reloaded extension gets
  // a new session and therefore does *not* own it — which is one of the things this suite
  // already proves, by a different code, and both refusals are correct.
  giveWorkspace(store, {
    workspaceId: WORKSPACE,
    ownerId: admitted.ownerId,
    sessionId,
    adapterId: BROWSER_DELEGATION_ADAPTER_ID,
  });

  const control = new UiDelegationControlPlane({
    store, key: createControllerPlaneKey('local.operator.cli'),
  });
  const { delegationId } = control.issue({
    goalId: 'goal_replay_durability',
    ttlMs: 60 * 60_000,
    bindings: {
      goalId: 'goal_replay_durability',
      controllerId: 'local.operator.cli',
      allowedOrigins: [PAGE_ORIGIN],
      allowedTools: [TOOL],
      workspaceId: WORKSPACE,
      sessionId,
      adapterId: BROWSER_DELEGATION_ADAPTER_ID,
      maxActions: options.maxActions ?? 8,
    },
  });

  const executed: { tool: string; arguments: unknown }[] = [];
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
          executor: {
            async callTool(input) {
              executed.push(input);
              return { ok: true, structuredContent: { matches: [], tool: input.tool } };
            },
          },
        });
      },
    },
  });

  /** Spawn a host over a fresh stdio pair. Every call is a separate native port. */
  const connect = (): Connection => {
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

    return {
      send: (envelope) => new Promise((resolve, reject) => {
        const requestId = String((envelope as { requestId?: unknown }).requestId);
        const timer = setTimeout(
          () => { waiting.delete(requestId); reject(new Error(`timeout ${requestId}`)); }, 5_000,
        );
        waiting.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
        toHost.write(encodeNativeMessage(envelope));
      }),
      close: async () => { toHost.end(); await hostRun; },
    };
  };

  const connections: Connection[] = [connect()];

  // One ordered cleanup. `t.after` hooks run in registration order and Windows holds the sqlite
  // file open until its handle closes, so every host must be down before the directory goes.
  t.after(async () => {
    for (const connection of connections) await connection.close();
    await server.close();
    admission.close();
    store.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });

  return {
    store,
    correlationId,
    sessionId,
    delegationId,
    executed,
    send: (envelope) => connections[0]!.send(envelope),
    reloadExtension: async () => {
      // The old port goes away with the extension that held it.
      await connections[0]!.close();
      const connection = connect();
      connections.push(connection);
      return { connection, correlationId: `session_${randomUUID()}` };
    },
    claims: () => store.countDelegationClaims(delegationId),
  };
}

const bindOn = async (
  connection: Pick<Connection, 'send'>, correlationId: string,
): Promise<Record<string, unknown>> => {
  const hello = await connection.send({ version: 5, type: 'hello', requestId: `req_${randomUUID()}` });
  assert.equal(hello.type, 'result', JSON.stringify(hello));
  const bound = await connection.send({
    version: 5, type: 'session.bind', requestId: `req_${randomUUID()}`,
    sessionId: correlationId, provider: 'chatgpt', origin: PAGE_ORIGIN,
  });
  assert.equal(bound.type, 'result', JSON.stringify(bound));
  return bound.result as Record<string, unknown>;
};

const bind = (h: Harness, correlationId: string) => bindOn({ send: h.send }, correlationId);

const stage = (h: Harness, sessionId: string) => h.send({
  version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
  sessionId, delegationId: h.delegationId, tool: TOOL, workspaceId: WORKSPACE,
  origin: PAGE_ORIGIN, arguments: CALL.arguments,
});

const dispatch = (h: Harness, sessionId: string, proposalId: string) => h.send({
  version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
  sessionId, delegationId: h.delegationId, proposalId,
});

const errorCode = (envelope: Record<string, unknown>): string =>
  String((envelope.error as { code?: unknown } | undefined)?.code ?? '');

/**
 * Read one extension-side outcome as either the authority that ran it or the code that refused it.
 *
 * The union `stageAndDispatch` returns distinguishes the phase, and on success the authority lives
 * inside the dispatch result rather than on the outcome. Flattening it here keeps each assertion
 * about the thing being tested — whether the action ran a second time — instead of about the shape.
 */
const outcomeCode = (outcome: unknown): string => {
  if (outcome === undefined) return 'NOT_ATTEMPTED';
  const value = outcome as Record<string, unknown>;
  if (value.alreadyDecided === true) return 'ALREADY_DECIDED';
  if (value.ok === false) return String(value.code ?? 'REFUSED');
  const result = value.result as { authority?: unknown } | undefined;
  return String(result?.authority ?? 'RAN');
};

// -------------------------------------------------------------------------------------------
// The memory is gone, the session is not. This is the case the extension's memory used to own.
// -------------------------------------------------------------------------------------------

test('a re-observed candidate is refused by the store, not by the extension remembering it', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };

  const first = await stage(h, sessionId);
  assert.equal(first.type, 'result', JSON.stringify(first));
  const ran = await dispatch(h, sessionId, (first.result as { proposalId: string }).proposalId);
  assert.equal(ran.type, 'result', JSON.stringify(ran));
  assert.equal(h.executed.length, 1);
  assert.equal(h.claims(), 1);

  // The extension forgot. It re-stages the same message, with no memory involved at all.
  const second = await stage(h, sessionId);
  assert.equal(second.type, 'error', 'a re-observed action must not stage again');
  assert.equal(errorCode(second), 'PROPOSAL_REPLAY');

  assert.equal(h.executed.length, 1, 'nothing ran a second time');
  assert.equal(h.claims(), 1, 'and no second slot was spent');
});

test('the guarantee is the claim transaction, not the fail-fast at staging', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };

  // Stage *both* before dispatching either, which is what a concurrent rescan produces and what
  // the stage-time check cannot see: at this moment no claim exists, so both are admitted.
  const a = await stage(h, sessionId);
  const b = await stage(h, sessionId);
  assert.equal(a.type, 'result', JSON.stringify(a));
  assert.equal(b.type, 'result', JSON.stringify(b));
  const first = (a.result as { proposalId: string }).proposalId;
  const second = (b.result as { proposalId: string }).proposalId;
  assert.notEqual(first, second, 'two stagings really are two distinct rows');
  assert.equal(
    (a.result as { fingerprint: string }).fingerprint,
    (b.result as { fingerprint: string }).fingerprint,
    'and they carry the same WAG-computed identity, which is the whole point',
  );

  const ranFirst = await dispatch(h, sessionId, first);
  assert.equal(ranFirst.type, 'result', JSON.stringify(ranFirst));
  const ranSecond = await dispatch(h, sessionId, second);
  assert.equal(ranSecond.type, 'error', 'the second dispatch of the same action is refused');
  assert.equal(errorCode(ranSecond), 'PROPOSAL_REPLAY');

  assert.equal(h.executed.length, 1);
  assert.equal(h.claims(), 1);
  assert.equal(
    h.store.getStagedProposalRow(second)?.state, 'STAGED',
    'a refusal before the claim leaves the row untouched and spends nothing',
  );
});

test('two dispatches racing on identical actions produce exactly one claim and one effect', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };

  const a = await stage(h, sessionId);
  const b = await stage(h, sessionId);
  const first = (a.result as { proposalId: string }).proposalId;
  const second = (b.result as { proposalId: string }).proposalId;

  const [one, two] = await Promise.all([
    dispatch(h, sessionId, first),
    dispatch(h, sessionId, second),
  ]);

  const outcomes = [one, two].map((r) => (r.type === 'result' ? 'ok' : errorCode(r))).sort();
  assert.deepEqual(outcomes, ['PROPOSAL_REPLAY', 'ok'], JSON.stringify([one, two]));
  assert.equal(h.executed.length, 1, 'exactly one effect');
  assert.equal(h.claims(), 1, 'exactly one slot');
});

// -------------------------------------------------------------------------------------------
// The session is gone too. An extension reload re-mints the correlation.
// -------------------------------------------------------------------------------------------

test('after an extension reload the same message cannot run at all, and spends nothing', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };

  const first = await stage(h, sessionId);
  await dispatch(h, sessionId, (first.result as { proposalId: string }).proposalId);
  assert.equal(h.executed.length, 1);

  // The reload: the native port dies with the extension, and `chrome.storage.session` is cleared,
  // so the correlation is minted afresh and WAG resolves a *different* durable session. The
  // delegation binds the old one.
  const { connection, correlationId } = await h.reloadExtension();
  assert.notEqual(correlationId, h.correlationId);
  const rebound = await bindOn(connection, correlationId) as
    { sessionId: string; delegationId?: string };
  assert.notEqual(
    rebound.sessionId, sessionId,
    'a reload must land on a different durable session, or this test proves nothing',
  );
  assert.equal(
    rebound.delegationId, h.delegationId,
    'the reference is still offered; it is the binding that refuses, not a withheld id',
  );

  const again = await connection.send({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId: rebound.sessionId, delegationId: h.delegationId, tool: TOOL, workspaceId: WORKSPACE,
    origin: PAGE_ORIGIN, arguments: CALL.arguments,
  });
  assert.equal(again.type, 'error');
  assert.equal(
    errorCode(again), 'SESSION_MISMATCH',
    'the delegation binds a session, and the reloaded extension is not it',
  );

  assert.equal(h.executed.length, 1, 'no second effect');
  assert.equal(h.claims(), 1, 'no second slot');
});

test('a reloaded extension cannot dispatch a proposal the previous session staged', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };

  const staged = await stage(h, sessionId);
  const proposalId = (staged.result as { proposalId: string }).proposalId;

  const { connection, correlationId } = await h.reloadExtension();
  const rebound = await bindOn(connection, correlationId) as { sessionId: string };

  const stolen = await connection.send({
    version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
    sessionId: rebound.sessionId, delegationId: h.delegationId, proposalId,
  });
  assert.equal(stolen.type, 'error', JSON.stringify(stolen));
  assert.equal(errorCode(stolen), 'SESSION_MISMATCH');
  assert.equal(h.executed.length, 0, 'nothing ran');
  assert.equal(h.claims(), 0, 'and nothing was spent');
  assert.equal(
    h.store.getStagedProposalRow(proposalId)?.state, 'STAGED',
    'the orphaned row stays inert rather than becoming runnable by the new session',
  );
});

// -------------------------------------------------------------------------------------------
// The whole extension core, recreated. This drives the shipped modules, not a stand-in.
// -------------------------------------------------------------------------------------------

/**
 * One extension core: a fresh observation memory and a fresh attempt function over the same
 * transport. Recreating it is what an extension reload or a discarded MV3 worker produces.
 *
 * `storageSession` is supplied by the caller so a test can hand over an empty store, a store that
 * throws, or a store that survived — which are the three states production actually reaches.
 */
function extensionCore(h: Harness, boundSessionId: string, storageSession?: {
  get(key: string): Promise<Record<string, unknown>>;
  set(entries: Record<string, unknown>): Promise<void>;
}) {
  const memory = createDelegatedObservationMemory(storageSession);
  const attempt = createDelegatedRunAttempt({
    delegation: {
      ensureReady: async () => undefined,
      send: h.send,
      delegationId: () => h.delegationId,
      boundSessionId: () => boundSessionId,
    },
    memory,
    stageAndDispatch,
    randomUUID,
  });
  return { memory, attempt };
}

test('a recreated extension core with an empty memory re-offers, and WAG refuses it', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };
  const identity = proposalIdentity(h.correlationId, 7, MESSAGE_ID, CALL.tool, CALL.arguments);

  const before = extensionCore(h, sessionId);
  await before.memory.ready();
  const ran = await before.attempt({
    identity, correlationId: h.correlationId, call: CALL, origin: PAGE_ORIGIN,
  });
  assert.equal(outcomeCode(ran), 'DELEGATED_RUN', JSON.stringify(ran));
  assert.equal(h.executed.length, 1);

  // Everything the extension knew is gone. Same session, same message, brand-new core.
  const after = extensionCore(h, sessionId);
  await after.memory.ready();
  assert.equal(after.memory.has(identity), false, 'the recreated core remembers nothing');

  const replayed = await after.attempt({
    identity, correlationId: h.correlationId, call: CALL, origin: PAGE_ORIGIN,
  });
  assert.equal(
    outcomeCode(replayed), 'PROPOSAL_REPLAY',
    `the recreated core did ask, and WAG answered: ${JSON.stringify(replayed)}`,
  );
  assert.equal(h.executed.length, 1, 'one message, one effect, across a core recreation');
  assert.equal(h.claims(), 1);
});

test('a storage that throws on every read cannot buy a second effect', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };
  const identity = proposalIdentity(h.correlationId, 7, MESSAGE_ID, CALL.tool, CALL.arguments);

  // The module documents this exact behaviour: "A memory that cannot be read is an empty memory,
  // which re-offers rather than suppresses." That is the right call for the extension to make —
  // and it is only safe because the refusal below does not depend on it.
  const hostile = {
    get: async () => { throw new Error('storage unavailable'); },
    set: async () => { throw new Error('storage unavailable'); },
  };

  const first = extensionCore(h, sessionId, hostile);
  await first.memory.ready();
  const ran = await first.attempt({
    identity, correlationId: h.correlationId, call: CALL, origin: PAGE_ORIGIN,
  });
  assert.equal(outcomeCode(ran), 'DELEGATED_RUN', JSON.stringify(ran));

  const second = extensionCore(h, sessionId, hostile);
  await second.memory.ready();
  const replayed = await second.attempt({
    identity, correlationId: h.correlationId, call: CALL, origin: PAGE_ORIGIN,
  });
  assert.equal(outcomeCode(replayed), 'PROPOSAL_REPLAY', JSON.stringify(replayed));
  assert.equal(h.executed.length, 1);
  assert.equal(h.claims(), 1);
});

test('an intact memory still short-circuits, so the durable check is a backstop and not the path', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };
  const identity = proposalIdentity(h.correlationId, 7, MESSAGE_ID, CALL.tool, CALL.arguments);

  const core = extensionCore(h, sessionId);
  await core.memory.ready();
  await core.attempt({ identity, correlationId: h.correlationId, call: CALL, origin: PAGE_ORIGIN });

  const again = await core.attempt({
    identity, correlationId: h.correlationId, call: CALL, origin: PAGE_ORIGIN,
  });
  assert.deepEqual(again, { alreadyDecided: true }, 'the memory answers without a round trip');
  assert.equal(h.executed.length, 1);
});

// -------------------------------------------------------------------------------------------
// Abandonment, which is where a refund would have re-opened the hole
// -------------------------------------------------------------------------------------------

test('an abandoned claim does not release the action for a re-observation to take', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };

  const staged = await stage(h, sessionId);
  const proposalId = (staged.result as { proposalId: string }).proposalId;
  const fingerprint = (staged.result as { fingerprint: string }).fingerprint;

  // Claim without dispatching — a crash between the two — then let the sweeper retire it.
  const claimed = h.store.claimDelegatedDispatch({
    delegationId: h.delegationId,
    proposalId,
    now: Date.now(),
    expectedFingerprint: fingerprint,
    maxWindowMs: 4 * 60 * 60_000,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  h.store.abandonExpiredClaims(Date.now() + 10 * 60_000, 60_000);
  assert.equal(h.store.getStagedProposalRow(proposalId)?.state, 'ABANDONED');

  const reoffered = await stage(h, sessionId);
  assert.equal(reoffered.type, 'error', 'an abandoned action is not re-runnable');
  assert.equal(errorCode(reoffered), 'PROPOSAL_REPLAY');
  assert.equal(h.claims(), 1, 'abandonment never refunds the slot it spent');
  assert.equal(h.executed.length, 0);
});

// -------------------------------------------------------------------------------------------
// The invariant underneath the refusal
// -------------------------------------------------------------------------------------------

test('the database refuses a duplicate claim even with the application check bypassed', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };

  const staged = await stage(h, sessionId);
  const proposalId = (staged.result as { proposalId: string }).proposalId;
  const fingerprint = (staged.result as { fingerprint: string }).fingerprint;
  assert.equal(
    h.store.claimDelegatedDispatch({
      delegationId: h.delegationId, proposalId, now: Date.now(),
      expectedFingerprint: fingerprint, maxWindowMs: 4 * 60 * 60_000,
    }).ok,
    true,
  );

  // A second real staged row, so the foreign key is satisfied and the only thing that can refuse
  // the insert below is the uniqueness of (delegation, fingerprint).
  //
  // The first version of this test inserted a proposal id that did not exist, and passed — on a
  // FOREIGN KEY error, matched by a regex loose enough to accept the word "constraint". It proved
  // the table had a foreign key. Exactly the defect this suite exists to catch, found by mutating
  // UNIQUE away and watching the test still pass.
  const other = await h.send({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId, delegationId: h.delegationId, tool: TOOL, workspaceId: WORKSPACE,
    origin: PAGE_ORIGIN, arguments: { workspace_id: WORKSPACE, query: 'a genuinely other action' },
  });
  assert.equal(other.type, 'result', JSON.stringify(other));
  const otherId = (other.result as { proposalId: string }).proposalId;
  const otherFingerprint = (other.result as { fingerprint: string }).fingerprint;
  assert.notEqual(otherFingerprint, fingerprint, 'the control: these are two different actions');

  const raw = (h.store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
  const insert = (proposal: string, print: string) => raw.prepare(
    'INSERT INTO delegation_claims (delegation_id, proposal_id, claimed_at, fingerprint) '
    + 'VALUES (?, ?, ?, ?)',
  ).run(h.delegationId, proposal, Date.now(), print);

  // Reach past `claimDelegatedDispatch` entirely, which is what a second insert path added later
  // would look like. The difference between an invariant and a check: the check produces
  // PROPOSAL_REPLAY for an operator to read, the index holds whatever code does the write.
  assert.throws(
    () => insert(otherId, fingerprint),
    /UNIQUE/i,
    'the database must refuse a second claim for the same (delegation, action)',
  );
  assert.equal(h.claims(), 1, 'and the ledger still holds exactly one slot');

  // The control: the same insert with that row's own fingerprint is a different action and is
  // accepted, so what refused above was the uniqueness and not the insert itself.
  insert(otherId, otherFingerprint);
  assert.equal(h.claims(), 2);
});

// -------------------------------------------------------------------------------------------
// What this does *not* claim
// -------------------------------------------------------------------------------------------

test('a genuinely different action from the same session is unaffected', async (t) => {
  const h = await harness(t);
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };

  const first = await stage(h, sessionId);
  await dispatch(h, sessionId, (first.result as { proposalId: string }).proposalId);

  const other = await h.send({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId, delegationId: h.delegationId, tool: TOOL, workspaceId: WORKSPACE,
    origin: PAGE_ORIGIN, arguments: { workspace_id: WORKSPACE, query: 'a different needle' },
  });
  assert.equal(other.type, 'result', 'different arguments are a different action');
  const ran = await dispatch(h, sessionId, (other.result as { proposalId: string }).proposalId);
  assert.equal(ran.type, 'result', JSON.stringify(ran));
  assert.equal(h.executed.length, 2);
  assert.equal(h.claims(), 2);
});

test('a hostile extension is bounded by maxActions, which is the honest claim and not replay', async (t) => {
  const h = await harness(t, { maxActions: 3 });
  const { sessionId } = await bind(h, h.correlationId) as { sessionId: string };

  // Replay protection keys on the action's identity, so an extension that varies the arguments
  // produces genuinely distinct actions and is not replaying anything. Nothing here pretends
  // otherwise: what bounds this case is the budget, and it does.
  const codes: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const staged = await h.send({
      version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
      sessionId, delegationId: h.delegationId, tool: TOOL, workspaceId: WORKSPACE,
      origin: PAGE_ORIGIN, arguments: { workspace_id: WORKSPACE, query: `needle ${i}` },
    });
    if (staged.type !== 'result') { codes.push(errorCode(staged)); continue; }
    const ran = await dispatch(h, sessionId, (staged.result as { proposalId: string }).proposalId);
    codes.push(ran.type === 'result' ? 'ok' : errorCode(ran));
  }

  assert.deepEqual(codes.slice(0, 3), ['ok', 'ok', 'ok']);
  assert.equal(h.executed.length, 3, 'the budget is the bound, and it held');
  assert.equal(h.claims(), 3);
  for (const code of codes.slice(3)) {
    assert.ok(
      code === 'ACTION_LIMIT_REACHED' || code === 'STAGING_LIMIT_REACHED',
      `expected a budget refusal, got ${code}`,
    );
  }
});
