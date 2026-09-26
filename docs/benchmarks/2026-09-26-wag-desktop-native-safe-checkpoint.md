# WAG Desktop Native Harness — Safe Source Checkpoint

Date: 2026-09-26
Branch: feat/full-harness-desktop-native-v1
Base: db341ff38e15335f5729d2399deddadfab17f853
Status: SOURCE-GREEN / LIVE DESKTOP ACCEPTANCE NOT YET PASSED / NOT PROMOTED

## Scope completed in this checkpoint

The Desktop harness now has source implementations for:

- native Windows UI Automation backend;
- exact owned window resolution from a WAG-owned process identity;
- semantic UIA snapshotting;
- semantic Invoke / Value / Toggle / SelectionItem effects;
- bounded screenshot capture;
- Desktop MCP runtime composition;
- exact-once effect ledger integration;
- caller/session ownership;
- live PID/process-instance/window identity revalidation;
- autonomous-stop recheck at semantic effect boundaries;
- explicit normal-window process start support for WAG-owned GUI fixtures;
- public Desktop MCP projection when desktop is enabled:
  - desktop.open
  - desktop.describe
  - desktop.snapshot
  - desktop.exec
  - desktop.effect.get
  - desktop.screenshot
  - desktop.close

The generic live WAG runtime is intentionally unchanged at this checkpoint and remains the
50-tool db341ff3 runtime. Desktop publication/promotion is not part of this checkpoint.

## First live acceptance attempt

A prior live attempt used Windows Character Map as the fixture.

Durable evidence was written to:

E:/WAG-Acceptance/promotion-logs/desktop-native-live-db341ff3.json
E:/WAG-Acceptance/promotion-logs/desktop-native-live-db341ff3.json.journal/

The attempt proved:

- owned GUI process started;
- exact window opened;
- semantic snapshot returned 13 nodes;
- one Value effect reached durable SUCCEEDED;
- retry of the same idempotency key returned the same durable effect/result;
- the original fixture process PID 56936 is no longer alive.

The attempt then failed after EXACT_ONCE_RETRY_CONFIRMED while validating readback.
It is therefore not counted as a live Desktop acceptance PASS.

This was not retried blindly.

## Acceptance harness correction

The current live acceptance script no longer relies on Character Map semantics.

It now builds a dedicated WPF fixture with explicit semantic controls:

- Input — ValuePattern
- Apply — InvokePattern
- Enabled — TogglePattern
- Status — ValuePattern

The intended live sequence is:

1. create isolated temporary fixture;
2. start it as a WAG-owned normal-window process;
3. open exact DesktopPort target;
4. snapshot semantic controls;
5. set Input from alpha to beta;
6. retry the same setValue idempotency key and require the same durable success;
7. read back Input=beta;
8. invoke Apply;
9. retry the same invoke idempotency key and require the same durable success;
10. read back Status=applied:beta;
11. capture a bounded PNG screenshot;
12. close DesktopPort without killing the app;
13. prove the owned process is still alive;
14. terminate exactly that owned process.

This corrected live flow has not been executed at this checkpoint.

## Local-machine regression correction

Windows process listing is bounded to 500 OS rows. On a heavily loaded host, a freshly started
WAG-owned process may fall outside that OS listing and previously disappear from machine.process.list.

The source now guarantees that caller-owned process records for the workspace are appended to the
bounded process result when absent from the OS sample. This preserves bounded enumeration while
keeping WAG ownership evidence observable.

## Verification on exact current source bytes

PASS:

- npm run typecheck
- npm run build
- git diff --check
- Desktop-focused/native/MCP/config/process-window tests: 18 / 18
- local-machine DC parity rerun: 8 / 8
- local-machine runtime: 5 / 5
- local-machine file mutation + machine MCP surface: 4 / 4
- autonomous-local/core regression: 16 / 16

One earlier local-machine DC-parity run exposed a timing-sensitive persistent-terminal readback
failure. The same file was rerun immediately after the process-list correction and passed 8 / 8.
No source change was made solely to hide that timing event.

## Safety state

- No Desktop live acceptance is currently running.
- The prior fixture PID 56936 is not alive.
- Temporary debug/patch/compiled fixture files under scripts/.tmp-* were removed.
- No runtime promotion occurred.
- No live config change occurred.
- No Git push occurred.
- Goal Lease was not reintroduced.
- Existing live WAG remains AUTONOMOUS_LOCAL.

## Next step after discussion

Do not promote yet.

The next consequential gate is a fresh live run of scripts/accept-full-harness-desktop-live.ts
using a new receipt path. Only after that run proves semantic readback, exact-once behavior,
screenshot, desktop.close ownership semantics and exact process termination should the Desktop
slice receive the full composite regression and be promoted into the live MCP surface.
