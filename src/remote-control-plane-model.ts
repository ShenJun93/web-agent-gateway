export type RemoteHealthLayer =
  | 'ACCOUNT_AUTH'
  | 'HOSTED_RELAY'
  | 'DEVICE_SESSION'
  | 'DEVICE_TRANSPORT'
  | 'LOCAL_EXECUTOR'
  | 'TOOL_ROUNDTRIP';

export type RemoteCallState =
  | 'ACCEPTED'
  | 'DISPATCHED'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

export interface RemoteHealthView {
  ready: boolean;
  layers: Record<RemoteHealthLayer, 'READY' | 'NOT_READY' | 'REVOKED'>;
}

export interface RemoteDeviceView {
  accountId: string;
  deviceId: string;
  clientId: string;
  keyThumbprint: string;
  label: string;
  revoked: boolean;
  revocationEpoch: number;
  sessionId: string | null;
  sessionGeneration: number;
}

export interface RemoteCallView {
  requestId: string;
  accountId: string;
  deviceId: string;
  state: RemoteCallState;
  stage: RemoteHealthLayer | 'LOCAL_EFFECT' | 'COMPLETE';
  failureCode: string | null;
  effectId: string | null;
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
}

export type BeginCallOutcome =
  | { disposition: 'ACCEPTED'; call: RemoteCallView }
  | { disposition: 'DUPLICATE'; call: RemoteCallView }
  | { disposition: 'REJECTED'; call: RemoteCallView };

interface RemoteDeviceRecord extends RemoteDeviceView {
  transportReady: boolean;
  executorReady: boolean;
  toolRoundTripReady: boolean;
}

interface RemoteCallRecord extends RemoteCallView {}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const THUMBPRINT = /^[a-f0-9]{64}$/;

function assertId(value: string, label: string): string {
  if (!ID.test(value)) throw new Error('REMOTE_' + label.toUpperCase() + '_INVALID');
  return value;
}

function copyDevice(value: RemoteDeviceRecord): RemoteDeviceView {
  const {
    transportReady: _transportReady,
    executorReady: _executorReady,
    toolRoundTripReady: _toolRoundTripReady,
    ...view
  } = value;
  return { ...view };
}

function copyCall(value: RemoteCallRecord): RemoteCallView {
  return { ...value };
}

