import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BROWSER_DELEGATION_ADAPTER_ID,
  BROWSER_OPERATOR_ADAPTER_ID,
} from '../src/adapter-admission.js';
import {
  DELEGATED_DISPATCH_MAX_BYTES,
  DELEGATED_DISPATCH_PROTOCOL_VERSION as V,
  DELEGATED_DISPATCH_VERBS,
  parseDelegatedDispatchRequest,
  parseDelegatedDispatchResponse,
} from '../src/browser-adapter/protocol-v5.js';
import { DelegatedDispatchRouter } from '../src/delegated-dispatch-router.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  createControllerPlaneKey, UiDelegationControlPlane,
} from '../src/goal-ui-delegation-control.js';
import {
  createDelegationDispatchPort, UiDelegationDispatchPlane,
} from '../src/goal-ui-delegation-dispatch.js';
import {
  buildDispatchEnvelope, buildStageEnvelope, readResponse, stageAndDispatch,
} from '../browser/extension/delegated-dispatch-core-v5.js';
import type { ConnectionIdentity, UiDelegationBindings } from '../src/goal-ui-delegation.js';

/**
 * The transport seam, on its own: schema in, envelope out.
 *
 * The E2E suite proves the whole path works. This proves the two things the seam is responsible
 * for and nothing else is: that the schema refuses an envelope rather than ignoring part of it,
 * and that the identity handed to the plane comes from the admitted connection rather than from
 * the message that arrived.
 */
const CONTROLLER = 'transport.test.controller';
const SESSION = 'session_transport_1';
const CONNECTION: ConnectionIdentity = {
  ownerId: 'owner_transport', sessionId: SESSION, adapterId: BROWSER_DELEGATION_ADAPTER_ID,
};

const BINDINGS: UiDelegationBindings = {
  goalId: 'goal_transport',
  controllerId: CONTROLLER,
  allowedOrigins: ['https://chatgpt.com'],
  allowedTools: ['repo.search'],
  workspaceId: 'ws_1',
  sessionId: SESSION,
  adapterId: BROWSER_DELEGATION_ADAPTER_ID,
  maxActions: 4,
};

let seq = 0;
const rid = () => `req_${(seq += 1).toString().padStart(8, '0')}`;

async function harness(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-transport-'));
  const store = new SqliteDurableStore(join(dir, 'store.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const control = new UiDelegationControlPlane({
    store, key: createControllerPlaneKey(CONTROLLER), now: () => 1_000_000,
  });
  const delegationId = control.issue({
    goalId: 'goal_transport', bindings: BINDINGS, ttlMs: 60_000,
  }).delegationId;

  const router = (configured: string | undefined = delegationId) => new DelegatedDispatchRouter({
    plane: new UiDelegationDispatchPlane({
      port: createDelegationDispatchPort(store),
      killSwitch: () => false,
      now: () => 1_000_000,
      ...(configured === undefined ? {} : { configuredDelegationId: configured }),
    }),
    connection: CONNECTION,
  });
  return { store, delegationId, router };
}

const bound = (r: DelegatedDispatchRouter) => {
  r.handle({
    version: V, type: 'session.bind', requestId: rid(), sessionId: SESSION,
    provider: 'chatgpt', origin: 'https://chatgpt.com',
  });
  return r;
};

const codeOf = (envelope: unknown): string => {
  const e = envelope as { type: string; error?: { code: string } };
  assert.equal(e.type, 'error', `expected an error envelope: ${JSON.stringify(envelope)}`);
  return e.error?.code ?? '';
};

// ---------------------------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------------------------

test('the v5 surface is exactly the declared verbs, and has no tool.call', () => {
  assert.deepEqual([...DELEGATED_DISPATCH_VERBS], [
    'hello', 'session.bind', 'session.unbind', 'ping', 'verbs.list',
    'run.stage', 'run.dispatch', 'run.human', 'run.result',
  ]);
  // v4's shape is the thing this revision deliberately does *not* have: on v4 the browser names
  // a tool and its arguments and the gateway runs it. Here the tool that runs is the stored one.
  assert.equal(DELEGATED_DISPATCH_VERBS.includes('tool.call' as never), false);
  assert.notEqual(BROWSER_DELEGATION_ADAPTER_ID, BROWSER_OPERATOR_ADAPTER_ID);
});

