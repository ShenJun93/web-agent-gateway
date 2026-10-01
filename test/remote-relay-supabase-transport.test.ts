import assert from 'node:assert/strict';
import test from 'node:test';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import {
  SupabaseRemoteRelayTransport,
} from '../src/remote-relay-supabase-transport.js';
import {
  encodeRemoteRelayMessage,
  remoteRelayTopic,
  type RemoteRelayFrame,
} from '../src/remote-relay-protocol.js';

function fakeJwt(role: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256' }), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ role }), 'utf8').toString('base64url'),
    'signature',
  ].join('.');
}

test('Supabase device transport rejects credential-bearing URLs and server/service-role secrets', () => {
  assert.throws(() => new SupabaseRemoteRelayTransport({
    url: 'http://project.supabase.co',
    publishableKey: 'sb_publishable_' + 'a'.repeat(32),
  }), /credential-free HTTPS/);
  assert.throws(() => new SupabaseRemoteRelayTransport({
    url: 'https://user:pass@project.supabase.co',
    publishableKey: 'sb_publishable_' + 'a'.repeat(32),
  }), /credential-free HTTPS/);
  assert.throws(() => new SupabaseRemoteRelayTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_secret_' + 'a'.repeat(32),
  }), /server\/service-role secret/);
  assert.throws(() => new SupabaseRemoteRelayTransport({
    url: 'https://project.supabase.co',
    publishableKey: fakeJwt('service_role'),
  }), /server\/service-role secret/);
});

test('Supabase adapter subscribes public Broadcast, sends only frame events, and closes the client', async () => {
  const sent: unknown[] = [];
  let broadcastCallback: ((event: { payload: unknown }) => void) | null = null;
  let subscribeCallback: ((status: string) => void) | null = null;
  let disconnectCalls = 0;
  let removeCalls = 0;
  const tracked: unknown[] = [];
  let untrackCalls = 0;

  const channel = {
    on(type: string, filter: { event: string }, callback: (event: { payload: unknown }) => void) {
      assert.equal(type, 'broadcast');
      assert.deepEqual(filter, { event: 'frame' });
      broadcastCallback = callback;
      return this;
    },
    subscribe(callback: (status: string) => void) {
      subscribeCallback = callback;
      queueMicrotask(() => callback('SUBSCRIBED'));
      return this;
    },
    async send(value: unknown) {
      sent.push(value);
      return 'ok';
    },
    async track(value: unknown) {
      tracked.push(value);
      return 'ok';
    },
    async untrack() {
      untrackCalls += 1;
      return 'ok';
    },
  } as unknown as RealtimeChannel;

  const client = {
    channel(topic: string, options: unknown) {
      assert.match(topic, /^wag:/);
      assert.deepEqual(options, {
        config: {
          private: false,
          broadcast: { ack: true, self: false },
          presence: { key: 'f'.repeat(64) },
        },
      });
      return channel;
    },
    async removeChannel(value: RealtimeChannel) {
      assert.equal(value, channel);
      removeCalls += 1;
      return 'ok';
    },
    realtime: {
      disconnect() {
        disconnectCalls += 1;
      },
    },
  } as unknown as SupabaseClient;

  const received: unknown[] = [];
  const transport = new SupabaseRemoteRelayTransport({
    url: 'https://project.supabase.co/',
    publishableKey: 'sb_publishable_' + 'a'.repeat(32),
    clientFactory: () => client,
  });
  const topic = remoteRelayTopic(Buffer.alloc(32, 4), 'device_transport');
  const presence = {
    kind: 'device.session' as const,
    protocol_version: 'wag-relay-v1' as const,
    device_id_hash: 'f'.repeat(64),
    session_id: 'session_transport',
    agent_version: '1.0.0',
    catalog_hash: 'e'.repeat(64),
    connected_at: Date.now(),
  };
  const connection = await transport.connect({
    topic,
    presence,
    onFrame(frame) {
      received.push(frame);
    },
  });
  assert.deepEqual(tracked, [presence]);

  assert.ok(subscribeCallback, 'channel subscription callback is installed');
  const [frame] = encodeRemoteRelayMessage({
    secret: Buffer.alloc(32, 4),
    deviceId: 'device_transport',
    sessionId: 'session_transport',
    callId: 'call_transport',
    direction: 'device_to_relay',
    payload: 'payload',
    expiresAt: Date.now() + 30_000,
    messageId: 'message_transport',
  });
  assert.ok(frame);
  await connection.send(frame);
  assert.deepEqual(sent, [{
    type: 'broadcast',
    event: 'frame',
    payload: frame,
  }]);

  assert.ok(broadcastCallback);
  (broadcastCallback as (event: { payload: RemoteRelayFrame }) => void)({ payload: frame });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [frame]);

  await connection.close();
  assert.equal(untrackCalls, 1);
  assert.equal(removeCalls, 1);
  assert.equal(disconnectCalls, 1);
  assert.equal(await connection.closed, 'CLOSED');
});
