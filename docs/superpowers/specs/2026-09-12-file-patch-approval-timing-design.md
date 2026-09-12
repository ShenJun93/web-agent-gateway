# File Patch Approval Timing Design Delta

Date: 2026-09-12
Status: Accepted
Decision authority: ADR-0009
Amends: `2026-09-11-file-patch-mutation-spike-design.md` timing semantics only

## Goal

Preserve the existing 60-second pending-preview limit and 60-second short-lived mutation authority while preventing host latency before apply from consuming time that should belong to the operator-approved window.

This delta changes only approval timing. It does not broaden mutation scope, remote inputs, executor capability, target policy, persistence, or the default Business/stdio surface.

## State model

Each approval request has one immutable identity and fingerprint plus two distinct time boundaries:

- `pendingExpiresAt = createdAt + 60_000` while state is pending;
- `approvedExpiresAt = approvedAt + 60_000` after the first successful local approval.

Effective states remain pending, approved, and consumed/removed. While pending, expiry is evaluated against the pending deadline. After the first successful approval, expiry is evaluated only against the approved-use deadline. Expiry removes the request fail-closed.

A request cannot transition from expired pending to approved. A request cannot transition from consumed/removed back to approved.

## Preview semantics

Preview keeps every validation and fingerprint rule from the approved mutation-spike design. It creates a pending request with a 60-second pending deadline.

The existing MCP preview response stays compatible. Its `expiresAt` field means **deadline for local approval**, not deadline for later apply.

Preview still performs no mutation and does not create approved authority.

## Local approval semantics

For a pending request, `approveLocal(approvalId, fingerprint)` succeeds only when the request exists, is still inside its pending deadline, and the fingerprint matches exactly.

The first successful approval records `approvedAt` and `approvedExpiresAt = approvedAt + 60_000` without changing `pendingExpiresAt`.

For an already-approved request, repeating the same exact local approval returns success only while the original approved-use window is still live. It preserves the original `approvedAt` and `approvedExpiresAt` and never refreshes mutation authority. Re-approval after approved-use expiry fails closed.

A mismatched fingerprint remains rejected.

## Apply semantics

Apply repeats every existing fresh validation before approval consumption. The request must be approved, the fingerprint must match exactly, and `approvedExpiresAt` must still be in the future.

The pending deadline no longer controls apply after a request has transitioned to approved. This is the only timing behavior changed by this delta.

Consumption remains single-use and happens immediately before DevSpace mutation. Any stale, mismatched, expired, or replayed request fails closed and cannot be revived.

## Implementation boundary

`src/patch-approval.ts` owns the split clocks and state transition. The stored request must preserve the pending deadline after approval and add separate approved timing fields.

`src/file-patch.ts` continues to depend only on approval-store state and fingerprint checks. It must not calculate or extend approval timing itself.

`scripts/file-patch-browser-spike.ts` remains the local-only approval channel. The remote `file.patch` schema and default five-tool surfaces do not change.

No executor, path-policy, patch-generation, or HTTP authentication behavior changes under this delta.

## Required tests

TDD must prove the timing state machine directly with an injected clock:

- pending approval expires at 60 seconds if never approved;
- approval just before pending expiry succeeds and creates a fresh 60-second approved-use window;
- apply/consume can succeed after the original pending deadline when still inside the approved-use deadline;
- approved authority expires exactly at its own deadline;
- repeated exact local approval does not extend `approvedExpiresAt`;
- mismatched approval, stale target, fingerprint drift, replay, and revoke behavior remain fail-closed;
- preview response still reports the pending deadline and the MCP schema is unchanged;
- default MCP and Business stdio still expose exactly five tools.

## Acceptance gate

After implementation, rerun the full repository suite, typecheck, build, Business acceptance, exact-pinned DevSpace checks, and `git diff --check`.

Browser acceptance must start from a fresh disposable fixture and prove the complete supported-host sequence: preview, local approval, apply inside the approved-use window, file read-back, and final `repo.snapshot`/Git diff.

The previous fail-closed browser attempts remain historical evidence only. This timing delta does not convert them into successful acceptance.

## Non-goals

This delta does not authorize a longer than 60-second approved-use window, a longer pending-preview window, approval renewal, persistent approvals, public approval APIs, wildcard approvals, raw patch input, broader file mutation, or Business/default mutation enablement.

Production approval transport and production mutation promotion remain separate decisions.