test('a dispatch envelope carries two references, and any extra field is refused', () => {
  const valid = {
    version: V, type: 'run.dispatch', requestId: 'req_00000001', sessionId: SESSION,
    delegationId: 'uidel_0123456789abcdef', proposalId: 'prop_0123456789abcdef',
  };
  assert.doesNotThrow(() => parseDelegatedDispatchRequest(valid));
  for (const extra of [
    { goalId: 'goal_x' }, { controllerId: 'c' }, { expiresAt: 1 }, { maxActions: 9 },
    { authority: 'DELEGATED_RUN' }, { proposalFingerprint: 'fp_x' }, { slotClaimed: false },
    { tool: 'repo.search' }, { arguments: {} }, { state: 'STAGED' }, { killSwitch: false },
  ]) {
    assert.throws(() => parseDelegatedDispatchRequest({ ...valid, ...extra }),
      `${Object.keys(extra)[0]} must be refused, not ignored`);
  }
});

test('a stage envelope is bounded, and its arguments must be finite JSON', () => {
  const base = {
    version: V, type: 'run.stage', requestId: 'req_00000001', sessionId: SESSION,
    tool: 'repo.search', workspaceId: 'ws_1', origin: 'https://chatgpt.com',
    arguments: { query: 'needle' },
  };
  assert.doesNotThrow(() => parseDelegatedDispatchRequest(base));
  assert.doesNotThrow(() => parseDelegatedDispatchRequest({ ...base, delegationId: 'uidel_0123456789abcdef' }));
  for (const bad of [
    { tool: 'Repo.Search' }, { tool: '' }, { tool: 'x'.repeat(129) },
    { workspaceId: '' }, { origin: '' }, { version: 4 }, { requestId: 'short' },
    { arguments: { n: Number.POSITIVE_INFINITY } },
    { delegationId: 'short' }, { delegationId: 'has spaces in it' },
  ]) {
    assert.throws(() => parseDelegatedDispatchRequest({ ...base, ...bad }), JSON.stringify(bad));
  }
  // And the envelope has a size ceiling, checked before the schema walks it.
  assert.throws(
    () => parseDelegatedDispatchRequest({ ...base, arguments: { q: 'x'.repeat(DELEGATED_DISPATCH_MAX_BYTES) } }),
    /exceeds size limit/,
  );
});

test('a response envelope is validated as strictly as a request', () => {
  const ok = { version: V, type: 'result', requestId: 'req_00000001', result: { a: 1 } };
  assert.doesNotThrow(() => parseDelegatedDispatchResponse(ok));
  assert.throws(() => parseDelegatedDispatchResponse({ ...ok, extra: 1 }));
  assert.throws(() => parseDelegatedDispatchResponse({
    version: V, type: 'error', requestId: 'req_00000001',
    error: { code: 'lower_case', message: 'no' },
  }), 'error codes are upper snake case');
});

// ---------------------------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------------------------

test('the session in the envelope is compared against the admitted one, never believed', async (t) => {
  const h = await harness(t);
  const r = bound(h.router());
  // A routable, plausible, attacker-chosen field. Without the comparison it would be worse than
  // useless; with it, it is a routing hint that has to agree with a fact.
  for (const type of ['ping', 'run.dispatch', 'run.result'] as const) {
    const envelope: Record<string, unknown> = {
      version: V, type, requestId: rid(), sessionId: 'session_somebody_else',
    };
    if (type === 'run.dispatch') {
      envelope.delegationId = h.delegationId;
      envelope.proposalId = 'prop_0123456789abcdef';
    }
    if (type === 'run.result') {
      envelope.proposalId = 'prop_0123456789abcdef';
      envelope.resultId = 'res_0123456789abcdef';
    }
    assert.equal(codeOf(r.handle(envelope)), 'SESSION_MISMATCH', type);
  }
});

