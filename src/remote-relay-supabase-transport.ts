import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

import type { RemoteRelayFrame } from './remote-relay-protocol.js';

export type RemoteRelayConnectionClosedReason = 'CLOSED' | 'CHANNEL_ERROR' | 'TIMED_OUT';

export interface RemoteRelayConnection {
  send(frame: RemoteRelayFrame): Promise<void>;
  readonly closed: Promise<RemoteRelayConnectionClosedReason>;
  close(): Promise<void>;
}

export interface RemoteRelayTransport {
  connect(input: {
    topic: string;
    onFrame(frame: unknown): void | Promise<void>;
  }): Promise<RemoteRelayConnection>;
}

export interface SupabaseRemoteRelayTransportOptions {
  url: string;
  publishableKey: string;
  subscribeTimeoutMs?: number;
  clientFactory?: (url: string, key: string) => SupabaseClient;
}

function assertSafeSupabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Supabase Realtime URL is invalid');
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('Supabase Realtime URL must be credential-free HTTPS');
  }
  return url.href.replace(/\/$/, '');
}

function jwtRole(value: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const role = (parsed as Record<string, unknown>).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

function assertPublicSupabaseKey(value: string): string {
  if (value.length < 16 || value.length > 4096 || /\s/.test(value)) {
    throw new Error('Supabase publishable key is invalid');
  }
  if (value.startsWith('sb_secret_') || jwtRole(value) === 'service_role') {
    throw new Error('Supabase server/service-role secret is forbidden on the device');
  }
  return value;
}

function defaultClientFactory(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 20,
      },
    },
  });
}

export class SupabaseRemoteRelayTransport implements RemoteRelayTransport {
  readonly #url: string;
  readonly #publishableKey: string;
  readonly #subscribeTimeoutMs: number;
  readonly #clientFactory: (url: string, key: string) => SupabaseClient;

  constructor(options: SupabaseRemoteRelayTransportOptions) {
    this.#url = assertSafeSupabaseUrl(options.url);
    this.#publishableKey = assertPublicSupabaseKey(options.publishableKey);
    this.#subscribeTimeoutMs = options.subscribeTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.#subscribeTimeoutMs)
      || this.#subscribeTimeoutMs < 1_000
      || this.#subscribeTimeoutMs > 30_000
    ) {
      throw new Error('Supabase Realtime subscribe timeout is invalid');
    }
    this.#clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  async connect(input: {
    topic: string;
    onFrame(frame: unknown): void | Promise<void>;
  }): Promise<RemoteRelayConnection> {
    if (!/^wag:[A-Za-z0-9_-]{40,}$/.test(input.topic)) {
      throw new Error('remote relay topic is invalid');
    }
    const client = this.#clientFactory(this.#url, this.#publishableKey);
    const channel = client.channel(input.topic, {
      config: {
        private: false,
        broadcast: {
          ack: true,
          self: false,
        },
      },
    });
    channel.on('broadcast', { event: 'frame' }, (event) => {
      void Promise.resolve(input.onFrame(event.payload)).catch(() => undefined);
    });

    let resolveClosed!: (reason: RemoteRelayConnectionClosedReason) => void;
    const closed = new Promise<RemoteRelayConnectionClosedReason>((resolve) => {
      resolveClosed = resolve;
    });
    let subscribed = false;
    let settled = false;
    let resolveConnect!: () => void;
    let rejectConnect!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectConnect(new Error('Supabase Realtime subscribe timed out'));
      resolveClosed('TIMED_OUT');
    }, this.#subscribeTimeoutMs);

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        subscribed = true;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolveConnect();
        }
        return;
      }
      if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        const reason = status as RemoteRelayConnectionClosedReason;
        resolveClosed(reason);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          rejectConnect(new Error('Supabase Realtime subscribe failed: ' + reason));
        }
      }
    });

    try {
      await connected;
    } catch (error) {
      await closeSupabaseChannel(client, channel);
      throw error;
    }

    let closedByCaller = false;
    return {
      closed,
      async send(frame: RemoteRelayFrame): Promise<void> {
        if (!subscribed || closedByCaller) throw new Error('Supabase Realtime channel is not subscribed');
        const result = await channel.send({
          type: 'broadcast',
          event: 'frame',
          payload: frame,
        });
        if (result !== 'ok') throw new Error('Supabase Realtime frame send failed');
      },
      async close(): Promise<void> {
        if (closedByCaller) return;
        closedByCaller = true;
        subscribed = false;
        await closeSupabaseChannel(client, channel);
        resolveClosed('CLOSED');
      },
    };
  }
}

async function closeSupabaseChannel(client: SupabaseClient, channel: RealtimeChannel): Promise<void> {
  try {
    await client.removeChannel(channel);
  } finally {
    client.realtime.disconnect();
  }
}
