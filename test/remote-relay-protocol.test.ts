import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REMOTE_RELAY_LOGICAL_MESSAGE_MAX_BYTES,
  REMOTE_RELAY_SERIALIZED_FRAME_MAX_BYTES,
  RemoteRelayReassembler,
  encodeRemoteRelayMessage,
  remoteRelayCatalogHash,
  remoteRelayDeviceIdHash,
  remoteRelayTopic,
} from '../src/remote-relay-protocol.js';

const SECRET = Buffer.alloc(32, 0x5a);
const DEVICE = 'device_primary';
const SESSION = 'session_primary';
const CALL = 'call_primary';
const NOW = 1_790_547_200_000;
const EXPIRES = NOW + 30_000;

function reassembler(direction: 'relay_to_device' | 'device_to_relay' = 'relay_to_device') {
  return new RemoteRelayReassembler({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    expectedDirection: direction,
    now: () => NOW,
  });
}

test('remote relay derives stable opaque topic/device identifiers without exposing the secret', () => {
  const topic = remoteRelayTopic(SECRET, DEVICE);
  const hash = remoteRelayDeviceIdHash(SECRET, DEVICE);
  assert.match(topic, /^wag:[A-Za-z0-9_-]{40,}$/);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(topic, remoteRelayTopic(SECRET, DEVICE));
  assert.equal(hash, remoteRelayDeviceIdHash(SECRET, DEVICE));
  assert.equal(topic.includes(DEVICE), false);
  assert.equal(hash.includes(DEVICE), false);
});

test('single-frame relay message authenticates metadata and round-trips exactly', () => {
  const payload = Buffer.from(JSON.stringify({ kind: 'tool.call', tool: 'health', arguments: {} }), 'utf8');
  const [frame] = encodeRemoteRelayMessage({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    callId: CALL,
    direction: 'relay_to_device',
    payload,
    expiresAt: EXPIRES,
    messageId: 'message_primary',
  });
  assert.ok(frame);
  assert.ok(Buffer.byteLength(JSON.stringify(frame), 'utf8') <= REMOTE_RELAY_SERIALIZED_FRAME_MAX_BYTES);
  const result = reassembler().accept(frame);
  assert.equal(result?.callId, CALL);
  assert.equal(result?.messageId, 'message_primary');
  assert.deepEqual(result?.payload, payload);
});

test('256 KiB logical payload fragments below the 192 KiB serialized frame ceiling and reassembles out of order', () => {
  const payload = Buffer.alloc(REMOTE_RELAY_LOGICAL_MESSAGE_MAX_BYTES, 0xa5);
  const frames = encodeRemoteRelayMessage({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    callId: CALL,
    direction: 'relay_to_device',
    payload,
    expiresAt: EXPIRES,
    messageId: 'message_fragmented',
  });
  assert.ok(frames.length > 1);
  for (const frame of frames) {
    assert.ok(
      Buffer.byteLength(JSON.stringify(frame), 'utf8') <= REMOTE_RELAY_SERIALIZED_FRAME_MAX_BYTES,
      'every serialized Realtime application frame is <= 192 KiB',
    );
  }

  const receiver = reassembler();
  let completed = null;
  for (const frame of [...frames].reverse()) {
    completed = receiver.accept(frame) ?? completed;
  }
  assert.deepEqual(completed?.payload, payload);
});

test('logical payload above 256 KiB is rejected before encryption', () => {
  assert.throws(() => encodeRemoteRelayMessage({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    callId: CALL,
    direction: 'relay_to_device',
    payload: Buffer.alloc(REMOTE_RELAY_LOGICAL_MESSAGE_MAX_BYTES + 1),
    expiresAt: EXPIRES,
  }), /exceeds 256 KiB/);
});

test('AAD tampering is rejected and cannot turn one call into another', () => {
  const [frame] = encodeRemoteRelayMessage({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    callId: CALL,
    direction: 'relay_to_device',
    payload: 'secret-payload',
    expiresAt: EXPIRES,
    messageId: 'message_tamper',
  });
  assert.ok(frame);
  assert.throws(
    () => reassembler().accept({ ...frame, call_id: 'call_attacker' }),
    /authentication failed/,
  );
});

test('wrong direction/session/device and expired frames fail closed before dispatch', () => {
  const [frame] = encodeRemoteRelayMessage({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    callId: CALL,
    direction: 'relay_to_device',
    payload: 'payload',
    expiresAt: EXPIRES,
    messageId: 'message_scope',
  });
  assert.ok(frame);
  assert.throws(
    () => new RemoteRelayReassembler({
      secret: SECRET,
      deviceId: DEVICE,
      sessionId: SESSION,
      expectedDirection: 'device_to_relay',
      now: () => NOW,
    }).accept(frame),
    /direction mismatch/,
  );
  assert.throws(
    () => new RemoteRelayReassembler({
      secret: SECRET,
      deviceId: DEVICE,
      sessionId: 'session_other',
      expectedDirection: 'relay_to_device',
      now: () => NOW,
    }).accept(frame),
    /session mismatch/,
  );
  assert.throws(
    () => new RemoteRelayReassembler({
      secret: SECRET,
      deviceId: 'device_other',
      sessionId: SESSION,
      expectedDirection: 'relay_to_device',
      now: () => NOW,
    }).accept(frame),
    /device mismatch/,
  );
  assert.throws(
    () => new RemoteRelayReassembler({
      secret: SECRET,
      deviceId: DEVICE,
      sessionId: SESSION,
      expectedDirection: 'relay_to_device',
      now: () => EXPIRES,
    }).accept(frame),
    /expired/,
  );
});

test('completed message replay and duplicate fragment are rejected', () => {
  const frames = encodeRemoteRelayMessage({
    secret: SECRET,
    deviceId: DEVICE,
    sessionId: SESSION,
    callId: CALL,
    direction: 'relay_to_device',
    payload: Buffer.alloc(180 * 1024, 7),
    expiresAt: EXPIRES,
    messageId: 'message_replay',
  });
  assert.ok(frames.length > 1);
  const receiver = reassembler();
  assert.equal(receiver.accept(frames[0]), null);
  assert.throws(() => receiver.accept(frames[0]), /duplicate frame/);
  for (const frame of frames.slice(1)) receiver.accept(frame);
  assert.throws(() => receiver.accept(frames[0]), /replay rejected/);
});

test('catalog hash is deterministic and changes with the public manifest', () => {
  const a = remoteRelayCatalogHash([{ name: 'health', schema: {} }]);
  const b = remoteRelayCatalogHash([{ name: 'health', schema: {} }]);
  const c = remoteRelayCatalogHash([{ name: 'health', schema: { type: 'object' } }]);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
