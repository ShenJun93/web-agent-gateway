# WAG M9 — Atomic Runtime + Extension Promotion v1

Date: 2026-10-02
Branch: feat/wag-m9-atomic-promotion-v1

## Objective

Make WAG promotion treat the runtime, browser extension, local launchers, and supervisor coordination as one bounded release instead of independent manual steps.

## Implemented

- Prepared runtime now packages:
  - dist runtime;
  - browser extension;
  - generated extension release identity bound to the exact source HEAD;
  - WAG local launcher/starter/supervisor scripts.
- RUNTIME.json now records:
  - schema WAG_ATOMIC_RUNTIME_RELEASE_V1;
  - sourceHead;
  - extensionSourceHead;
  - extensionSha256.
- Promotion performs an asset transaction:
  - stage and hash-check extension;
  - back up installed extension and launchers;
  - install prepared extension and launchers;
  - switch runtime wrapper;
  - restart WAG;
  - roll back runtime + extension + launchers together on failure.
- Supervisor maintenance lease:
  - promotion writes a bounded 10-minute maintenance lease;
  - M9 supervisor ACKs and pauses self-healing while cutover is active;
  - pre-M9 supervisor is stopped/restarted through the bootstrap fallback;
  - lease/ACK are removed on release/failure.
- Browser extension release handshake:
  - extension hello reports exact release source HEAD;
  - runtime persists expected/observed/match state;
  - mismatch requests extension.reload;
  - extension defers chrome.runtime.reload() until after the control response is sent;
  - reconnect with the new SHA converges match=true.
- health now exposes browserExtension release state.
- runtime identity exposes extension_source_head and extension_sha256.
- supervisor mutex is scoped to the WAG-Local install root, allowing isolated acceptance/side-by-side roots without weakening single-instance protection per install.

## Backward compatibility

The first promotion from a pre-M9 extension may report SUCCEEDED_EXTENSION_RELOAD_REQUIRED because the already-running old service worker does not understand extension.reload. After that one bootstrap reload, M9 and later releases can self-reload the extension automatically.

If Edge/the extension is offline during promotion, activation can complete as SUCCEEDED_EXTENSION_DEFERRED; the packaged extension is already installed on disk and is verified when it next connects.

## Local acceptance

- PowerShell supervisor parse: PASS
- Supervisor maintenance lease regression: PASS
- Browser extension release mismatch -> reload -> reconnect convergence: PASS
- Health extension state regression: PASS
- Runtime extension identity regression: PASS
- Affected suite: 26/26 PASS
- TypeScript typecheck: PASS
- Build: PASS
- git diff --check: PASS

No public push, merge, or live promotion is claimed by this document yet.
