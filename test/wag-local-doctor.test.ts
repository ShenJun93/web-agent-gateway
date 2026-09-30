import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyDoctorDiagnostics,
  classifyProductUpdateDiagnostic,
  type DoctorSignals,
} from '../src/product-doctor.js';
import type { ProductUpdateCheck, ProductUpdateStatus } from '../src/product-update-discovery.js';

function healthy(): DoctorSignals {
  return {
    tunnelClientPinPresent: true,
    tunnelClientExecutable: true,
    tunnelProfilePresent: true,
    staleLauncherPid: false,
    staleDevspacePid: false,
    staleSupervisorPid: false,
    port7677Collision: false,
    port8080Collision: false,
    controlPlaneReachable: true,
    controlPlaneAuthorizationFailed: false,
    stackReady: true,
    updateConfigured: false,
  };
}

function codes(signals: DoctorSignals): string[] {
  return classifyDoctorDiagnostics(signals).map((item) => item.code);
}

test('doctor healthy state reports only update-channel informational gap', () => {
  assert.deepEqual(codes(healthy()), ['WAG_UPDATE_CHECK_UNCONFIGURED']);
});

test('doctor maps stale WAG-owned PID receipts to stable diagnostics', () => {
  const state = healthy();
  state.staleLauncherPid = true;
  state.staleDevspacePid = true;
  state.staleSupervisorPid = true;
  assert.deepEqual(codes(state), [
    'WAG_STALE_LAUNCHER_PID',
    'WAG_STALE_DEVSPACE_PID',
    'WAG_STALE_SUPERVISOR_PID',
    'WAG_UPDATE_CHECK_UNCONFIGURED',
  ]);
});

test('doctor distinguishes missing tunnel client/profile from unrelated port collisions', () => {
  const state = healthy();
  state.tunnelClientPinPresent = true;
  state.tunnelClientExecutable = false;
  state.tunnelProfilePresent = false;
  state.port7677Collision = true;
  state.port8080Collision = true;
  assert.deepEqual(codes(state), [
    'WAG_TUNNEL_CLIENT_MISSING',
    'WAG_TUNNEL_PROFILE_MISSING',
    'WAG_PORT_7677_COLLISION_UNRELATED',
    'WAG_PORT_8080_COLLISION_UNRELATED',
    'WAG_UPDATE_CHECK_UNCONFIGURED',
  ]);
});

test('doctor emits stable external network and authorization diagnostics', () => {
  const offline = healthy();
  offline.stackReady = false;
  offline.controlPlaneReachable = false;
  assert.ok(codes(offline).includes('WAG_CONTROL_PLANE_NETWORK_UNREACHABLE'));

  const expired = healthy();
  expired.stackReady = false;
  expired.controlPlaneAuthorizationFailed = true;
  assert.ok(codes(expired).includes('WAG_CONTROL_PLANE_AUTHORIZATION_FAILED'));
});

test('doctor distinguishes a missing client pin from a non-executable pinned client', () => {
  const missingPin = healthy();
  missingPin.tunnelClientPinPresent = false;
  missingPin.tunnelClientExecutable = false;
  assert.ok(codes(missingPin).includes('WAG_TUNNEL_CLIENT_PIN_MISSING'));
  assert.equal(codes(missingPin).includes('WAG_TUNNEL_CLIENT_MISSING'), false);
});

function update(status: ProductUpdateStatus): ProductUpdateCheck {
  return {
    schema: 'WAG_LOCAL_UPDATE_CHECK_V1',
    checked_at_utc: '2026-09-30T09:30:00.000Z',
    status,
    configured: status !== 'UNCONFIGURED',
    channel: 'stable',
    auto_check_updates: true,
    available: status === 'UPDATE_AVAILABLE' ? true : status === 'CURRENT' ? false : null,
    current: null,
    candidate: null,
    feed: null,
    failure_code: null,
  };
}

test('doctor maps update discovery failures to non-destructive diagnostics', () => {
  assert.deepEqual(
    classifyProductUpdateDiagnostic(update('OFFLINE')).map((item) => [item.code, item.severity]),
    [['WAG_UPDATE_FEED_UNREACHABLE', 'WARN']],
  );
  assert.deepEqual(
    classifyProductUpdateDiagnostic(update('INVALID_METADATA')).map((item) => [item.code, item.severity]),
    [['WAG_UPDATE_METADATA_INVALID', 'WARN']],
  );
  assert.deepEqual(
    classifyProductUpdateDiagnostic(update('EXPIRED')).map((item) => [item.code, item.severity]),
    [['WAG_UPDATE_METADATA_EXPIRED', 'WARN']],
  );
});

test('doctor reports available updates without treating them as a health failure', () => {
  assert.deepEqual(
    classifyProductUpdateDiagnostic(update('UPDATE_AVAILABLE')).map((item) => [item.code, item.severity]),
    [['WAG_UPDATE_AVAILABLE', 'INFO']],
  );
  assert.deepEqual(classifyProductUpdateDiagnostic(update('CURRENT')), []);
});
