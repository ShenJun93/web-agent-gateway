# WAG Browser v2 — STOP 2B AI Tab Group + Loopback WebSocket

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering HEAD: `1d4ee20f5ec459af000b424f9e0305909aeffd57`

## Result

```text
BROWSER_V2_WEBSOCKET_TRANSPORT = PASS
AI_TAB_GROUP = PASS
ACTIVE_TAB_STABILITY = PASS
NO_OS_MOUSE_CONTENTION = PASS
REAL_EDGE_TEMP_PROFILE_ACCEPTANCE = PASS

USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED
PRODUCTION_PAIRING_UX = NOT_COMPLETE
PER_TARGET_FENCING = NOT_IMPLEMENTED
CROSS_PROCESS_MULTI_SESSION = NOT_PROVEN

PUBLIC_LAUNCH = NO
LIVE_RUNTIME_PROMOTION = NO
```

This checkpoint replaces the Browser v2 runtime-initiated existing-tab control dependency on a separately signed Browser Control native executable with an authenticated loopback WebSocket path from the Edge extension to the already-running WAG Local Node runtime.

The historical native-host implementation remains in the source tree as prior evidence/fallback work. Browser v2 does not require it for the accepted AI Tab Group path in this checkpoint.

## Product behavior

The visible browser mode now includes:

```text
AI_TAB_GROUP
```

An exact existing web tab in the user's Edge profile can be:

1. grouped under a visible WAG tab group;
2. attached through `chrome.debugger`;
3. controlled through the same semantic Browser layer used by the other Browser v2 modes;
4. released without closing the browser or the tab.

The session carries:

```text
executionMode = AI_TAB_GROUP
ownershipMode = ATTACHED_EXISTING
groupId
groupTitle
```

The default group title is derived from the WAG profile/task, while callers may provide a bounded title of at most 64 characters.

## No-user-mouse-contention invariant

The AI Tab Group implementation does not use Windows UI Automation, SendInput, a desktop mouse driver, or foreground-window activation.

The browser extension does not call:

```text
chrome.tabs.update({ active: true })
chrome.windows.update(...focus...)
```

as part of grouping or attached semantic execution.

Grouping records the active tab before and after `chrome.tabs.group` / `chrome.tabGroups.update`. If the active tab changes, AI Tab Group open fails closed.

Semantic interaction is target-scoped:

```text
snapshot
  -> Accessibility.getFullAXTree

fill
  -> DOM.focus
  -> Input.dispatchKeyEvent
  -> Input.insertText

click
  -> DOM.resolveNode
  -> fixed Runtime.callFunctionOn(element.click)
  -> Runtime.releaseObject
  -> bounded target-scoped pointer fallback only when the DOM node cannot click
```

These commands are delivered to the exact attached browser target. They do not move the operating-system cursor.

A user may select the AI tab/group themselves and observe the page changing. WAG does not require foreground ownership of that tab to perform the accepted semantic flow.

## Fixed DOM activation boundary

Browser v2 does **not** expose arbitrary JavaScript.

`Runtime.evaluate` remains denied.

`Runtime.callFunctionOn` is admitted only when all parameters match the WAG-owned fixed function exactly:

```js
function(){if(typeof this.click==="function"){this.click();return true;}return false;}
```

The extension additionally validates exact parameter shape and bounded object ids.

A regression test confirms arbitrary `Runtime.callFunctionOn`, including an attempted `document.cookie` function, is rejected before debugger dispatch.

## WebSocket transport

The Edge extension connects outbound to:

```text
ws://127.0.0.1:<port>/browser-control
```

The WAG server:

- binds only `127.0.0.1`;
- verifies the exact stable WAG extension Origin;
- requires a random 256-bit pairing token;
- accepts text messages only;
- caps payloads at 256 KiB;
- correlates requests by opaque request id;
- rejects all pending requests if the extension disconnects;
- does not retry a timed-out consequential browser effect blindly.

The extension:

- stores its bounded endpoint + pairing token in extension-local storage;
- accepts loopback WebSocket endpoints only;
- authenticates before accepting control requests;
- uses heartbeat/reconnect behavior;
- dispatches only the existing bounded Browser Control protocol.

The default browser-control request timeout is 15 seconds. This avoids prematurely classifying slower background-target CDP execution as unknown while preserving no-blind-replay behavior.

## Native signing blocker bypass

The prior STOP 2 Browser Control native executable remained blocked by Windows Code Integrity events 3033/3077 because it did not meet Enterprise signing-level requirements.

STOP 2B avoids that dependency for Browser v2:

```text
Edge extension
      |
 authenticated localhost WebSocket
      |
 WAG Local Node runtime
```

