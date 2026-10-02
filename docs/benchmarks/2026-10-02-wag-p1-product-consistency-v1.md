# WAG P1 Product Consistency v1 — Batch C Acceptance

Date: 2026-10-02

## Branch / base

```text
branch: feat/p1-ai-owned-tab-git-policy-v1
stacked base: 2ce06b104ff73506fdec722a193b2fee979d54a7
publication: LOCAL ONLY
```

## Scope

Batch C closes two post-launch consistency gaps:

1. create a visible AI-owned browser tab without borrowing an existing user tab;
2. align workspace-level `GIT_PUSH` capability reporting with target-scoped autonomous remote policy.

## Browser: fresh visible AI-owned tab

### Explicit mode and backward compatibility

`AI_TAB_GROUP` may now be opened without `target_id`. The extension creates exactly one inactive `about:blank` tab, groups it, attaches debugger control, and marks the durable logical session as AI-owned.

`AUTO` behavior is intentionally unchanged:
- `AUTO` without an exact target remains `WAG_HEADLESS`;
- `AUTO` with an exact target still resolves to `AI_TAB_GROUP`.

This avoids turning a temporary extension disconnect into an unexpected visible-browser failure.

### Control protocol

The bounded existing-browser control protocol adds:

```text
target.create
target.close
```

`target.create` uses an inactive tab. `target.close` is exact-target and idempotent.

The attachability exception is limited to exactly `about:blank`; other browser-internal/non-web schemes remain non-attachable.

### Ownership and lifecycle

Durable attached-session state now records `ai_owned`.

For an AI-owned session:
- restart suspension detaches but preserves the created tab;
- recovery reuses the same durable logical session and tab rather than creating another tab;
- terminal close closes only targets retained by that AI-owned logical session;
- close replay remains idempotent.

For user-existing targets:
- existing `ATTACH_EXISTING` and exact-target `AI_TAB_GROUP` behavior is preserved;
- close detaches debugger control and does not close the user's browser tab.

The durable store performs an additive migration for the `ai_owned` column so existing state remains readable.

## Git push capability consistency

Previously, `capabilities.describe` could report workspace-level `GIT_PUSH.granted=true` whenever an autonomous remote policy was configured, even though a concrete push could later fail with `AUTONOMOUS_REMOTE_POLICY_DENIED` because the resolved push URL or destination ref was outside the allowlist.

Batch C changes the workspace-level description to:

```text
granted: false
denied: true
grantable: true
requires_human: false
reason: AUTONOMOUS_REMOTE_POLICY_TARGET_SCOPED
```

This is intentionally conservative: the workspace description no longer claims that every target is granted. The concrete `git.push` plan remains the authority for the exact push URL + destination ref.

Existing policy behavior is preserved:
- exact allowlisted autonomous push: PASS;
- unmatched autonomous-only target: fail-closed with `AUTONOMOUS_REMOTE_POLICY_DENIED`;
- kill switch: fail-closed before remote effect;
- no broadening of push authority.

## Automated evidence

Final focused browser + Git-policy battery:

```text
70/70 PASS
```

Final affected-surface regression:

```text
100/100 PASS
```

Supplemental bridge/runtime regression outside that 100-test set:

```text
browser-control-websocket-extension.test.ts  2/2 PASS
browser-existing-runtime.integration.test.ts 1/1 PASS
```

Build gates:

```text
typecheck        PASS
build            PASS
git diff --check PASS
```

A monolithic `npm test` invocation was attempted but exceeded the bounded WAG command-call window. Acceptance therefore uses the deterministic affected-surface and adjacent bridge/runtime batteries above; no full-suite claim is made.

## Publication boundary

No public push, live promotion, npm publish, GitHub release, or signing action was performed by Batch C acceptance.
