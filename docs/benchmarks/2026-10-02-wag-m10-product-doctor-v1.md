# WAG M10 — Unified Product Doctor MCP v1

Date: 2026-10-02
Branch: feat/wag-m10-product-doctor-v1

## Objective

Expose one read-only semantic `product.doctor` tool that reports the readiness of the local WAG product without requiring a sequence of manual health/process/browser/config checks.

## Implemented

- Added `product.doctor` to the private local MCP surface.
- Added a unified local doctor report with PASS/WARN/FAIL checks for:
  - deployed runtime identity and gateway health;
  - installed extension byte SHA against the active runtime marker;
  - runtime/extension release-head handshake;
  - exact WAG Local supervisor process identity;
  - tunnel health/readiness;
  - managed DevSpace discovery readiness;
  - promotion maintenance lease state;
  - safe product config validity;
  - configured remote-Git policy versus published semantic Git tools;
  - semantic media preflight availability;
  - semantic browser upload availability;
  - browser wait/assert/media reliability surface;
  - MCP surface coherence;
  - CLI doctor/health support files in the promoted runtime.
- Report exposes stable blocker/warning IDs and bounded next actions.
- Browser-only checks are not treated as failures when browser integration is disabled.
- Existing repair-capable CLI doctor remains separate; `product.doctor` is read-only.
- Promotion packaging now carries the product support files needed by the existing CLI doctor/health paths:
  - `scripts/install-wag-local-launchers.ps1`
  - `scripts/wag-local-doctor.ps1`
  - `scripts/wag-local-product-health.ps1`
  - `scripts/wag-local-provision.ps1`
  - `scripts/wag-local-setup.ps1`
  - launcher/start/supervisor scripts
  - `docs/benchmarks/devspace-pin.json`
  - `packaging/runtime-package-lock.json`
  - license notices.
- Promotion validation now fails closed if those support files are missing.

## Acceptance

- TypeScript typecheck: PASS.
- Build: PASS.
- Focused M10/direct-surface suite: 22/22 PASS.
- Product suite after adding M10 regression: 63/63 PASS.
- `git diff --check`: PASS.
- DC replacement acceptance: ENVIRONMENT BLOCKED before M10 code execution because the isolated DevSpace fixture timed out during startup. The same failure reproduced at `startPinnedDevspace`; no M10 assertion or tool invocation failed.

## Regression coverage

Pure doctor regression covers:
- fully coherent PASS;
- installed extension SHA mismatch -> FAIL;
- remote Git policy/tool mismatch -> FAIL;
- bounded maintenance lease -> WARN;
- browser-disabled profile does not require browser-only capabilities.

Promotion regression asserts doctor/health support files remain part of every prepared runtime.

No public push, merge, or live promotion is claimed by this document yet.
