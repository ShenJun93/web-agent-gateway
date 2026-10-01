# WAG Browser Harness v1 — Source Lane Receipt

Date: 2026-09-24
Branch: feat/full-harness-browserport-v1
Base: 16c13ab9a30f7a3376aa2dc70fa91916724ea725
Status: SOURCE-GREEN / ISOLATED / NOT INTEGRATED / NO LIVE BROWSER

## Scope

This lane adds a provider-neutral outbound BrowserPort foundation without editing the live MCP
surface or the existing ChatGPT browser proposal/delegation adapters.

Added source:

- src/browser-harness/browser-port.ts
- src/browser-harness/cdp-protocol.ts
- src/browser-harness/cdp-browser-backend.ts
- test/browser-harness-port.test.ts
- test/browser-harness-cdp.test.ts
- docs/superpowers/specs/2026-09-24-wag-browser-harness-v1.md

## Proven properties

- one active BrowserPort session owns one profile;
- ownership is exact owner/session/adapter tuple;
- foreign authority cannot describe, act on or close the session;
- profile ownership is released only after owned close;
- BrowserPort exec accepts CDP domain.method shapes, not shell strings;
- CDP target attach uses flatten=true and routes page commands through the returned session id;
- screenshot and target description are backend operations;
- no browser worker/profile was allocated during this source gate.

## Measured gates

Focused Browser Harness tests:

```text
7 tests
7 pass
0 fail
```

Combined Browser Harness + existing local-machine/repository runtime regressions:

```text
23 tests
23 pass
0 fail
```

Source-only strict TypeScript check over the three new src/browser-harness modules:

```text
PASS
```

Repository build:

```text
npm run build
PASS
```

Whole-repository `npm run typecheck` in this fresh worktree did not constitute a source failure:
the worktree does not have the optional dev dependency `resedit` available, and the only diagnostic
was TS2307 for scripts/native-host-pe-metadata.ts importing resedit. No Browser Harness diagnostic
was emitted. No dependency install or package mutation was performed merely to make that environment
green.

## Non-claims

This receipt does not claim:

- public MCP BrowserPort tools;
- Playwright integration;
- WebMCP integration;
- real CDP socket/WebSocket transport;
- authenticated profile reuse;
- Notebook99 acceptance;
- browser upload/download;
- persistent recovery;
- effect receipts/idempotency;
- browser automation authority;
- runtime promotion.

## Integration gate

Before integrating into WAG-Core:

1. rebase onto a green autonomous-local core;
2. preserve the separation between outbound BrowserPort and browser.chatgpt.native v4/v5 proposal
   adapters;
3. add owned browser/profile lifecycle implementation;
4. fresh-read E:/AI-BROWSER/PLAYWRIGHT_HANDOFF.md before any live browser allocation;
5. run Notebook99 exact-once H3 acceptance only after browser authority is explicitly accepted.
