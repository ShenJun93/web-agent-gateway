# WAG Post-Launch Gap Closure Run

Updated: 2026-10-02

## Execution order

### Batch A — P0 upload + media safety

State: **LOCAL ACCEPTANCE PASS / PUBLICATION STOP**

Scope:

- `browser.upload_file`
- `machine.media.inspect`
- `verify.media`

Evidence:

- real managed Edge upload without native chooser: PASS;
- exact-once replay: PASS;
- real multipart filename/content verification: PASS;
- workspace-relative/contained/file-only path policy: PASS;
- real FFmpeg video with audio: PASS;
- real FFmpeg silent video: correctly FAIL;
- focused + affected-surface regression: PASS;
- typecheck/build/diff-check: PASS.

Canonical evidence:

```text
docs/benchmarks/2026-10-02-wag-p0-upload-media-preflight-v1.md
```

### Batch B — P1 browser reliability

State: **LOCAL ACCEPTANCE PASS / PUBLICATION STOP**

Scope:

- `browser.wait_for`
- `browser.assert`
- `browser.media.inspect`
- session recovery/release hardening.

Evidence:

- real managed Edge semantic wait: PASS without caller sleep;
- real semantic assert: PASS;
- real media inspect: playback state, duration, error, dimensions and decoded-audio evidence PASS;
- existing-browser fixed media function allowlist + arbitrary-JS denial: PASS;
- missing broker-route recovery preserves the durable caller-owned session: PASS;
- fresh profile alias on the same exact owned target reuses the durable logical session instead of creating a conflicting claim: PASS;
- active foreign/session target claim remains fail-closed: PASS;
- detach timeout keeps claims retryable: PASS;
- atomic multi-target claim cleanup: PASS;
- successful close deletes broker route and attached close replay is idempotent: PASS;
- affected-surface regression: 84/84 PASS;
- typecheck/build/diff-check: PASS.

Canonical evidence:

```text
docs/benchmarks/2026-10-02-wag-p1-browser-reliability-v1.md
```

### Batch C — P1 product consistency

State: **LOCAL ACCEPTANCE PASS / PUBLICATION STOP**

Scope:

- create a new visible AI-owned tab without borrowing an existing user tab;
- align `capabilities.describe` Git-push grants with actual autonomous remote policy decisions.

Evidence:

- explicit `AI_TAB_GROUP` without `target_id` creates one inactive WAG-owned tab: PASS;
- `AUTO` without target remains headless for backward compatibility: PASS;
- user-existing attached tabs remain detach-only on close: PASS;
- AI-owned tab restart recovery reuses the same logical session/tab: PASS;
- terminal close closes the AI-owned tab and close replay remains idempotent: PASS;
- `target.create` / `target.close` bounded protocol + WebSocket bridge: PASS;
- autonomous `GIT_PUSH` capability is reported as target-scoped rather than globally granted: PASS;
- exact allowlisted autonomous push still executes; unmatched target remains fail-closed: PASS;
- final focused regression: 70/70 PASS;
- affected-surface regression: 100/100 PASS;
- supplemental bridge/runtime regression: 3/3 PASS;
- typecheck/build/diff-check: PASS.

Canonical evidence:

```text
docs/benchmarks/2026-10-02-wag-p1-product-consistency-v1.md
```

## Publication boundary

Batch A+B+C remain local until their stacked feature branches are explicitly published/reviewed. No
live promotion is performed from this ledger without the normal public-main boundary.
