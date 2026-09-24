# WAG Full Harness v1.8 — CDP download driver source receipt

Date: 2026-09-24
Branch: feat/full-harness-browser-download-driver-v1
Base: e6c76550993ea4f1b6e406fcb3a9816abb78346b
Status: SOURCE-GREEN / ISOLATED PARALLEL LANE / NO LIVE BROWSER

## Why this lane exists

The BrowserPort lane already contains the generic BrowserDownloadController and Notebook99 exact-once
contract. Its remaining follow-up requires Browser.downloadWillBegin/downloadProgress plumbing.

A separate session is currently editing BrowserPort/CDP event plumbing. This lane intentionally does
not modify those files. Instead it adds a BrowserLevelCdpClient interface that the event-plumbing
lane can satisfy through a thin adapter after its own gate is green.

## Added

src/browser-harness/cdp-download-driver.ts

The driver:

- arms Browser.downloadWillBegin and Browser.downloadProgress before the action trigger;
- calls Browser.setDownloadBehavior with allowAndName, a fresh owned capture directory and
  eventsEnabled=true;
- chooses the first guid and rejects a second distinct guid from the same trigger;
- rejects canceled downloads;
- reads bytes from <captureDir>/<guid>, not event filePath;
- accepts only a regular, non-symlink file;
- enforces a default 32 MiB ceiling with a bounded configurable maximum;
- cleans the capture directory after copying bytes;
- permits only one active capture per browserSessionId;
- releases that guard on every failure path including allocation failure.

test/browser-harness-cdp-download-driver.test.ts proves:

- event arming precedes trigger;
- successful bytes + filename + source URL capture;
- canceled failure and subsequent same-session retry;
- multi-download ambiguity denial;
- event filePath is not trusted;
- size ceiling;
- allocation failure cannot strand the active-session guard.

## Measured gates

CDP driver + existing browser download controller:

```text
8 pass
0 fail
```

Artifact + CDP download + BrowserDownloadController + Notebook99 + exact-once effect ledger:

```text
20 pass
0 fail
```

Repository source build:

```text
npm run build
PASS
```

## Parallel safety

No changes were made to the five currently dirty BrowserPort event-plumbing paths in the other
worktree:

- src/browser-harness/browser-port.ts
- src/browser-harness/cdp-browser-backend.ts
- src/browser-harness/cdp-protocol.ts
- src/browser-harness/node-cdp-transport.ts
- test/browser-harness-semantic.test.ts

## Non-claims

- BrowserPort event plumbing is not claimed by this lane.
- No BrowserPort MCP tools are public.
- No Edge/browser worker was opened.
- No E:/AI-BROWSER profile or download directory was touched.
- No live website download occurred.
- No Notebook99 prompt was submitted.
- No runtime/config was promoted.

## Integration next

After event plumbing is committed and green, adapt its browser-level call/event methods to
BrowserLevelCdpClient, run the combined source gate, fresh-read E:/AI-BROWSER/PLAYWRIGHT_HANDOFF.md,
then proceed to one WAG-owned live browser acceptance.
