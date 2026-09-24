# WAG Browser Harness v1

Date: 2026-09-24
Status: ISOLATED IMPLEMENTATION LANE — NOT MCP-PUBLISHED, NOT RUNTIME-PROMOTED

## Goal

Add the provider-neutral browser actuation substrate WAG currently lacks, without changing the
accepted ChatGPT-page proposal adapters or the live autonomous-local authority plane.

The first concrete workflow gap is Notebook99: a WAG-owned authenticated browser session must
eventually be able to inspect the notebook, submit one idempotent H3 request, read the response and
prove the submission persisted exactly once without Desktop Commander.

## Boundary

Browser Harness v1 is a new outbound agent -> browser plane.

It is not browser.chatgpt.native.operator.v4 or delegation.v5, does not parse ChatGPT page output,
does not inherit proposal authority, and does not register public MCP tools in this lane.

The BrowserPort owns explicit resources:

- browserSessionId
- profileId
- exact owner/session/adapter tuple
- targetId
- lifecycle state

One active profile is owned by at most one BrowserPort session. A foreign authority cannot inspect,
act on or close another session.

## Backend order

1. structured site/API/WebMCP where available;
2. CDP browser backend for low-level flexible execution;
3. deterministic Playwright adapter in a successor slice;
4. multimodal/pixel input only as a later fallback.

This slice implements the provider-neutral BrowserPort contract and injected CDP transport/backend.
It deliberately does not open a real browser or expose unrestricted host code execution.

## v1 operations

- open
- describe
- snapshot
- exec (CDP domain.method only)
- screenshot
- close

Upload/download, persistent recovery, idempotent effect receipts and Playwright are successor work.

## Security invariants

- browser ownership is exact authority tuple, never transport identity;
- profile ownership is single-active-session;
- BrowserPort does not expose shell/host filesystem/environment access;
- the CDP transport is injected and not trusted to confer WAG authority;
- close only affects the exact owned target/session;
- no existing browser worker is reclaimed from absence/idle state;
- no live browser is touched by source tests.

## Acceptance for this slice

- source compiles;
- focused Browser Harness tests pass;
- existing autonomous-local tests remain green;
- no edit to server.ts/private config/runtime promotion;
- no browser worker allocation;
- worktree remains isolated from WAG-Core.

Live Notebook99 acceptance is a later gate after BrowserPort integration and a fresh read of
E:/AI-BROWSER/PLAYWRIGHT_HANDOFF.md.
