/**
 * The delegated path must be idempotent by proposal identity (ADR-0029).
 *
 * `.claude/rules/human-presence-boundary.md` says "reattachment and rescan are the extension's own
 * job and are idempotent by proposal identity". That was true of the v4 queue and **false of the
 * delegated path**, which ran before `queueProviderRequest` and was handed no `messageId`.
 *
 * What that cost, measured by an adversarial review reading the shipped control flow: opening the
 * side panel calls `attachAndRescan`, the content script clears its own suppression map by design,
 * and every completed turn is re-emitted. Each re-observation staged, claimed, dispatched and
 * executed the same candidate again, spending a budget slot every time. Ten in-scope proposals in a
 * conversation drained a `maxActions: 20` delegation in two panel opens.
 *
 * `maxActions` held arithmetically the whole time — every run really did spend a slot — which is why
 * nothing on the store side looked wrong. The bound that failed was "one candidate runs once".
 *
 * These tests execute the logic rather than asserting on the worker's source. The previous
 * extension tests read `service-worker.js` as text, and a missing call is exactly the thing that
 * looks like the code around it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_REMEMBERED_DELEGATED,
  createDelegatedObservationMemory,
  createDelegatedRunAttempt,
} from '../browser/extension/delegated-observation-v5.js';
import { stageAndDispatch } from '../browser/extension/delegated-dispatch-core-v5.js';
import { proposalIdentity } from '../browser/extension/service-worker-core-v4.js';

const CORRELATION = 'session_11111111-1111-4111-8111-111111111111';
const SESSION = 'session_22222222-2222-4222-8222-222222222222';
const DELEGATION = 'uidel_0123456789abcdef';
const CALL = { tool: 'repo.search', arguments: { workspace_id: 'ws_1', query: 'needle' } };
const IDENTITY = proposalIdentity(CORRELATION, 7, 'msg_1', CALL.tool, CALL.arguments);

/** A storage double with the shape `chrome.storage.session` presents. */
function storage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (entries: Record<string, unknown>) => { Object.assign(data, entries); },
  };
}

/**
 * A delegation controller double plus a transport that records every envelope.
 *
 * `answers` maps a verb to what the transport replies with; anything absent gets a generic result.
 */
function controller(options: {
  delegationId?: string | undefined;
  ready?: () => Promise<void>;
  answer?: (envelope: Record<string, unknown>) => unknown;
} = {}) {
  const sent: Record<string, unknown>[] = [];
  const delegation = {
    ensureReady: options.ready ?? (async () => undefined),
    delegationId: () => ('delegationId' in options ? options.delegationId : DELEGATION),
    boundSessionId: () => SESSION,
    send: async (envelope: Record<string, unknown>) => {
      sent.push(envelope);
      if (options.answer) return options.answer(envelope);
      if (envelope.type === 'run.stage') {
        return {
          version: 5, type: 'result', requestId: envelope.requestId,
          result: { proposalId: 'prop_0123456789abcdef', fingerprint: 'fp' },
        };
      }
      return {
        version: 5, type: 'result', requestId: envelope.requestId,
        result: { proposalId: 'prop_0123456789abcdef', authority: 'DELEGATED_RUN' },
      };
    },
  };
  return { delegation, sent };
}

