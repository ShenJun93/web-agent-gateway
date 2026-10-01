# WAG Immutable Multi-File Change Set — P0 Acceptance

Date: 2026-10-01

Implementation commit: `860ed6998ab5818f5bb8b4ca9a6088d977ed17f9`

Branch: `feat/wag-public-launch-p0-v1`

## Scope

This closes the P0 **Immutable Multi-File Change Set** item in the public-launch plan.

Published semantic family:

- `change.preview`
- `change.apply`
- `change.result`

Supported operations: `replace`, `create`, `delete`, `move`.

No standalone public `file.delete` or `file.move` surface was added.

## Immutable plan binding

A prepared change set binds caller-owned workspace identity, canonical repository root, exact base Git HEAD, ordered operation set, base SHA-256 values, result SHA-256 values, create/move destination vacancy, and an immutable plan SHA-256.

Bounds: 1–32 operations; each caller-provided content payload <= 32 KiB; aggregate caller-provided content <= 256 KiB; exact workspace-relative path policy; duplicate/touch-overlap paths rejected; no-op replace rejected. Replace may intentionally produce an empty file; create remains non-empty.

## Durable state and recovery

Durable state lives at `<mutation-state-path>.change-set.sqlite`.

State model: `PREPARED -> APPLYING -> APPLIED -> VERIFIED`, with post-effect uncertainty recorded as `PARTIAL_EFFECT_DETECTED`.

Before apply, WAG revalidates workspace identity, exact HEAD, every path precondition, and the local autonomy kill switch. VERIFIED replay returns the durable result. Recovery never blindly replays APPLYING/APPLIED plans: it classifies observed filesystem state as BEFORE, AFTER, or mixed. Mixed/uncertain post-effect state becomes `PARTIAL_EFFECT_DETECTED`.

Filesystem-level perfect transactions are not claimed.

## Backend coverage

The same coordinator runs against `local-machine` and `devspace` file mutation backends. The shared backend contract now includes exact-content delete; both production backends verify complete current text before delete and verify absence afterward.

Move is intentionally decomposed into exact destination create + exact source delete. An interruption between them is detected as a durable partial effect rather than replayed blindly.

## MCP/runtime wiring

The change-set context is wired through repository engineering runtime, private stdio, CLI `serve-stdio`, direct MCP tunnel projection, and remote relay device runtime.

Measured projected tool counts on the accepted full profile after this change:

- without BrowserPort: **70**
- with BrowserPort: **78**

The three `change.*` tools are present in both projections.

## Verification

Focused change-set acceptance: **6/6 PASS**. Coverage includes all four operations, idempotent VERIFIED replay, replace-to-empty, create-empty rejection, HEAD drift, all-path preflight, partial move detection, and restart reconciliation without blind replay.

DevSpace backend focused acceptance: **5/5 PASS**, including a real pinned-DevSpace exact delete test.

Direct MCP projection/declaration, repository engineering runtime, stdio lifecycle, DesktopPort semantic-delta test, and private BrowserPort assembly all pass in focused reruns.

Build gates:

- `npm run typecheck` = PASS
- `npm run build` = PASS
- `git diff --check` = PASS

## Broad-suite evidence and environment blockers

Initial broad local suite on this candidate lineage: **1187 tests / 1177 pass / 4 fail / 6 todo**.

Failure classification:

1. DesktopPort test had a stale absolute total-tool count. It now asserts the intended invariant: DesktopPort adds exactly seven semantic tools regardless of unrelated surface growth. Isolated rerun = PASS.
2. Private BrowserPort assembly test attempted to bind the live fixed browser-control port 17841. It now injects the existing runtime seam instead of competing with the user's running WAG instance. Isolated rerun = PASS.
3. Browser adapter native-host acceptance repeatedly fails with Windows `spawn UNKNOWN` while launching a newly built temporary SEA executable.
4. Native-host artifact acceptance repeatedly fails with the same Windows `spawn UNKNOWN` condition.

The two native-host failures reproduce in isolation and are treated as Windows Application Control / local executable-policy blockers. Production code was not weakened and no bypass was added.

## Publication boundary

- `PUBLIC_PUSH = NO`
- `LIVE_RUNTIME_PROMOTION = NO`
- `PUBLIC_NPM_PUBLISH = NO`
- `PUBLIC_LAUNCH = NO`

Remote truth at acceptance time:

- `origin/main = 033a913c2f05b8b9a62c376a70832e7ae9f9e91c`
- `origin/feat/wag-public-launch-p0-v1 = absent`
