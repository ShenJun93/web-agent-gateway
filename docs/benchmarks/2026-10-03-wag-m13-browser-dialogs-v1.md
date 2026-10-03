# WAG M13 — Semantic Browser JavaScript Dialogs v1

Date: 2026-10-03
Branch: feat/wag-m13-browser-dialogs-v1
Base public main: 1011c5820d791baf5c95ce3369b8d5ecf781594e

## Objective

Close the JavaScript alert/confirm/prompt/beforeunload automation gap for the existing-browser / AI-tab path without exposing generic CDP commands or broad browser permission grants.

## Public surface

### browser.dialog.get

Read-only semantic observation of the currently open JavaScript dialog for one caller-owned browser session.

Returns either:

- `{ open: false }`, or
- `open=true` with:
  - stale-safe `dialog_id`;
  - bounded dialog `type`;
  - bounded `message`;
  - sanitized URL (no credentials/query/fragment) or null;
  - bounded `default_prompt`.

Annotations:
- readOnlyHint: true
- destructiveHint: false
- idempotentHint: true
- openWorldHint: true

### browser.dialog.respond

Responds only to the exact currently observed `dialog_id`.

Input:
- browser_session_id
- exact dialog_id
- accept boolean
- optional prompt_text only for prompt dialogs

Annotations:
- readOnlyHint: false
- destructiveHint: true
- idempotentHint: false
- openWorldHint: true

Retries after the dialog has closed or changed fail stale rather than reporting false success.

## Safety and authority

- Existing-browser attach enables the Page domain before the session becomes attached.
- Extension forwards only four bounded control events:
  - Browser.downloadWillBegin
  - Browser.downloadProgress
  - Page.javascriptDialogOpening
  - Page.javascriptDialogClosed
- Dialog opening payload is sanitized and bounded:
  - http/https URL only, with username/password/query/hash removed;
  - message <= 8 KiB UTF-8, no NUL;
  - default prompt <= 4 KiB UTF-8, no NUL;
  - type limited to alert/confirm/prompt/beforeunload.
- Closed event exposes only the boolean result.
- Page.handleJavaScriptDialog is allowlisted with exact params only:
  - accept
  - optional promptText <= 4 KiB, no NUL.
- Generic CDP event subscriptions remain unavailable to the model.
- Generic Runtime.evaluate remains denied.
- Runtime binds dialog state to browser_session_id + exact targetId + claimEpoch.
- Target continuity changes clear/rebind dialog watchers.
- Close/restart/closeAll remove all dialog subscriptions.
- A prompt string is rejected for alert/confirm/beforeunload.
- This milestone does not grant notifications, camera, microphone, geolocation, clipboard, or other browser permissions.

## Backend scope

v1 is supported for ATTACH_EXISTING and AI_TAB_GROUP sessions using the bounded existing-browser event bridge.

Managed WAG_HEADLESS/WAG_VISIBLE sessions fail closed for dialog observation/response until their backend gains an equivalent bounded browser-event bridge.

## Acceptance

- M13 focused protocol/extension/runtime/MCP/product-doctor suite: 47/47 PASS.
- Direct MCP readiness + DC replacement surface: 25/25 PASS.
- Product suite: 66/66 PASS.
- TypeScript typecheck: PASS.
- Build: PASS.
- git diff --check: PASS.

## Regression coverage

- Page.enable is performed before attach ownership is accepted.
- Dialog events from other tabs and unrelated debugger events are ignored.
- URL secrets are stripped before crossing the extension control boundary.
- Protocol rejects unsanitized URLs and malformed dialog response params.
- WebSocket event routing is exact-target scoped.
- Runtime get -> respond behavior is covered.
- Stale dialog ids do not dispatch CDP.
- prompt_text is accepted only for prompt dialogs.
- Dialog watchers are released on session close.
- MCP output uses the bounded snake_case public contract.
- Tool annotations are pinned.
- product.doctor fails when browser dialog surface is incomplete.

Expected live MCP tool count after promotion: 87.

No public push, merge, or live promotion is claimed by this document yet.
