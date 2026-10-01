import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createSpeechPort,
  type SpeechBackend,
} from '../src/audio-harness/speech-port.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_speech',
  sessionId: 'session_speech',
  adapterId: 'private.stdio.v1',
};

function fixture() {
  const calls: Array<{ text: string; voiceId?: string }> = [];
  let allowed = true;
  const backend: SpeechBackend = {
    async listVoices() {
      return [
        { voiceId: 'voice_en_us_1', displayName: 'English One', language: 'en-US' },
        { voiceId: 'voice_vi_vn_1', displayName: 'Vietnamese One', language: 'vi-VN' },
      ];
    },
    async synthesize(request) {
      calls.push({
        text: request.text,
        ...(request.voiceId === undefined ? {} : { voiceId: request.voiceId }),
      });
      return {
        bytes: new TextEncoder().encode(`WAV:${request.text}`),
        ...(request.voiceId === undefined ? {} : { voiceId: request.voiceId }),
      };
    },
  };
  const port = createSpeechPort({
    backend,
    speechAllowed: () => allowed,
  });
  return {
    port,
    calls,
    setAllowed(value: boolean) { allowed = value; },
  };
}

test('SpeechPort lists validated voices and synthesizes bytes without playback authority', async () => {
  const f = fixture();
  const voices = await f.port.listVoices(OWNER);
  assert.equal(voices.length, 2);
  assert.equal(voices[1]!.language, 'vi-VN');

  const result = await f.port.synthesize(OWNER, {
    text: 'xin chao',
    voiceId: 'voice_vi_vn_1',
  });
  assert.equal(result.contentType, 'audio/wav');
  assert.equal(result.format, 'wav_pcm_s16le');
  assert.equal(result.voiceId, 'voice_vi_vn_1');
  assert.equal(new TextDecoder().decode(result.bytes), 'WAV:xin chao');
  assert.deepEqual(f.calls, [{ text: 'xin chao', voiceId: 'voice_vi_vn_1' }]);
});

test('SpeechPort policy denial occurs before synthesis', async () => {
  const f = fixture();
  f.setAllowed(false);
  await assert.rejects(() => f.port.listVoices(OWNER), /synthesis denied/);
  await assert.rejects(
    () => f.port.synthesize(OWNER, { text: 'blocked' }),
    /synthesis denied/,
  );
  assert.deepEqual(f.calls, []);
});

test('SpeechPort fails closed when backend returns a different requested voice', async () => {
  const backend: SpeechBackend = {
    async listVoices() { return []; },
    async synthesize() {
      return {
        bytes: new Uint8Array([1, 2, 3]),
        voiceId: 'voice_other',
      };
    },
  };
  const port = createSpeechPort({ backend, speechAllowed: () => true });
  await assert.rejects(
    () => port.synthesize(OWNER, { text: 'hello', voiceId: 'voice_expected' }),
    /unexpected voice/,
  );
});

test('SpeechPort rejects invalid text and duplicate voice identities', async () => {
  const backend: SpeechBackend = {
    async listVoices() {
      return [
        { voiceId: 'same', displayName: 'One', language: 'en-US' },
        { voiceId: 'same', displayName: 'Two', language: 'en-US' },
      ];
    },
    async synthesize() { return { bytes: new Uint8Array([1]) }; },
  };
  const port = createSpeechPort({ backend, speechAllowed: () => true });

  await assert.rejects(() => port.listVoices(OWNER), /duplicate voice id/);
  await assert.rejects(
    () => port.synthesize(OWNER, { text: '' }),
    /text is invalid/,
  );
});