The successful acceptance did not launch a Browser Control native executable and did not change Windows App Control or Code Integrity policy.

This does not remove future installer/public-signing requirements for WAG as a commercial product. It removes the separate Browser v2 native-host signing dependency from this local browser-control path.

## Real Microsoft Edge acceptance

Real Edge acceptance used:

- real Microsoft Edge;
- a temporary Edge profile;
- the real WAG extension modules under test;
- a local authenticated fixture;
- an initially inactive target tab;
- real `chrome.tabGroups`;
- real `chrome.debugger`;
- the loopback WebSocket transport;
- the semantic Browser layer.

Observed result:

```json
{
  "status": "PASS",
  "transport": "LOOPBACK_WEBSOCKET",
  "nativeBrowserControlExecutable": false,
  "executionMode": "AI_TAB_GROUP",
  "ownershipMode": "ATTACHED_EXISTING",
  "groupTitle": "WAG • Acceptance",
  "authenticatedSessionPreserved": true,
  "targetStartedInactive": true,
  "activeTabStable": true,
  "semanticSnapshot": true,
  "semanticFill": "SUCCEEDED",
  "semanticClick": "SUCCEEDED",
  "finalStateVerified": true,
  "targetStillOpenAfterRelease": true,
  "browserStillOpenAfterRelease": true,
  "windowsUiAutomationUsed": false,
  "osPointerInjectionUsed": false,
  "userRealProfileUsed": false
}
```

The test verified the page state changed from the semantic fill/click flow while the user's active tab identity remained stable.

The acceptance browser used a temporary profile and an off-user-workflow test context. It does **not** prove use against the user's actual logged-in daily Edge profile.

## Verification

Latest broad Browser/runtime regression:

```text
Browser / extension / WebSocket batch A = 75 / 75 PASS
Browser MCP / managed / semantic batch B = 38 / 38 PASS
Control protocol / runtime assembly batch C = 23 / 23 PASS

Total latest broad regression = 136 / 136 PASS

real Edge AI_TAB_GROUP acceptance = PASS
typecheck = PASS
build = PASS
git diff --check = PASS
```

Focused tests additionally cover:

- focus-free target discovery;
- tab-group active-tab stability;
- exact-target attach/release;
- WebSocket Origin + token authentication;
- loopback-only endpoint validation;
- AI Tab Group session metadata;
- Pause / Take Control / Resume routing;
- exact-once browser effect behavior;
- fixed DOM click allowlist;
- denial of arbitrary runtime JavaScript.

## Browser mode state after STOP 2B

```text
ATTACH_EXISTING
  exact existing tab
  no group reorganization

AI_TAB_GROUP
  exact existing tab
  visible WAG tab group
  authenticated profile continuity
  background semantic execution
  user mouse/focus remains available

WAG_VISIBLE
  dedicated WAG-owned visible profile

WAG_HEADLESS
  dedicated WAG-owned background profile
```

`AUTO` remains conservative. It is not yet promoted to automatically select an authenticated AI Tab Group.

## Remaining work

### Task 4 — target ownership / fencing

Still not implemented:

```text
target claim
owner_session_id
claim_epoch
heartbeat / expiry
stale-owner fencing
successor claim
```

Until Task 4 is complete, transport connectivity must not be interpreted as proof that multiple independent WAG processes can safely mutate the same tab concurrently.

### Cross-process WebSocket ownership

The current runtime assembly starts the browser-control server with the repository-engineering runtime. The loopback transport works and request correlation is verified, but a full shared-control-plane design across multiple independently started WAG processes has not been accepted.

```text
CROSS_PROCESS_MULTI_SESSION = NOT_PROVEN
```

Task 4 must settle ownership/sharing semantics rather than relying on port binding as coordination.

### Production pairing UX

The extension/runtime pairing protocol exists, and side-panel configuration/state message hooks exist, but final first-time product UX is not complete.

```text
PRODUCTION_PAIRING_UX = NOT_COMPLETE
```

A public build must not require users to manually edit extension storage or copy secrets through developer tooling.

### Real user profile

```text
USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED
```

The real Edge acceptance deliberately used a temporary profile to avoid modifying or competing with the user's daily browser while the architecture was still under development.

## STOP 2B decision

```text
AI_TAB_GROUP_IMPLEMENTATION = ACCEPTED_FOR_BRANCH
WEBSOCKET_TRANSPORT_PIVOT = ACCEPTED_FOR_BRANCH

PROCEED_TO_TASK_4_FENCING = YES
PROMOTE_TO_LIVE = NO
PUBLIC_LAUNCH = NO
PUBLIC_PUSH = NO
```
