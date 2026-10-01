# WAG Browser v2 — STOP 6 OAuth / Successor-Target Continuity

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering HEAD: `cf4526cab545a2599883802f87e51b299cc1a6b4`

## Result

```text
OAUTH_SUCCESSOR_TARGET_CONTINUITY = PASS
SAME_TAB_REDIRECT_CONTINUITY = PASS
NEW_TAB_NEW_WINDOW_SUCCESSOR = PASS
CALLBACK_TO_ROOT_CONTINUITY = PASS
LOGICAL_BROWSER_SESSION_STABILITY = PASS
SUCCESSOR_TARGET_FENCING = PASS
AI_TAB_GROUP_SUCCESSOR_GROUPING = PASS
USER_ACTIVE_TAB_STABILITY = PASS

REAL_EDGE_LOCAL_OAUTH_FIXTURE = PASS
REAL_EXTERNAL_OAUTH_PROVIDER = NOT_EXECUTED
USER_DAILY_EDGE_PROFILE = NOT_EXECUTED

LIVE_RUNTIME_PROMOTION = NO
PUBLIC_LAUNCH = NO
PUBLIC_PUSH = NO
```

## Logical target model

An attached Browser v2 session now separates durable workflow identity from ephemeral browser target identity:

```text
browser_session_id       durable logical workflow
root_target_id           original workflow tab
target_id                current browser tab
target_generation        monotonic in-session target switch generation
claim_epoch              durable per-target ownership epoch
```

A new OAuth/new-target transition does not mint a new WAG browser session.

Example:

```text
browser_session_id = browser_X

generation 0
root = tab_A
current = tab_A

OAuth popup
        |
        v

generation 1
root = tab_A
current = tab_B

callback / popup closes
        |
        v

generation 2
root = tab_A
current = tab_A
```

The MCP session projection now exposes `rootTargetId` and `targetGeneration` together with the current `targetId`.

## Continuity observation

The Edge extension records bounded tab activity using:

- `chrome.tabs.onCreated`;
- URL-changing `chrome.tabs.onUpdated`;
- opener ancestry;
- a monotonically increasing in-memory activity sequence.

The initial target establishes a continuity baseline through:

```text
target.watch
```

WAG later asks:

```text
target.continuity
  rootTargetId
  currentTargetId
```

Possible bounded results are:

```text
NO_CHANGE
ROOT_UPDATED
SUCCESSOR
CURRENT_GONE
```

Successor selection is not a global "newest tab" heuristic.

A candidate successor must descend through the opener chain from the watched root. Unrelated browser tabs are ignored.

The chain walk is bounded to 16 ancestors.

## Privacy boundary

Continuity metadata uses the existing sanitized target representation.

Returned URLs remove:

- credentials;
- query strings;
- fragments.

OAuth authorization codes, `state`, tokens and other query/fragment secrets are therefore not surfaced through Browser v2 target metadata.

No cookies or browser auth tokens are exported.

## Target switching and fencing

Before WAG switches to a successor:

1. the logical session claims the successor target;
2. the claim receives the current durable `claim_epoch`;
3. AI Tab Group mode groups the successor and verifies active-tab stability;
4. the extension attaches the debugger to the successor;
5. only after successor attach succeeds does WAG detach the previous debugger target;
6. `target_generation` increments.

The logical session retains claims for targets traversed by the workflow.

On close, all retained target claims are released rather than leaving old root/successor claims to expire by TTL.

Every browser operation continues to use the Task 4 per-target fencing model.

A successor target therefore does not bypass multi-session ownership.

## Effect-fence refresh

A continuity switch can occur while producing a new semantic snapshot.

Browser MCP now refreshes its current target/claim binding after:

- semantic snapshot;
- screenshot;
- explicit describe.

This prevents the exact-once effect layer from retaining a stale target fence after the logical browser session has legitimately switched to an OAuth successor.

If the binding changes unexpectedly between the latest accepted observation and a consequential effect, the effect still fails closed instead of being replayed against a different target.

## OAuth launch gesture without OS mouse contention

The WAG-owned fixed DOM click path remains the preferred background activation mechanism.

For the exact fixed click function only, Browser v2 now supplies CDP:

```text
userGesture = true
```

This allows browser-mediated popup flows such as OAuth `window.open()` without requiring:

- Windows mouse injection;
- foreground-window activation;
- UIAutomation;
- arbitrary JavaScript.

The extension validates the exact fixed click function and exact parameter shape.

`Runtime.evaluate` remains denied.

Other WAG-owned fixed Runtime functions, including framework-safe native fill and rich-text selection, do not receive the widened click parameter shape.

## WebSocket protocol

Both Browser Control transports understand:

```text
target.watch
target.continuity
```

The accepted Browser v2 path remains the authenticated loopback WebSocket transport.

The legacy native-control implementation is kept protocol-compatible but is not required by this accepted Browser v2 flow.

## Real Microsoft Edge acceptance

A real Edge acceptance used:

- Microsoft Edge;
- a temporary Edge profile;
- the real WAG browser extension modules;
- authenticated loopback WebSocket control;
- an initially inactive application tab;
- a local OAuth-shaped app/provider/callback workflow;
- real `window.open()`;
- real successor tab/window discovery;
- real callback return to the root target.

Observed result:

```json
{
  "status": "PASS",
  "transport": "LOOPBACK_WEBSOCKET",
  "executionMode": "AI_TAB_GROUP",
  "browserSessionStable": true,
  "successorObserved": true,
  "successorGeneration": 1,
  "returnedToRoot": true,
  "finalTargetGeneration": 2,
  "authenticatedSessionPreserved": true,
  "callbackStateVerified": true,
  "originalUserTabStayedActive": true,
  "windowsUiAutomationUsed": false,
  "osPointerInjectionUsed": false,
  "arbitraryJavascriptExposed": false,
  "nativeBrowserControlExecutable": false,
  "userRealProfileUsed": false
}
```

The acceptance deliberately does not record the ephemeral tab id in this receipt.

## Regression verification

Latest broad Browser/runtime regression:

```text
browser / extension / OAuth batch A = 76 / 76 PASS
Browser MCP / semantic batch B       = 44 / 44 PASS
control / runtime / fencing batch C  = 29 / 29 PASS

total                                  149 / 149 PASS
```

Real Edge regression after OAuth continuity changes:

```text
OAuth successor-target continuity = PASS
AI_TAB_GROUP                      = PASS
framework-safe input/React fill   = PASS
rich text / ProseMirror / TipTap  = PASS
```

Final source gates:

```text
typecheck       = PASS
build           = PASS
git diff --check = PASS
```

## Remaining limits

This checkpoint does not claim:

```text
REAL_EXTERNAL_OAUTH_PROVIDER = PASS
USER_DAILY_EDGE_PROFILE = PASS
CROSS_RUNTIME_SESSION_RECOVERY = PASS
PRODUCTION_PAIRING_UX = COMPLETE
AUTO_SELECTS_AI_TAB_GROUP = YES
```

The acceptance provider is a local OAuth-shaped fixture, not Google, GitHub, Microsoft, or another production identity provider.

## STOP 6 decision

```text
OAUTH_CONTINUITY_IMPLEMENTATION = ACCEPTED_FOR_BRANCH
PROCEED_TO_RUNTIME_SESSION_RECOVERY = YES

PROMOTE_TO_LIVE = NO
PUBLIC_LAUNCH = NO
PUBLIC_PUSH = NO
```
