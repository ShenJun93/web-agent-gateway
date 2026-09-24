import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createAudioPort,
  type AudioCaptureBackend,
  type AudioCaptureTarget,
  type AudioTargetResolver,
} from '../src/audio-harness/audio-port.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_audio',
  sessionId: 'session_audio',
  adapterId: 'private.stdio.v1',
};
const OTHER: GatewayAuthority = {
  ownerId: 'owner_audio',
  sessionId: 'session_other',
  adapterId: 'private.stdio.v1',
};
const FORMAT = { sampleRateHz: 48000, channels: 2, encoding: 'pcm_s16le' as const };

function processTarget(instance = 'created:6000:100'): AudioCaptureTarget {
  return {
    kind: 'process',
    targetId: 'process_music',
    pid: 6000,
    processInstanceId: instance,
    executablePath: 'C:\\Apps\\Music\\music.exe',
    includeChildProcesses: true,
  };
}

function fixture() {
  const targets = new Map<string, AudioCaptureTarget>([
    ['process_music', processTarget()],
    ['system_default', { kind: 'system', targetId: 'system_default', endpointId: 'render:default' }],
    ['mic_default', { kind: 'microphone', targetId: 'mic_default', deviceId: 'capture:default' }],
  ]);
  const allowed = new Set<string>(['process']);
  const stopped: string[] = [];
  let sequence = 0;

  const resolver: AudioTargetResolver = {
    async resolve(owner, targetId) {
      if (owner.sessionId !== OWNER.sessionId) throw new Error('target not owned');
      const target = targets.get(targetId);
      if (!target) throw new Error('target not found');
      return target;
    },
  };
  const backend: AudioCaptureBackend = {
    async open(target) {
      return {
        async read(maxBytes) {
          const bytes = new TextEncoder().encode(`audio:${target.targetId}:${sequence}`);
          assert.ok(bytes.byteLength <= maxBytes);
          return {
            bytes,
            sequence: sequence++,
            capturedAt: 1000 + sequence,
          };
        },
        async stop() {
          stopped.push(target.targetId);
        },
      };
    },
  };

  let n = 1;
  const port = createAudioPort({
    resolver,
    backend,
    captureAllowed: (_owner, target) => allowed.has(target.kind),
    randomUUID: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  });
  return { port, targets, allowed, stopped };
}

test('AudioPort owns process capture by exact authority and returns bounded monotonic chunks', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, 'process_music', FORMAT);
  assert.equal(opened.audioSessionId, 'audio_00000000-0000-4000-8000-000000000001');
  assert.equal(opened.state, 'ACTIVE');
  assert.equal(opened.target.kind, 'process');

  await assert.rejects(() => f.port.describe(OTHER, opened.audioSessionId), /another authority/);
  await assert.rejects(() => f.port.read(OTHER, opened.audioSessionId), /another authority/);

  const first = await f.port.read(OWNER, opened.audioSessionId, { maxBytes: 1024, timeoutMs: 1000 });
  const second = await f.port.read(OWNER, opened.audioSessionId, { maxBytes: 1024, timeoutMs: 1000 });
  assert.equal(first.sequence, 0);
  assert.equal(second.sequence, 1);
  assert.equal(new TextDecoder().decode(first.bytes), 'audio:process_music:0');
});

test('process capture revalidates exact process-instance identity before every read', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, 'process_music', FORMAT);
  f.targets.set('process_music', processTarget('created:6000:replacement'));

  await assert.rejects(
    () => f.port.read(OWNER, opened.audioSessionId),
    /target identity changed/,
  );
  assert.equal(f.stopped.length, 0);
  assert.equal((await f.port.stop(OWNER, opened.audioSessionId)).state, 'STOPPED');
});

test('capture authority is separate for process, system output and microphone', async () => {
  const f = fixture();
  const processCapture = await f.port.open(OWNER, 'process_music', FORMAT);
  await f.port.stop(OWNER, processCapture.audioSessionId);

  await assert.rejects(
    () => f.port.open(OWNER, 'system_default', FORMAT),
    /capture denied/,
  );
  await assert.rejects(
    () => f.port.open(OWNER, 'mic_default', { sampleRateHz: 16000, channels: 1, encoding: 'pcm_s16le' }),
    /capture denied/,
  );

  f.allowed.add('system');
  const system = await f.port.open(OWNER, 'system_default', FORMAT);
  assert.equal(system.target.kind, 'system');
  await f.port.stop(OWNER, system.audioSessionId);

  f.allowed.add('microphone');
  const mic = await f.port.open(
    OWNER,
    'mic_default',
    { sampleRateHz: 16000, channels: 1, encoding: 'pcm_s16le' },
  );
  assert.equal(mic.target.kind, 'microphone');
});

test('capture policy can be revoked while cleanup remains available', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, 'process_music', FORMAT);
  f.allowed.delete('process');

  await assert.rejects(
    () => f.port.read(OWNER, opened.audioSessionId),
    /capture denied/,
  );
  const stopped = await f.port.stop(OWNER, opened.audioSessionId);
  assert.equal(stopped.state, 'STOPPED');
  assert.deepEqual(f.stopped, ['process_music']);
});

test('AudioPort reserves a target during asynchronous open so concurrent sessions cannot race', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const target = processTarget();
  const resolver: AudioTargetResolver = {
    async resolve() { return target; },
  };
  const backend: AudioCaptureBackend = {
    async open() {
      await gate;
      return {
        async read() { return { bytes: new Uint8Array([1]), sequence: 0, capturedAt: 1 }; },
        async stop() {},
      };
    },
  };
  let n = 10;
  const port = createAudioPort({
    resolver,
    backend,
    captureAllowed: () => true,
    randomUUID: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  });

  const first = port.open(OWNER, 'process_music', FORMAT);
  await assert.rejects(
    () => port.open(OWNER, 'process_music', FORMAT),
    /already has an active capture/,
  );
  release();
  const opened = await first;
  assert.equal(opened.state, 'ACTIVE');
});

test('AudioPort rejects invalid formats and oversized read requests before backend use', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.port.open(OWNER, 'process_music', { sampleRateHz: 1000, channels: 2, encoding: 'pcm_s16le' }),
    /sample rate is invalid/,
  );

  const opened = await f.port.open(OWNER, 'process_music', FORMAT);
  await assert.rejects(
    () => f.port.read(OWNER, opened.audioSessionId, { maxBytes: 2 * 1024 * 1024 }),
    /byte limit is invalid/,
  );
});
