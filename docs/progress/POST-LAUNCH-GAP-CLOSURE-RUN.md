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

State: **PENDING**

Planned scope:

- `browser.wait_for`
- `browser.assert`
- `browser.media.inspect`
- session recovery/release improvements for:
  - session is not routed;
  - target owned by another session;
  - timeout/reconnect cleanup.

### Batch C — P1 product consistency

State: **PENDING**

Planned scope:

- create a new visible AI-owned tab without borrowing an existing user tab;
- align `capabilities.describe` Git-push grants with actual autonomous remote policy decisions.

## Publication boundary

Batch A remains local until its feature branch is explicitly published/reviewed. No live promotion is
performed from this ledger without the normal public-main boundary.