test('an unbound port can bind and unbind, and does nothing else', async (t) => {
  const h = await harness(t);
  const r = h.router();
  assert.equal(r.isBound, false);
  assert.equal(codeOf(r.handle({ version: V, type: 'ping', requestId: rid(), sessionId: SESSION })), 'NOT_BOUND');
  // `hello` answers before the session is known, as a handshake must.
  const hello = r.handle({ version: V, type: 'hello', requestId: rid() }) as
    { type: string; result?: { adapterId: string } };
  assert.equal(hello.type, 'result');
  assert.equal(hello.result?.adapterId, BROWSER_DELEGATION_ADAPTER_ID);

  bound(r);
  assert.equal(r.isBound, true);
  r.handle({ version: V, type: 'session.unbind', requestId: rid(), sessionId: SESSION });
  assert.equal(r.isBound, false);
  assert.equal(codeOf(r.handle({ version: V, type: 'ping', requestId: rid(), sessionId: SESSION })), 'NOT_BOUND');
});

test('a malformed envelope is answered without crashing, and keeps its request id when it has one', async (t) => {
  const h = await harness(t);
  const r = bound(h.router());
  const answered = r.handle({ version: V, type: 'run.dispatch', requestId: 'req_00000042', sessionId: SESSION });
  assert.equal(codeOf(answered), 'ENVELOPE_MALFORMED');
  assert.equal((answered as { requestId: string }).requestId, 'req_00000042');
  // And a frame too broken to have one still gets an answer rather than an exception.
  for (const junk of [null, undefined, 'a string', 42, [], {}, { requestId: 'short' }]) {
    const out = r.handle(junk) as { type: string; requestId: string };
    assert.equal(out.type, 'error', JSON.stringify(junk));
    assert.equal(typeof out.requestId, 'string');
  }
});

test('the router adds no policy: what the plane refused, it refuses', async (t) => {
  const h = await harness(t);
  const r = bound(h.router());
  const staged = r.handle({
    version: V, type: 'run.stage', requestId: rid(), sessionId: SESSION,
    delegationId: h.delegationId, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com', arguments: { workspace_id: 'ws_1', query: 'needle' },
  }) as { type: string; result?: { proposalId: string } };
  assert.equal(staged.type, 'result');
  const proposalId = staged.result!.proposalId;

  // With a different delegation configured, the same envelope is refused — and the refusal is the
  // plane's code, verbatim, not something the router invented.
  const unconfigured = bound(h.router('uidel_something_else_entirely'));
  assert.equal(
    codeOf(unconfigured.handle({
      version: V, type: 'run.dispatch', requestId: rid(), sessionId: SESSION,
      delegationId: h.delegationId, proposalId,
    })),
    'DELEGATION_NOT_CONFIGURED',
  );
  assert.equal(h.store.countDelegationClaims(h.delegationId), 0);
});

// ---------------------------------------------------------------------------------------------
// The extension core
// ---------------------------------------------------------------------------------------------

test('the extension builds envelopes that carry no authority', () => {
  const dispatch = buildDispatchEnvelope({
    requestId: 'req_00000001', sessionId: SESSION,
    delegationId: 'uidel_0123456789abcdef', proposalId: 'prop_0123456789abcdef',
  });
  assert.deepEqual(Object.keys(dispatch).sort(),
    ['delegationId', 'proposalId', 'requestId', 'sessionId', 'type', 'version']);
  assert.doesNotThrow(() => parseDelegatedDispatchRequest(dispatch));

  // An absent delegation is absent, not `undefined`: the schema is strict about the key set, so
  // spelling it out would turn the human path into a malformed envelope.
  const human = buildStageEnvelope({
    requestId: 'req_00000002', dispatchRequestId: 'req_00000003', sessionId: SESSION,
    tool: 'repo.search', workspaceId: 'ws_1', origin: 'https://chatgpt.com',
    arguments: { query: 'needle' },
  });
  assert.equal('delegationId' in human, false);
  assert.doesNotThrow(() => parseDelegatedDispatchRequest(human));
});

