import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { z } from 'zod';

export const REMOTE_RELAY_PROTOCOL_VERSION = 'wag-relay-v1';
export const REMOTE_RELAY_LOGICAL_MESSAGE_MAX_BYTES = 256 * 1024;
export const REMOTE_RELAY_SERIALIZED_FRAME_MAX_BYTES = 192 * 1024;
export const REMOTE_RELAY_FRAGMENT_PLAINTEXT_MAX_BYTES = 120 * 1024;
export const REMOTE_RELAY_MAX_FRAMES = 4;
export const REMOTE_RELAY_MAX_INFLIGHT_MESSAGES = 64;
export const REMOTE_RELAY_MAX_FRAME_TTL_MS = 120_000;

export type RemoteRelayDirection = 'relay_to_device' | 'device_to_relay';

const opaqueId = z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const hexHash = z.string().regex(/^[0-9a-f]{64}$/);

const frameSchema = z.object({
  protocol_version: z.literal(REMOTE_RELAY_PROTOCOL_VERSION),
  device_id_hash: hexHash,
  session_id: opaqueId,
  call_id: opaqueId,
  message_id: opaqueId,
  direction: z.enum(['relay_to_device', 'device_to_relay']),
  frame_index: z.number().int().min(0).max(REMOTE_RELAY_MAX_FRAMES - 1),
  frame_count: z.number().int().min(1).max(REMOTE_RELAY_MAX_FRAMES),
  expires_at: z.number().int().positive(),
  ciphertext: z.string().min(1).max(REMOTE_RELAY_SERIALIZED_FRAME_MAX_BYTES * 2).regex(/^[A-Za-z0-9_-]+$/),
}).strict().superRefine((value, context) => {
  if (value.frame_index >= value.frame_count) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['frame_index'],
      message: 'frame_index must be below frame_count',
    });
  }
});

export type RemoteRelayFrame = z.infer<typeof frameSchema>;

function secretBuffer(secret: Uint8Array): Buffer {
  const value = Buffer.from(secret);
  if (value.length < 32 || value.length > 128) {
    throw new Error('remote relay device secret must be 32..128 bytes');
  }
  return value;
}

function exactOpaqueId(value: string, label: string): string {
  if (!opaqueId.safeParse(value).success) throw new Error(`remote relay invalid ${label}`);
  return value;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function remoteRelayDeviceIdHash(secret: Uint8Array, deviceId: string): string {
  exactOpaqueId(deviceId, 'device id');
  return createHmac('sha256', secretBuffer(secret))
    .update('wag-relay-v1:device:')
    .update(deviceId, 'utf8')
    .digest('hex');
}

export function remoteRelayTopic(secret: Uint8Array, deviceId: string): string {
  const digest = createHmac('sha256', secretBuffer(secret))
    .update('wag-relay-v1:topic:')
    .update(exactOpaqueId(deviceId, 'device id'), 'utf8')
    .digest('base64url');
  return 'wag:' + digest;
}

function sessionSalt(deviceIdHash: string, sessionId: string): Buffer {
  return createHash('sha256')
    .update('wag-relay-v1:session:')
    .update(deviceIdHash)
    .update(':')
    .update(sessionId)
    .digest();
}

function directionKey(
  secret: Uint8Array,
  deviceIdHash: string,
  sessionId: string,
  direction: RemoteRelayDirection,
): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    secretBuffer(secret),
    sessionSalt(deviceIdHash, sessionId),
    Buffer.from('wag-relay-v1:key:' + direction, 'utf8'),
    32,
  ));
}

function aad(frame: Omit<RemoteRelayFrame, 'ciphertext'>): Buffer {
  return Buffer.from(JSON.stringify([
    frame.protocol_version,
    frame.device_id_hash,
    frame.session_id,
    frame.call_id,
    frame.message_id,
    frame.direction,
    frame.frame_index,
    frame.frame_count,
    frame.expires_at,
  ]), 'utf8');
}

function seal(
  key: Buffer,
  metadata: Omit<RemoteRelayFrame, 'ciphertext'>,
  plaintext: Uint8Array,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(metadata));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, encrypted]).toString('base64url');
}

