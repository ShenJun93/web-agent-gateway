# Browser Harness upstream evidence — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE RECHECK / SOURCE DESIGN INPUT

## Node.js WebSocket

Node.js 24 documents the browser-compatible global WebSocket implementation as stable. WAG's
supported Node range begins at 22.19, after WebSocket stopped being experimental in Node 22.4.
Therefore Browser Harness does not add a WebSocket package merely to speak loopback CDP.

Official source:
- https://nodejs.org/download/release/latest-v24.x/docs/api/globals.html

Disposition:
- use the Node global WebSocket behind an injected transport seam;
- tests use a fake socket and make no network connection;
- loopback is the default CDP trust boundary; remote CDP is denied unless a later reviewed policy
  explicitly enables it.

## Playwright connectOverCDP

Current Playwright documentation supports chromium.connectOverCDP with either an HTTP CDP endpoint
or a browser WebSocket endpoint. The same official page warns that CDP attachment has lower fidelity
than Playwright's own protocol connection and that functionality may be impaired when the browser
was not launched with Playwright's expected arguments.

Current options also include isLocal and noDefaults; noDefaults is specifically useful when attaching
to an existing default browser context because it avoids changing download/focus/media defaults.

Official source:
- https://playwright.dev/docs/api/class-browsertype

Disposition:
- Playwright is an optional deterministic adapter, not BrowserPort authority;
- adapter is dependency-injected in this lane, so WAG does not add Playwright to package.json;
- adapter sets isLocal=true and noDefaults=true;
- this adapter may close only a WAG-owned dedicated browser, never an arbitrary attached user browser.

## Chrome DevTools Protocol

The current CDP Target domain exposes getTargets, attachToTarget and closeTarget. The Page domain
exposes captureScreenshot. These are sufficient primitives for the v1 raw-CDP backend's target
attachment, observation and owned-target close path.

Official sources:
- https://chromedevtools.github.io/devtools-protocol/tot/Target/
- https://chromedevtools.github.io/devtools-protocol/tot/Page/

Disposition:
- raw CDP remains the low-level flexible primitive;
- Target.attachToTarget uses flatten=true;
- page commands carry the returned CDP session id;
- BrowserPort still owns policy/resource identity outside CDP.

## Non-decision

This recheck does not authorize:
- opening an existing browser;
- attaching to a daily-driver profile;
- remote CDP;
- BrowserPort MCP publication;
- Notebook99 mutation;
- package dependency changes.
