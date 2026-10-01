# WAG Browser v2 — STOP 2 Existing-Target Discovery & Attach

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering HEAD: `4fdf0494460147874a5cc3f82e78f9d62c624a74`

## Result

```text
BROWSER_V2_TASK_2_TARGET_DISCOVERY = IMPLEMENTED
BROWSER_V2_TASK_3_SAFE_ATTACH_RELEASE = IMPLEMENTED
BROWSER_V2_SOURCE_INTEGRATION = PASS
REAL_EDGE_EXTENSION_DEBUGGER_FEASIBILITY = PASS (from Task 0.5)
REAL_EDGE_NATIVE_HOST_END_TO_END = VERIFICATION_BLOCKED
BROWSER_V2_STOP_2 = PARTIAL / VERIFICATION_BLOCKED
```

The remaining verification blocker is Windows Code Integrity refusing the newly built unsigned Browser Control native-host executable. No Windows security control was disabled or weakened.

## Implemented architecture

```text
browser.targets / browser.open(ATTACH_EXISTING,target_id)
                        |
                        v
                BrowserMcpContext
                        |
                        v
                  BrowserBroker
                        |
                        v
          AttachedExistingBrowserPort
                        |
                        v
       ExistingBrowserControlClient
                        |
        loopback TCP + bearer token
                        |
                        v
       dedicated Browser Control host
                        |
              Native Messaging
                        |
                        v
            WAG browser extension
                        |
                chrome.debugger
                        |
                        v
             exact existing tab
```

The Browser Control channel is separate from operator v4 and delegated-dispatch v5.

Native application name:

```text
com.openai.web_agent_gateway_browser_control
```

The extension origin is pinned to the existing stable WAG extension id.

## Discovery surface

A new read-only semantic MCP tool is added:

```text
browser.targets
```

It returns bounded sanitized target metadata:

```text
targetId
windowId
title
url
origin
active
attachable
ownership = USER_EXISTING
attached
```

No cookies, auth tokens, raw profile paths, query strings, URL fragments or debugger secrets are returned.

`browser.open` now accepts an optional exact `target_id`. `ATTACH_EXISTING` fails closed if an exact target is not supplied.

Browser opt-in surface is therefore eight semantic tools at this branch state:

```text
browser.targets
browser.open
browser.describe
browser.snapshot
browser.exec
browser.effect.get
browser.screenshot
browser.close
```

Raw CDP remains unpublished.

## Internal command boundary

The extension bridge accepts only the bounded transport commands required by the existing semantic engine:

```text
Accessibility.getFullAXTree
Page.navigate
DOM.scrollIntoViewIfNeeded
DOM.getBoxModel
Input.dispatchMouseEvent
DOM.focus
Input.dispatchKeyEvent
Input.insertText
DOM.setFileInputFiles
Page.captureScreenshot
```

For example, `Runtime.evaluate` is rejected before dispatch.

## Safe attach/release behavior

The attached BrowserPort:

- binds one BrowserPort session to one explicit `tab_N` target;
- exposes `executionMode = ATTACH_EXISTING`;
- exposes `ownershipMode = ATTACHED_EXISTING`;
- routes snapshot/exec/screenshot through the same semantic Browser layer used by managed modes;
- detaches debugger state on close;
- does not close the user's browser or tab;
- keeps WAG authority isolation for the logical BrowserPort session.

Per-target multi-session claim epochs/fencing are not implemented in this checkpoint; that remains Task 4.

## Multi-session transport foundation

The dedicated native host owns one loopback endpoint and publishes:

```text
%LOCALAPPDATA%\WebAgentGateway\browser-control-v1.json
```

The discovery file contains:

```text
protocolVersion
loopback endpoint
random bearer token
```

Multiple WAG processes can send bounded requests to the same host. The host multiplexes responses by opaque request id. This avoids a last-runtime-wins control-file design.

This is transport multiplexing only. Conflicting claims on the same tab are intentionally deferred to Task 4 fencing.

## Verification completed

### Focused and regression suites

```text
Browser/extension regression batch A = 72 / 72 PASS
Browser/private-runtime regression batch B = 30 / 30 PASS
new Browser Control contract tests = 10 / 10 PASS
full source ATTACH_EXISTING integration = 1 / 1 PASS

typecheck = PASS
build = PASS
git diff --check = PASS
```

The full source integration traverses:

```text
BrowserMcpContext
-> BrowserBroker
-> AttachedExistingBrowserPort
-> loopback host/client
-> Native Messaging framing
-> extension-control simulator
-> semantic snapshot
-> semantic fill
-> semantic click
-> final-state verification
-> release
```

and verifies that the logical target remains available after release.

### Existing real Edge feasibility

Task 0.5 previously proved against real Microsoft Edge:

- focus-free target discovery;
- debugger attach to an inactive target;
- debugger command execution;
- no query-secret leak;
- release without closing the tab/browser.

That remains valid evidence for the extension debugger transport itself.

## Real native-host acceptance attempt

A dedicated Browser Control SEA artifact was built successfully:

```text
E:\WAG-Acceptance\browser-control-task23\wag-native-browser-control.exe
size = 94249472 bytes
sha256 = 8a74004bb4611bb1bcf6e22ed3f5b91c69a384afad999834077ce7278c67d014
```

A dedicated manifest was generated and temporarily registered only at:

```text
HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\
  com.openai.web_agent_gateway_browser_control
```

The real authenticated local-fixture acceptance then attempted to load the current extension and start the dedicated native host.

The host did not start. Windows Code Integrity recorded:

```text
Event ID 3033
Event ID 3077
Result: executable did not meet Enterprise signing level requirements
Policy ID: {d8809ec6-f1a7-485c-bd87-9e2fd18c8bec}
```

Therefore:

```text
REAL_EDGE_NATIVE_HOST_END_TO_END = VERIFICATION_BLOCKED
```

This is not reported as an ATTACH_EXISTING functional failure because the executable was denied before the extension/native-host bridge could execute.

## Cleanup

The temporary Edge Browser Control registration was removed after the attempt.

Post-cleanup:

```text
HKCU Browser Control native-host key = ABSENT
browser-control-v1 discovery file = ABSENT
security policy changes = NONE
user real browser profile used = NO
public push = NO
live runtime promotion = NO
```

The built acceptance artifact remains under `E:\WAG-Acceptance\browser-control-task23` as local evidence only.

## Remaining risks

```text
signed/trusted Browser Control host real Edge acceptance = BLOCKED
actual user's authenticated profile acceptance = NOT EXECUTED
enterprise debugger-policy behavior beyond current machine = NOT MEASURED
per-target claim epoch / fencing = NOT IMPLEMENTED
stale claim recovery = NOT IMPLEMENTED
OAuth successor-target continuity = NOT IMPLEMENTED
browser-session recovery across runtime restart = NOT IMPLEMENTED
installer/product registration of Browser Control host = NOT IMPLEMENTED
```

## STOP 2 decision

Tasks 2-3 implementation is suitable to commit because source contracts, security bounds and full source integration pass.

However the Browser v2 STOP 2 acceptance gate is not fully PASS until the exact Browser Control native host can execute under Windows trust policy and the real Edge end-to-end acceptance completes.

```text
IMPLEMENTATION_COMMIT = YES
PROMOTE_TO_LIVE = NO
PUBLIC_LAUNCH = NO
PROCEED_AS_IF_STOP_2_PASS = NO
```
