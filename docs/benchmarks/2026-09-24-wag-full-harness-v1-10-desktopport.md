# WAG Full Harness v1.10 — DesktopPort semantic foundation

Date: 2026-09-24
Branch: feat/full-harness-desktopport-v1
Base: e6c76550993ea4f1b6e406fcb3a9816abb78346b
Status: SOURCE-GREEN / BACKEND-NEUTRAL / NO LIVE DESKTOP EFFECT

## Added

src/desktop-harness/desktop-port.ts

DesktopPort v1 provides:
- explicit desktopSessionId;
- exact owner/session/adapter ownership;
- DesktopTargetIdentity with target id, PID, process-instance identity, executable path, native
  window id and title;
- target identity revalidation before snapshot, screenshot or effect;
- one active DesktopPort session per target;
- snapshot-scoped opaque element refs;
- semantic Invoke / Value / Toggle / SelectionItem actions;
- pattern and enabled-state enforcement before effect;
- policy/effect gate immediately before backend mutation;
- complete snapshot invalidation before crossing an effect boundary;
- screenshot as a separate read-only observation;
- owned close that releases only the exact target session.

## Security properties

- PID or HWND alone is not authority.
- Foreign session cannot inspect or close another DesktopPort session.
- Changed process-instance/window identity fails closed.
- Caller does not supply screen coordinates.
- Unsupported pattern or disabled element never reaches backend mutation.
- UI refs are ephemeral and cannot be replayed after any semantic action.
- Effect denial leaves snapshot/screenshot observation available.

## Measured gates

DesktopPort focused:

```text
6 pass
0 fail
```

DesktopPort + BrowserPort semantic + ProcessPort regression:

```text
23 pass
0 fail
```

Repository source build:

```text
npm run build
PASS
```

## Native backend target

The preferred Windows implementation is:
- Microsoft UI Automation Control View;
- targeted FindFirst/FindAll/cache retrieval where practical;
- Invoke/Value/Toggle/SelectionItem control patterns;
- Windows.Graphics.Capture for screenshot/vision fallback;
- raw SendInput only under a later, separately gated fallback design.

## Non-claims

- no native UIA COM backend exists in this slice;
- no GraphicsCapture backend exists in this slice;
- no raw mouse/keyboard input exists;
- no desktop window was inspected or controlled;
- no public MCP tool changed;
- no runtime/config promotion occurred.
