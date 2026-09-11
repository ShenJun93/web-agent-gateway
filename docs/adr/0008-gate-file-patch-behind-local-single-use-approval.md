# ADR-0008: Gate `file.patch` Behind Local Single-Use Approval

Date: 2026-09-11
Status: Accepted for post-V0 mutation spike

## Context

ADR-0005 requires mutation to be evaluated only after the read/verify architecture proves value. That local architecture gate has passed, while the current Business stdio design intentionally remains a five-tool non-mutation surface.

The pinned DevSpace executor exposes `apply_patch`, but that capability can add, update, delete, or move files. Exposing it directly would bypass the Gateway's path, stale-target, and approval boundaries.

Repository content and model output are untrusted policy inputs. A model saying that a change is approved is not a local-user approval.

## Decision

Authorize a separate mutation spike for one semantic capability: updating one existing non-sensitive text file inside an already-opened workspace.

The mutation flow is two-phase: preview first, then apply only after a local human approval bound to the exact request fingerprint. Approval is short-lived and single-use. Apply revalidates the canonical target, base SHA-256, replacement fingerprint, and approval immediately before delegating to DevSpace.

The first spike rejects file creation, deletion, moves, multiple targets, raw Codex patches supplied by the remote model, Git mutation, raw shell, and persistent or wildcard approvals.

## Approval boundary

The mutation core owns an in-memory pending-request store. The post-V0 browser spike may use an operator-controlled local approval channel that is not exposed as an MCP tool. The existing Business stdio command does not enable mutation in this ADR.

Approval state cannot be changed by repository files, MCP arguments, model text, or verification command output. Failed, expired, replayed, mismatched, or stale approvals fail closed.

## Consequences

- Existing five-tool Business/stdio behavior stays unchanged unless a later decision explicitly enables mutation there.
- The Gateway constructs the DevSpace patch itself; callers never receive arbitrary `apply_patch` passthrough.
- A successful spike proves bounded file-update mechanics, not full coding equivalence or safe arbitrary mutation.
- A secure production approval transport for Business/Secure MCP Tunnel remains a separate decision if this spike proves valuable.
