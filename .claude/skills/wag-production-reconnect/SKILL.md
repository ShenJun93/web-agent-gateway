---
name: wag-production-reconnect
description: Use when WAG's browser side looks disconnected, empty or duplicated — after a service-worker suspension, an extension reload, a side-panel close, a native-host idle disconnect or a runtime restart — to recover automatically and to tell an ordinary reattach apart from a real regression.
---

# WAG reconnect and restart

Most "WAG is broken" moments are ordinary reattachment, and reattachment is automated. Recover
first, and only then decide whether something is actually wrong.

**The operator must never be asked to reload the ChatGPT page as part of normal recovery.** The
implementation already reattaches; needing a manual reload is a defect to diagnose, not a step to
perform.

## What each event actually does

| Event | What survives | What you do |
| --- | --- | --- |
| MV3 worker suspends (~30s idle) | queue and seen set, in `chrome.storage.session` | open the panel; `restore()` rehydrates |
| Side panel closed and reopened | everything | `panel.state` reattaches to open conversations and rescans before answering |
| Content script orphaned by an extension reload | tabs stay open | re-injection and rescan are automatic |
| **Extension reloaded** | **nothing** — `chrome.storage.session` is cleared | the tab's correlation is re-minted; workspace ids from before the reload stop working. Deliberate: `storage.local` would write a session key to disk |
| Native host idle disconnect | durable WAG records | it reconnects when a proposal is run; an idle host is normal, not an error |
| WAG runtime restarted | durable records reconcile and stay approvable | TTL is **not** refreshed by restart |

## Recovery, in order

1. Open the side panel and read its status. "Native host idle; it connects when you run a
   proposal" is a healthy state, not a failure.
2. Let the automatic rescan run. Do not reload the page, and do not re-send the conversation turn.
3. Re-read the pending list, and WAG's durable records for anything already submitted.
4. Only if the correlation was genuinely lost (extension reload) does the session start again —
   say so plainly rather than presenting it as a fresh failure.

## Telling a regression from a reattach

The one symptom that is always a regression: **more than one pending entry for the same proposal.**

Identity is `sessionId + tabId + provider message id + tool + exact arguments`, with object keys
sorted so key order cannot change it. A rescan, reload, suspension, extension reload or panel
reopen re-observes the same message; each observation mints a fresh request id, so request id is
never the identity. Settled and dismissed proposals stay in the `seen` set precisely so a later
rescan does not raise them again.

Two defects produced duplicates during the cutover dogfood, and both have regression tests —
check they still pass before looking further:

- `forTab` read and wrote storage across two awaits, so one tab became two WAG sessions. Minting
  is now coalesced per tab, one in flight.
- the identity depended on which node kind the DOM scan matched. The innermost
  `data-message-id` now wins.

A turn with no provider-assigned message id is refused outright: an unstable identity is worse
than none, and it is exactly what produced the pile.

```bash
npx tsx --test --test-concurrency=1 test/browser-extension-v4.test.ts
```

## Restart evidence worth capturing

A proposal made before a runtime restart is still approvable afterwards, and its review page still
renders the repository, author, parent, tree, selected paths, change set and message. Its deadline
did not move. Nothing was re-offered twice. Approval remains single-use.
