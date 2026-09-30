import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteControlPlanePrototype } from '../src/remote-control-plane-model.js';

const ACCOUNT_A = 'account_alpha';
const ACCOUNT_B = 'account_bravo';
const DEVICE_A = 'device_alpha';
const DEVICE_B = 'device_bravo';
const CLIENT_A = 'client_alpha';
const CLIENT_B = 'client_bravo';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function create(now = 1_800_000_000_000) {
  let clock = now;
  const plane = new RemoteControlPlanePrototype({ now: () => clock });
  plane.registerAccount(ACCOUNT_A);
  plane.registerAccount(ACCOUNT_B);
  return {
    plane,
    now: () => clock,
    advance(ms: number) { clock += ms; },
  };
}

function enroll(
  plane: RemoteControlPlanePrototype,
  accountId = ACCOUNT_A,
  deviceId = DEVICE_A,
  clientId = CLIENT_A,
  keyThumbprint = KEY_A,
  suffix = 'alpha',
) {
  return plane.consumeVerifiedEnrollment({
    accountId,
    enrollmentGrantId: 'enroll_' + suffix,
    deviceId,
    clientId,
    keyThumbprint,
    label: 'Windows ' + suffix,
  });
}

function readyDevice(plane: RemoteControlPlanePrototype) {
  enroll(plane);
  plane.connectDevice({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    clientId: CLIENT_A,
    keyThumbprint: KEY_A,
    sessionId: 'session_alpha_1',
  });
  plane.setDeviceExecutionHealth({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    transportReady: true,
    executorReady: true,
    toolRoundTripReady: true,
  });
}

test('verified enrollment is one-time and binds one account/device to one device key', () => {
  const { plane } = create();
  const first = enroll(plane);
  assert.equal(first.accountId, ACCOUNT_A);
  assert.equal(first.deviceId, DEVICE_A);
  assert.equal(first.keyThumbprint, KEY_A);
  assert.equal(first.revoked, false);

  assert.throws(
    () => plane.consumeVerifiedEnrollment({
      accountId: ACCOUNT_A,
      enrollmentGrantId: 'enroll_alpha',
      deviceId: 'device_other',
      clientId: 'client_other',
      keyThumbprint: 'c'.repeat(64),
      label: 'Other',
    }),
    /ENROLLMENT_REPLAY/,
  );

  assert.throws(
    () => plane.connectDevice({
      accountId: ACCOUNT_A,
      deviceId: DEVICE_A,
      clientId: CLIENT_A,
      keyThumbprint: KEY_B,
      sessionId: 'session_bad_key',
    }),
    /CREDENTIAL_MISMATCH/,
  );
});

test('remote Ready requires all six architecture layers, not a device heartbeat alone', () => {
  const { plane } = create();
  enroll(plane);
  plane.connectDevice({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    clientId: CLIENT_A,
    keyThumbprint: KEY_A,
    sessionId: 'session_alpha_1',
  });

  let health = plane.health(ACCOUNT_A, DEVICE_A);
  assert.equal(health.layers.ACCOUNT_AUTH, 'READY');
  assert.equal(health.layers.HOSTED_RELAY, 'READY');
  assert.equal(health.layers.DEVICE_SESSION, 'READY');
  assert.equal(health.layers.DEVICE_TRANSPORT, 'READY');
  assert.equal(health.layers.LOCAL_EXECUTOR, 'NOT_READY');
  assert.equal(health.layers.TOOL_ROUNDTRIP, 'NOT_READY');
  assert.equal(health.ready, false);

  health = plane.setDeviceExecutionHealth({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    executorReady: true,
    toolRoundTripReady: true,
  });
  assert.equal(health.ready, true);

  plane.setHostedRelayReady(false);
  health = plane.health(ACCOUNT_A, DEVICE_A);
  assert.equal(health.layers.HOSTED_RELAY, 'NOT_READY');
  assert.equal(health.ready, false);
});

test('connector access-token expiry fails at ACCOUNT_AUTH and refresh allows only a new request', () => {
  const { plane, now } = create();
  readyDevice(plane);
  plane.setAccountAuth(ACCOUNT_A, false);

  const denied = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_auth_expired',
    expiresAt: now() + 30_000,
  });
  assert.equal(denied.disposition, 'REJECTED');
  assert.equal(denied.call.stage, 'ACCOUNT_AUTH');
  assert.equal(denied.call.failureCode, 'ACCOUNT_AUTH_REQUIRED');

  plane.setAccountAuth(ACCOUNT_A, true);
  const retry = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_auth_expired',
    expiresAt: now() + 30_000,
  });
  assert.equal(retry.disposition, 'DUPLICATE');
  assert.equal(retry.call.state, 'REJECTED');

  const fresh = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_auth_refreshed',
    expiresAt: now() + 30_000,
  });
  assert.equal(fresh.disposition, 'ACCEPTED');
});