function open(
  key: Buffer,
  frame: RemoteRelayFrame,
): Buffer {
  let packed: Buffer;
  try {
    packed = Buffer.from(frame.ciphertext, 'base64url');
  } catch {
    throw new Error('remote relay ciphertext encoding invalid');
  }
  if (packed.length < 28) throw new Error('remote relay ciphertext truncated');
  const nonce = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad({
      protocol_version: frame.protocol_version,
      device_id_hash: frame.device_id_hash,
      session_id: frame.session_id,
      call_id: frame.call_id,
      message_id: frame.message_id,
      direction: frame.direction,
      frame_index: frame.frame_index,
      frame_count: frame.frame_count,
      expires_at: frame.expires_at,
    }));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('remote relay frame authentication failed');
  }
}

function serializedBytes(frame: RemoteRelayFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

export interface EncodeRemoteRelayMessageInput {
  secret: Uint8Array;
  deviceId: string;
  sessionId: string;
  callId: string;
  direction: RemoteRelayDirection;
  payload: Uint8Array | string;
  expiresAt: number;
  messageId?: string;
}

export function encodeRemoteRelayMessage(
  input: EncodeRemoteRelayMessageInput,
): RemoteRelayFrame[] {
  const secret = secretBuffer(input.secret);
  const deviceIdHash = remoteRelayDeviceIdHash(secret, input.deviceId);
  const sessionId = exactOpaqueId(input.sessionId, 'session id');
  const callId = exactOpaqueId(input.callId, 'call id');
  const messageId = exactOpaqueId(input.messageId ?? ('msg_' + randomUUID()), 'message id');
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error('remote relay expiry invalid');
  }
  const payload = typeof input.payload === 'string'
    ? Buffer.from(input.payload, 'utf8')
    : Buffer.from(input.payload);
  if (payload.length > REMOTE_RELAY_LOGICAL_MESSAGE_MAX_BYTES) {
    throw new Error('remote relay logical message exceeds 256 KiB');
  }

  const frameCount = Math.max(1, Math.ceil(payload.length / REMOTE_RELAY_FRAGMENT_PLAINTEXT_MAX_BYTES));
  if (frameCount > REMOTE_RELAY_MAX_FRAMES) {
    throw new Error('remote relay message requires too many frames');
  }
  const key = directionKey(secret, deviceIdHash, sessionId, input.direction);
  const frames: RemoteRelayFrame[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const start = index * REMOTE_RELAY_FRAGMENT_PLAINTEXT_MAX_BYTES;
    const end = Math.min(payload.length, start + REMOTE_RELAY_FRAGMENT_PLAINTEXT_MAX_BYTES);
    const metadata: Omit<RemoteRelayFrame, 'ciphertext'> = {
      protocol_version: REMOTE_RELAY_PROTOCOL_VERSION,
      device_id_hash: deviceIdHash,
      session_id: sessionId,
      call_id: callId,
      message_id: messageId,
      direction: input.direction,
      frame_index: index,
      frame_count: frameCount,
      expires_at: input.expiresAt,
    };
    const frame = frameSchema.parse({
      ...metadata,
      ciphertext: seal(key, metadata, payload.subarray(start, end)),
    });
    if (serializedBytes(frame) > REMOTE_RELAY_SERIALIZED_FRAME_MAX_BYTES) {
      throw new Error('remote relay serialized frame exceeds 192 KiB');
    }
    frames.push(frame);
  }
  return frames;
}

interface PartialMessage {
  callId: string;
  direction: RemoteRelayDirection;
  frameCount: number;
  expiresAt: number;
  parts: Map<number, Buffer>;
  bytes: number;
}

export interface RemoteRelayReassemblerOptions {
  secret: Uint8Array;
  deviceId: string;
  sessionId: string;
  expectedDirection: RemoteRelayDirection;
  now?: () => number;
  maxInflight?: number;
}

export interface RemoteRelayAcceptedMessage {
  callId: string;
  messageId: string;
  expiresAt: number;
  payload: Buffer;
}

export class RemoteRelayReassembler {
  readonly #secret: Buffer;
  readonly #deviceIdHash: string;
  readonly #sessionId: string;
  readonly #expectedDirection: RemoteRelayDirection;
  readonly #now: () => number;
  readonly #maxInflight: number;
  readonly #partials = new Map<string, PartialMessage>();
  readonly #completed = new Map<string, number>();

