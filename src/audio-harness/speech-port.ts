import type { GatewayAuthority } from '../caller-context.js';

export type SpeechAudioFormat = 'wav_pcm_s16le';

export interface SpeechVoice {
  readonly voiceId: string;
  readonly displayName: string;
  readonly language: string;
}

export interface SpeechSynthesisRequest {
  readonly text: string;
  readonly voiceId?: string;
  readonly format?: SpeechAudioFormat;
}

export interface SpeechSynthesisResult {
  readonly bytes: Uint8Array;
  readonly contentType: 'audio/wav';
  readonly voiceId?: string;
  readonly format: SpeechAudioFormat;
}

export interface SpeechBackend {
  listVoices(): Promise<readonly SpeechVoice[]>;
  synthesize(request: {
    readonly text: string;
    readonly voiceId?: string;
    readonly format: SpeechAudioFormat;
  }): Promise<{
    readonly bytes: Uint8Array;
    readonly voiceId?: string;
  }>;
}

export interface SpeechPort {
  listVoices(owner: GatewayAuthority): Promise<readonly SpeechVoice[]>;
  synthesize(
    owner: GatewayAuthority,
    request: SpeechSynthesisRequest,
  ): Promise<SpeechSynthesisResult>;
}

const VOICE_ID = /^[^\u0000-\u001F]{1,512}$/;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

function validateVoice(voice: SpeechVoice): void {
  if (!VOICE_ID.test(voice.voiceId)) throw new Error('Speech voice id is invalid');
  if (typeof voice.displayName !== 'string'
      || /[\u0000-\u001F]/.test(voice.displayName)
      || Buffer.byteLength(voice.displayName, 'utf8') > 1024) {
    throw new Error('Speech voice display name is invalid');
  }
  if (typeof voice.language !== 'string'
      || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(voice.language)) {
    throw new Error('Speech voice language is invalid');
  }
}

export function createSpeechPort(options: {
  backend: SpeechBackend;
  speechAllowed(owner: GatewayAuthority, voiceId: string | undefined): boolean;
}): SpeechPort {
  return {
    async listVoices(owner) {
      if (!options.speechAllowed(owner, undefined)) {
        throw new Error('Speech synthesis denied');
      }
      const voices = await options.backend.listVoices();
      const seen = new Set<string>();
      const output: SpeechVoice[] = [];
      for (const voice of voices) {
        validateVoice(voice);
        if (seen.has(voice.voiceId)) throw new Error('Speech backend returned duplicate voice id');
        seen.add(voice.voiceId);
        output.push(Object.freeze({ ...voice }));
      }
      return Object.freeze(output);
    },

    async synthesize(owner, request) {
      if (typeof request.text !== 'string'
          || request.text.includes('\0')
          || Buffer.byteLength(request.text, 'utf8') < 1
          || Buffer.byteLength(request.text, 'utf8') > MAX_TEXT_BYTES) {
        throw new Error('Speech synthesis text is invalid');
      }
      if (request.voiceId !== undefined && !VOICE_ID.test(request.voiceId)) {
        throw new Error('Speech voice id is invalid');
      }
      const format = request.format ?? 'wav_pcm_s16le';
      if (format !== 'wav_pcm_s16le') throw new Error('Speech format is invalid');
      if (!options.speechAllowed(owner, request.voiceId)) {
        throw new Error('Speech synthesis denied');
      }

      const result = await options.backend.synthesize({
        text: request.text,
        ...(request.voiceId === undefined ? {} : { voiceId: request.voiceId }),
        format,
      });
      if (!(result.bytes instanceof Uint8Array)
          || result.bytes.byteLength < 1
          || result.bytes.byteLength > MAX_AUDIO_BYTES) {
        throw new Error('Speech backend returned invalid audio bytes');
      }
      if (result.voiceId !== undefined && !VOICE_ID.test(result.voiceId)) {
        throw new Error('Speech backend returned invalid voice id');
      }
      if (request.voiceId !== undefined
          && result.voiceId !== undefined
          && request.voiceId !== result.voiceId) {
        throw new Error('Speech backend synthesized with an unexpected voice');
      }

      return Object.freeze({
        bytes: new Uint8Array(result.bytes),
        contentType: 'audio/wav' as const,
        ...(result.voiceId === undefined ? {} : { voiceId: result.voiceId }),
        format,
      });
    },
  };
}
