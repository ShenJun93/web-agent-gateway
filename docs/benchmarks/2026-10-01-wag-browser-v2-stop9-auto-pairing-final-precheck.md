# WAG Browser v2 — STOP 9 AUTO + Pairing + Final Precheck

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering implementation HEAD: `57a4fea7896fe9a0213b0af36cf5b35047cc4ffc`

## Result

```text
AUTO_EXACT_TARGET_SELECTION = PASS
FIRST_TIME_PAIRING_IMPLEMENTATION = PASS
PAIRING_AUTHORITY_BOUNDARY = PASS
PAIRING_SECRET_DOM_RETENTION = PASS

WAG_HEADLESS_REAL_EDGE = PASS
WAG_VISIBLE_REAL_EDGE = PASS
WAG_VISIBLE_TAKEOVER = PASS
AUTO_TO_AI_TAB_GROUP_REAL_EDGE = PASS
FRAMEWORK_SAFE_FILL_REAL_EDGE = PASS
RICH_TEXT_REAL_EDGE = PASS
OAUTH_CONTINUITY_REAL_EDGE = PASS
RUNTIME_RECOVERY_EXACT_ONCE_REAL_EDGE = PASS

BROWSER_RUNTIME_REGRESSION = 162 / 162 PASS
AUTO_PAIRING_FOCUSED = 35 / 35 PASS
WAG_PRODUCT_NON_BROWSER = 58 / 58 PASS
DC_REPLACEMENT_PRODUCTION_LOCAL = 1 / 1 PASS
TYPECHECK = PASS
BUILD = PASS
DIFF_CHECK = PASS

USER_DAILY_EDGE_PROFILE_ACCEPTANCE = NOT_EXECUTED
LIVE_FIRST_TIME_PAIRING_BY_REAL_USER = NOT_EXECUTED
LEGACY_NATIVE_BROWSER_CONTROL_HOST = NOT_PRODUCT_PATH / HISTORICALLY CODE_INTEGRITY_BLOCKED
PUBLIC_LAUNCH = NO
LIVE_RUNTIME_PROMOTION = NO
PUBLIC_PUSH = NO
```

This checkpoint finishes the remaining source/product plumbing before the real-user profile gate. It does not convert temporary-profile acceptance into user-profile evidence.

## AUTO selection

AUTO remains fail-closed and does not attempt to infer login state from page content, cookies or credentials.

The routing rule is now:

```text
AUTO + no exact target_id
  -> WAG_HEADLESS

AUTO + exact target_id selected from browser.targets
  -> AI_TAB_GROUP
```

The exact target id is the caller's explicit selection boundary. WAG does not inspect cookies or authentication secrets to guess whether a tab is logged in.

The rule is wired through both:

```text
BrowserMcpContext
BrowserBroker
```

and covered by focused tests.

### Real Edge AUTO proof

The AI Tab Group acceptance was changed to request:

```text
requestedMode = AUTO
target_id = exact discovered inactive target
```

Observed real Microsoft Edge result:

```json
{
  "status": "PASS",
  "transport": "LOOPBACK_WEBSOCKET",
  "nativeBrowserControlExecutable": false,
  "requestedMode": "AUTO",
  "executionMode": "AI_TAB_GROUP",
  "ownershipMode": "ATTACHED_EXISTING",
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

Therefore AUTO is no longer accepted only by unit routing tests; the current product transport has exercised it against real Edge.

## First-time pairing UX

Browser v2 keeps the existing authenticated loopback WebSocket transport:

```text
Edge extension
   |
   | exact extension Origin + random pairing token
   v
ws://127.0.0.1:<port>/browser-control
   |