  constructor(options: RemoteRelayReassemblerOptions) {
    this.#secret = secretBuffer(options.secret);
    this.#deviceIdHash = remoteRelayDeviceIdHash(this.#secret, options.deviceId);
    this.#sessionId = exactOpaqueId(options.sessionId, 'session id');
    this.#expectedDirection = options.expectedDirection;
    this.#now = options.now ?? Date.now;
    this.#maxInflight = options.maxInflight ?? REMOTE_RELAY_MAX_INFLIGHT_MESSAGES;
    if (!Number.isSafeInteger(this.#maxInflight) || this.#maxInflight < 1 || this.#maxInflight > 256) {
      throw new Error('remote relay max inflight invalid');
    }
  }

  accept(raw: unknown): RemoteRelayAcceptedMessage | null {
    const frame = frameSchema.parse(raw);
    if (serializedBytes(frame) > REMOTE_RELAY_SERIALIZED_FRAME_MAX_BYTES) {
      throw new Error('remote relay serialized frame exceeds 192 KiB');
    }
    const now = this.#now();
    this.#sweep(now);
    if (frame.expires_at <= now) throw new Error('remote relay frame expired');
    if (frame.expires_at > now + REMOTE_RELAY_MAX_FRAME_TTL_MS) {
      throw new Error('remote relay frame expiry exceeds bounded TTL');
    }
    if (frame.device_id_hash !== this.#deviceIdHash) throw new Error('remote relay device mismatch');
    if (frame.session_id !== this.#sessionId) throw new Error('remote relay session mismatch');
    if (frame.direction !== this.#expectedDirection) throw new Error('remote relay direction mismatch');
    if (this.#completed.has(frame.message_id)) throw new Error('remote relay replay rejected');

    let partial = this.#partials.get(frame.message_id);
    if (!partial) {
      if (this.#partials.size >= this.#maxInflight) {
        throw new Error('remote relay inflight message limit reached');
      }
      partial = {
        callId: frame.call_id,
        direction: frame.direction,
        frameCount: frame.frame_count,
        expiresAt: frame.expires_at,
        parts: new Map(),
        bytes: 0,
      };
      this.#partials.set(frame.message_id, partial);
    } else if (
      partial.callId !== frame.call_id
      || partial.direction !== frame.direction
      || partial.frameCount !== frame.frame_count
      || partial.expiresAt !== frame.expires_at
    ) {
      throw new Error('remote relay fragmented metadata mismatch');
    }
    if (partial.parts.has(frame.frame_index)) {
      throw new Error('remote relay duplicate frame rejected');
    }

    const key = directionKey(this.#secret, this.#deviceIdHash, this.#sessionId, frame.direction);
    const plaintext = open(key, frame);
    partial.bytes += plaintext.length;
    if (partial.bytes > REMOTE_RELAY_LOGICAL_MESSAGE_MAX_BYTES) {
      this.#partials.delete(frame.message_id);
      throw new Error('remote relay reassembly exceeds 256 KiB');
    }
    partial.parts.set(frame.frame_index, plaintext);
    if (partial.parts.size !== partial.frameCount) return null;

    const ordered: Buffer[] = [];
    for (let index = 0; index < partial.frameCount; index += 1) {
      const part = partial.parts.get(index);
      if (!part) throw new Error('remote relay reassembly missing frame');
      ordered.push(part);
    }
    const payload = Buffer.concat(ordered);
    this.#partials.delete(frame.message_id);
    this.#completed.set(frame.message_id, frame.expires_at);
    return {
      callId: frame.call_id,
      messageId: frame.message_id,
      expiresAt: frame.expires_at,
      payload,
    };
  }

  #sweep(now: number): void {
    for (const [id, expiry] of this.#completed) {
      if (expiry <= now) this.#completed.delete(id);
    }
    for (const [id, partial] of this.#partials) {
      if (partial.expiresAt <= now) this.#partials.delete(id);
    }
  }
}

export function remoteRelayCatalogHash(toolManifest: unknown): string {
  return sha256Hex(Buffer.from(JSON.stringify(toolManifest), 'utf8'));
}
