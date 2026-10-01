# WAG Browser v2 — STOP 0 Baseline Architecture & Regression Lock

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Baseline HEAD entering Browser v2: `40d0c365d519fdd94596675c23ccd96093b60445`

## Result

```text
BROWSER_V2_STOP_0_BASELINE = PASS
BROWSER_V2_FEASIBILITY_SPIKE = NOT_EXECUTED
ATTACH_EXISTING = NOT_IMPLEMENTED
WAG_VISIBLE = NOT_IMPLEMENTED
WAG_HEADLESS = IMPLEMENTED_AS_CURRENT_WAG_OWNED_EDGE_PATH
```

Current architecture does not materially contradict the Browser v2 plan. The new architecture can preserve the existing BrowserPort semantic/effect surface while adding broker/adapter layers.

## Current public BrowserPort surface

Exactly seven BrowserPort tools are projected when browser support is enabled:

```text
browser.open
browser.describe
browser.snapshot
browser.exec
browser.effect.get
browser.screenshot
browser.close
```

The surface deliberately exposes semantic/effect operations, not CDP/Playwright implementation names.

## Current process/profile ownership model

### WAG-owned browser only

Current production assembly is:

```text
browser.open
  -> BrowserPort
  -> FileBrowserProfileStore
  -> OwnedEdgeCdpBackend
  -> OwnedEdgeLauncher
  -> dedicated Edge user-data-dir
  -> loopback remote-debugging port
  -> headless Edge
  -> CDP target attach
```

Important properties:

- browser allocation is lazy at `browser.open`;
- profile directory is WAG-owned and persistent;
- a profile is persistently bound to the exact WAG authority tuple;
- active BrowserPort sessions are held in an in-memory map;
- the backend selects one page target from the WAG-owned browser;
- commands are routed to the attached CDP target session;
- current Edge launch plan is headless;
- current close semantics are appropriate for WAG-owned targets/processes, not user-owned attached tabs.

## Current logical identity

Current durable-enough caller-facing identity is:

```text
browser_session_id
profile_id
backend
process_id? / pid?
state
created_at
last_seen_at
```

The browser session is not currently backed by a durable cross-runtime target binding.

The lower backend also has a CDP `targetId`, but the current model does not yet separate durable logical identity from ephemeral process/window/tab identities in the Browser v2 sense.

## Current semantic interaction engine

`src/browser-harness/semantic-browser.ts` already provides one semantic layer over BrowserPort.

### snapshot

- calls BrowserPort metadata snapshot;
- calls `Accessibility.getFullAXTree`;
- returns opaque snapshot-bound node refs;
- refs bind to `backendDOMNodeId`;
- stale refs fail closed after a new snapshot/navigation.

### click

Current semantic click:

```text
DOM.scrollIntoViewIfNeeded
DOM.getBoxModel
Input.dispatchMouseEvent mouseMoved
Input.dispatchMouseEvent mousePressed
Input.dispatchMouseEvent mouseReleased
```

Caller does not supply screen coordinates.

### fill

Current semantic fill:

```text
DOM.focus
Ctrl+A key down/up
Input.insertText
```

This is stronger than direct DOM property assignment and already models real input better than UIAutomation `SetValue`, but there is no acceptance proof yet for:

- React controlled inputs;
- React Hook Form/equivalent validation;
- Vue/Svelte/Angular controlled inputs;
- TipTap;
- ProseMirror;
- post-fill submit enablement.

Therefore:

```text
FRAMEWORK_SAFE_FILL = NOT PROVEN
RICH_TEXT_FILL = NOT PROVEN
```

### press

A bounded key allowlist is converted to CDP `Input.dispatchKeyEvent`.

## Existing exact-once effect behavior

The browser MCP runtime already wraps consequential semantic actions in the harness effect coordinator/ledger.

Existing tests prove:

- a succeeded browser effect is not replayed;
- an outcome-unknown effect blocks blind replay;
- `browser.effect.get` can recover durable effect state;
- diagnostics can correlate to durable effect state without replay.

This must be preserved unchanged through Browser v2.

## Existing extension/nativeMessaging architecture

The shipped MV3 extension is currently a ChatGPT operator/delegation adapter, not a general browser-control adapter.

Current manifest permissions:

```text
nativeMessaging
scripting
sidePanel
storage
```

Current host permission:

```text
https://chatgpt.com/*
```

The extension currently does **not** request:

```text
debugger
tabs
```

Current service worker:

- accepts observations only from trusted ChatGPT content-script senders;
- keeps per-tab correlation in `chrome.storage.session`;
- uses native host `com.openai.web_agent_gateway` for operator protocol v4;
- uses native host `com.openai.web_agent_gateway_v5` for delegated dispatch;
- can query/reinject/rescan already-open ChatGPT tabs only;
- does not expose a general tab inventory;
- does not attach `chrome.debugger` to existing user tabs.

The existing v4/v5 native protocols must not be overloaded with Browser v2 target-control authority. Browser v2 should add a separate bounded control bridge/adapter identity.

