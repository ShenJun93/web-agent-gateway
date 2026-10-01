# WAG Local M6 — Search lifecycle candidate

Date: 2026-09-30  
Branch: `feat/wag-local-m6-search-lifecycle-v1`  
Base: `e80fbe9ed172ef0b955f34e9ddfd16f331f25a83` (M5 DC gap matrix)

## Verdict

`M6_SEARCH_LIFECYCLE_CANDIDATE = PASS`

`M6_SEARCH_LIFECYCLE_LIVE_PROMOTION = NOT_EXECUTED`

This closes the highest-priority low-authority local gap identified by M5 without widening filesystem,
process, network or credential authority.

## Product surface

Two bounded tools are added to the full local-machine surface:

```text
machine.search_list
machine.search_cancel
```

Existing tools remain:

```text
machine.search
machine.search_continue
```

The candidate therefore moves the full WAG live surface from 53 to an expected 55 tools **only after
a later live promotion**. The primary live WAG instance remains on the previously accepted 53-tool
runtime at this checkpoint.

## Lifecycle model

A new search creates an opaque caller-owned search session.

States:

```text
RUNNING
PAUSED
CANCELLING
```

Behavior:

- completed searches are removed immediately;
- truncated searches remain PAUSED with one opaque cursor;
- only the exact latest cursor may continue a PAUSED session;
- cursor replay is rejected;
- cancelling a PAUSED session removes it immediately;
- cancelling a RUNNING session sets a cancellation flag and the active search exits at bounded async
  filesystem checkpoints;
- after a RUNNING cancellation rejects, no session remains;
- sessions are isolated by caller-owned workspace identity and canonical root;
- legacy v1 search cursors remain readable for backward compatibility but are not presented as owned
  lifecycle sessions.

Bounds:

- maximum search sessions: **32**;
- PAUSED/CANCELLING cleanup TTL: **10 minutes**;
- existing per-page match cap remains **50**;
- existing file/read/message bounds remain unchanged.

## Safety / authority

The new controls do not kill OS processes or add filesystem mutation authority.

`machine.search_list` is read-only.

`machine.search_cancel` only mutates WAG-owned in-memory search lifecycle state. It cannot cancel a
different workspace's session and returns NOT_FOUND for a foreign/unknown id.

No new shell, network, credential, browser, Git or file-write authority is introduced.

## Acceptance

Machine-readable receipt:

`docs/benchmarks/2026-09-30-wag-local-product-m6-search-lifecycle.json`

Measured:

- two PAUSED searches can be listed independently;
- one PAUSED search can be cancelled and its cursor becomes invalid;
- replay of an already-consumed cursor is rejected;
- a second workspace cannot list/cancel another workspace's search;
- a currently RUNNING search can be observed, cancelled and rejects with no orphan session left;
- active session capacity stops at 32;
- MCP routing schemas/hints are strict;
- relay message-bound regression remains accepted;
- DC replacement production-local acceptance passes with the two added tools in the declared surface.

Final verification:

- affected surface tests: **26/26 PASS**;
- local-machine runtime: **9/9 PASS**;
- direct MCP readiness: **10/10 PASS**;
- relay message bound: **1/1 PASS**;
- WAG product regression: **34/34 PASS**;
- DC replacement production-local acceptance: **1/1 PASS**;
- typecheck: **PASS**;
- build: **PASS**;
- `git diff --check`: **PASS**.

## Remaining M6 candidates from M5

Search lifecycle is now locally accepted.

Remaining measured candidates:

1. native DOCX/XLSX/PDF operations;
2. product config / recent activity UX;
3. update discovery;
4. bounded in-memory execution remains lower priority.

Remote/multi-device management remains behind M7 and is not part of this capability.
