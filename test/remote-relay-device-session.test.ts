import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteRelayDeviceSession,
  type RemoteRelayToolExecutionPort,
} from '../src/remote-relay-device-session.js';
import {
  RemoteRelayReassembler,
  encodeRemoteRelayMessage,
  type RemoteRelayFrame,
} from '../src/remote-relay-protocol.js';
import { InMemoryRemoteRelayCallStore } from '../src/remote-relay-call-store.js';

const SECRET = Buffer.alloc(32, 0x33);
const DEVICE = 'device_primary';
const SESSION = 'session_device_test';
const NOW = 1_790_547_300_000;

function requestFrames(
  callId: string,
  value: unknown,
  messageId: string,
): RemoteRelayFrame[] {
  return encodeRemoteRelayMessage({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    callId,
    direction: 'relay_to_device',
    payload: JSON.stringify(value),
    expiresAt: NOW + 30_000,
    messageId,
  });
}

function decodeSent(frames: RemoteRelayFrame[]) {
  const receiver = new RemoteRelayReassembler({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    expectedDirection: 'device_to_relay',
    now: () => NOW,
  });
  const messages: Array<{ callId: string; value: unknown }> = [];
  for (const frame of frames) {
    const accepted = receiver.accept(frame);
    if (accepted) {
      messages.push({
        callId: accepted.callId,
        value: JSON.parse(accepted.payload.toString('utf8')),
      });
    }
  }
  return messages;
}

class FakeExecutor implements RemoteRelayToolExecutionPort {
  calls: Array<{ tool: string; arguments: unknown }> = [];
  result: Awaited<ReturnType<RemoteRelayToolExecutionPort['callTool']>> = {
    ok: true,
    result: {
      content: [{ type: 'text', text: '{\"status\":\"ok\"}' }],
      structuredContent: { status: 'ok' },
    },
  };

  async callTool(input: { tool: string; arguments: unknown }) {
    this.calls.push(input);
    return this.result;
  }
}

function fixture() {
  const executor = new FakeExecutor();
  const sent: RemoteRelayFrame[] = [];
  let failSend = false;
  const session = new RemoteRelayDeviceSession({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    agentVersion: '1.2.3',
    toolManifest: [{ name: 'health', inputSchema: { type: 'object' } }],
    executor,
    sendFrame: async (frame) => {
      if (failSend) throw new Error('transport disconnected');
      sent.push(frame);
    },
    now: () => NOW,
  });
  return {
    executor,
    sent,
    session,
    setFailSend(value: boolean) { failSend = value; },
  };
}

test('device session announces version, protocol session and catalog hash over encrypted response direction', async () => {
  const f = fixture();
  await f.session.announce();
  const [message] = decodeSent(f.sent);
  assert.equal(message?.callId, 'session_hello');
  assert.deepEqual(message?.value, {
    kind: 'device.hello',
    protocol_version: 'wag-relay-v1',
    agent_version: '1.2.3',
    catalog_hash: f.session.catalogHash,
    session_id: SESSION,
  });
});

test('authenticated tool call dispatches exactly once and returns bounded structured result', async () => {
  const f = fixture();
  const frames = requestFrames('call_health', {
    kind: 'tool.call',
    tool: 'health',
    arguments: {},
  }, 'message_health');

  let outcome = null;
  for (const frame of frames) outcome = await f.session.receive(frame);
  assert.deepEqual(outcome, {
    state: 'EXECUTED',
    callId: 'call_health',
    resultSent: true,
  });
  assert.deepEqual(f.executor.calls, [{ tool: 'health', arguments: {} }]);

  const [response] = decodeSent(f.sent);
  assert.deepEqual(response?.value, {
    kind: 'tool.result',
    ok: true,
    result: {
      content: [{ type: 'text', text: '{\"status\":\"ok\"}' }],
      structuredContent: { status: 'ok' },
    },
  });
});

test('same call_id in a new authenticated message is never executed twice', async () => {
  const f = fixture();
  for (const frame of requestFrames('call_once', {
    kind: 'tool.call',
    tool: 'health',
    arguments: { first: true },
  }, 'message_once_a')) {
    await f.session.receive(frame);
  }
  for (const frame of requestFrames('call_once', {
    kind: 'tool.call',
    tool: 'health',
    arguments: { first: false },
  }, 'message_once_b')) {
    const outcome = await f.session.receive(frame);
    if (outcome.state !== 'PARTIAL') assert.equal(outcome.state, 'DUPLICATE_CALL');
  }

  assert.equal(f.executor.calls.length, 1);
  const responses = decodeSent(f.sent);
  assert.deepEqual(responses.at(-1)?.value, responses[0]?.value,
    'duplicate call returns the locally durable original result without re-execution');
});