## Existing-session attach status

```text
discover arbitrary existing browser tabs without focus = NOT IMPLEMENTED
attach exact existing authenticated tab             = NOT IMPLEMENTED
preserve existing user auth through attach           = NOT IMPLEMENTED
release attached tab while browser remains open      = NOT IMPLEMENTED
```

Current workaround paths outside BrowserPort are not accepted as Browser v2 implementation.

## Multi-session isolation status

Current BrowserPort prevents foreign WAG authority from using another BrowserPort session and the profile store prevents profile ownership transfer.

However Browser v2 per-target semantics are not implemented:

```text
target claim = NOT IMPLEMENTED
claim epoch/fencing token = NOT IMPLEMENTED
stale target recovery = NOT IMPLEMENTED
two sessions on two existing user tabs = NOT IMPLEMENTED
```

No global Goal-Lease-style browser lock should be introduced.

## Visible browser / takeover status

Current Edge launch plan is explicitly headless.

Therefore:

```text
WAG_VISIBLE = NOT IMPLEMENTED
Pause = NOT IMPLEMENTED
Take Control = NOT IMPLEMENTED
Resume with revalidation = NOT IMPLEMENTED
```

## OAuth/new-target continuity status

Current raw CDP backend binds one selected page target. There is no Browser v2 logical successor-target model for:

- same-tab OAuth redirect continuity;
- new-tab OAuth;
- new-window OAuth;
- callback-to-origin continuity.

```text
OAUTH_TARGET_CONTINUITY = NOT IMPLEMENTED
```

## Runtime/session recovery status

Durable **effect** recovery exists.

Durable **browser target/session** recovery across runtime restart is not yet implemented because active BrowserPort sessions are in memory.

```text
EXACT_ONCE_EFFECT_RECOVERY = IMPLEMENTED
BROWSER_SESSION_RECOVERY = NOT IMPLEMENTED
```

## Baseline regression gate

The focused BrowserPort/extension baseline initially found one stale test assumption:

```text
expected total projected surface = 51
actual current projected surface = 67
```

The failure was not Browser behavior. The repository had legitimately gained document/search/product/remote Git tools after that fixed count was written.

The assertion was changed to the stronger invariant:

```text
browser opt-in surface
  = current non-browser surface
  + exactly seven BrowserPort tools
```

and still asserts raw `cdp` / `playwright` implementation names are not published.

Final baseline:

```text
66 / 66 PASS
```

## Planned file-level changes

Exact names may be refined by the feasibility spike, but the ownership boundaries are fixed.

### Task 0.5 — extension debugger feasibility

Create:

- `browser/extension/existing-browser-control-v1.js`
- `test/browser-existing-control-v1.test.ts`
- controlled integration/acceptance harness for real Edge extension attach

Modify:

- `browser/extension/manifest.json` — add only permissions actually required for general existing-tab discovery/attach;
- `browser/extension/service-worker.js` — compose the new adapter without weakening existing ChatGPT operator sender/authority rules.

Do not expose raw CDP to MCP.

### Task 1 — BrowserBroker + execution modes

Create:

- `src/browser-harness/browser-broker.ts`

Modify:

- `src/browser-harness/browser-port.ts`
- `src/browser-harness/browser-mcp-runtime.ts`
- `src/browser-harness/edge-launch-plan.ts`
- `src/browser-harness/owned-edge-launcher.ts`

Introduce mode/ownership metadata while preserving existing seven-tool behavior unless API consolidation later proves necessary.

### Task 2 — target discovery

Create a bounded extension/native control protocol rather than reusing operator v4/v5 authority.

Likely create:

- `src/browser-adapter/existing-browser-control-protocol.ts`
- a dedicated native-host/control bridge entrypoint and tests.

Discovery returns sanitized target metadata only.

### Task 3 — safe attach + ownership

Create:

- `src/browser-harness/browser-target-ownership.ts` or equivalent durable store/coordinator.

Bind:

```text
browser_session_id
target_id
target_generation
owner_session_id
claim_epoch
expires_at
```

Attached-browser release must detach, not close the user's browser.

### Task 4 — multi-session fencing

Extend ownership store/coordinator and BrowserBroker.

Every effect on an attached target must bind the current claim epoch. Old epochs fail with `TARGET_FENCED`.

### Task 5 — framework-safe fill

Modify:

- `src/browser-harness/semantic-browser.ts`
- semantic browser tests;
- controlled fixture pages/tests.

Acceptance is based on framework/model postconditions, not merely dispatched event sequence.

### Task 6 — rich text/contenteditable

Extend the same semantic fill engine and fixtures for:

- contenteditable;
- ProseMirror;
- TipTap;
- textarea.

Do not create an unrelated second interaction engine.

## STOP 0 decision

No material architecture contradiction was found.

Recommendation:

```text
PROCEED_TO_FEASIBILITY_SPIKE = YES
```

But by the Browser v2 operating contract, implementation stops here for STOP 0 reporting before the debugger/attach feasibility work begins.
