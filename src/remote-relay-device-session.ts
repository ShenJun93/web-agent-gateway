import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  InMemoryRemoteRelayCallStore,
  type RemoteRelayCallStore,
} from './remote-relay-call-store.js';
import {
  REMOTE_RELAY_LOGICAL_MESSAGE_MAX_BYTES,
  REMOTE_RELAY_PROTOCOL_VERSION,
  RemoteRelayReassembler,
  encodeRemoteRelayMessage,
  remoteRelayCatalogHash,
  type RemoteRelayFrame,
} from './remote-relay-protocol.js';

const RESPONSE_TTL_MS = 30_000;
const CALL_RESULT_RETENTION_MS = 24 * 60 * 60_000;

const toolCallSchema = z.object({
  kind: z.literal('tool.call'),
  tool: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  arguments: z.unknown(),
}).strict();

const callGetSchema = z.object({
  kind: z.literal('relay.call.get'),
  target_call_id: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

const sessionProbeSchema = z.object({
  kind: z.literal('relay.session.probe'),
}).strict();

export interface RemoteRelayToolExecutionPort {
  callTool(input: {
    tool: string;
    arguments: unknown;
  }): Promise<{
    ok: boolean;
    /** Full bounded MCP CallToolResult, including native image/text content when present. */
    result?: unknown;
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
  callStore?: RemoteRelayCallStore;
  now?: () => number;
}

export type RemoteRelayDeviceReceiveOutcome =
  | { state: 'PARTIAL' }
  | { state: 'INVALID_REQUEST'; callId: string }
  | { state: 'DUPLICATE_CALL'; callId: string }
  | { state: 'RECOVERED_CALL'; callId: string }
  | { state: 'SESSION_PROBED'; callId: string }
  | { state: 'EXECUTED'; callId: string; resultSent: boolean };

export class RemoteRelayDeviceSession {
  readonly sessionId: string;
  readonly catalogHash: string;
  readonly #secret: Buffer;
  readonly #deviceId: string;
  readonly #agentVersion: string;
  readonly #executor: RemoteRelayToolExecutionPort;
  readonly #sendFrame: RemoteRelaySendFrame;
  readonly #callStore: RemoteRelayCallStore;
  readonly #now: () => number;
  readonly #reassembler: RemoteRelayReassembler;

  constructor(options: RemoteRelayDeviceSessionOptions) {
    this.#secret = Buffer.from(options.secret);
    this.#deviceId = options.deviceId;
    this.sessionId = options.sessionId ?? ('session_' + randomUUID());
    this.#agentVersion = options.agentVersion;
    this.catalogHash = remoteRelayCatalogHash(options.toolManifest);
    this.#executor = options.executor;
    this.#sendFrame = options.sendFrame;
    this.#callStore = options.callStore ?? new InMemoryRemoteRelayCallStore();
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
    await this.#sendHello('session_hello');
  }

  async receive(frame: unknown): Promise<RemoteRelayDeviceReceiveOutcome> {
    const message = this.#reassembler.accept(frame);
    if (!message) return { state: 'PARTIAL' };
    const callId = message.callId;

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.payload.toString('utf8'));
    } catch {
      await this.#sendBoundedError(callId, 'INVALID_REQUEST');
      return { state: 'INVALID_REQUEST', callId };
    }

    const probe = sessionProbeSchema.safeParse(parsed);
    if (probe.success) {
      await this.#sendHello(callId);
      return { state: 'SESSION_PROBED', callId };
    }

    const poll = callGetSchema.safeParse(parsed);
    if (poll.success) {
      return this.#recoverCall(callId, poll.data.target_call_id);
    }

    const request = toolCallSchema.safeParse(parsed);
    if (!request.success) {
      await this.#sendBoundedError(callId, 'INVALID_REQUEST');
      return { state: 'INVALID_REQUEST', callId };
    }

    const claim = this.#callStore.claim(callId, this.#now() + CALL_RESULT_RETENTION_MS);
    if (!claim.claimed) {
      if (
        (claim.record.state === 'COMPLETED' || claim.record.state === 'FAILED')
        && claim.record.result
      ) {
        await this.#sendPayload(callId, claim.record.result);
      } else {
        await this.#sendBoundedError(
          callId,
          claim.record.state === 'UNKNOWN'
            ? 'CALL_STATE_UNKNOWN'
            : 'DUPLICATE_CALL_NOT_REEXECUTED',
        );
      }
      return { state: 'DUPLICATE_CALL', callId };
    }

    let result: Awaited<ReturnType<RemoteRelayToolExecutionPort['callTool']>>;
    try {
      result = await this.#executor.callTool({
        tool: request.data.tool,
        arguments: request.data.arguments,
      });
    } catch {
      result = { ok: false };
    }

    let payload = Buffer.from(JSON.stringify(result.ok
      ? {
        kind: 'tool.result',
        ok: true,
        result: result.result ?? null,
      }
      : {
        kind: 'tool.result',
        ok: false,
        error_class: 'TOOL_ERROR',
      }), 'utf8');

    if (payload.length > REMOTE_RELAY_LOGICAL_MESSAGE_MAX_BYTES) {
      payload = Buffer.from(JSON.stringify({
        kind: 'tool.result',
        ok: false,
        error_class: 'RESULT_BOUND_REQUIRED',
      }), 'utf8');
      this.#callStore.complete(callId, 'FAILED', payload);
    } else {
      this.#callStore.complete(callId, result.ok ? 'COMPLETED' : 'FAILED', payload);
    }

    let resultSent = false;
    try {
      await this.#sendPayload(callId, payload);
      resultSent = true;
    } catch {
      // The encrypted result is already durable locally. Never execute the tool again merely
      // because transport delivery is uncertain; relay.call.get recovers by opaque call_id.
      resultSent = false;
    }
    return { state: 'EXECUTED', callId, resultSent };
  }

  async #recoverCall(
    pollCallId: string,
    targetCallId: string,
  ): Promise<RemoteRelayDeviceReceiveOutcome> {
    const stored = this.#callStore.get(targetCallId);
    if (!stored) {
      await this.#sendJson(pollCallId, {
        kind: 'relay.call.state',
        target_call_id: targetCallId,
        state: 'NOT_FOUND',
      });
      return { state: 'RECOVERED_CALL', callId: pollCallId };
    }
    if ((stored.state === 'COMPLETED' || stored.state === 'FAILED') && stored.result) {
      await this.#sendPayload(pollCallId, stored.result);
      return { state: 'RECOVERED_CALL', callId: pollCallId };
    }
    await this.#sendJson(pollCallId, {
      kind: 'relay.call.state',
      target_call_id: targetCallId,
      state: stored.state === 'UNKNOWN' ? 'UNKNOWN' : 'RUNNING',
    });
    return { state: 'RECOVERED_CALL', callId: pollCallId };
  }

  async #sendHello(callId: string): Promise<void> {
    await this.#sendJson(callId, {
      kind: 'device.hello',
      protocol_version: REMOTE_RELAY_PROTOCOL_VERSION,
      agent_version: this.#agentVersion,
      catalog_hash: this.catalogHash,
      session_id: this.sessionId,
    });
  }

  async #sendBoundedError(callId: string, errorClass: string): Promise<void> {
    await this.#sendJson(callId, {
      kind: 'tool.result',
      ok: false,
      error_class: errorClass,
    });
  }

  async #sendJson(callId: string, value: unknown): Promise<void> {
    await this.#sendPayload(callId, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  async #sendPayload(callId: string, payload: Uint8Array): Promise<void> {
    const frames = encodeRemoteRelayMessage({
      secret: this.#secret,
      deviceId: this.#deviceId,
      sessionId: this.sessionId,
      callId,
      direction: 'device_to_relay',
      payload,
      expiresAt: this.#now() + RESPONSE_TTL_MS,
    });
    for (const frame of frames) {
      await this.#sendFrame(frame);
    }
  }
}
