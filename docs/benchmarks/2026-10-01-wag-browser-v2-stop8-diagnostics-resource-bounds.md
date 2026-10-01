# WAG Browser v2 — STOP 8 Sanitized Diagnostics & Resource Bounds

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering HEAD: `23d8e48c7ecb86cb1e28572c1b726b26d621c2eb`

## Result

```text
BROWSER_V2_SANITIZED_DIAGNOSTICS = PASS
BROWSER_V2_RESOURCE_BOUNDS = PASS
P2_DIAGNOSTICS_RESOURCE_BOUNDS = PASS

REAL_EDGE_AI_TAB_GROUP_REGRESSION = PASS
REAL_EDGE_OAUTH_CONTINUITY_REGRESSION = PASS
REAL_EDGE_RUNTIME_RECOVERY_REGRESSION = PASS

USER_REAL_PROFILE_DIAGNOSTICS = NOT_EXECUTED
PUBLIC_LAUNCH = NO
LIVE_RUNTIME_PROMOTION = NO
```

## Sanitized Browser diagnostics

Browser v2 now owns a bounded support-diagnostics ring persisted at:

```text
<mutation state>.browser-diagnostics.json
```

The default retained capacity is 256 events, configurable only within:

```text
16 <= capacity <= 2048
recent read <= 100 events
```

Events may contain only:

```text
sequence
started_at_utc
duration_ms
action_type
success
browser_session_id?   opaque
target_id?            opaque
ownership_mode?
error_class?
target_changed
recovered
```

The persisted schema is exact-key validated. Unknown event fields or malformed persisted state are rejected as diagnostics input rather than trusted.

### Data deliberately excluded

Browser diagnostics do not persist:

```text
URL
origin
page title
page text
semantic node names or values
typed form content
fill text
passwords
cookies
tokens
OAuth codes
credentials
profile paths
browser command parameters
idempotency keys
exception messages
screenshots
```

Errors retain only a bounded constructor/type class such as `TypeError`, not the exception message.

Tests inject password/token/URL/form-shaped secrets into an exception message and confirm none appear in the serialized diagnostics file.

Recovery diagnostics distinguish:

```text
attempt blocked by live lease  -> recovered=true, success=false
successful successor recovery -> recovered=true, success=true
```

without recording browser content.

## Resource bounds

### Semantic accessibility tree

Raw `Accessibility.getFullAXTree` processing is capped before semantic refs are built:

```text
AX source nodes processed <= 2,000
public Browser MCP nodes returned <= 500
```

If either layer truncates, the public snapshot reports:

```text
truncated = true
```

This prevents very large pages from creating an unbounded semantic-ref map.

### Browser sessions

One Browser MCP runtime may track at most:

```text
32 active browser sessions
```

The 33rd open fails before the BrowserPort/backend open call, so no additional Edge process/profile/browser resources are allocated after the cap.

### Browser screenshots

Screenshot payloads are capped at:

```text
8 MiB decoded PNG data
```

The MCP runtime first checks the base64 character bound before computing decoded byte length, avoiding an unnecessary full decoded Buffer allocation for obviously oversized payloads.

The WebSocket client validates the same 8 MiB screenshot bound.

### Browser Control WebSocket

The primary Browser v2 Edge-extension transport remains:

```text
ws://127.0.0.1:<port>/browser-control
```

and retains exact extension Origin + pairing-token authentication.

New transport bounds:

```text
concurrent pending requests <= 128
targets.list entries <= 512
normal control response <= 256 KiB
screenshot decoded data <= 8 MiB
WebSocket inbound payload <= bounded screenshot envelope
```

A non-screenshot response above 256 KiB is rejected and its connection is closed with a size-policy WebSocket close.

### Existing semantic bounds retained

Previously accepted limits remain:

```text
fill text <= 64 KiB UTF-8
upload files <= 20
internal upload path <= 4,096 UTF-8 bytes
snapshot role <= 512 UTF-8 bytes
snapshot name <= 1,024 UTF-8 bytes
snapshot value <= 2,048 UTF-8 bytes
snapshot URL <= 4,096 UTF-8 bytes
snapshot title <= 1,024 UTF-8 bytes
```

## Diagnostics do not widen authority

The diagnostics object has no browser mutation method and no new MCP authority.

It observes coarse runtime metadata only after or around operations already authorized by Browser v2.

Diagnostic persistence failure is not allowed to transform a successfully completed exact-once browser effect into a second dispatch. After a confirmed effect, post-effect diagnostic/fencing refresh failures are swallowed rather than replaying the effect.

## Verification

### Dedicated P2 tests

```text
Browser Control target-list bound          PASS
Browser Control normal response bound      PASS
Browser Control pending-request bound      PASS
AX source-node bound                        PASS
public snapshot 500-node bound             PASS
32 active-session bound                     PASS
8 MiB screenshot bound                      PASS
diagnostics secret-exclusion                PASS
diagnostics ring/persistence bound          PASS
strict persisted diagnostics schema         PASS
recovery diagnostics success/failure split PASS
```

Focused resource/diagnostics/transport gate:

```text
11 / 11 PASS
```

Final recovery/diagnostics/resource gate:

```text
8 / 8 PASS
```

### Broad Browser/runtime regression

```text
Browser / extension / WebSocket batch A = 80 / 80 PASS
Browser MCP / managed-runtime batch B1 = 17 / 17 PASS
Browser semantic / recovery / P2 batch B2 = 32 / 32 PASS
Control / private-runtime / assembly batch C = 32 / 32 PASS

Total = 161 / 161 PASS
```

### Real Microsoft Edge

All were rerun after the final P2 implementation:

```text
AI_TAB_GROUP                       PASS
OAuth successor/return continuity  PASS
runtime/session recovery           PASS
exact-once no duplicate recovery   PASS
active user tab remains stable     PASS
Windows UIAutomation used          NO
OS pointer injection used          NO
native Browser Control exe used    NO
user real daily profile used       NO
```

### Engineering gates

```text
typecheck = PASS
build = PASS
git diff --check = PASS
```

## Material files

New:

```text
src/browser-harness/browser-runtime-diagnostics.ts
test/browser-runtime-diagnostics.test.ts
test/browser-resource-bounds.test.ts
```

Modified:

```text
src/browser-harness/browser-control-websocket-server.ts
src/browser-harness/browser-mcp-runtime.ts
src/browser-harness/semantic-browser.ts
src/repository-engineering-runtime.ts
test/browser-control-websocket-server.test.ts
test/browser-runtime-session-recovery.test.ts
```

## Remaining public-launch work

P2 is closed, but public launch is not declared from this receipt.

Still outstanding or intentionally not measured:

```text
AUTO authenticated-existing-target selection = NOT FINALIZED
production first-time pairing UX = NOT COMPLETE
user daily Edge profile acceptance = NOT EXECUTED
real OS-process SIGKILL recovery = NOT EXECUTED
final Browser v2 public-launch gate = PENDING
live runtime promotion = NO
public push = NO
```

## STOP 8 decision

```text
SANITIZED_DIAGNOSTICS_ACCEPTED_FOR_BRANCH = YES
RESOURCE_BOUNDS_ACCEPTED_FOR_BRANCH = YES
PROCEED_TO_FINAL_BROWSER_V2_PUBLIC_LAUNCH_GATE = YES

PROMOTE_TO_LIVE = NO
PUBLIC_LAUNCH = NO
PUBLIC_PUSH = NO
```
