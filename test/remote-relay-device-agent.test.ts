import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteRelayDeviceAgent,
  remoteRelayReconnectDelayMs,
  type RemoteRelayDeviceAgentMetadata,
} from '../src/remote-relay-device-agent.js';
import type { RemoteRelayToolExecutionPort } from '../src/remote-relay-device-session.js';
import type {
  RemoteRelayConnection,
  RemoteRelayConnectionClosedReason,
  RemoteRelayTransport,
} from '../src/remote-relay-supabase-transport.js';
import type { RemoteRelayFrame } from '../src/remote-relay-protocol.js';

class FakeConnection implements RemoteRelayConnection {
  readonly sent: RemoteRelayFrame[] = [];
  readonly closed: Promise<RemoteRelayConnectionClosedReason>;
  #resolve!: (reason: RemoteRelayConnectionClosedReason) => void;
  closeCalls = 0;

  constructor() {
    this.closed = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  async send(frame: RemoteRelayFrame): Promise<void> {
    this.sent.push(frame);
  }

  finish(reason: RemoteRelayConnectionClosedReason): void {
    this.#resolve(reason);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeTransport implements RemoteRelayTransport {
  readonly connections: FakeConnection[] = [];
  readonly topics: string[] = [];

  async connect(input: {
    topic: string;
    onFrame(frame: unknown): void | Promise<void>;
  }): Promise<RemoteRelayConnection> {
    this.topics.push(input.topic);
    const connection = new FakeConnection();
    this.connections.push(connection);
    return connection;
  }
}

const executor: RemoteRelayToolExecutionPort = {
  async callTool() {
    return { ok: true, structuredContent: { status: 'ok' } };
  },
};

async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}

test('full-jitter reconnect delay follows 1,2,4,8,16,32,60 second ceilings and stays capped', () => {
  assert.deepEqual(
    Array.from({ length: 9 }, (_, attempt) => remoteRelayReconnectDelayMs(attempt, () => 0.5)),
    [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
  );
  assert.equal(remoteRelayReconnectDelayMs(0, () => 0), 0);
  assert.equal(remoteRelayReconnectDelayMs(6, () => 0.999), 59_940);
  assert.throws(() => remoteRelayReconnectDelayMs(-1), /attempt/);
  assert.throws(() => remoteRelayReconnectDelayMs(0, () => 1), /jitter/);
});

test('device agent creates a new cryptographic session after channel loss and never reuses the old session', async () => {
  const transport = new FakeTransport();
  const metadata: RemoteRelayDeviceAgentMetadata[] = [];
  const delays: number[] = [];
  const controller = new AbortController();
  const agent = new RemoteRelayDeviceAgent({
    secret: Buffer.alloc(32, 9),
    deviceId: 'device_agent',
    agentVersion: '1.0.0',
    toolManifest: [{ name: 'health' }],
    executor,
    transport,
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms);
    },
    onMetadata: (event) => metadata.push(event),
  });

  const running = agent.run(controller.signal);
  await eventually(() => transport.connections.length === 1 && metadata.some((event) => event.state === 'CONNECTED'));

  transport.connections[0]!.finish('CHANNEL_ERROR');
  await eventually(() => transport.connections.length === 2 && metadata.filter((event) => event.state === 'CONNECTED').length === 2);

  const connected = metadata.filter((event) => event.state === 'CONNECTED');
  assert.equal(connected.length, 2);
  assert.notEqual(connected[0]!.sessionId, connected[1]!.sessionId);
  assert.deepEqual(delays, [500]);
  assert.equal(transport.topics[0], transport.topics[1], 'topic stays device-bound while session id rotates');
  assert.ok(transport.connections[0]!.sent.length > 0, 'first session announces after subscribe');
  assert.ok(transport.connections[1]!.sent.length > 0, 'replacement session announces after reconnect');

  controller.abort();
  await running;
  assert.ok(transport.connections[1]!.closeCalls >= 1);
});
