# WAG M10 Hotfix — Product Health Self-Probe Socket Isolation v1

Date: 2026-10-02
Branch: fix/wag-m10-doctor-self-probe-v1

## Problem

The packaged product health/doctor path starts a fresh private stdio WAG client to collect listTools + health. With browser integration enabled, that probe could try to bind the same single-owner browser-control WebSocket socket as the live WAG runtime.

## Fix

- Product health self-probe sets `WAG_PRODUCT_HEALTH_PROBE=1` only for the probe child.
- CLI maps that internal env flag to `skipBrowserControlServer=true` when assembling repository engineering.
- Repository engineering:
  - does not start the browser-control WebSocket server in self-probe mode;
  - still assembles the browser MCP context so the published tool surface remains representative;
  - does not claim browser extension release ownership in the probe process.
- Normal WAG runtimes are unchanged because the option defaults false.

## Regression coverage

- CLI doctor path receives `skipBrowserControlServer=true` when the probe env is set.
- Private stdio wiring propagates the option.
- Repository runtime proves the control-server starter is never called while browser MCP context remains present.

## Acceptance

- targeted self-probe/runtime/CLI suite: 35/35 PASS
- typecheck: PASS
- build: PASS
- git diff --check: PASS

No public push, merge, or live promotion is claimed yet.
