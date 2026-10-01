# WAG Browser v2 — STOP 4 / Task 5 Framework-Safe Fill

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering HEAD: `906c239efdf0db8bf5af3844a203a64924ff1d55`

## Result

```text
PLAIN_INPUT_REPLACEMENT = PASS
TEXTAREA_REPLACEMENT = PASS
REACT_CONTROLLED_INPUT = PASS
REACT_STATE_POSTCONDITION = PASS
CONTROLLED_VALIDATION_POSTCONDITION = PASS
SUBMIT_ENABLE_POSTCONDITION = PASS
STANDARD_REPLACEMENT_NOT_APPEND = PASS
BACKGROUND_ACTIVE_TAB_STABILITY = PASS
REAL_EDGE_FRAMEWORK_FILL = PASS

RICH_TEXT_CONTENTEDITABLE = NOT_PROVEN
PROSEMIRROR_TIPTAP = NOT_PROVEN
USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED
LIVE_RUNTIME_PROMOTION = NO
PUBLIC_PUSH = NO
```

## RED evidence before the fix

The existing fill path was:

```text
DOM.focus
Ctrl+A key down/up
Input.insertText
```

Real Edge acceptance against an initially populated background input failed the replacement postcondition.

Observed value:

```text
expected: plain-new
actual:   plain-newplain-old
```

This proved background `Ctrl+A` selection was not reliable enough to claim standard replacement semantics.

Task 5 therefore changed the implementation only after a real postcondition failure.

## Accepted fill strategy

For native `<input>` and `<textarea>` elements, semantic fill now prefers:

```text
DOM.resolveNode
Runtime.callFunctionOn(FIXED_NATIVE_VALUE_FILL_FUNCTION)
Runtime.releaseObject
```

The fixed function:

1. accepts only a native input or textarea;
2. obtains the native prototype `value` setter;
3. replaces the entire value;
4. dispatches bubbling `input`;
5. dispatches bubbling `change`;
6. returns the resulting element value;
7. fails the semantic effect if the returned value does not equal the requested text.

The old bounded keyboard path remains only as fallback for editable surfaces that are not native input/textarea elements.

Rich contenteditable/editor behavior is intentionally deferred to Task 6.

## Framework behavior

The prototype setter is deliberate.

Controlled frameworks may install value tracking around individual elements. Calling the native prototype setter updates the browser value while allowing the subsequent bubbling events to be observed by the framework model.

Acceptance is based on state/postconditions, not merely on whether events were dispatched.

## Security boundary

Browser v2 still does not expose arbitrary JavaScript.

`Runtime.evaluate` remains denied.

`Runtime.callFunctionOn` is accepted only for WAG-owned exact function bodies.

The new fill function requires exact parameter shape:

```text
objectId
functionDeclaration = exact fixed fill function
arguments = exactly [{ value: <bounded string> }]
returnByValue = true
```

The extension rejects:

- arbitrary function bodies;
- extra argument fields;
- NUL-containing fill text;
- fill text above the 64 KiB UTF-8 limit;
- malformed object ids;
- widened Runtime.callFunctionOn parameter shapes.

The existing fixed click function remains separately admitted and unchanged.

## Real React fixture

Task 5 uses real React, not a simulated framework.

Dev-only acceptance dependencies:

```text
react      19.2.0
react-dom  19.2.0
```

They are bundled locally for the fixture with the existing esbuild dev dependency.

They are not production/runtime dependencies and are not included to implement WAG browser control.

The real Edge fixture contains:

- plain input with an existing value;
- textarea with existing content;
- React controlled input whose DOM value is driven by React state;
- React controlled validated field;
- validation state rendered from React state;
- submit button disabled/enabled from React state.

## Acceptance postconditions

Real Edge `AI_TAB_GROUP` acceptance verified:

```text
plain input exact value         plain-new
textarea exact value            notes-new
React controlled DOM value      react-new
React rendered state            react-state:react-new
validated input exact value     valid-text
React validation state          validation:valid:valid-text
React submit button disabled    false
active user tab                 unchanged
OS pointer injection            false
Windows UIAutomation            false
```

The acceptance target began inactive and stayed background-capable.

The test used a temporary Edge profile.

```text
USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED
```

## Regression

Latest broad Browser/runtime regression after the fill change and transport dependency update:

```text
Browser / extension / WebSocket batch A = 76 / 76 PASS
Browser MCP / semantic / private batch B = 39 / 39 PASS
Control / runtime / claim-fencing batch C = 28 / 28 PASS

Total broad Browser regression = 143 / 143 PASS
```

Real acceptance:

```text
framework-safe fill real Edge = PASS
AI_TAB_GROUP real Edge regression = PASS
```

Final gates:

```text
typecheck = PASS
build = PASS
git diff --check = PASS
```

## WebSocket dependency security update

During Task 5 verification, production audit identified the previous direct dependency:

```text
ws 8.18.3
```

as affected by published memory disclosure / memory exhaustion advisories.

The dependency was upgraded to the non-major patched version:

```text
ws 8.22.0
```

After upgrade:

```text
npm audit --omit=dev = 0 vulnerabilities
```

The full Browser/WebSocket regression and both real Edge acceptances were rerun after this upgrade.

## Files materially changed

```text
src/browser-harness/semantic-browser.ts
browser/extension/existing-browser-control-v1.js
test/browser-harness-semantic.test.ts
test/browser-existing-control-v1.test.ts
scripts/accept-browser-v2-framework-fill.ts
package.json
package-lock.json
```

## Remaining Browser v2 work

Still not accepted:

```text
RICH_TEXT_CONTENTEDITABLE = NOT_PROVEN
PROSEMIRROR_TIPTAP = NOT_PROVEN
OAUTH_TARGET_CONTINUITY = NOT IMPLEMENTED
BROWSER_SESSION_RECOVERY = NOT IMPLEMENTED
CROSS_PROCESS_WEBSOCKET_CONTROL = NOT_PROVEN
PRODUCTION_PAIRING_UX = NOT_COMPLETE
USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED
AUTO_AI_TAB_GROUP_SELECTION = NOT IMPLEMENTED
```

## STOP 4 decision

```text
TASK_5_FRAMEWORK_SAFE_FILL = ACCEPTED_FOR_BRANCH
PROCEED_TO_RICH_TEXT_CONTENTEDITABLE = YES

PROMOTE_TO_LIVE = NO
PUBLIC_PUSH = NO
PUBLIC_LAUNCH = NO
```