test('relay delivery loss after local dispatch becomes UNKNOWN and provider retry never reexecutes', () => {
  const { plane, now } = create();
  readyDevice(plane);
  const first = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_relay_loss',
    expiresAt: now() + 30_000,
  });
  assert.equal(first.disposition, 'ACCEPTED');

  const dispatched = plane.dispatchCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_relay_loss',
    effectId: 'effect_relay_loss',
  });
  assert.equal(dispatched.state, 'DISPATCHED');

  plane.setHostedRelayReady(false);
  const unknown = plane.markUnknown({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_relay_loss',
    failureCode: 'RELAY_DELIVERY_LOSS',
  });
  assert.equal(unknown.state, 'UNKNOWN');
  assert.equal(unknown.effectId, 'effect_relay_loss');

  const providerRetry = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_relay_loss',
    expiresAt: now() + 30_000,
  });
  assert.equal(providerRetry.disposition, 'DUPLICATE');
  assert.equal(providerRetry.call.state, 'UNKNOWN');
});

test('device transport reconnect increments session generation and does not revive an offline request', () => {
  const { plane, now } = create();
  readyDevice(plane);
  const before = plane.device(ACCOUNT_A, DEVICE_A);
  plane.disconnectDevice(ACCOUNT_A, DEVICE_A);

  const offline = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_device_offline',
    expiresAt: now() + 30_000,
  });
  assert.equal(offline.disposition, 'REJECTED');
  assert.equal(offline.call.failureCode, 'DEVICE_OFFLINE');

  const reconnected = plane.connectDevice({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    clientId: CLIENT_A,
    keyThumbprint: KEY_A,
    sessionId: 'session_alpha_2',
  });
  assert.equal(reconnected.sessionGeneration, before.sessionGeneration + 1);
  plane.setDeviceExecutionHealth({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    executorReady: true,
    toolRoundTripReady: true,
  });

  const old = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_device_offline',
    expiresAt: now() + 30_000,
  });
  assert.equal(old.disposition, 'DUPLICATE');
  assert.equal(old.call.state, 'REJECTED');

  const fresh = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_after_reconnect',
    expiresAt: now() + 30_000,
  });
  assert.equal(fresh.disposition, 'ACCEPTED');
});

test('executor crash and local agent restart are stage-specific and durable call state survives reconnect', () => {
  const { plane, now } = create();
  readyDevice(plane);

  plane.setDeviceExecutionHealth({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    executorReady: false,
    toolRoundTripReady: false,
  });
  const crashed = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_executor_crash',
    expiresAt: now() + 30_000,
  });
  assert.equal(crashed.call.stage, 'LOCAL_EXECUTOR');
  assert.equal(crashed.call.failureCode, 'LOCAL_EXECUTOR_NOT_READY');

  plane.setDeviceExecutionHealth({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    executorReady: true,
    toolRoundTripReady: true,
  });
  const accepted = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_before_agent_restart',
    expiresAt: now() + 30_000,
  });
  assert.equal(accepted.disposition, 'ACCEPTED');
  plane.dispatchCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_before_agent_restart',
  });

  plane.disconnectDevice(ACCOUNT_A, DEVICE_A);
  plane.connectDevice({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    clientId: CLIENT_A,
    keyThumbprint: KEY_A,
    sessionId: 'session_after_restart',
  });
  plane.setDeviceExecutionHealth({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    executorReady: true,
    toolRoundTripReady: true,
  });

  const recovered = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_before_agent_restart',
    expiresAt: now() + 30_000,
  });
  assert.equal(recovered.disposition, 'DUPLICATE');
  assert.equal(recovered.call.state, 'DISPATCHED');
});

test('duplicate delivery and provider retry return one durable call instead of a second execution', () => {
  const { plane, now } = create();
  readyDevice(plane);

  const first = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_duplicate',
    expiresAt: now() + 30_000,
  });
  assert.equal(first.disposition, 'ACCEPTED');
  plane.dispatchCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_duplicate',
  });
  const completed = plane.completeCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_duplicate',
    ok: true,
  });
  assert.equal(completed.state, 'COMPLETED');

  for (let index = 0; index < 2; index += 1) {
    const duplicate = plane.beginCall({
      accountId: ACCOUNT_A,
      deviceId: DEVICE_A,
      requestId: 'request_duplicate',
      expiresAt: now() + 30_000,
    });
    assert.equal(duplicate.disposition, 'DUPLICATE');
    assert.equal(duplicate.call.state, 'COMPLETED');
  }
});