WAG Local
```

The new first-time flow is explicit:

1. WAG Local creates the owner-only pairing state as part of the browser-control runtime.
2. The user explicitly asks the local CLI for the current payload:
   ```text
   web-agent-gateway browser-pairing --config <absolute-path>
   ```
3. The side panel accepts that JSON once.
4. The service worker validates that configure/state/clear messages come from the side panel.
5. The transport validates loopback-only WebSocket configuration.
6. After a Pair attempt, the pasted payload is cleared from the rendered textarea.
7. The UI displays connection state and endpoint only; it does not render the pairing token.
8. Forget pairing disconnects and removes the stored configuration.

No pairing token is added to diagnostics, tool results, page observations or ordinary error text by this work.

### Pairing security properties

```text
HTTP secret endpoint = NO
remote endpoint = DENIED
page/content-script configure authority = DENIED
sidepanel configure authority = YES
sidepanel clear authority = YES
token re-render after pair = NO
manual extension-storage editing = NOT REQUIRED
runtime auto-start from browser-pairing CLI = NO
```

The CLI command is read-only with respect to the runtime. If the pairing state is unavailable it fails with a sanitized `BROWSER_PAIRING_UNAVAILABLE` error instead of creating a second browser-control runtime.

## Resource/package housekeeping

The non-browser product suite exposed a pre-existing packaging drift:

```text
packaging/runtime-package-lock.json != package-lock.json
```

The drift existed at entering HEAD and was not caused by AUTO/pairing changes. It omitted dependencies introduced by prior Browser v2 work, including WebSocket and framework/rich-text acceptance dependencies.

The packaged runtime lock was synchronized byte-for-byte with the canonical project lock and committed separately:

```text
57a4fea7896fe9a0213b0af36cf5b35047cc4ffc
chore: sync packaged runtime lock
```

After repair:

```text
wag-local-setup focused = 7 / 7 PASS
WAG product/non-browser = 58 / 58 PASS
```

The known WAG `git.commit` index anomaly temporarily presented the lock as `MM`; resetting only the index to HEAD restored the correct committed/worktree state without changing file content.

## Verification

### AUTO + pairing focused gate

```text
35 / 35 PASS
```

Coverage includes:

- AUTO no-target -> WAG_HEADLESS;
- AUTO exact-target -> AI_TAB_GROUP;
- loopback WebSocket configure;
- invalid/non-loopback configuration rejection;
- clearConfig disconnect + storage removal;
- CLI pairing state read without runtime bootstrap;
- sanitized unavailable-state error;
- sidepanel-only configure/state/clear authority;
- pasted token cleared from the panel DOM after pairing;
- no pairing-token rendering in status/result elements;
- existing v4 extension authority/order invariants.

### Broad Browser/runtime regression

Latest batches:

```text
Browser / extension / WebSocket / broker batch = 81 / 81 PASS
Browser MCP / CDP / owned Edge batch           = 17 / 17 PASS
Profile / semantic / fencing / recovery batch  = 32 / 32 PASS
Control protocol / runtime assembly batch      = 32 / 32 PASS

Total                                             162 / 162 PASS
```

### Non-browser product regression

```text
WAG product/non-browser suite = 58 / 58 PASS
```

This covers bounded document operations, update discovery, product UX, doctor, launchers, transactional update/rollback, uninstall, setup and packaged runtime lock synchronization.

### DC replacement production-local acceptance

The acceptance needed longer than the 30-second repository command wrapper limit, so it was run unchanged in a WAG-owned interactive machine terminal.

```text
WAG_DC_REPLACEMENT_V1_PRODUCTION_LOCAL = 1 / 1 PASS
operatorApprovals = 0
autonomousLocalEffects = true
baselineExitCode = 1
afterFixExitCode = 0
```

The first two wrapper attempts timed out before verdict and are not treated as failures; the completed interactive run is the measured result.

### Real Edge managed modes

`scripts/spike-browser-broker-modes.ts`:

```text
status = PASS

WAG_HEADLESS
  browserSessionIdStable = true
  executionMode = WAG_HEADLESS
  ownershipMode = WAG_OWNED
  controlState = RUNNING
  closedState = CLOSED

WAG_VISIBLE
  browserSessionIdStable = true
  executionMode = WAG_VISIBLE
  ownershipMode = WAG_OWNED
  Pause = PAUSED_FOR_USER
  Take Control = USER_CONTROL
  Resume = RUNNING
  control effect states = SUCCEEDED / SUCCEEDED / SUCCEEDED
  closedState = CLOSED
