# ADR-0016: Use WAG-Owned Durable Verify Jobs

Date: 2026-09-15
Status: Proposed
Depends on: ADR-0014, ADR-0015, `TRUSTED_CALLER_CONTEXT_V1 = PASS`

## Decision

WAG will introduce its first generic-job specialization as a durable job core for the existing configured `verify.run` capability.

A durable verify job is WAG state. Its WAG-generated `job_id`, exact `owner_id` / `session_id` / `adapter_id`, `workspace_id`, trusted profile identity, effective-plan hash, fixed dispatch deadline, attempt id, state, bounded result, and recovery decision are persisted independently from MCP task state or backend process handles. V1 fixes the dispatch lifetime at 300,000 ms from creation and never refreshes that deadline.

The v1 state set is `QUEUED`, `EXECUTING`, `SUCCEEDED`, `FAILED`, and `OUTCOME_UNKNOWN`.

Immediately before any initial or recovered claim, WAG revalidates the stored dispatch deadline, durable workspace ownership, supported backend, current trusted profile, and effective-plan hash. Expiry or drift while the job is still `QUEUED` fails before any backend call. Startup reconciliation sweeps expired queued rows, and no reconnect/retry/recovery may extend the deadline.

Normal execution then claims a job atomically from `QUEUED` to `EXECUTING` and persists a fresh WAG attempt id before invoking the execution port.

A command that returns confirmed completion becomes `SUCCEEDED` even when its exit code is non-zero. The exit code is part of the verification result.

`FAILED` is reserved for cases where WAG can prove execution did not begin, such as pre-execution ownership/profile/recovery admission failure. V1 does not use `EXECUTING -> FAILED` for uncertain backend errors.

Once a job is `EXECUTING`, restart, backend loss, unconfirmed timeout interruption, or any other condition that cannot prove exact completion produces `OUTCOME_UNKNOWN`. WAG must not blind-replay that job.
## Restart policy

A persisted `QUEUED` job may execute after WAG restart only when all original capability constraints still hold and the trusted local profile explicitly opts into `resumeQueuedAfterRestart`.

That option defaults to false. It is local trusted configuration, never a model/tool argument.

Recovery recomputes the effective verify-profile plan from current trusted configuration. The stored SHA-256 plan hash and dispatch deadline must remain valid before restart dispatch. Profile removal, effective-plan drift, ownership drift, unsupported backend kind, disabled queued-resume policy, or deadline expiry terminates the still-unexecuted job as `FAILED` with a bounded closed-set error class and no backend call. The resume flag remains in the plan hash to detect changes and is also checked explicitly true so an unchanged non-resumable profile cannot run after restart.

The effective plan hash covers normalized argv order, effective timeout, effective max-output bound, sorted trusted environment entries, and the restart-resume policy. Raw argv/env are not copied into the durable job record.

V1 intentionally does not bind a verify job to a repository content snapshot. A queued-resume profile is therefore an operator assertion that delayed execution against the current contents of the same owned workspace is acceptable for that profile.

## Capability port

The durable coordinator will execute only through a verify-specific port. The port accepts a trusted resolved verify profile and owned canonical workspace context; it does not accept model-supplied shell text, arbitrary argv/env, generic MCP forwarding, or backend-native handles from the caller.

Backend process/session handles remain replaceable attempt evidence. They are not job identity or ownership authority and are not returned through host adapters.

The current DevSpace adapter may make a best-effort same-runtime interrupt when a bounded execution remains running, but Ctrl-C submission is not proof that the owned process stopped. V1 therefore records that outcome as unknown unless exact completion was already observed.
## Storage and ownership

The accepted SQLite control-plane store is extended additively with verify-job and verify-job-event tables. Existing workspace, mutation, and mutation-audit tables are not rewritten by this decision.

Each job references one durable workspace record and duplicates the exact authority tuple required by ADR-0014 so every direct job lookup can fail closed before returning result data. Unknown ids and wrong-owner ids must use the same caller-facing denial so lookup behavior does not reveal another caller's resource existence.

Durable events record transition metadata, attempt id, bounded reason/error class, and timestamps. They do not store raw command text, environment values, canonical roots, backend handles, or command output.

The bounded final verify output may be persisted in the job result because result recovery is part of this capability. The implementation must impose an independent UTF-8 byte limit and an explicit truncation marker in addition to the existing executor token bound. Parent/runtime secrets remain scrubbed under the existing verify environment policy.

## MCP Tasks boundary

The repository remains on exact-pinned `@modelcontextprotocol/sdk` 1.29.0 during this milestone.

SDK v1 task ids and `TaskStore` remain compatibility machinery only. This milestone does not rewrite the current MCP task projection or expose a new public job API.

A future reviewed projection may map MCP Tasks extension handles to WAG job ids, but the projection must preserve WAG authority, recovery state, and failure classification and must remain replaceable across SDK versions.

## Surface and authority boundary

Default MCP and Business stdio remain the existing five tools. Browser Adapter v1 remains the existing three read-only tools. No `job.*` tool, cancellation, arbitrary command input, PTY, Git write, browser mutation, or process manager is authorized by this ADR.

The first implementation has zero production coordinator call sites: it is exercised only by tests or an explicit non-production harness where trusted composition supplies `GatewayCallerContext`. It does not manufacture caller identity for transports that do not yet have a reviewed WAG session/admission binding.
## Consequences

WAG gains restart-safe ownership and result semantics for one bounded capability without prematurely designing a generic shell/process scheduler.

The conservative post-claim rule can produce false-positive `OUTCOME_UNKNOWN` both when WAG crashes after claim but before process start and when an ordinary same-runtime execution-port exception occurs without exact no-side-effect evidence. That is accepted in v1 because it prevents unsafe duplicate execution; stronger no-side-effect/reattach evidence belongs to a later process-ownership milestone.

Queued restart execution is explicit rather than automatic for every profile. Operators must opt a trusted profile into delayed restart execution; profiles without that property fail safely before any recovered backend call.

Persisting bounded verify output extends its local retention lifetime. This data remains in the local control-plane trust domain and must not be included in audit rows or exposed to a different caller tuple.

Passing the v1 acceptance gate authorizes only the internal durable verify-job core and later reviewed consumers of it. It does not authorize default/Business activation, MCP Tasks replacement, cancellation, process reattachment, terminal/Git authority, browser execution, or Remote Desktop Commander replacement.