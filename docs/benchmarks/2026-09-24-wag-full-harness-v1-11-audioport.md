# WAG Full Harness v1.11 — AudioPort + SpeechPort semantic foundation

Date: 2026-09-24
Branch: feat/full-harness-audioport-v1
Base: e6c76550993ea4f1b6e406fcb3a9816abb78346b
Status: SOURCE-GREEN / BACKEND-NEUTRAL / NO LIVE AUDIO CAPTURE OR PLAYBACK

## Added

AudioPort:
- explicit audioSessionId and exact owner/session/adapter ownership;
- separately resolved process / system-output / microphone targets;
- process target identity includes PID, opaque process-instance id, executable path and
  include-child-process mode;
- target identity revalidation before every read;
- separate capture-policy check before open and every read;
- post-backend-open identity/policy revalidation with cleanup on drift;
- one active capture per target, including an in-flight open reservation to close concurrent races;
- bounded PCM formats, chunk byte ceilings and read timeouts;
- strictly increasing backend chunk sequence validation;
- cleanup remains available after capture authority is revoked.

SpeechPort:
- validated installed-voice inventory contract;
- bounded text input;
- optional exact voice selection;
- bounded WAV byte output;
- requested/result voice mismatch fails closed;
- no playback primitive.

## Authority separation

These are intentionally independent:

- PROCESS_AUDIO_CAPTURE
- SYSTEM_AUDIO_CAPTURE
- MICROPHONE_CAPTURE
- SPEECH_SYNTHESIZE
- future SPEAKER_PLAYBACK

The source tests prove that granting process capture does not grant system or microphone capture.

## Measured gates

AudioPort + SpeechPort focused:

```text
10 pass
0 fail
```

Audio + existing BrowserPort + ProcessPort regression:

```text
21 pass
0 fail
```

Repository source build:

```text
npm run build
PASS
```

## Mutation note

One AudioPort file.replace returned OUTCOME_UNKNOWN / DivergentTarget while reporting a result digest.
No blind retry was performed. Exact file readback proved the intended in-flight target reservation
logic was present; subsequent focused tests and repository build exercised those bytes successfully.

## Native backend target

Process audio:
- WASAPI ActivateAudioInterfaceAsync;
- VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK;
- AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;
- process identity must be supplied by the future exact Windows process-identity observer rather than
  trusting a model-supplied PID.

System output:
- WASAPI shared-mode loopback capture.

Speech:
- Windows.Media.SpeechSynthesis.SpeechSynthesizer;
- stream/bytes returned into WAG artifact/audio pipeline;
- no automatic MediaElement/speaker playback.

Microphone:
- native device/permission design remains a separately reviewed follow-up because it is a more
  sensitive observation authority.

## Non-claims

- no WASAPI backend is implemented;
- no microphone API/backend is implemented;
- no SpeechSynthesizer native adapter is implemented;
- no audio device/process was opened;
- no microphone was accessed;
- no speaker playback occurred;
- no public MCP tool changed;
- no runtime/config promotion occurred.
