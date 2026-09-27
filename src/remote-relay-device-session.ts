import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  REMOTE_RELAY_PROTOCOL_VERSION,
  RemoteRelayReassembler,
  encodeRemoteRelayMessage,
  remoteRelayCatalogHash,
  type RemoteRelayFrame,
} from './remote-relay-protocol.js';

const RESPONSE_TTL_MS = 30_000;
const MAX_TRACKED_CALLS = 4096;

const toolCallSchema = z.object({
  kind: z.literal('tool.call'),
  tool: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  arguments: z.unknown(),
}).strict();

export interface RemoteRelayToolExecutionPort {
  callTool(input: {
    tool: string;
    arguments: unknown;
  }): Promise<{
    ok: boolean;
    structuredContent?: unknown;
  }>;
}

export type RemoteRelaySendFrame = (frame: RemoteRelayFrame) => Promise<void>;

export interface RemoteRelayDeviceSessionOptions {
  secret: Uint8Array;
  deviceId: string;
  sessionId?: string;
  agentVersion: string;
  toolManifest: unknown;
  executor: RemoteRelayToolExecutionPort;
  sendFrame: RemoteRelaySendFrame;
  now?: () => number;
}

export type RemoteRelayDeviceReceiveOutcome =
  | { state: 'PARTIAL' }
  | { state: 'INVALID_REQUEST'; callId: string }
  | { state: 'DUPLICATE_CALL'; callId: string }
  | { state: 'EXECUTED'; callId: string; resultSent: boolean };

export class RemoteRelayDeviceSession {
  readonly sessionId: string;
  readonly catalogHash: string;
  readonly #secret: Buffer;
  readonly #deviceId: string;
  readonly #agentVersion: string;
  readonly #executor: RemoteRelayToolExecutionPort;
  readonly #sendFrame: RemoteRelaySendFrame;
  readonly #now: () => number;
  readonly #reassembler: RemoteRelayReassembler;
  readonly #seenCalls = new Map<string, number>();

  constructor(options: RemoteRelayDeviceSessionOptions) {
    this.#secret = Buffer.from(options.secret);
    this.#deviceId = options.deviceId;
    this.sessionId = options.sessionId ?? ('session_' + randomUUID());
    this.#agentVersion = options.agentVersion;
    this.catalogHash = remoteRelayCatalogHash(options.toolManifest);
    this.#executor = options.executor;
    this.#sendFrame = options.sendFrame;
    this.#now = options.now ?? Date.now;
    this.#reassembler = new RemoteRelayReassembler({
      secret: this.#secret,
      deviceId: this.#deviceId,
      sessionId: this.sessionId,
      expectedDirection: 'relay_to_device',
      now: this.#now,
    });
  }

  async announce(): Promise<void> {
    await this.#sendJson('session_hello', {
      kind: 'device.hello',
      protocol_version: REMOTE_RELAY_PROTOCOL_VERSION,
      agent_version: this.#agentVersion,
      catalog_hash: this.catalogHash,
      session_id: this.sessionId,
    });
  }

  async receive(frame: unknown): Promise<RemoteRelayDeviceReceiveOutcome> {
    const message = this.#reassembler.accept(frame);
    if (!message) return { state: 'PARTIAL' };
    this.#sweepSeenCalls();
    const callId = message.callId;

    if (this.#seenCalls.has(callId)) {
      await this.#sendBoundedError(callId, 'DUPLICATE_CALL_NOT_REEXECUTED');
      return { state: 'DUPLICATE_CALL', callId };
    }

    let request: z.infer<typeof toolCallSchema>;
    try {
      request = toolCallSchema.parse(JSON.parse(message.payload.toString('utf8')));
    } catch {
      await this.#sendBoundedError(callId, 'INVALID_REQUEST');
      return { state: 'INVALID_REQUEST', callId };
    }

    if (this.#seenCalls.size >= MAX_TRACKED_CALLS) {
      await this.#sendBoundedError(callId, 'SESSION_CALL_LIMIT');
      return { state: 'INVALID_REQUEST', callId };
    }

    // Claim the call before invoking WAG. A transport failure after this point can never cause
    // this session to execute the same opaque call_id again.
    this.#seenCalls.set(callId, message.expiresAt);

    let result: Awaited<ReturnType<RemoteRelayToolExecutionPort['callTool']>>;
    try {
      result = await this.#executor.callTool({
        tool: request.tool,
        arguments: request.arguments,
      });
    } catch {
      result = { ok: false };
    }

    let resultSent = false;
    try {
      await this.#sendJson(callId, result.ok
        ? {
          kind: 'tool.result',
          ok: true,
          structuredContent: result.structuredContent ?? null,
        }
        : {
          kind: 'tool.result',
          ok: false,
          error_class: 'TOOL_ERROR',
        });
      resultSent = true;
    } catch (error) {
      // Never retry after dispatch. A failed response send leaves the relay with an uncertain
      // outcome; recovery must use WAG durable result state or an explicit new call.
      if (error instanceof Error && /logical message exceeds|serialized frame exceeds/.test(error.message)) {
        try {
          await this.#sendBoundedError(callId, 'RESULT_BOUND_REQUIRED');
          resultSent = true;
        } catch {
          resultSent = false;
        }
      }
    }
    return { state: 'EXECUTED', callId, resultSent };
  }

  #sweepSeenCalls(): void {
    const now = this.#now();
    for (const [callId, expiry] of this.#seenCalls) {
      if (expiry <= now) this.#seenCalls.delete(callId);
    }
  }

  async #sendBoundedError(callId: string, errorClass: string): Promise<void> {
    await this.#sendJson(callId, {
      kind: 'tool.result',
      ok: false,
      error_class: errorClass,
    });
  }

  async #sendJson(callId: string, value: unknown): Promise<void> {
    const frames = encodeRemoteRelayMessage({
      secret: this.#secret,
      deviceId: this.#deviceId,
      sessionId: this.sessionId,
      callId,
      direction: 'device_to_relay',
      payload: JSON.stringify(value),
      expiresAt: this.#now() + RESPONSE_TTL_MS,
    });
    for (const frame of frames) {
      await this.#sendFrame(frame);
    }
  }
}
