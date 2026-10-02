# WAG P0 Upload + Media Preflight v1 — local acceptance

Date: 2026-10-02

State: **LOCAL ACCEPTANCE PASS / NOT YET PROMOTED**

Branch: `feat/p0-upload-media-v1`

Base public main:

```text
f648e40c5e0544c27ebaa68284756813b5d023e5
```

Live runtime remained unchanged during this acceptance:

```text
source_head = 4645aeef1edd21b6193b31029b74a94f85ee0438
```

## Scope

This closes the two highest-priority post-launch gaps:

1. semantic browser file upload without a native file chooser;
2. mandatory semantic media preflight that catches missing audio and other demo defects before publication.

New MCP tools:

```text
browser.upload_file
machine.media.inspect
verify.media
```

Under the same direct-tunnel projection and current live config, the source catalog changes from:

```text
current live source projection: 71
candidate source projection:    74
delta:                          +3
```

The live health surface currently contains additional conditional remote-Git tools, so post-promotion
health is expected to increase from 74 to 77 if the live configuration is otherwise unchanged.

## browser.upload_file contract

Public input is bounded to:

- caller-owned local-machine `workspace_id`;
- semantic file-input `ref`;
- 1..20 **workspace-relative** paths;
- caller-supplied idempotency key.

The public schema does **not** accept an absolute host path.

Immediately before `DOM.setFileInputFiles`, WAG:

1. revalidates caller-owned local-machine workspace identity;
2. validates each workspace-relative path;
3. enforces workspace containment;
4. resolves the current real path;
5. requires a regular file;
6. rechecks the kill switch;
7. dispatches the semantic file-selection effect.

Large media is not copied into ArtifactPort; this avoids doubling disk usage and unnecessary I/O for
hundreds-of-megabytes videos. The authority boundary remains the caller-owned workspace.

The browser effect uses the existing durable exact-once ledger. A successful replay with the same
idempotency key returns the original effect and does not call `DOM.setFileInputFiles` again.

## Real browser acceptance

A real managed Edge headless session loaded a local multipart form with:

- one semantic `<input type=file>`;
- one semantic submit button.

WAG then performed:

```text
semantic snapshot
-> browser.upload_file
-> replay same browser.upload_file
-> semantic snapshot refresh
-> semantic click Submit
-> local multipart receive
```

Observed:

```text
state = PASS
semantic_file_ref = true
native_file_chooser_used = false
replay_same_effect = true
multipart_filename_verified = true
multipart_content_verified = true
```

The local receiver observed the expected `upload.txt` filename and exact fixture payload.

Acceptance script:

```text
scripts/accept-browser-upload-file.ts
```

## machine.media.inspect contract

The tool accepts a caller-owned local-machine workspace, a workspace-relative path and an optional
analysis window in the bounded interval 1..600 seconds.

It executes fixed argv only, with `shell:false`:

- `ffprobe`: format + stream metadata;
- `ffmpeg loudnorm`: first audio stream loudness;
- `ffmpeg blackdetect`: first video stream black-frame segments.

Returned semantic evidence includes:

- duration;
- container format and bit rate;
- video streams, codec, resolution, pixel format, frame rate;
- audio streams, codec, sample rate, channels/layout;
- integrated loudness / true peak / loudness range when measurable;
- black-frame segments, total black duration, ratio and longest segment;
- analysis coverage and whether the whole media file was analyzed.

Default analysis window is 120 seconds; maximum is 600 seconds.

## verify.media contract

Profile: `web-demo`.

Mandatory checks:

- duration >= 1 second;
- video stream present;
- video codec present;
- positive resolution;
- audio stream present;
- audio codec present;
- loudness measurable;
- integrated loudness >= -50 LUFS, preventing an effectively silent demo from passing;
- black-frame analysis available;
- near-total black content (>95% of analyzed window) fails;
- >25% black or >5 second longest black segment warns;
- partial analysis coverage warns rather than silently claiming whole-file coverage.

Any FAIL yields overall `state=FAIL`.

## Real FFmpeg acceptance

Host toolchain:

```text
ffprobe 8.1.2-full_build-www.gyan.dev
```

Two real 3-second MP4 fixtures were generated locally.

### good.mp4

Observed:

```text
video = h264 640x360
audio = aac
duration = 3.000 s
integrated loudness = -21.13 LUFS
black ratio = 0
analysis complete = true
verify.media = PASS
```

### silent.mp4

Observed:

```text
video = h264 640x360
audio streams = 0
loudness = null
analysis complete = true
verify.media = FAIL
failed checks = audio_stream, loudness
```

This directly covers the failure mode that previously allowed a demo candidate with missing audio.

## Automated evidence

Focused:

```text
local-machine-media.test.ts                 3/3 PASS
browser-harness-mcp-runtime.test.ts         4/4 PASS
local-machine-mcp-surface.test.ts           1/1 PASS
local-machine-runtime.test.ts              10/10 PASS
direct-mcp-readiness.test.ts               10/10 PASS
browser-harness-mcp-surface.test.ts         2/2 PASS
```

Broader affected-surface regression:

```text
49/49 PASS
```

The broader set covers browser semantic/upload/resource bounds, desktop composition, direct MCP,
local machine/media routing, repository engineering runtime and stdio lifecycle.

Build gates:

```text
typecheck       PASS
build           PASS
git diff --check PASS
```

## Security / authority notes

- no raw CDP tool was exposed;
- no arbitrary absolute upload path is accepted from MCP callers;
- no OS pointer injection or native file-chooser automation is needed;
- upload is exact-once and target-fenced under existing Browser v2 semantics;
- media subprocesses use fixed executable/argv shape with `shell:false`;
- media input remains workspace-contained;
- no Git push, GitHub release, npm publish, signing request or live runtime promotion occurred in this local acceptance.
