import {
  RemoteRelayDeviceSession,
  type RemoteRelayToolExecutionPort,
} from './remote-relay-device-session.js';
import { remoteRelayTopic } from './remote-relay-protocol.js';
import type { RemoteRelayCallStore } from './remote-relay-call-store.js';
import type {
  RemoteRelayConnection,
  RemoteRelayTransport,
} from './remote-relay-supabase-transport.js';

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;
const STABLE_CONNECTION_MS = 60_000;

export function remoteRelayReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error('remote relay reconnect attempt is invalid');
  }
  const ceiling = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error('remote relay jitter source is invalid');
  }
  return Math.floor(ceiling * sample);
}

export interface RemoteRelayDeviceAgentMetadata {
  state: 'CONNECTED' | 'DISCONNECTED' | 'CONNECT_FAILED';
  sessionId: string;
  errorClass?: 'CHANNEL_CLOSED' | 'CONNECT_FAILED';
}

export interface RemoteRelayDeviceAgentOptions {
  secret: Uint8Array;
  deviceId: string;
  agentVersion: string;
  toolManifest: unknown;
  executor: RemoteRelayToolExecutionPort;
  transport: RemoteRelayTransport;
  callStore?: RemoteRelayCallStore;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onMetadata?: (event: RemoteRelayDeviceAgentMetadata) => void;
}

export class RemoteRelayDeviceAgent {
  readonly #secret: Buffer;
  readonly #deviceId: string;
  readonly #agentVersion: string;
  readonly #toolManifest: unknown;
  readonly #executor: RemoteRelayToolExecutionPort;
  readonly #transport: RemoteRelayTransport;
  readonly #callStore: RemoteRelayCallStore | undefined;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #onMetadata: (event: RemoteRelayDeviceAgentMetadata) => void;

  constructor(options: RemoteRelayDeviceAgentOptions) {
    this.#secret = Buffer.from(options.secret);
    this.#deviceId = options.deviceId;
    this.#agentVersion = options.agentVersion;
    this.#toolManifest = options.toolManifest;
    this.#executor = options.executor;
    this.#transport = options.transport;
    this.#callStore = options.callStore;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? sleepWithAbort;
    this.#onMetadata = options.onMetadata ?? (() => undefined);
  }

  async run(signal: AbortSignal): Promise<void> {
    const topic = remoteRelayTopic(this.#secret, this.#deviceId);
    let attempt = 0;

    while (!signal.aborted) {
      let connection: RemoteRelayConnection | null = null;
      let connectedAt = 0;
      let receiveFrame: ((frame: unknown) => void) | null = null;
      const pendingFrames: unknown[] = [];
      const session = new RemoteRelayDeviceSession({
        secret: this.#secret,
        deviceId: this.#deviceId,
        agentVersion: this.#agentVersion,
        toolManifest: this.#toolManifest,
        executor: this.#executor,
        ...(this.#callStore === undefined ? {} : { callStore: this.#callStore }),
        now: this.#now,
        sendFrame: async (frame) => {
          if (!connection) throw new Error('remote relay transport not connected');
          await connection.send(frame);
        },
      });

      try {
        connection = await this.#transport.connect({
          topic,
          onFrame: (frame) => {
            if (receiveFrame) {
              receiveFrame(frame);
            } else {
              pendingFrames.push(frame);
            }
          },
        });
        connectedAt = this.#now();
        receiveFrame = (frame) => {
          void session.receive(frame).catch(() => undefined);
        };
        for (const frame of pendingFrames.splice(0)) receiveFrame(frame);
        await session.announce();
        this.#onMetadata({
          state: 'CONNECTED',
          sessionId: session.sessionId,
        });

        await Promise.race([
          connection.closed,
          waitForAbort(signal),
        ]);
        if (signal.aborted) break;
        this.#onMetadata({
          state: 'DISCONNECTED',
          sessionId: session.sessionId,
          errorClass: 'CHANNEL_CLOSED',
        });
        if (this.#now() - connectedAt >= STABLE_CONNECTION_MS) {
          attempt = 0;
        } else {
          attempt += 1;
        }
      } catch {
        if (signal.aborted) break;
        this.#onMetadata({
          state: 'CONNECT_FAILED',
          sessionId: session.sessionId,
          errorClass: 'CONNECT_FAILED',
        });
        attempt += 1;
      } finally {
        receiveFrame = null;
        pendingFrames.length = 0;
        await connection?.close().catch(() => undefined);
      }

      if (signal.aborted) break;
      const delay = remoteRelayReconnectDelayMs(Math.max(0, attempt - 1), this.#random);
      await this.#sleep(delay, signal).catch(() => undefined);
    }
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
