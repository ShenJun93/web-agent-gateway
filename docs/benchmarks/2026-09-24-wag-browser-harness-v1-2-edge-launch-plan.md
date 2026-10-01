# WAG Browser Harness v1.2 — Dedicated Edge launch-plan receipt

Date: 2026-09-24
Status: SOURCE-ONLY / NO EDGE PROCESS SPAWNED

## Upstream constraint

Chrome's official remote-debugging security change requires a non-default --user-data-dir for
remote-debugging switches from Chrome 136 onward. Microsoft Edge's DevTools Protocol documentation
supports remote-debugging-port and distinct user-data-dir profiles.

Sources:
- https://developer.chrome.com/blog/remote-debugging-port
- https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/

## Source decision

Browser Harness generates a pure launch plan for a WAG-owned dedicated profile:

- absolute Edge executable;
- absolute BrowserProfileStore userDataDir;
- one bounded debug port;
- BrowserPort connects only to http://127.0.0.1:<port>;
- caller extra args cannot override user-data-dir, remote-debugging-port or request a debugging pipe;
- default startup is about:blank;
- no process is started in source tests.

This does not attach to or reuse the user's default Edge profile.

## Gate

The launch-plan tests must pass together with all Browser Harness focused tests before this slice is
committed. Live process creation is a later ProcessPort/BrowserLauncher integration gate and must
fresh-read E:/AI-BROWSER/PLAYWRIGHT_HANDOFF.md immediately before allocation.
