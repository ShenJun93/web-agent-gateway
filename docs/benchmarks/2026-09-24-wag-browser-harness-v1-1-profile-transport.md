# WAG Browser Harness v1.1 — Profile / Transport / Playwright Source Receipt

Date: 2026-09-24
Branch: feat/full-harness-browserport-v1
Parent: ca008927ea462a6d2973279cd067005f31dc3d46
Status: SOURCE-GREEN / NO LIVE BROWSER / NOT MCP-PUBLISHED

## Added capability

BrowserPort now composes a profile store rather than treating a profile name as disposable caller
input.

Profile invariants:
- one active use at a time;
- persistent exact owner/session/adapter ownership after close;
- foreign authority cannot adopt a previously used profile;
- file-backed profiles store OWNER.json under a configured root;
- profile ids cannot contain path separators or traversal syntax;
- backend-open failure releases only the active slot, not persistent ownership.

CDP transport:
- Node built-in WebSocket path;
- HTTP /json/version discovery supported;
- loopback-only by default;
- command ids are correlated over one socket;
- bounded connect and command timeouts;
- close/error fail pending commands closed.

Playwright adapter:
- dependency-injected; package.json unchanged;
- connectOverCDP;
- isLocal=true;
- noDefaults=true;
- CDP session for flexible method execution;
- Browser.close only on the WAG-owned dedicated-browser adapter path.

## Measured gates

Browser Harness focused:
```text
15 pass
0 fail
```

Browser Harness + autonomous-local/repository regression:
```text
31 pass
0 fail
```

Repository source build:
```text
npm run build
PASS
```

## Non-claims

No live browser was opened or attached.
No E:/AI-BROWSER profile was created.
No Playwright package was installed.
No MCP surface changed.
No server.ts/private config/runtime promotion changed.
No Notebook99 action was executed.
No browser upload/download or durable restart recovery is claimed.