test('delayed response after dispatch expires to UNKNOWN instead of a blind retry', () => {
  const { plane, now, advance } = create();
  readyDevice(plane);

  plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_delayed',
    expiresAt: now() + 1_000,
  });
  plane.dispatchCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_delayed',
    effectId: 'effect_delayed',
  });

  advance(2_000);
  assert.equal(plane.expireCalls(), 1);
  const call = plane.call('request_delayed');
  assert.equal(call?.state, 'UNKNOWN');
  assert.equal(call?.failureCode, 'CALL_EXPIRED_AFTER_DISPATCH');
  assert.equal(call?.effectId, 'effect_delayed');
});

test('concurrent calls remain independently correlated', () => {
  const { plane, now } = create();
  readyDevice(plane);

  for (const id of ['request_parallel_a', 'request_parallel_b']) {
    const accepted = plane.beginCall({
      accountId: ACCOUNT_A,
      deviceId: DEVICE_A,
      requestId: id,
      expiresAt: now() + 30_000,
    });
    assert.equal(accepted.disposition, 'ACCEPTED');
    plane.dispatchCall({
      accountId: ACCOUNT_A,
      deviceId: DEVICE_A,
      requestId: id,
      effectId: id.replace('request_', 'effect_'),
    });
  }

  assert.equal(plane.call('request_parallel_a')?.state, 'DISPATCHED');
  assert.equal(plane.call('request_parallel_b')?.state, 'DISPATCHED');
  assert.notEqual(
    plane.call('request_parallel_a')?.effectId,
    plane.call('request_parallel_b')?.effectId,
  );
});

test('device revoked before dispatch is rejected and revoked mid-call becomes UNKNOWN', () => {
  const pre = create();
  readyDevice(pre.plane);
  const accepted = pre.plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_revoke_before',
    expiresAt: pre.now() + 30_000,
  });
  assert.equal(accepted.disposition, 'ACCEPTED');
  pre.plane.revokeDevice(ACCOUNT_A, DEVICE_A);
  const before = pre.plane.call('request_revoke_before');
  assert.equal(before?.state, 'REJECTED');
  assert.equal(before?.failureCode, 'DEVICE_REVOKED');

  const mid = create();
  readyDevice(mid.plane);
  mid.plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_revoke_mid',
    expiresAt: mid.now() + 30_000,
  });
  mid.plane.dispatchCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_A,
    requestId: 'request_revoke_mid',
    effectId: 'effect_revoke_mid',
  });
  mid.plane.revokeDevice(ACCOUNT_A, DEVICE_A);
  const after = mid.plane.call('request_revoke_mid');
  assert.equal(after?.state, 'UNKNOWN');
  assert.equal(after?.failureCode, 'DEVICE_REVOKED_MID_CALL');
  assert.equal(after?.effectId, 'effect_revoke_mid');
});

test('wrong-device routing is denied before transport and keeps stable request correlation', () => {
  const { plane, now } = create();
  readyDevice(plane);
  enroll(plane, ACCOUNT_B, DEVICE_B, CLIENT_B, KEY_B, 'bravo');
  plane.connectDevice({
    accountId: ACCOUNT_B,
    deviceId: DEVICE_B,
    clientId: CLIENT_B,
    keyThumbprint: KEY_B,
    sessionId: 'session_bravo_1',
  });
  plane.setDeviceExecutionHealth({
    accountId: ACCOUNT_B,
    deviceId: DEVICE_B,
    executorReady: true,
    toolRoundTripReady: true,
  });

  const denied = plane.beginCall({
    accountId: ACCOUNT_A,
    deviceId: DEVICE_B,
    requestId: 'request_wrong_device',
    expiresAt: now() + 30_000,
  });
  assert.equal(denied.disposition, 'REJECTED');
  assert.equal(denied.call.requestId, 'request_wrong_device');
  assert.equal(denied.call.stage, 'DEVICE_SESSION');
  assert.equal(denied.call.failureCode, 'DEVICE_NOT_FOUND_OR_FORBIDDEN');

  assert.throws(
    () => plane.beginCall({
      accountId: ACCOUNT_B,
      deviceId: DEVICE_A,
      requestId: 'request_wrong_device',
      expiresAt: now() + 30_000,
    }),
    /REQUEST_ROUTE_MISMATCH/,
  );
});