export class RemoteControlPlanePrototype {
  readonly #accounts = new Set<string>();
  readonly #accountAuth = new Map<string, boolean>();
  readonly #devices = new Map<string, RemoteDeviceRecord>();
  readonly #usedEnrollmentGrants = new Set<string>();
  readonly #calls = new Map<string, RemoteCallRecord>();
  readonly #now: () => number;
  #hostedRelayReady = true;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  registerAccount(accountId: string): void {
    assertId(accountId, 'account_id');
    this.#accounts.add(accountId);
    this.#accountAuth.set(accountId, true);
  }

  setAccountAuth(accountId: string, ready: boolean): void {
    this.#requireAccount(accountId);
    this.#accountAuth.set(accountId, ready);
  }

  setHostedRelayReady(ready: boolean): void {
    this.#hostedRelayReady = ready;
  }

  consumeVerifiedEnrollment(input: {
    accountId: string;
    enrollmentGrantId: string;
    deviceId: string;
    clientId: string;
    keyThumbprint: string;
    label: string;
  }): RemoteDeviceView {
    this.#requireAccount(input.accountId);
    const grant = assertId(input.enrollmentGrantId, 'enrollment_grant');
    const deviceId = assertId(input.deviceId, 'device_id');
    const clientId = assertId(input.clientId, 'client_id');
    if (!THUMBPRINT.test(input.keyThumbprint)) throw new Error('REMOTE_DEVICE_KEY_INVALID');
    if (input.label.length < 1 || input.label.length > 80) throw new Error('REMOTE_DEVICE_LABEL_INVALID');
    if (this.#usedEnrollmentGrants.has(grant)) throw new Error('REMOTE_ENROLLMENT_REPLAY');
    if (this.#devices.has(deviceId)) throw new Error('REMOTE_DEVICE_ID_CONFLICT');

    this.#usedEnrollmentGrants.add(grant);
    const record: RemoteDeviceRecord = {
      accountId: input.accountId,
      deviceId,
      clientId,
      keyThumbprint: input.keyThumbprint,
      label: input.label,
      revoked: false,
      revocationEpoch: 0,
      sessionId: null,
      sessionGeneration: 0,
      transportReady: false,
      executorReady: false,
      toolRoundTripReady: false,
    };
    this.#devices.set(deviceId, record);
    return copyDevice(record);
  }

  connectDevice(input: {
    accountId: string;
    deviceId: string;
    clientId: string;
    keyThumbprint: string;
    sessionId: string;
  }): RemoteDeviceView {
    const device = this.#requireOwnedDevice(input.accountId, input.deviceId);
    if (device.revoked) throw new Error('REMOTE_DEVICE_REVOKED');
    if (device.clientId !== input.clientId || device.keyThumbprint !== input.keyThumbprint) {
      throw new Error('REMOTE_DEVICE_CREDENTIAL_MISMATCH');
    }
    device.sessionId = assertId(input.sessionId, 'session_id');
    device.sessionGeneration += 1;
    device.transportReady = true;
    device.executorReady = false;
    device.toolRoundTripReady = false;
    return copyDevice(device);
  }

  disconnectDevice(accountId: string, deviceId: string): RemoteDeviceView {
    const device = this.#requireOwnedDevice(accountId, deviceId);
    device.sessionId = null;
    device.transportReady = false;
    device.executorReady = false;
    device.toolRoundTripReady = false;
    return copyDevice(device);
  }

  setDeviceExecutionHealth(input: {
    accountId: string;
    deviceId: string;
    transportReady?: boolean;
    executorReady?: boolean;
    toolRoundTripReady?: boolean;
  }): RemoteHealthView {
    const device = this.#requireOwnedDevice(input.accountId, input.deviceId);
    if (device.revoked) return this.health(input.accountId, input.deviceId);
    if (input.transportReady !== undefined) device.transportReady = input.transportReady;
    if (input.executorReady !== undefined) device.executorReady = input.executorReady;
    if (input.toolRoundTripReady !== undefined) device.toolRoundTripReady = input.toolRoundTripReady;
    return this.health(input.accountId, input.deviceId);
  }

  health(accountId: string, deviceId: string): RemoteHealthView {
    const accountReady = this.#accounts.has(accountId) && this.#accountAuth.get(accountId) === true;
    const device = this.#devices.get(deviceId);
    const owned = device?.accountId === accountId;
    const revoked = owned && device!.revoked;
    const layers: RemoteHealthView['layers'] = {
      ACCOUNT_AUTH: accountReady ? 'READY' : 'NOT_READY',
      HOSTED_RELAY: this.#hostedRelayReady ? 'READY' : 'NOT_READY',
      DEVICE_SESSION: revoked
        ? 'REVOKED'
        : owned && device!.sessionId !== null
          ? 'READY'
          : 'NOT_READY',
      DEVICE_TRANSPORT: revoked
        ? 'REVOKED'
        : owned && device!.sessionId !== null && device!.transportReady
          ? 'READY'
          : 'NOT_READY',
      LOCAL_EXECUTOR: revoked
        ? 'REVOKED'
        : owned && device!.executorReady
          ? 'READY'
          : 'NOT_READY',
      TOOL_ROUNDTRIP: revoked
        ? 'REVOKED'
        : owned && device!.toolRoundTripReady
          ? 'READY'
          : 'NOT_READY',
    };
    return {
      ready: Object.values(layers).every((state) => state === 'READY'),
      layers,
    };
  }

  beginCall(input: {
    accountId: string;
    deviceId: string;
    requestId: string;
    expiresAt: number;
  }): BeginCallOutcome {
    assertId(input.accountId, 'account_id');
    assertId(input.deviceId, 'device_id');
    const requestId = assertId(input.requestId, 'request_id');
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.#now()) {
      throw new Error('REMOTE_CALL_EXPIRY_INVALID');
    }

    const existing = this.#calls.get(requestId);
    if (existing) {
      if (existing.accountId !== input.accountId || existing.deviceId !== input.deviceId) {
        throw new Error('REMOTE_REQUEST_ROUTE_MISMATCH');
      }
      return { disposition: 'DUPLICATE', call: copyCall(existing) };
    }

    const now = this.#now();
    const record: RemoteCallRecord = {
      requestId,
      accountId: input.accountId,
      deviceId: input.deviceId,
      state: 'ACCEPTED',
      stage: 'HOSTED_RELAY',
      failureCode: null,
      effectId: null,
      createdAt: now,
      expiresAt: input.expiresAt,
      completedAt: null,
    };

    const device = this.#devices.get(input.deviceId);
    if (!this.#accounts.has(input.accountId) || this.#accountAuth.get(input.accountId) !== true) {
      return this.#rejectNew(record, 'ACCOUNT_AUTH', 'ACCOUNT_AUTH_REQUIRED');
    }
    if (!this.#hostedRelayReady) {
      return this.#rejectNew(record, 'HOSTED_RELAY', 'HOSTED_RELAY_UNAVAILABLE');
    }
    if (!device || device.accountId !== input.accountId) {
      return this.#rejectNew(record, 'DEVICE_SESSION', 'DEVICE_NOT_FOUND_OR_FORBIDDEN');
    }
    if (device.revoked) {
      return this.#rejectNew(record, 'DEVICE_SESSION', 'DEVICE_REVOKED');
    }
    if (device.sessionId === null) {
      return this.#rejectNew(record, 'DEVICE_SESSION', 'DEVICE_OFFLINE');
    }
    if (!device.transportReady) {
      return this.#rejectNew(record, 'DEVICE_TRANSPORT', 'DEVICE_TRANSPORT_NOT_READY');
    }
    if (!device.executorReady) {
      return this.#rejectNew(record, 'LOCAL_EXECUTOR', 'LOCAL_EXECUTOR_NOT_READY');
    }
    if (!device.toolRoundTripReady) {
      return this.#rejectNew(record, 'TOOL_ROUNDTRIP', 'TOOL_ROUNDTRIP_NOT_READY');
    }

    record.stage = 'TOOL_ROUNDTRIP';
    this.#calls.set(requestId, record);
    return { disposition: 'ACCEPTED', call: copyCall(record) };
  }

  dispatchCall(input: {
    accountId: string;
    deviceId: string;
    requestId: string;
    effectId?: string;
  }): RemoteCallView {
    const call = this.#requireCall(input.requestId);
    this.#assertRoute(call, input.accountId, input.deviceId);
    if (call.state !== 'ACCEPTED') throw new Error('REMOTE_CALL_NOT_DISPATCHABLE');

    const health = this.health(input.accountId, input.deviceId);
    if (!health.ready) throw new Error('REMOTE_CALL_HEALTH_CHANGED_BEFORE_DISPATCH');

    call.state = 'DISPATCHED';
    call.stage = 'LOCAL_EFFECT';
    call.effectId = input.effectId === undefined ? null : assertId(input.effectId, 'effect_id');
    return copyCall(call);
  }

  completeCall(input: {
    accountId: string;
    deviceId: string;
    requestId: string;
    ok: boolean;
  }): RemoteCallView {
    const call = this.#requireCall(input.requestId);
    this.#assertRoute(call, input.accountId, input.deviceId);
    if (call.state !== 'DISPATCHED') throw new Error('REMOTE_CALL_NOT_COMPLETABLE');
    call.state = input.ok ? 'COMPLETED' : 'FAILED';
    call.stage = 'COMPLETE';
    call.failureCode = input.ok ? null : 'LOCAL_EFFECT_FAILED';
    call.completedAt = this.#now();
    return copyCall(call);
  }

  markUnknown(input: {
    accountId: string;
    deviceId: string;
    requestId: string;
    failureCode: string;
  }): RemoteCallView {
    const call = this.#requireCall(input.requestId);
    this.#assertRoute(call, input.accountId, input.deviceId);
    if (call.state !== 'DISPATCHED') throw new Error('REMOTE_CALL_NOT_UNKNOWNABLE');
    call.state = 'UNKNOWN';
    call.stage = 'LOCAL_EFFECT';
    call.failureCode = input.failureCode;
    call.completedAt = this.#now();
    return copyCall(call);
  }

  expireCalls(): number {
    const now = this.#now();
    let changed = 0;
    for (const call of this.#calls.values()) {
      if (call.expiresAt > now) continue;
      if (call.state === 'ACCEPTED') {
        call.state = 'EXPIRED';
        call.failureCode = 'CALL_EXPIRED_BEFORE_DISPATCH';
        call.completedAt = now;
        changed += 1;
      } else if (call.state === 'DISPATCHED') {
        call.state = 'UNKNOWN';
        call.stage = 'LOCAL_EFFECT';
        call.failureCode = 'CALL_EXPIRED_AFTER_DISPATCH';
        call.completedAt = now;
        changed += 1;
      }
    }
    return changed;
  }

  revokeDevice(accountId: string, deviceId: string): RemoteDeviceView {
    const device = this.#requireOwnedDevice(accountId, deviceId);
    if (device.revoked) return copyDevice(device);
    device.revoked = true;
    device.revocationEpoch += 1;
    device.sessionId = null;
    device.transportReady = false;
    device.executorReady = false;
    device.toolRoundTripReady = false;

    const now = this.#now();
    for (const call of this.#calls.values()) {
      if (call.accountId !== accountId || call.deviceId !== deviceId) continue;
      if (call.state === 'ACCEPTED') {
        call.state = 'REJECTED';
        call.stage = 'DEVICE_SESSION';
        call.failureCode = 'DEVICE_REVOKED';
        call.completedAt = now;
      } else if (call.state === 'DISPATCHED') {
        call.state = 'UNKNOWN';
        call.stage = 'LOCAL_EFFECT';
        call.failureCode = 'DEVICE_REVOKED_MID_CALL';
        call.completedAt = now;
      }
    }
    return copyDevice(device);
  }

  call(requestId: string): RemoteCallView | null {
    const call = this.#calls.get(requestId);
    return call ? copyCall(call) : null;
  }

  device(accountId: string, deviceId: string): RemoteDeviceView {
    return copyDevice(this.#requireOwnedDevice(accountId, deviceId));
  }

  #rejectNew(
    record: RemoteCallRecord,
    stage: RemoteHealthLayer,
    failureCode: string,
  ): BeginCallOutcome {
    record.state = 'REJECTED';
    record.stage = stage;
    record.failureCode = failureCode;
    record.completedAt = this.#now();
    this.#calls.set(record.requestId, record);
    return { disposition: 'REJECTED', call: copyCall(record) };
  }

  #requireAccount(accountId: string): void {
    assertId(accountId, 'account_id');
    if (!this.#accounts.has(accountId)) throw new Error('REMOTE_ACCOUNT_NOT_FOUND');
  }

  #requireOwnedDevice(accountId: string, deviceId: string): RemoteDeviceRecord {
    this.#requireAccount(accountId);
    assertId(deviceId, 'device_id');
    const device = this.#devices.get(deviceId);
    if (!device || device.accountId !== accountId) {
      throw new Error('REMOTE_DEVICE_NOT_FOUND_OR_FORBIDDEN');
    }
    return device;
  }

  #requireCall(requestId: string): RemoteCallRecord {
    assertId(requestId, 'request_id');
    const call = this.#calls.get(requestId);
    if (!call) throw new Error('REMOTE_CALL_NOT_FOUND');
    return call;
  }

  #assertRoute(call: RemoteCallRecord, accountId: string, deviceId: string): void {
    if (call.accountId !== accountId || call.deviceId !== deviceId) {
      throw new Error('REMOTE_REQUEST_ROUTE_MISMATCH');
    }
  }
}
