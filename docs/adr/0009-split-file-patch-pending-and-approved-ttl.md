# ADR-0009: Split `file.patch` Pending and Approved TTL Windows

Date: 2026-09-12
Status: Superseded — historical timing rule for the retired `file.patch` protocol
Amends: ADR-0008 timing semantics only

## Context

ADR-0008 requires local, fingerprint-bound, short-lived, single-use approval for the bounded `file.patch` spike. The approved spike design implemented one 60-second clock beginning when preview creates the pending approval.

Browser acceptance showed that this single clock can expire after the operator has approved but before the supported host emits the apply call. In the latest ChatGPT Instant trace, preview-to-apply took 66.717 seconds, while operator-approval-to-apply was only about 37 seconds.

Simply increasing the preview TTL would also increase the lifetime of an already-approved mutation. That weakens the intended short-lived mutation authority more than the observed host behavior requires.

## Decision

Keep the pending-preview lifetime at exactly 60 seconds from preview creation. A pending request that is not locally approved before that deadline expires and cannot later be approved.

On the first successful local approval of the exact `approvalId + fingerprint`, transition the request to approved and start a separate approved-use lifetime of exactly 60 seconds from that local approval time.

The original pending deadline remains an audit fact and is not rewritten. The approved-use deadline is stored separately. Repeating the same local approval may be treated as idempotent, but it must never extend or restart the approved-use deadline.

Apply may consume only an approved, unexpired request with the exact fingerprint. Consumption remains single-use and occurs immediately before DevSpace mutation after all existing fresh validation succeeds.

## Approval boundary

This decision does not add an approval MCP tool, persistent approval storage, wildcard approval, model-controlled approval, or a production approval transport. Approval remains process-memory only and writable only through the local operator channel.

`preview.expiresAt` continues to mean the deadline for local approval. The approved-use deadline is not supplied by the remote model and does not become a new remote authority input.

All stale-target, path, size, binary, exact-match, base-hash, fingerprint, donor-metadata, and post-write verification rules remain unchanged.

## Consequences

- A host may take up to the existing pending 60 seconds to surface a preview for operator approval without consuming the later mutation-authority window.
- Once the operator approves, actual mutation authority still lives for at most 60 seconds and remains single-use.
- Browser acceptance must be rerun; this ADR does not retroactively convert the prior fail-closed attempts into a pass.
- Default MCP and Business stdio remain five-tool non-mutation surfaces.
- Production mutation enablement remains a separate decision even if the spike browser gate later passes.