test('the extension refuses a response that answers a different request', () => {
  assert.deepEqual(
    readResponse('req_00000001', { version: V, type: 'result', requestId: 'req_00000002', result: 1 }),
    { ok: false, code: 'REQUEST_ID_MISMATCH', message: 'response answers another request' },
  );
  assert.equal(readResponse('req_00000001', { version: 4, type: 'result', requestId: 'req_00000001' }).ok, false);
  assert.equal(readResponse('req_00000001', undefined).ok, false);
  assert.deepEqual(
    readResponse('req_00000001', {
      version: V, type: 'error', requestId: 'req_00000001',
      error: { code: 'TOOL_NOT_DELEGATED', message: 'no' },
    }),
    { ok: false, code: 'TOOL_NOT_DELEGATED', message: 'no' },
  );
});

test('the extension does not dispatch what it staged on the human path', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const send = async (envelope: Record<string, unknown>) => {
    sent.push(envelope);
    return {
      version: V, type: 'result', requestId: envelope.requestId,
      result: { proposalId: 'prop_0123456789abcdef' },
    };
  };
  const outcome = await stageAndDispatch(send as never, {
    requestId: 'req_00000001', dispatchRequestId: 'req_00000002', sessionId: SESSION,
    tool: 'repo.search', workspaceId: 'ws_1', origin: 'https://chatgpt.com',
    arguments: { query: 'needle' },
  });
  assert.deepEqual(sent.map((e) => e.type), ['run.stage'], 'no dispatch was attempted');
  assert.equal(outcome.phase, 'stage');
  assert.equal((outcome as { dispatched: boolean }).dispatched, false);
});

test('the extension does not retry a refused dispatch', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const send = async (envelope: Record<string, unknown>) => {
    sent.push(envelope);
    if (envelope.type === 'run.stage') {
      return {
        version: V, type: 'result', requestId: envelope.requestId,
        result: { proposalId: 'prop_0123456789abcdef' },
      };
    }
    return {
      version: V, type: 'error', requestId: envelope.requestId,
      error: { code: 'ACTION_LIMIT_REACHED', message: 'budget spent' },
    };
  };
  const outcome = await stageAndDispatch(send as never, {
    requestId: 'req_00000001', dispatchRequestId: 'req_00000002', sessionId: SESSION,
    delegationId: 'uidel_0123456789abcdef',
    tool: 'repo.search', workspaceId: 'ws_1', origin: 'https://chatgpt.com',
    arguments: { query: 'needle' },
  });
  // Exactly two calls: asking again is how a budget gets drained by a loop that thinks it knows
  // better than the refusal it just received.
  assert.deepEqual(sent.map((e) => e.type), ['run.stage', 'run.dispatch']);
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { code: string }).code, 'ACTION_LIMIT_REACHED');
});

