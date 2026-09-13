# Durable Local Control Plane — First Vertical Slice

Date: 2026-09-13
Status: Proposed for written review
Decision authority: ADR-0010, ADR-0011, ADR-0012
Supersedes: the remote `preview -> local approve -> remote apply` mutation protocol from ADR-0008/0009 once this design passes acceptance

## Goal

Turn WAG into the authority for durable local execution state without widening the production Business/default tool surface.

The first vertical slice removes the browser round-trip from mutation authorization. A Web AI host may request an immutable preview and later read its result, but only a local operator action may authorize execution of that exact stored mutation.

This slice also removes two accidental architectural dependencies:

- MCP transport/session state is not WAG domain state.
- DevSpace is not WAG's permanent security or execution authority; it is one pluggable backend implementation.

The design keeps one reasoning brain in the selected Web AI conversation. WAG executes policy, persistence, approval, reconciliation and bounded local side effects; it does not add an autonomous LLM loop.

## Target topology

`Web AI -> thin host adapter -> WAG control plane -> capability-specific backend`

Host adapters may be native MCP, a WAG-owned browser bridge, or Playwright as a last resort. Adapter choice must not change control-plane semantics.
## Durable state

The control plane owns its persistent records. Transport connections and backend handles are references to that state, not the source of truth.

## First vertical slice

The first slice introduces two remote operations for an opt-in change workflow:

- `mutation.preview`
- `mutation.result`

The existing five-tool default and Business stdio surfaces remain unchanged. The old browser spike protocol is not a compatibility requirement because it has never been a production surface.

## Identity and ownership

Every durable record carries neutral identity fields: `owner_id`, `session_id`, `adapter_id`, `workspace_id`, and its own operation id.

Provider-specific conversation identifiers may be stored as optional metadata, but they cannot replace WAG identity.

A workspace record stores its canonical local root and backend kind locally. Remote callers receive only opaque WAG ids. Backend-specific handles are re-creatable references and are not durable authority.

This first slice does not implement a generic multi-session scheduler. It establishes the record shape and owner checks needed by the change workflow so later process/browser managers can use the same ownership model.

## Persistence

The architectural storage contract is `DurableStore`; the first implementation uses SQLite. The ADR does not lock WAG to a specific Node SQLite package.

The database lives outside repositories in a per-user local application-data directory. Tests use disposable databases. Audit records must avoid copying unrestricted file contents or secrets.

For this slice, the change record itself is the durable job. Do not build a generic job framework yet. The record stores the immutable plan, timing, ownership, lifecycle state and bounded result/error metadata.

The minimum persisted plan includes relative path, base SHA-256, bounded `before` and `after` text, result SHA-256 and fingerprint. Execution always re-reads the target and revalidates these facts before writing.

## Lifecycle

The first-slice lifecycle is:

`PENDING_APPROVAL -> QUEUED -> EXECUTING -> SUCCEEDED | FAILED | OUTCOME_UNKNOWN`

Additional terminal states are `REJECTED` and `EXPIRED`.

Preview creates `PENDING_APPROVAL` with a 60-second local-review deadline. A local approval performs one conditional database transition from the still-live pending state to `QUEUED` and records an execution-admission deadline 60 seconds after approval.

The worker may claim only a queued record whose execution-admission deadline has not passed. Claiming moves it to `EXECUTING`. Repeated local approval does not extend either deadline and cannot create a second job.

## Local operator surface

Local review is not an MCP tool and is not writable by model output, repository content or adapter messages.

The preferred first implementation is a loopback-only operator service with a tiny review page. It binds only to `127.0.0.1`, validates its exact Origin, and uses a high-entropy local operator session established outside the Web AI adapter path.

A one-time bootstrap value may establish the operator browser session, then must be rotated and replaced by an HttpOnly, SameSite=Strict cookie. State-changing requests require a separate CSRF value. No bearer or review credential is returned through MCP or written into repository files.

The page shows the exact relative path, bounded before/after summary, line counts, hashes and fingerprint. The operator can approve or reject only the displayed immutable record.

A native desktop UI may replace this transport later without changing the control-plane contract.

## Execution and reconciliation

Before backend execution, WAG repeats canonical path containment, sensitive-path policy, target existence, binary/size checks, base hash, exact-match uniqueness and fingerprint calculation from fresh local state.

Only after those checks pass may the worker submit the exact candidate through the selected file-mutation backend. Post-write read-back must equal the stored result SHA-256 before the record becomes `SUCCEEDED`.

On restart, `PENDING_APPROVAL` and `QUEUED` records are evaluated against their stored deadlines. Expired records fail closed.

For a record found in `EXECUTING`, WAG re-reads the target. Result hash means reconcile to `SUCCEEDED`. Base hash means no file effect is visible; the record may return to `QUEUED` only while its original execution-admission deadline is still live. Any other hash becomes `OUTCOME_UNKNOWN` and requires operator review rather than blind retry.

This slice never refreshes authorization timing during recovery.

## Backend contracts

WAG does not treat one executor as the permanent implementation for every capability.

The file-change controller depends on a narrow backend port for workspace rebinding, exact text reads and one bounded existing-file update. The first adapter may continue using DevSpace so the control-plane redesign changes one major variable at a time.

Command/verification and browser execution use separate backend ports. Future implementations may be evaluated independently against compatibility, latency, Windows behavior and security tests.

Backend outputs are evidence, not policy. WAG verifies target identity and final content independently.

Replacing a backend must not change remote tool semantics, durable ids, local review semantics or audit schema.

## Verification strategy

Tests cover stored-state transitions, deadlines, identity mismatch, stale local state, path containment, bounded text rules, restart recovery and final hash checks.

Storage tests use injected clocks and disposable databases. Backend contract tests run against a fake implementation first and the pinned DevSpace adapter second.

The repository gate remains test, typecheck, build, Business acceptance, backend compatibility checks and `git diff --check`.

## Acceptance gate

The first vertical slice passes only when a supported Web AI path can create a fresh preview, the local operator can review that exact stored record, WAG can complete it locally, and the host can later read the durable result.

Acceptance also requires file read-back and final repository snapshot evidence on a fresh disposable fixture, plus restart tests for queued and in-progress records.

No result generated only by the model or adapter counts as evidence without matching WAG state and local read-back.

## Migration

The existing file-patch spike remains historical evidence during implementation. The new slice is built beside it and benchmarked independently.

After the new acceptance gate passes, the old two-step browser protocol is removed from the experimental path rather than retained for compatibility. Default and Business production surfaces still require a separate enablement decision.

DevSpace remains the first file backend only to isolate variables during the control-plane change. A later benchmark may replace it without changing this design.

## Non-goals

This slice does not add arbitrary shell, persistent PTY, Git writes, file creation/deletion/move, multi-file transactions, a generic scheduler, a new autonomous model loop, production Business mutation, or a full browser-extension rewrite.

It also does not claim that a path allowlist or same-host ACL is a complete sandbox.

## Minimum durable record

Each record stores: operation id, owner id, session id, adapter id, workspace id, backend kind, relative path, base hash, bounded before/after text, result hash, fingerprint, lifecycle state, creation time, review deadline, reviewed time, execution-admission deadline, execution-start time, completion time, bounded result metadata and bounded error class.

State changes use conditional database updates against the expected current state and deadline. Competing reviewers or workers cannot both advance the same record.

Audit events are append-only facts derived from successful state changes. They record ids, timestamps, state transitions and hashes/summaries, not unrestricted source-file contents.