let sequence = 0;
const attemptOver = (delegation: ReturnType<typeof controller>['delegation'], memory: ReturnType<typeof createDelegatedObservationMemory>) =>
  createDelegatedRunAttempt({
    delegation, memory, stageAndDispatch,
    randomUUID: () => { sequence += 1; return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`; },
  });

const attemptOnce = (
  attempt: ReturnType<typeof createDelegatedRunAttempt>,
) => attempt({ identity: IDENTITY, correlationId: CORRELATION, call: CALL, origin: 'https://chatgpt.com' });

// ---------------------------------------------------------------------------------------------

test('a re-observed candidate is not dispatched a second time', async () => {
  const memory = createDelegatedObservationMemory(storage());
  const { delegation, sent } = controller();
  const attempt = attemptOver(delegation, memory);

  const first = await attemptOnce(attempt);
  assert.equal((first as { ok: boolean }).ok, true);
  assert.equal(sent.filter((e) => e.type === 'run.dispatch').length, 1);

  // The rescan. Same message, same tool, same arguments — so the same proposal.
  const second = await attemptOnce(attempt);
  assert.deepEqual(second, { alreadyDecided: true });
  assert.equal(
    sent.filter((e) => e.type === 'run.dispatch').length, 1,
    'the second observation must not reach WAG at all',
  );
  assert.equal(sent.filter((e) => e.type === 'run.stage').length, 1, 'and must not stage again');
});

test('a refusal is remembered too, so a rescan does not re-ask', async () => {
  // "It never retries a refusal: a refused dispatch means WAG decided, and asking again is how a
  // budget gets drained by a loop that thinks it knows better." A rescan is such a loop.
  const memory = createDelegatedObservationMemory(storage());
  const { delegation, sent } = controller({
    answer: (envelope) => (envelope.type === 'run.stage'
      ? { version: 5, type: 'result', requestId: envelope.requestId, result: { proposalId: 'prop_0123456789abcdef' } }
      : { version: 5, type: 'error', requestId: envelope.requestId, error: { code: 'DELEGATION_EXPIRED', message: 'no' } }),
  });
  const attempt = attemptOver(delegation, memory);

  const first = await attemptOnce(attempt);
  assert.equal((first as { code: string }).code, 'DELEGATION_EXPIRED');

  assert.deepEqual(await attemptOnce(attempt), { alreadyDecided: true });
  assert.equal(sent.filter((e) => e.type === 'run.stage').length, 1);
});

test('a candidate that never reached WAG is not remembered, and may be offered later', async () => {
  // Staging is inert: nothing was spent and nothing ran, so this one genuinely may be retried —
  // and must be, or a transient port failure would silently drop the work forever.
  const memory = createDelegatedObservationMemory(storage());
  let failStage = true;
  const { delegation, sent } = controller({
    answer: (envelope) => {
      if (envelope.type === 'run.stage' && failStage) throw new Error('port died');
      if (envelope.type === 'run.stage') {
        return { version: 5, type: 'result', requestId: envelope.requestId, result: { proposalId: 'prop_0123456789abcdef' } };
      }
      return {
        version: 5, type: 'result', requestId: envelope.requestId,
        result: { proposalId: 'prop_0123456789abcdef', authority: 'DELEGATED_RUN' },
      };
    },
  });
  const attempt = attemptOver(delegation, memory);

  const first = await attemptOnce(attempt);
  assert.equal((first as { code: string }).code, 'STAGE_TRANSPORT_FAILED');
  assert.equal(memory.size(), 0, 'nothing decided, nothing remembered');

  failStage = false;
  const second = await attemptOnce(attempt);
  assert.equal((second as { ok: boolean }).ok, true, 'and the retry works');
  assert.equal(sent.filter((e) => e.type === 'run.dispatch').length, 1);
});

test('a dispatch whose answer was lost is indeterminate, and is remembered', async () => {
  // The dispatch was SENT. WAG may have claimed a slot, transitioned the row and run the tool
  // before the port died — `handleDisconnect` rejects every pending promise, and an MV3 worker is
  // terminated without warning. Offering this to a person afterwards runs the work twice.
  const memory = createDelegatedObservationMemory(storage());
  const { delegation } = controller({
    answer: (envelope) => {
      if (envelope.type === 'run.stage') {
        return { version: 5, type: 'result', requestId: envelope.requestId, result: { proposalId: 'prop_0123456789abcdef' } };
      }
      throw new Error('native messaging host disconnected');
    },
  });
  const attempt = attemptOver(delegation, memory);

  const outcome = await attemptOnce(attempt) as { indeterminate?: boolean; code?: string; proposalId?: string };
  assert.equal(outcome.indeterminate, true);
  assert.equal(outcome.code, 'DISPATCH_INDETERMINATE');
  assert.equal(outcome.proposalId, 'prop_0123456789abcdef', 'and it names the row to go and look at');
  assert.equal(memory.size(), 1, 'remembered, so a rescan does not turn "maybe ran" into "ran twice"');
});

test('no host and no delegation are not decisions, and are never remembered', async () => {
  const memory = createDelegatedObservationMemory(storage());

  const noHost = attemptOver(
    controller({ ready: async () => { throw new Error('connectNative failed'); } }).delegation, memory,
  );
  assert.equal(await attemptOnce(noHost), undefined);

  const noDelegation = attemptOver(controller({ delegationId: undefined }).delegation, memory);
  assert.equal(await attemptOnce(noDelegation), undefined);

  assert.equal(
    memory.size(), 0,
    'enabling delegation tomorrow must pick up a candidate skipped today',
  );
});

test('a tool that resolves no workspace is left for a person, without asking WAG', async () => {
  const memory = createDelegatedObservationMemory(storage());
  const { delegation, sent } = controller();
  const attempt = attemptOver(delegation, memory);

  for (const call of [
    { tool: 'workspace.open', arguments: { path: 'E:\\somewhere' } },
    { tool: 'health', arguments: {} },
  ]) {
    const outcome = await attempt({
      identity: proposalIdentity(CORRELATION, 7, 'msg_2', call.tool, call.arguments),
      correlationId: CORRELATION, call, origin: 'https://chatgpt.com',
    });
    assert.equal(outcome, undefined, call.tool);
  }
  assert.deepEqual(sent, [], 'not asked, because WAG would refuse it anyway');
  assert.equal(memory.size(), 0);
});

// ---------------------------------------------------------------------------------------------
// The memory itself
// ---------------------------------------------------------------------------------------------

test('the memory survives a worker restart', async () => {
  // MV3 suspends an idle worker after about thirty seconds. An identity that did not outlive that
  // would be no identity at all — the restart itself re-observes every message.
  const shared = storage();
  const first = createDelegatedObservationMemory(shared);
  await first.ready();
  first.remember(IDENTITY);

  const afterRestart = createDelegatedObservationMemory(shared);
  await afterRestart.ready();
  assert.equal(afterRestart.has(IDENTITY), true);
});

test('the memory is bounded and evicts in first-seen order', async () => {
  const memory = createDelegatedObservationMemory(storage());
  await memory.ready();
  for (let i = 0; i < MAX_REMEMBERED_DELEGATED + 5; i += 1) memory.remember(`identity_${i}`);
  assert.equal(memory.size(), MAX_REMEMBERED_DELEGATED);
  assert.equal(memory.has('identity_0'), false, 'the oldest went first');
  assert.equal(memory.has(`identity_${MAX_REMEMBERED_DELEGATED + 4}`), true);
});

test('unreadable storage reads as empty, which re-offers rather than suppresses', async () => {
  const broken = {
    get: async () => { throw new Error('storage gone'); },
    set: async () => undefined,
  };
  const memory = createDelegatedObservationMemory(broken);
  await memory.ready();
  assert.equal(memory.has(IDENTITY), false);
  // The safe direction: a duplicate proposal costs a slot, a wrongly suppressed one costs the work.
});

test('the identity is the v4 queue\'s, so the two paths agree about what one proposal is', () => {
  // Sharing `proposalIdentity` is the point. A candidate the delegated path decided and one the
  // human queue remembers must be the same proposal, or a rescan raises it on whichever path did
  // not see it first.
  assert.equal(
    proposalIdentity(CORRELATION, 7, 'msg_1', CALL.tool, CALL.arguments),
    IDENTITY,
  );
  // Key order must not matter, and a different message is a different proposal.
  assert.equal(
    proposalIdentity(CORRELATION, 7, 'msg_1', CALL.tool, { query: 'needle', workspace_id: 'ws_1' }),
    IDENTITY,
  );
  assert.notEqual(proposalIdentity(CORRELATION, 7, 'msg_2', CALL.tool, CALL.arguments), IDENTITY);
});
