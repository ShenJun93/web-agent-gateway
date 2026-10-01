# WAG Browser v2 — STOP 10 Final Public-Launch Gate

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering HEAD: `3a516652`

## Result

```text
USER_DAILY_EDGE_PROFILE_ACCEPTANCE = PASS
LIVE_FIRST_TIME_PAIRING_BY_REAL_USER = PASS
AUTO_TO_AI_TAB_GROUP_DAILY_PROFILE = PASS
BOUNDED_READ_ONLY_DAILY_PROFILE_FLOW = PASS
REAL_PROFILE_AX_RESOURCE_FIX = PASS

BROWSER_V2_FINAL_TECHNICAL_GATE = PASS_FOR_BRANCH

PUBLIC_PUSH = NO
LIVE_RUNTIME_PROMOTION = NO
PUBLIC_LAUNCH_EXECUTION = STOP_PENDING_EXPLICIT_APPROVAL
```

This checkpoint closes the final Browser v2 evidence gap using the user's normal Microsoft Edge profile.

It does **not** push the branch, promote the runtime, publish an npm package, deploy hosted infrastructure, or alter public distribution state.

## Daily-profile acceptance scope

The user loaded the current WAG Browser Adapter extension into the existing daily Edge profile and completed the side-panel pairing flow.

The acceptance runner then selected only the active attachable HTTP(S) tab and executed:

```text
AUTO
  -> AI_TAB_GROUP
  -> semantic snapshot
  -> Pause for User
  -> Resume Automation
  -> release
```

The gate deliberately did **not**:

```text
navigate
fill
click
submit
read cookies
read authentication tokens
use Windows UI Automation
inject operating-system pointer input
close the tab
close Edge
```

The observed sanitized result was:

```json
{
  "status": "PASS",
  "userDailyEdgeProfileUsed": true,
  "transport": "LOOPBACK_WEBSOCKET",
  "requestedMode": "AUTO",
  "executionMode": "AI_TAB_GROUP",
  "ownershipMode": "ATTACHED_EXISTING",
  "pairingConnected": true,
  "selectedTargetWasActive": true,
  "activeTabStable": true,
  "semanticSnapshotSucceeded": true,
  "semanticNodeCountObserved": 500,
  "snapshotTruncated": true,
  "pauseState": "PAUSED_FOR_USER",
  "resumeState": "RUNNING",
  "releaseState": "CLOSED",
  "targetStillOpenAfterRelease": true,
  "browserStillRunningAfterRelease": true,
  "noNavigate": true,
  "noFill": true,
  "noClick": true,
  "noSubmit": true,
  "noCookieRead": true,
  "noTokenRead": true,
  "noWindowsUiAutomation": true,
  "noOsPointerInjection": true
}
```

## Real-profile issue discovered and fixed

The first daily-profile run reached:

```text
pairing PASS
AUTO attach PASS
snapshot FAIL
```

The bounded failure was:

```text
Browser control response exceeds size limit
```

The cause was a real-world Accessibility tree larger than the generic 256 KiB Browser Control response budget.

The fix remains bounded and method-specific:

```text
ordinary Browser Control response       <= 256 KiB
Accessibility.getFullAXTree response    <= 4 MiB
screenshot decoded size                 <= 8 MiB
pending Browser Control requests        <= 128
enumerated targets                      <= 512
semantic AX source nodes                <= 2,000
semantic nodes returned through MCP     <= 500
active Browser MCP sessions             <= 32
```

Only `Accessibility.getFullAXTree` receives the larger transport budget. Other `target.exec` responses remain under the 256 KiB generic limit.

The daily-profile gate was then rerun without changing the user's tab or browser and passed.

## Pairing evidence

The real user performed the intended first-time flow:

```text
load WAG extension into daily Edge profile
  -> open WAG side panel
  -> paste one-time local pairing payload
  -> Pair
  -> extension connects outbound to 127.0.0.1 Browser Control server
```

Therefore:

```text
LIVE_FIRST_TIME_PAIRING_BY_REAL_USER = PASS
```

The acceptance pairing payload was never printed into chat.

After the gate:

