# Browser download CDP upstream recheck — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE INPUT / SOURCE-ONLY

## Chrome DevTools Protocol Browser domain

Current CDP Browser domain documents:

- Browser.setDownloadBehavior as Experimental;
- behavior=allowAndName, which names downloaded files by their download guid;
- downloadPath is required for allow/allowAndName;
- eventsEnabled=true emits browser download events;
- Browser.downloadWillBegin exposes guid, URL and suggestedFilename;
- Browser.downloadProgress exposes guid, byte counts and state=inProgress|completed|canceled;
- downloadProgress.filePath may be absent and the protocol explicitly does not guarantee that the
  reported file exists.

Official source:
- https://chromedevtools.github.io/devtools-protocol/tot/Browser/

## WAG disposition

Because these CDP APIs remain Experimental:

- the driver is behind an injected browser-level CDP seam;
- one capture per BrowserPort session is allowed at a time;
- event listeners are armed before the trigger;
- behavior is allowAndName into a fresh WAG-owned capture directory;
- a trigger that starts multiple distinct guids fails closed;
- canceled download is failure;
- completion is not accepted from filePath alone;
- WAG reads the expected <captureDir>/<guid> regular file and enforces a size ceiling;
- capture directory is removed after bytes are copied into memory;
- allocation/subscription/method/trigger/read failure always releases the per-session active guard.

No live browser or website was used for this receipt.
