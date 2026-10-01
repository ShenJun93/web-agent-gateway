# WAG Browser v2 — STOP 5 / Task 6 Rich Text & Contenteditable

Date: 2026-10-01
Branch: `feat/wag-public-launch-p0-v1`
Entering HEAD: `ae3eb765cfb5ce440c3fa4afe3898591135d7dbf`

## Result

```text
CONTENTEDITABLE_REPLACEMENT = PASS
CONTENTEDITABLE_MODEL_POSTCONDITION = PASS
PROSEMIRROR_REAL_EDITOR = PASS
PROSEMIRROR_MODEL_POSTCONDITION = PASS
TIPTAP_REAL_EDITOR = PASS
TIPTAP_MODEL_POSTCONDITION = PASS
REPLACEMENT_NOT_APPEND = PASS
BACKGROUND_ACTIVE_TAB_STABILITY = PASS
NO_OS_MOUSE_CONTENTION = PASS
REAL_EDGE_RICH_TEXT = PASS

USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED
OAUTH_TARGET_CONTINUITY = NOT_IMPLEMENTED
BROWSER_SESSION_RECOVERY = NOT_IMPLEMENTED
PUBLIC_PUSH = NO
LIVE_RUNTIME_PROMOTION = NO
```

## RED evidence

Task 6 began with the prior bounded fallback:

```text
DOM.focus
Ctrl+A
Input.insertText
```

Real Edge first exposed a semantic discovery gap: Chromium represented the real ProseMirror editor with an Accessibility `editable` token of `richtext`, not boolean `true`.

After correcting AX parsing, the real plain-contenteditable fixture still failed its model postcondition because background Ctrl+A did not reliably select the existing editor content.

The implementation changed only after those real failures.

## Accessibility correction

Browser semantic discovery now treats these Accessibility editable values as editable:

```text
true
plaintext
richtext
```

This is required for real ProseMirror surfaces that Chromium exposes as a generic focusable node with:

```text
editable = richtext
```

## Accepted rich-text replacement path

Native `input` and `textarea` continue to use the Task 5 framework-safe native value setter.

For editable surfaces where the native value setter reports unsupported, WAG now uses:

```text
DOM.resolveNode
Runtime.callFunctionOn(FIXED_CONTENTEDITABLE_SELECT_ALL_FUNCTION)
Input.insertText
Runtime.releaseObject
```

The fixed selection function:

1. requires an `HTMLElement`;
2. requires `isContentEditable`;
3. focuses only the exact target element inside the attached browser target;
4. creates a Range over that element's contents;
5. replaces the document Selection with that exact range;
6. returns a boolean success marker.

Text itself is still delivered through bounded CDP `Input.insertText`.

No operating-system mouse or keyboard injection is used.

## Security boundary

Browser v2 still does not expose arbitrary JavaScript.

`Runtime.evaluate` remains denied.

`Runtime.callFunctionOn` admits only exact WAG-owned function bodies, including:

- fixed DOM click;
- fixed native input/textarea value setter;
- fixed contenteditable select-all.

The contenteditable function accepts exactly:

```text
objectId
functionDeclaration = exact fixed selection function
returnByValue = true
```

No arguments or extra fields are permitted.

Regression proves:

- exact fixed selection function is accepted;
- adding an `arguments` field is rejected;
- changing the function body toward `document.cookie` is rejected;
- arbitrary runtime functions remain rejected before debugger dispatch.

## Real framework fixtures

The acceptance uses real editor packages as dev-only fixture dependencies:

```text
@tiptap/core             3.31.4
@tiptap/starter-kit      3.31.4
prosemirror-state        1.4.4
prosemirror-view         1.42.6
prosemirror-model        1.25.12
prosemirror-schema-basic 1.2.5
```

They are bundled locally by the existing esbuild dev tool for the acceptance fixture.

They are not production dependencies used by WAG browser control.

## Real Microsoft Edge acceptance

Real Edge temporary-profile acceptance contains:

- plain contenteditable with an input-event-backed model state;
- real ProseMirror `EditorState` + `EditorView`;
- real TipTap `Editor` + StarterKit.

Acceptance is based on editor/model state:

```text
contenteditable model = ce-state:ce-new
ProseMirror state.doc.textContent = pm-new
TipTap editor.getText() = tip-new
```

Observed result:

```json
{
  "status": "PASS",
  "executionMode": "AI_TAB_GROUP",
  "activeTabStable": true,
  "contenteditableModel": true,
  "prosemirrorModel": true,
  "tiptapModel": true,
  "replacementNotAppend": true,
  "windowsUiAutomationUsed": false,
  "osPointerInjectionUsed": false,
  "userRealProfileUsed": false
}
```

The target remained background-capable and the user's active tab identity stayed unchanged.

## Regression

Latest broad Browser/runtime regression:

```text
Browser / extension / WebSocket batch A = 77 / 77 PASS
Browser MCP / semantic / private batch B = 40 / 40 PASS
Control / runtime / claim-fencing batch C = 28 / 28 PASS

Total broad Browser regression = 145 / 145 PASS
```

Real Edge acceptance rerun after the rich-text change:

```text
rich-text / contenteditable / ProseMirror / TipTap = PASS
framework-safe native + React fill = PASS
AI_TAB_GROUP snapshot/fill/click regression = PASS
```

Final gates:

```text
focused rich-text/security tests = 17 / 17 PASS
typecheck = PASS
build = PASS
git diff --check = PASS
npm audit --omit=dev = 0 vulnerabilities
```

## Files materially changed

```text
src/browser-harness/semantic-browser.ts
browser/extension/existing-browser-control-v1.js
test/browser-harness-semantic.test.ts
test/browser-existing-control-v1.test.ts
scripts/accept-browser-v2-rich-text.ts
package.json
package-lock.json
```

## Remaining Browser v2 work

```text
OAUTH_TARGET_CONTINUITY = NOT_IMPLEMENTED
BROWSER_SESSION_RECOVERY = NOT_IMPLEMENTED
CROSS_PROCESS_WEBSOCKET_CONTROL = NOT_PROVEN
PRODUCTION_PAIRING_UX = NOT_COMPLETE
USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED
AUTO_AI_TAB_GROUP_SELECTION = NOT_IMPLEMENTED
```

## STOP 5 decision

```text
TASK_6_RICH_TEXT = ACCEPTED_FOR_BRANCH
PROCEED_TO_OAUTH_TARGET_CONTINUITY = YES

PROMOTE_TO_LIVE = NO
PUBLIC_PUSH = NO
PUBLIC_LAUNCH = NO
```
