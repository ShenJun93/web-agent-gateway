# WAG P1 Browser Reliability v1 — local acceptance

Date: 2026-10-02

State: **LOCAL ACCEPTANCE PASS / NOT YET PROMOTED**

Branch:

```text
feat/p1-browser-reliability-v1
```

Stack base:

```text
b707da660222cc349448a05917441f09528ec682
```

The stack base is Batch A (P0 browser upload + media preflight). Public main and the live runtime were not changed during this acceptance.

## Scope

This batch closes the reliability gaps:

```text
browser.wait_for
browser.assert
browser.media.inspect
attached-session recovery/release hardening
```

Under the same direct-tunnel projection and current live config:

```text
Batch A source projection: 74 tools
Batch B source projection: 77 tools
Batch B delta:              +3 tools
```

The currently promoted live runtime has 74 tools because its source predates Batch A/B and also carries conditional remote-Git tools. If Batch A+B are promoted together under the same live configuration, the expected live health count is 80.

## browser.wait_for

Public conditions are semantic only. The caller may match URL, document title, accessible node role/name/value, disabled/editable/focusable state, and explicit node absence.

Operators are bounded to `equals` and `contains`. Conditions combine with `all` or `any`.

Bounds:

```text
conditions        1..8
timeout_ms        1..120000
poll_interval_ms  50..5000
default timeout   15000 ms
default interval  250 ms
```

No CSS selector, XPath, JavaScript, raw CDP method or caller-supplied function is accepted. The tool returns snapshot id, attempts, elapsed time and per-condition evidence.

## browser.assert

`browser.assert` uses the same semantic condition language but observes exactly once. On mismatch it fails the tool rather than returning a misleading success-shaped object.

## browser.media.inspect

The caller supplies only a caller-owned browser session id and opaque semantic ref.

WAG resolves the current semantic DOM-backed node and invokes one exact WAG-owned fixed function. Arbitrary `Runtime.callFunctionOn` remains denied by the existing-browser extension allowlist.

Returned bounded evidence includes:

- media tag;
- paused/ended;
- muted and volume;
- duration/current time;
- playback rate;
- readyState/networkState;
- media error code/message;
- video width/height;
- audio evidence: `PRESENT`, `ABSENT` or `UNKNOWN`;
- decoded audio byte count when Chromium exposes it;
- audio track count when the browser exposes it;
- captured-stream audio track count when Chromium exposes it.

The tool never claims audio exists when evidence is unavailable.

## Real Edge acceptance

A real WAG-managed Edge headless session loaded a local fixture page. The page changed `Processing -> Checks complete` after a timer and hosted the real Batch A MP4 fixture.

Observed:

```text
browser.wait_for = PASS
wait attempts = 4
wait elapsed = 613 ms
browser.assert = PASS

browser.media.inspect:
  tag = video
  paused = false
  ended = false
  muted = true
  volume = 1
  duration = 3 s
  current time > 0 s
  readyState = 4
  networkState = 1
  error = null
  audio_evidence = PRESENT
  audio_decoded_bytes > 0
  captured_audio_track_count = 1
  video = 640x360
```

The acceptance exposed no arbitrary selector or JavaScript surface.

Acceptance script:

```text
scripts/accept-browser-reliability.ts
```

## Existing-browser / AI-tab safety

The exact fixed media-inspection function is also allowlisted in the existing-browser extension. Tests prove the exact function is allowed while parameter widening, modified function text and arbitrary JavaScript are rejected.

## Session recovery and release

### Lost broker route

If local in-memory routing disappears, WAG discards only stale in-memory route/fence state, consults durable attached-session state and recovers only the exact caller-owned session. No target is guessed.

### Active foreign/session claim

`TARGET_OWNED_BY_OTHER_SESSION` remains fail-closed. Batch B intentionally does not auto-steal an active target. A crashed owner may recover only after its lease is released or expires, and stale epochs remain fenced.

### Atomic multi-target release

OAuth continuity may retain multiple target claims. Claim cleanup now uses one transactional `releaseMany`. If one retained target is fenced, the transaction rolls back instead of releasing a subset.

### Detach timeout

If debugger detach times out or has unknown outcome, the session stays retryable in `CLOSING`, claims remain active, and WAG does not release ownership under an uncertain attachment outcome.

### Detach succeeded but claim cleanup interrupted

If detach succeeded but atomic claim cleanup fails, the session remains retryable and the next close retries claim cleanup without target takeover.

### Successful close

After successful close, claims are released atomically, durable state becomes `CLOSED`, the broker route is removed, and an attached-session close replay returns durable `CLOSED` without a second detach.

## Automated evidence

Focused:

```text
browser-harness-semantic.test.ts               8/8 PASS
browser-semantic-condition.test.ts             3/3 PASS
browser-harness-broker.test.ts                 6/6 PASS
browser-runtime-session-recovery.test.ts       3/3 PASS
browser-harness-attached-existing-port.test.ts 7/7 PASS
browser-target-claim-store.test.ts             8/8 PASS
browser-existing-control-v1.test.ts           11/11 PASS
direct-mcp-readiness.test.ts                  10/10 PASS
```

Affected-surface broad regression:

```text
83/83 PASS
```

Build gates:

```text
typecheck        PASS
build            PASS
git diff --check PASS
```

## Publication boundary

No public push, live promotion, npm publish, GitHub release or signing action was performed by this Batch B acceptance.