```

### Real Edge AI Tab Group / exact existing target

```text
AUTO -> AI_TAB_GROUP = PASS
authenticated fixture session preserved = true
inactive target preserved = true
user active tab stable = true
semantic snapshot/fill/click = PASS
release keeps target open = true
release keeps browser open = true
OS pointer injection = false
Windows UI Automation = false
```

### Framework-safe fill

```text
status = PASS
plain input replacement = true
textarea replacement = true
React controlled DOM value = true
React controlled state = true
React validation state = true
React submit enabled = true
append-instead-of-replace = false
active tab stable = true
```

### Rich text

```text
status = PASS
contenteditable model = true
ProseMirror model = true
TipTap model = true
replacement-not-append = true
active tab stable = true
```

### OAuth continuity

```text
status = PASS
transport = LOOPBACK_WEBSOCKET
executionMode = AI_TAB_GROUP
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
transport = LOOPBACK_WEBSOCKET
executionMode = AI_TAB_GROUP
browserSessionStable = true
claim epoch 1 -> 2
extensionReconnected = true
durableEffectReceiptPreserved = true
completedEffectReplayBlocked = true
consequentialClickCount = 1
activeTabStable = true
targetStayedOpen = true
browserStayedOpen = true
```

## Legacy native-host acceptance

`accept-browser-v2-existing-runtime.ts` still targets the historical dedicated Native Messaging Browser Control host.

On this machine it does not create its discovery file because the old unsigned native executable remains subject to the previously documented Windows Code Integrity restriction.

STOP 2B explicitly replaced that dependency for Browser v2 with the accepted authenticated loopback WebSocket path. Therefore:

```text
LEGACY_NATIVE_HOST_PATH = HISTORICAL / NOT REQUIRED BY CURRENT BROWSER_V2 PRODUCT PATH
CURRENT_LOOPBACK_WEBSOCKET_PRODUCT_PATH = PASS
```

The legacy failure must not be misreported as a current WebSocket attach failure.

## Evidence still missing

### User daily Edge profile

Every real Edge acceptance in this checkpoint used a temporary profile and controlled local fixture.

Therefore:

```text
USER_DAILY_EDGE_PROFILE_ACCEPTANCE = NOT_EXECUTED
```

This checkpoint does not prove:

- pairing the product extension in the user's normal daily Edge profile;
- selecting an already-authenticated real user tab from that profile;
- AUTO grouping/attaching that real tab;
- Pause/Take Control/Resume in the real daily profile;
- release while preserving that browser and login session.

### Live first-time pairing by a real user

The implementation, authority checks and extension source behavior pass automated verification, but the actual one-time copy/paste side-panel flow has not yet been performed by a real user in the daily profile.

```text
LIVE_FIRST_TIME_PAIRING_BY_REAL_USER = NOT_EXECUTED
```

## Final precheck matrix

```text
[PASS] feasibility / managed BrowserPort
[PASS] BrowserBroker multi-mode architecture
[PASS] WAG_HEADLESS real Edge
[PASS] WAG_VISIBLE real Edge
[PASS] Pause / Take Control / Resume
[PASS] exact-target discovery / attach / release on current WebSocket path
[PASS] two-session durable target fencing regressions
[PASS] framework-safe React fill
[PASS] rich-text / ProseMirror / TipTap fill
[PASS] OAuth successor continuity
[PASS] runtime restart recovery
[PASS] exact-once no duplicate consequential effect
[PASS] sanitized bounded browser diagnostics
[PASS] resource bounds
[PASS] AUTO exact target -> AI_TAB_GROUP
[PASS] first-time pairing implementation / authority / privacy
[PASS] non-browser product regression

[NOT EXECUTED] user daily Edge profile acceptance
[NOT EXECUTED] live first-time pairing by real user in daily profile
```

## STOP 9 decision

```text
AUTO_SELECTION_IMPLEMENTATION = ACCEPTED_FOR_BRANCH
PAIRING_UX_IMPLEMENTATION = ACCEPTED_FOR_BRANCH
TECHNICAL_FINAL_PRECHECK = PASS

USER_PROFILE_FINAL_GATE = PENDING
PUBLIC_LAUNCH = NO
LIVE_RUNTIME_PROMOTION = NO
PUBLIC_PUSH = NO
```

Next action is the bounded real-user-profile acceptance. No public push or live promotion should occur before that evidence is recorded.