test('transport failure after dispatch is recovered from local result state without re-execution', async () => {
  const f = fixture();
  f.setFailSend(true);
  const frames = requestFrames('call_uncertain', {
    kind: 'tool.call',
    tool: 'mutation.preview',
    arguments: { opaque: true },
  }, 'message_uncertain_a');

  let executed = null;
  for (const frame of frames) executed = await f.session.receive(frame);
  assert.deepEqual(executed, {
    state: 'EXECUTED',
    callId: 'call_uncertain',
    resultSent: false,
  });
  assert.equal(f.executor.calls.length, 1);

  f.setFailSend(false);
  for (const frame of requestFrames('call_uncertain', {
    kind: 'tool.call',
    tool: 'mutation.preview',
    arguments: { opaque: true },
  }, 'message_uncertain_b')) {
    await f.session.receive(frame);
  }
  assert.equal(f.executor.calls.length, 1, 'uncertain remote effect must never be blindly retried');
  assert.deepEqual(decodeSent(f.sent).at(-1)?.value, {
    kind: 'tool.result',
    ok: true,
    result: {
      content: [{ type: 'text', text: '{\"status\":\"ok\"}' }],
      structuredContent: { status: 'ok' },
    },
  });
});

test('invalid request does not reach the WAG executor', async () => {
  const f = fixture();
  for (const frame of requestFrames('call_invalid', {
    kind: 'not-a-tool-call',
    tool: 'health',
    arguments: {},
  }, 'message_invalid')) {
    const outcome = await f.session.receive(frame);
    if (outcome.state !== 'PARTIAL') assert.equal(outcome.state, 'INVALID_REQUEST');
  }
  assert.equal(f.executor.calls.length, 0);
  assert.deepEqual(decodeSent(f.sent).at(-1)?.value, {
    kind: 'tool.result',
    ok: false,
    error_class: 'INVALID_REQUEST',
  });
});

test('unexpected oversized executor result becomes a small RESULT_BOUND_REQUIRED response', async () => {
  const f = fixture();
  f.executor.result = {
    ok: true,
    result: { structuredContent: { giant: 'x'.repeat(300 * 1024) } },
  };
  for (const frame of requestFrames('call_large', {
    kind: 'tool.call',
    tool: 'health',
    arguments: {},
  }, 'message_large')) {
    const outcome = await f.session.receive(frame);
    if (outcome.state !== 'PARTIAL') {
      assert.deepEqual(outcome, {
        state: 'EXECUTED',
        callId: 'call_large',
        resultSent: true,
      });
    }
  }
  assert.equal(f.executor.calls.length, 1);
  assert.deepEqual(decodeSent(f.sent).at(-1)?.value, {
    kind: 'tool.result',
    ok: false,
    error_class: 'RESULT_BOUND_REQUIRED',
  });
});

test('relay.call.get recovers a completed result through a new device session without tool re-execution', async () => {
  const store = new InMemoryRemoteRelayCallStore();
  const executor = new FakeExecutor();
  const firstSent: RemoteRelayFrame[] = [];
  const first = new RemoteRelayDeviceSession({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: 'session_first',
    agentVersion: '1.2.3',
    toolManifest: [{ name: 'health' }],
    executor,
    callStore: store,
    sendFrame: async (frame) => { firstSent.push(frame); },
    now: () => NOW,
  });
  for (const frame of encodeRemoteRelayMessage({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: 'session_first',
    callId: 'call_recover_target',
    direction: 'relay_to_device',
    payload: JSON.stringify({ kind: 'tool.call', tool: 'health', arguments: {} }),
    expiresAt: NOW + 30_000,
    messageId: 'message_recover_target',
  })) {
    await first.receive(frame);
  }
  assert.equal(executor.calls.length, 1);

  const secondSent: RemoteRelayFrame[] = [];
  const second = new RemoteRelayDeviceSession({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: 'session_second',
    agentVersion: '1.2.3',
    toolManifest: [{ name: 'health' }],
    executor,
    callStore: store,
    sendFrame: async (frame) => { secondSent.push(frame); },
    now: () => NOW + 1_000,
  });
  for (const frame of encodeRemoteRelayMessage({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: 'session_second',
    callId: 'poll_recover_target',
    direction: 'relay_to_device',
    payload: JSON.stringify({
      kind: 'relay.call.get',
      target_call_id: 'call_recover_target',
    }),
    expiresAt: NOW + 31_000,
    messageId: 'message_poll_recover_target',
  })) {
    const outcome = await second.receive(frame);
    if (outcome.state !== 'PARTIAL') assert.equal(outcome.state, 'RECOVERED_CALL');
  }

  assert.equal(executor.calls.length, 1, 'poll recovery must not execute the original tool again');
  const receiver = new RemoteRelayReassembler({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: 'session_second',
    expectedDirection: 'device_to_relay',
    now: () => NOW + 1_000,
  });
  let recovered: unknown;
  for (const frame of secondSent) {
    const message = receiver.accept(frame);
    if (message) recovered = JSON.parse(message.payload.toString('utf8'));
  }
  assert.deepEqual(recovered, {
    kind: 'tool.result',
    ok: true,
    result: {
      content: [{ type: 'text', text: '{\"status\":\"ok\"}' }],
      structuredContent: { status: 'ok' },
    },
  });
  store.close();
});
