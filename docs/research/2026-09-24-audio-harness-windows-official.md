# Audio Harness Windows upstream recheck — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE INPUT / SOURCE-ONLY

## Process loopback

Microsoft's Application Loopback sample, published 2026-02-19, demonstrates
ActivateAudioInterfaceAsync with process loopback activation. It can restrict capture to audio
rendered by one target process and its child processes, or invert that selection. The capture is not
tied to one physical audio endpoint.

AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS carries TargetProcessId plus include/exclude mode. Microsoft
documents Windows 10 Build 20348 as the minimum supported client for this structure.

Official sources:
- https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/
- https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params
- https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-activateaudiointerfaceasync

WAG disposition:
- process capture is its own authority class;
- PID alone is never WAG ownership, so AudioPort resolves and revalidates an exact process-instance
  identity before reads;
- include-child-process mode is part of the resolved target identity and cannot silently change.

## System loopback

Microsoft documents WASAPI loopback capture through AUDCLNT_STREAMFLAGS_LOOPBACK. It is a shared-mode
capture of audio being rendered by an endpoint and is conceptually different from process loopback.

Official source:
- https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording

WAG disposition:
- system-output capture is a separate target/capability from process capture;
- granting one does not grant the other.

## Microphone

Microphone capture is intentionally a third target class in WAG. This source slice does not select a
native microphone API or permission UX. The contract requires a separately resolved device identity
and a separate capture-policy decision, so system/process audio authority cannot imply microphone
authority.

## Speech synthesis

Windows.Media.SpeechSynthesis.SpeechSynthesizer exposes installed voices and
SynthesizeTextToStreamAsync, which asynchronously returns a SpeechSynthesisStream. Microsoft examples
then send that stream to a separate MediaElement for playback. Microsoft also documents that only
installed Microsoft-signed voices can be used by this synthesizer.

Official sources:
- https://learn.microsoft.com/en-us/uwp/api/windows.media.speechsynthesis.speechsynthesizer
- https://learn.microsoft.com/en-us/uwp/api/windows.media.speechsynthesis.speechsynthesizer.synthesizetexttostreamasync
- https://learn.microsoft.com/en-us/uwp/api/windows.media.speechsynthesis.speechsynthesizer.allvoices

WAG disposition:
- SpeechPort synthesizes bounded bytes only;
- synthesis does not imply speaker/playback authority;
- speaker playback, if later required, must be a separate effect/capability.
