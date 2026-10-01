import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';

export type AudioCaptureKind = 'process' | 'system' | 'microphone';
export type AudioEncoding = 'pcm_s16le' | 'pcm_f32le';
export type AudioCaptureState = 'ACTIVE' | 'STOPPING' | 'STOPPED' | 'FAILED';

export interface AudioFormat {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly encoding: AudioEncoding;
}

export interface AudioProcessTarget {
  readonly kind: 'process';
  readonly targetId: string;
  readonly pid: number;
  readonly processInstanceId: string;
  readonly executablePath: string;
  readonly includeChildProcesses: boolean;
}

export interface AudioSystemTarget {
  readonly kind: 'system';
  readonly targetId: string;
  readonly endpointId: string;
}

export interface AudioMicrophoneTarget {
  readonly kind: 'microphone';
  readonly targetId: string;
  readonly deviceId: string;
}

export type AudioCaptureTarget = AudioProcessTarget | AudioSystemTarget | AudioMicrophoneTarget;

export interface AudioTargetResolver {
  resolve(owner: GatewayAuthority, targetId: string): Promise<AudioCaptureTarget>;
}

export interface AudioBackendChunk {
  readonly bytes: Uint8Array;
  readonly sequence: number;
  readonly capturedAt: number;
  readonly eof?: boolean;
}

export interface AudioBackendSession {
  read(maxBytes: number, timeoutMs: number): Promise<AudioBackendChunk>;
  stop(): Promise<void>;
}

export interface AudioCaptureBackend {
  open(target: AudioCaptureTarget, format: AudioFormat): Promise<AudioBackendSession>;
}

export interface AudioCaptureHandle {
  readonly audioSessionId: string;
  readonly owner: GatewayAuthority;
  readonly target: AudioCaptureTarget;
  readonly format: AudioFormat;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly state: AudioCaptureState;
}

export interface AudioChunk {
  readonly audioSessionId: string;
  readonly bytes: Uint8Array;
  readonly sequence: number;
  readonly capturedAt: number;
  readonly eof: boolean;
}

export interface AudioPort {
  open(
    owner: GatewayAuthority,
    targetId: string,
    format: AudioFormat,
  ): Promise<AudioCaptureHandle>;
  describe(owner: GatewayAuthority, audioSessionId: string): Promise<AudioCaptureHandle>;
  read(
    owner: GatewayAuthority,
    audioSessionId: string,
    options?: { readonly maxBytes?: number; readonly timeoutMs?: number },
  ): Promise<AudioChunk>;
  stop(owner: GatewayAuthority, audioSessionId: string): Promise<AudioCaptureHandle>;
}

interface LiveAudioSession {
  handle: AudioCaptureHandle;
  backend: AudioBackendSession;
  lastSequence: number;
}

const TARGET_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SESSION_ID = /^audio_[0-9a-f-]{36}$/;
const OPAQUE = /^[^\u0000-\u001F]{1,1024}$/;
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_READ_BYTES = 256 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const MAX_READ_TIMEOUT_MS = 30_000;

function validateFormat(format: AudioFormat): void {
  if (!Number.isInteger(format.sampleRateHz)
      || format.sampleRateHz < 8_000
      || format.sampleRateHz > 192_000) {
    throw new Error('Audio sample rate is invalid');
  }
  if (!Number.isInteger(format.channels) || format.channels < 1 || format.channels > 8) {
    throw new Error('Audio channel count is invalid');
  }
  if (format.encoding !== 'pcm_s16le' && format.encoding !== 'pcm_f32le') {
    throw new Error('Audio encoding is invalid');
  }
}

function validateTarget(target: AudioCaptureTarget): void {
  if (!TARGET_ID.test(target.targetId)) throw new Error('Audio target id is invalid');

  if (target.kind === 'process') {
    if (!Number.isInteger(target.pid) || target.pid <= 0) {
      throw new Error('Audio process target pid is invalid');
    }
    if (!OPAQUE.test(target.processInstanceId)) {
      throw new Error('Audio process instance id is invalid');
    }
    if (!isAbsolute(target.executablePath)
        || target.executablePath.includes('\0')
        || Buffer.byteLength(target.executablePath, 'utf8') > 4096) {
      throw new Error('Audio process executable path is invalid');
    }
    if (typeof target.includeChildProcesses !== 'boolean') {
      throw new Error('Audio process child-process mode is invalid');
    }
    return;
  }

  if (target.kind === 'system') {
    if (!OPAQUE.test(target.endpointId)) throw new Error('Audio system endpoint id is invalid');
    return;
  }

  if (!OPAQUE.test(target.deviceId)) throw new Error('Audio microphone device id is invalid');
}

function sameTarget(a: AudioCaptureTarget, b: AudioCaptureTarget): boolean {
  if (a.kind !== b.kind || a.targetId !== b.targetId) return false;

  if (a.kind === 'process' && b.kind === 'process') {
    const executableMatches = process.platform === 'win32'
      ? a.executablePath.toLowerCase() === b.executablePath.toLowerCase()
      : a.executablePath === b.executablePath;
    return a.pid === b.pid
      && a.processInstanceId === b.processInstanceId
      && executableMatches
      && a.includeChildProcesses === b.includeChildProcesses;
  }

  if (a.kind === 'system' && b.kind === 'system') {
    return a.endpointId === b.endpointId;
  }

  return a.kind === 'microphone'
    && b.kind === 'microphone'
    && a.deviceId === b.deviceId;
}

function cloneTarget(target: AudioCaptureTarget): AudioCaptureTarget {
  return Object.freeze({ ...target });
}

function cloneFormat(format: AudioFormat): AudioFormat {
  return Object.freeze({ ...format });
}