- Windows clipboard was cleared;
- the temporary server was stopped;
- TCP port 17841 was confirmed free;
- temporary `pairing.json`, claim/effect/session SQLite files and diagnostics were deleted;
- only sanitized `result.json` and `status.json` remain under the local acceptance directory.

The extension may still retain the now-dead acceptance pairing configuration in its own local extension storage. The server-side pairing secret no longer exists. A live promoted runtime should replace or explicitly clear that pairing state during product activation.

## Final Browser/runtime regression

After the real-profile AX response-budget fix:

```text
Browser / extension / WebSocket / broker batch = 82 / 82 PASS
Browser MCP / CDP / owned Edge batch           = 17 / 17 PASS
Profile / semantic / fencing / recovery batch  = 32 / 32 PASS
Control protocol / runtime assembly batch      = 32 / 32 PASS

Total                                           = 163 / 163 PASS
```

The new transport-bound test explicitly proves:

- ordinary non-screenshot responses above 256 KiB are rejected;
- Accessibility tree responses may use the bounded larger budget;
- target enumeration remains capped at 512;
- pending requests remain capped at 128.

## Real Edge regressions after the fix

### AUTO / AI Tab Group

```text
status = PASS
requestedMode = AUTO
executionMode = AI_TAB_GROUP
authenticatedSessionPreserved = true
activeTabStable = true
semantic fill/click = PASS
target/browser preserved after release = true
OS pointer injection = false
Windows UI Automation = false
```

### OAuth continuity

```text
status = PASS
browserSessionStable = true
successorObserved = true
returnedToRoot = true
authenticatedSessionPreserved = true
callbackStateVerified = true
originalUserTabStayedActive = true
arbitraryJavascriptExposed = false
```

### Runtime recovery / exact-once

```text
status = PASS
browserSessionStable = true
claim epoch = 1 -> 2
extensionReconnected = true
durableEffectReceiptPreserved = true
completedEffectReplayBlocked = true
consequentialClickCount = 1
activeTabStable = true
target/browser preserved = true
```

## Product / non-browser regression

Final product suite after the Browser v2 change:

```text
WAG product / non-browser = 58 / 58 PASS
```

This includes document operations, update discovery, doctor, local launcher/setup, transactional update/rollback, uninstall and packaged runtime lock synchronization.

The prior production-local DC replacement gate remains:

```text
WAG_DC_REPLACEMENT_V1_PRODUCTION_LOCAL = 1 / 1 PASS
operatorApprovals = 0
autonomousLocalEffects = true
```

## Engineering gates

```text
typecheck = PASS
build = PASS
git diff --check = PASS
```

## Final Browser v2 matrix

```text
[PASS] managed WAG_HEADLESS
[PASS] managed WAG_VISIBLE
[PASS] Pause / Take Control / Resume
[PASS] exact existing-target discovery
[PASS] AUTO exact target -> AI_TAB_GROUP
[PASS] first-time pairing UX
[PASS] daily Edge profile pairing
[PASS] daily Edge profile AUTO attach
[PASS] read-only semantic snapshot on real daily profile
[PASS] release preserves real user tab/browser
[PASS] framework-safe fill
[PASS] rich text / ProseMirror / TipTap
[PASS] OAuth successor continuity
[PASS] two-session target fencing
[PASS] restart/session recovery
[PASS] exact-once no duplicate consequential effect
[PASS] sanitized diagnostics
[PASS] bounded Browser Control transport/resources
[PASS] broad Browser/runtime regression
[PASS] non-browser product regression
```

## STOP 10 decision

```text
BROWSER_V2_FINAL_TECHNICAL_GATE = PASS_FOR_BRANCH
USER_DAILY_EDGE_PROFILE_ACCEPTANCE = PASS
LIVE_FIRST_TIME_PAIRING_BY_REAL_USER = PASS

READY_FOR_EXPLICIT_PUBLICATION_OR_PROMOTION_DECISION = YES

PUBLIC_PUSH = NO
LIVE_RUNTIME_PROMOTION = NO
PUBLIC_NPM_PUBLISH = NO
PUBLIC_LAUNCH = NO
```

The implementation is technically ready to move to the explicit publication/promotion decision. Those actions remain separate irreversible/public authority gates and are not performed by this checkpoint.