test('a refused stage comes back as an error, never as a result with no proposal', async (t) => {
  // The gap a mutation found: nothing in this suite refused a *stage* through the router, so
  // dropping the refusal branch fell through to a success envelope carrying undefined ids.
  const h = await harness(t);
  const r = bound(h.router());
  const stage = (over: Record<string, unknown>) => r.handle({
    version: V, type: 'run.stage', requestId: rid(), sessionId: SESSION,
    delegationId: h.delegationId, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com', arguments: { workspace_id: 'ws_1', query: 'needle' }, ...over,
  }) as { type: string; result?: { proposalId?: string }; error?: { code: string } };

  for (const [code, over] of [
    ['TOOL_NOT_DELEGATED', { tool: 'file.read', arguments: { workspace_id: 'ws_1', path: 'a.txt' } }],
    ['WORKSPACE_MISMATCH', { workspaceId: 'ws_elsewhere', arguments: { workspace_id: 'ws_elsewhere', query: 'needle' } }],
    ['ORIGIN_NOT_ALLOWED', { origin: 'https://evil.example' }],
    ['DELEGATION_NOT_CONFIGURED', { delegationId: 'uidel_0123456789abcdef' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const refused = stage(over);
    assert.equal(codeOf(refused), code, JSON.stringify(over));
    assert.equal(refused.result, undefined, 'a refusal carries no result to act on');
  }
  assert.equal(h.store.countStagedProposals(h.delegationId), 0, 'and nothing was queued');

  // The success path still returns both ids, so the assertions above are about the refusal and
  // not about the envelope shape being empty in general.
  const ok = stage({});
  assert.equal(ok.type, 'result');
  assert.match(ok.result?.proposalId ?? '', /^prop_[a-f0-9]{24}$/);
});

// ---------------------------------------------------------------------------------------------
// Findings from the transport review
// ---------------------------------------------------------------------------------------------

test('a staged candidate is bounded exactly as v4 bounds it', async (t) => {
  // Measured before the fix: v5 accepted "any finite JSON", so a 5 KB query and a max_results of
  // 99999 sailed through a surface where v4 caps them at 256 bytes and 50. v5 was narrower than v4
  // in verbs and *wider* in arguments, and the ADR reasoned from the favourable half.
  const h = await harness(t);
  const r = bound(h.router());
  const stage = (over: Record<string, unknown>) => r.handle({
    version: V, type: 'run.stage', requestId: rid(), sessionId: SESSION,
    delegationId: h.delegationId, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com', arguments: { workspace_id: 'ws_1', query: 'needle' }, ...over,
  }) as { type: string; error?: { code: string } };

  for (const args of [
    { workspace_id: 'ws_1', query: 'x'.repeat(5000) },
    { workspace_id: 'ws_1', query: 'needle', max_results: 99999 },
    { workspace_id: 'ws_1', query: 'needle', max_results: 0 },
    { workspace_id: 'ws_1', query: 'needle', context_lines: 99 },
    { workspace_id: 'ws_1', query: 'needle', unexpected_key: true },
    { workspace_id: 'ws_1', query: 'has a null' },
    { workspace_id: 'ws_1' },
    { query: 'needle' },
    'not an object',
  ]) {
    assert.equal(codeOf(stage({ arguments: args })), 'STAGING_INPUT_INVALID', JSON.stringify(args));
  }
  // A tool the frozen surface does not define cannot be staged at all.
  assert.equal(codeOf(stage({ tool: 'not.a.real.tool', arguments: { workspace_id: 'ws_1' } })),
    'STAGING_INPUT_INVALID');
  // And what v4 accepts, v5 accepts.
  assert.equal((stage({ arguments: { workspace_id: 'ws_1', query: 'needle', max_results: 50 } }) as
    { type: string }).type, 'result');
  assert.equal(h.store.countStagedProposals(h.delegationId), 1, 'only the valid one was queued');
});

test('staged arguments must name the workspace the proposal is staged for', async (t) => {
  // The field-name trap: every tool resolves its workspace from `arguments.workspace_id`, and the
  // delegation binds the staged `workspaceId`. A review staged a proposal bound to one workspace
  // carrying arguments naming another, dispatched it, and watched the foreign id land verbatim in
  // the audit row.
  const h = await harness(t);
  const r = bound(h.router());
  const refused = r.handle({
    version: V, type: 'run.stage', requestId: rid(), sessionId: SESSION,
    delegationId: h.delegationId, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com',
    arguments: { workspace_id: 'WS_SOMEWHERE_ELSE', query: 'needle' },
  }) as { type: string; error?: { code: string; message: string } };
  assert.equal(codeOf(refused), 'STAGING_INPUT_INVALID');
  assert.match(refused.error?.message ?? '', /workspace_id must be the workspace/);
  assert.equal(h.store.countStagedProposals(h.delegationId), 0);
});

test('only a v5 connection may drive this router', async (t) => {
  // The ADR called this isolation "structural". It was not: nothing compared the connection's
  // adapter to v5's, and a review drove a full DELEGATED_RUN through a router built over a
  // v4-identity connection, with `browser.chatgpt.native.operator.v4` written into the audit row.
  const h = await harness(t);
  for (const adapterId of [
    BROWSER_OPERATOR_ADAPTER_ID,
    'browser.chatgpt.native.verify.v3',
    'harness.lane.test-only',
    '',
  ]) {
    assert.throws(
      () => new DelegatedDispatchRouter({
        plane: new UiDelegationDispatchPlane({
          port: createDelegationDispatchPort(h.store), killSwitch: () => false,
        }),
        connection: { ...CONNECTION, adapterId },
      }),
      /only browser\.chatgpt\.native\.delegation\.v5 may speak v5/,
      adapterId || '(empty)',
    );
  }
  // And the right one is accepted.
  assert.doesNotThrow(() => h.router());
});

test('the router answers with the one verb list, not a copy of it', async (t) => {
  // Two lists is one list and a future divergence. The only assertion comparing them used to live
  // in an `.acceptance.ts` file, which `npm test` does not glob.
  const h = await harness(t);
  const r = bound(h.router());
  const listed = r.handle({
    version: V, type: 'verbs.list', requestId: rid(), sessionId: SESSION,
  }) as { type: string; result?: { verbs: string[] } };
  assert.deepEqual(listed.result?.verbs, [...DELEGATED_DISPATCH_VERBS]);
});

test('attaching a result to a proposal that never ran says so', async (t) => {
  // It used to report RESULT_ALREADY_ATTACHED, because the store's single-use update also returns
  // false when there is no audit row at all. Nothing was attached and no Run ever happened; an
  // operator reading that would conclude the opposite of the truth.
  const h = await harness(t);
  const r = bound(h.router());
  const staged = r.handle({
    version: V, type: 'run.stage', requestId: rid(), sessionId: SESSION,
    delegationId: h.delegationId, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com', arguments: { workspace_id: 'ws_1', query: 'needle' },
  }) as { type: string; result?: { proposalId: string } };
  const proposalId = staged.result!.proposalId;

  const attached = r.handle({
    version: V, type: 'run.result', requestId: rid(), sessionId: SESSION,
    proposalId, resultId: 'res_0123456789abcdef',
  }) as { type: string; error?: { code: string } };
  assert.equal(codeOf(attached), 'PROPOSAL_NOT_DISPATCHED');
});

test('the extension refuses to reuse one request id for both calls', async () => {
  // The correlation guard is defeated by the one input it did not validate: with both ids equal,
  // the stage response was accepted as the dispatch response and the core reported a dispatch that
  // never happened. A state lie rather than an authority grant — and exactly what its own header
  // says cannot happen.
  const sent: Array<Record<string, unknown>> = [];
  const send = async (envelope: Record<string, unknown>) => {
    sent.push(envelope);
    return {
      version: V, type: 'result', requestId: envelope.requestId,
      result: { proposalId: 'prop_0123456789abcdef' },
    };
  };
  const outcome = await stageAndDispatch(send as never, {
    requestId: 'req_00000001', dispatchRequestId: 'req_00000001', sessionId: SESSION,
    delegationId: 'uidel_0123456789abcdef',
    tool: 'repo.search', workspaceId: 'ws_1', origin: 'https://chatgpt.com',
    arguments: { workspace_id: 'ws_1', query: 'needle' },
  });
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { code: string }).code, 'REQUEST_IDS_NOT_DISTINCT');
  assert.deepEqual(sent, [], 'and it refused before sending anything');
});

test('the kill switch is read live by an already-open connection', async (t) => {
  // Every earlier kill-switch test reconnected first, so an implementation that snapshotted the
  // switch at construction would have passed all of them. `npm run lease:stop` promises to work
  // "in every WAG process, without any of them cooperating"; that means an open port too.
  const h = await harness(t);
  let engaged = false;
  const plane = new UiDelegationDispatchPlane({
    port: createDelegationDispatchPort(h.store),
    killSwitch: () => engaged,
    now: () => 1_000_000,
    configuredDelegationId: h.delegationId,
  });
  const r = new DelegatedDispatchRouter({ plane, connection: CONNECTION });
  bound(r);
  const staged = r.handle({
    version: V, type: 'run.stage', requestId: rid(), sessionId: SESSION,
    delegationId: h.delegationId, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com', arguments: { workspace_id: 'ws_1', query: 'needle' },
  }) as { result?: { proposalId: string } };
  const proposalId = staged.result!.proposalId;

  // Same router, same plane, same bound session — only the switch changes.
  engaged = true;
  assert.equal(codeOf(r.handle({
    version: V, type: 'run.dispatch', requestId: rid(), sessionId: SESSION,
    delegationId: h.delegationId, proposalId,
  })), 'KILL_SWITCH_ENGAGED');
  assert.equal(h.store.countDelegationClaims(h.delegationId), 0);

  engaged = false;
  assert.equal((r.handle({
    version: V, type: 'run.dispatch', requestId: rid(), sessionId: SESSION,
    delegationId: h.delegationId, proposalId,
  }) as { type: string }).type, 'result', 'it pauses; it does not revoke');
});

test('an expiry is read live by an already-open connection too', async (t) => {
  const h = await harness(t);
  let now = 1_000_000;
  const control = new UiDelegationControlPlane({
    store: h.store, key: createControllerPlaneKey('live.expiry.controller'), now: () => now,
  });
  const delegationId = control.issue({
    goalId: 'goal_live_expiry',
    bindings: { ...BINDINGS, goalId: 'goal_live_expiry', controllerId: 'live.expiry.controller' },
    ttlMs: 5_000,
  }).delegationId;
  const plane = new UiDelegationDispatchPlane({
    port: createDelegationDispatchPort(h.store),
    killSwitch: () => false,
    now: () => now,
    configuredDelegationId: delegationId,
  });
  const r = new DelegatedDispatchRouter({ plane, connection: CONNECTION });
  bound(r);
  const staged = r.handle({
    version: V, type: 'run.stage', requestId: rid(), sessionId: SESSION,
    delegationId, tool: 'repo.search', workspaceId: 'ws_1',
    origin: 'https://chatgpt.com', arguments: { workspace_id: 'ws_1', query: 'needle' },
  }) as { result?: { proposalId: string } };

  now += 5_001;
  assert.equal(codeOf(r.handle({
    version: V, type: 'run.dispatch', requestId: rid(), sessionId: SESSION,
    delegationId, proposalId: staged.result!.proposalId,
  })), 'DELEGATION_EXPIRED');
  assert.equal(h.store.countDelegationClaims(delegationId), 0);
});

test('the delegation adapter gets the strict correlation shape by default', async (t) => {
  // A delegation binds `sessionId`, and `sessionId` is derived from the correlation — so a caller
  // who can choose the correlation can join the exact session a delegation is bound to. The
  // registry's pattern argument is optional and an omitted one means the permissive v1/v2/v3
  // shape, which would have given the adapter that can cause a Run the weakest correlation shape
  // of any of them, by default rather than by decision.
  const dir = await mkdtemp(join(tmpdir(), 'wag-corr-'));
  const store = new SqliteDurableStore(join(dir, 'store.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const { BrowserAdmissionRegistry } = await import('../src/adapter-admission.js');
  const delegation = new BrowserAdmissionRegistry(BROWSER_DELEGATION_ADAPTER_ID, store, () => 1_000_000);
  for (const chosen of ['page.chose.this', 'session_not_a_uuid', 'aaaaaaaa']) {
    assert.throws(() => delegation.admit(chosen), /correlation shape rejected/, chosen);
  }
  assert.doesNotThrow(
    () => delegation.admit('session_3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    'a server-minted UUID is what it wants',
  );

  // The frozen adapters keep their permissive shape; constraining them would alter a contract.
  const v1 = new BrowserAdmissionRegistry('browser.chatgpt.native.v1', store, () => 1_000_000);
  assert.doesNotThrow(() => v1.admit('page.chose.this'));
});
