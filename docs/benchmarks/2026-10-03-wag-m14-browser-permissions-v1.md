# WAG M14 — Origin-Bound Browser Permissions v1

Date: 2026-10-03
Branch: feat/wag-m14-browser-permissions-v1

## Objective

Add a bounded semantic browser permission control without exposing arbitrary origins, broad permission grants, global permission reset, or generic CDP authority.

## Public tool

`browser.permission.set`

Input:
- `browser_session_id`
- `permission`: `notifications | clipboard_write | camera | microphone | geolocation | clipboard_read`
- `setting`: `granted | denied | prompt`

The caller does not provide an origin. WAG derives the current exact attached target origin immediately before dispatch.

## Policy matrix

| Permission | granted | denied | prompt |
| --- | --- | --- | --- |
| notifications | allowed | allowed | allowed |
| clipboard_write | allowed | allowed | allowed |
| camera | denied by WAG policy | allowed | allowed |
| microphone | denied by WAG policy | allowed | allowed |
| geolocation | denied by WAG policy | allowed | allowed |
| clipboard_read | denied by WAG policy | allowed | allowed |

## Security boundaries

- Uses only `Browser.setPermission`; no deprecated broad `Browser.grantPermissions`.
- Does not expose `Browser.resetPermissions`; M14 cannot reset all browser permissions.
- No arbitrary origin parameter is exposed by MCP.
- Runtime binds permission changes to the session's exact `targetId + claimEpoch`.
- Runtime re-reads the current target origin before dispatch.
- Extension re-reads the tab and verifies the requested origin still equals the current tab origin immediately before `chrome.debugger.sendCommand`.
- Protocol and extension both enforce exact-shape permission descriptors and settings.
- Sensitive grants for camera, microphone, geolocation, and clipboard-read fail before CDP dispatch.
- Managed/headless sessions without the bounded existing-browser control path fail closed.
- No new browser-extension manifest permission is added.
- No focus activation, tab activation, or mouse ownership is required.

## Diagnostics

- Browser runtime diagnostics adds `permission_set`.
- Product doctor requires `browser.permission.set` when browser integration is enabled.

## Acceptance

- Focused M14/browser surface suite: 40/40 PASS.
- WebSocket transport/server regression: 10/10 PASS.
- Product suite: 67/67 PASS.
- TypeScript typecheck: PASS.
- Build: PASS.
- `git diff --check`: PASS.
- Protocol tests cover allowed notification grant + camera deny and reject sensitive grant, path/query origin, and widened descriptor shapes.
- Extension tests prove origin mismatch and sensitive grant fail before CDP dispatch.
- Runtime test proves current-origin binding, sensitive-grant deny-before-CDP, safe camera deny, missing-origin failure, and claim-epoch rebound failure.
- MCP surface test covers tool publication, annotations, and structured result.
- Product-doctor regression fails when the permission surface is missing.

No public push, merge, or live promotion is claimed by this document yet.