function cloneHandle(handle: AudioCaptureHandle): AudioCaptureHandle {
  return Object.freeze({
    ...handle,
    owner: Object.freeze({ ...handle.owner }),
    target: cloneTarget(handle.target),
    format: cloneFormat(handle.format),
  });
}

export function createAudioPort(options: {
  resolver: AudioTargetResolver;
  backend: AudioCaptureBackend;
  captureAllowed(owner: GatewayAuthority, target: AudioCaptureTarget): boolean;
  now?: () => number;
  randomUUID?: () => string;
}): AudioPort {
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? randomUUID;
  const sessions = new Map<string, LiveAudioSession>();
  const activeTargets = new Map<string, string>();
  const openingTargets = new Set<string>();

  function owned(owner: GatewayAuthority, audioSessionId: string): LiveAudioSession {
    if (!SESSION_ID.test(audioSessionId)) throw new Error('Audio session id is invalid');
    const session = sessions.get(audioSessionId);
    if (!session) throw new Error('Audio session not found');
    if (!sameAuthorityTuple(session.handle.owner, owner)) {
      throw new Error('Audio session is owned by another authority');
    }
    if (session.handle.state !== 'ACTIVE') {
      throw new Error(`Audio session is not active: ${session.handle.state}`);
    }
    return session;
  }

  function update(session: LiveAudioSession, patch: Partial<AudioCaptureHandle>): void {
    session.handle = Object.freeze({
      ...session.handle,
      ...patch,
      updatedAt: now(),
    });
  }

  async function revalidate(session: LiveAudioSession): Promise<AudioCaptureTarget> {
    const current = await options.resolver.resolve(
      session.handle.owner,
      session.handle.target.targetId,
    );
    validateTarget(current);
    if (!sameTarget(session.handle.target, current)) {
      throw new Error('Audio target identity changed');
    }
    return current;
  }

  return {
    async open(owner, targetId, format) {
      if (!TARGET_ID.test(targetId)) throw new Error('Audio target id is invalid');
      validateFormat(format);
      if (activeTargets.has(targetId) || openingTargets.has(targetId)) {
        throw new Error('Audio target already has an active capture');
      }
      openingTargets.add(targetId);

      try {
        const target = await options.resolver.resolve(owner, targetId);
        validateTarget(target);
        if (!options.captureAllowed(owner, target)) {
          throw new Error('Audio capture denied');
        }

        const backend = await options.backend.open(target, format);
        let current: AudioCaptureTarget;
        try {
          current = await options.resolver.resolve(owner, targetId);
          validateTarget(current);
          if (!sameTarget(target, current)) {
            throw new Error('Audio target identity changed during open');
          }
          if (!options.captureAllowed(owner, current)) {
            throw new Error('Audio capture denied');
          }
        } catch (error) {
          await backend.stop().catch(() => undefined);
          throw error;
        }

        const createdAt = now();
        const handle: AudioCaptureHandle = Object.freeze({
          audioSessionId: `audio_${uuid()}`,
          owner: Object.freeze({ ...owner }),
          target: cloneTarget(current),
          format: cloneFormat(format),
          createdAt,
          updatedAt: createdAt,
          state: 'ACTIVE',
        });
        sessions.set(handle.audioSessionId, {
          handle,
          backend,
          lastSequence: -1,
        });
        activeTargets.set(targetId, handle.audioSessionId);
        return cloneHandle(handle);
      } finally {
        openingTargets.delete(targetId);
      }
    },

    async describe(owner, audioSessionId) {
      const session = owned(owner, audioSessionId);
      await revalidate(session);
      return cloneHandle(session.handle);
    },

    async read(owner, audioSessionId, request = {}) {
      const session = owned(owner, audioSessionId);
      const current = await revalidate(session);
      if (!options.captureAllowed(owner, current)) {
        throw new Error('Audio capture denied');
      }

      const maxBytes = request.maxBytes ?? DEFAULT_READ_BYTES;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
        throw new Error('Audio read byte limit is invalid');
      }
      const timeoutMs = request.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs)
          || timeoutMs < 100
          || timeoutMs > MAX_READ_TIMEOUT_MS) {
        throw new Error('Audio read timeout is invalid');
      }

      const chunk = await session.backend.read(maxBytes, timeoutMs);
      if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength > maxBytes) {
        throw new Error('Audio backend returned invalid bytes');
      }
      if (!Number.isSafeInteger(chunk.sequence)
          || chunk.sequence < 0
          || chunk.sequence <= session.lastSequence) {
        throw new Error('Audio backend returned invalid sequence');
      }
      if (!Number.isFinite(chunk.capturedAt) || chunk.capturedAt < 0) {
        throw new Error('Audio backend returned invalid timestamp');
      }
      if (chunk.eof !== undefined && typeof chunk.eof !== 'boolean') {
        throw new Error('Audio backend returned invalid EOF state');
      }

      session.lastSequence = chunk.sequence;
      update(session, {});
      return Object.freeze({
        audioSessionId,
        bytes: new Uint8Array(chunk.bytes),
        sequence: chunk.sequence,
        capturedAt: chunk.capturedAt,
        eof: chunk.eof === true,
      });
    },

    async stop(owner, audioSessionId) {
      const session = owned(owner, audioSessionId);
      update(session, { state: 'STOPPING' });
      try {
        // Cleanup is always available even if capture policy is later revoked.
        await session.backend.stop();
        update(session, { state: 'STOPPED' });
      } catch (error) {
        update(session, { state: 'FAILED' });
        throw error;
      } finally {
        activeTargets.delete(session.handle.target.targetId);
      }
      return cloneHandle(session.handle);
    },
  };
}
