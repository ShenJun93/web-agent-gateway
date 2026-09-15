# Durable Verify Job Core v1 Design

Date: 2026-09-15
Status: Accepted and implemented (internal core only)
Decision authority: ADR-0014, ADR-0015, ADR-0016
Research receipt: `docs/research/2026-09-15-durable-verify-job-core.md`
Acceptance receipt: `docs/benchmarks/2026-09-15-durable-verify-job-core-v1.md`
Dependency parent: `b1b6dcae175b3f7c2ff704161e9d683afafbee89`

## Goal

Implement the smallest WAG-owned durable job plane for the already bounded configured `verify.run` capability, with exact caller ownership, SQLite persistence, restart reconciliation, and bounded durable results.

This milestone is an internal control-plane capability. It does not add a new host-visible tool and does not activate durable verify jobs on default MCP, Business stdio, or Browser Adapter v1.

## Why this slice

Current SDK v1 MCP Tasks can survive a client reconnect only while the same WAG runtime and in-memory task store remain alive. They do not supply WAG restart durability, WAG caller ownership, or ADR-0014 recovery semantics.

Trusted Caller Context v1 now supplies the required provider-neutral authority tuple. `verify.run` is the narrowest existing long-running capability with trusted local admission, bounded timeout/output policy, and an existing same-runtime interrupt attempt.

Generic shell/process/PTY durability would require broader capability and cleanup contracts and is intentionally deferred.
## Authority and admission

Every durable verify job inherits `ownerId`, `sessionId`, and `adapterId` from a validated `GatewayCallerContext` supplied by trusted runtime composition. Model/tool arguments never carry or override those fields.

Job creation also requires an existing durable workspace record. The job caller tuple must exactly match the workspace tuple before a record is created. The job stores the same tuple so later direct lookups can fail closed without trusting only the workspace foreign key.

A WAG-generated `jobId` is the durable operation identity. MCP task ids, request ids, transport sessions, DevSpace workspace/session ids, PIDs, and provider/browser identifiers are correlation or backend handles only.

V1 exposes no host-visible `job.create`, `job.result`, `job.cancel`, or generic process API. Coordinator methods are internal TypeScript interfaces used by tests/approved runtime composition only.

## Verify profile contract

Existing `VerifyProfile` validation is factored into one shared trusted resolver used by both the historical synchronous path and the durable core so their execution semantics cannot silently drift.

The effective profile retains current bounds: 1-16 safe argv entries; timeout clamped to 100-30,000 ms; max output tokens clamped to 100-10,000; at most 16 env entries; safe env-key/value syntax; and secret-like env keys denied.

Add one trusted local option: `resumeQueuedAfterRestart?: boolean`, default false. It is never model-visible and does not grant any broader command authority. The flag is both hashed and checked explicitly during restart: hashing detects configuration changes in either direction, while the explicit true gate ensures an unchanged false profile still cannot resume.

The resolver computes a deterministic SHA-256 over the effective plan using canonical JSON with argv order preserved, effective timeout/max-output values, sorted env entries, and the effective restart-resume flag. Raw argv/env are not persisted in the job table.

Profile removal or effective-plan hash drift blocks recovered queued execution before a backend call.

## Durable record

Conceptually, a verify job record is:

```ts
interface VerifyJobRecord extends GatewayAuthority {
  jobId: string;
  workspaceId: string;
  backendKind: string;
  profileName: string;
  planSha256: string;
  state: VerifyJobState;
  createdAt: number;
  dispatchDeadline: number;
  attemptId?: string;
  executionStartedAt?: number;
  completedAt?: number;
  exitCode?: number;
  output?: string;
  outputTruncated?: boolean;
  errorClass?: string;
}
```

`jobId` and `attemptId` are WAG-generated opaque ids. Correlation metadata is not persisted as authority.
## State machine

`VerifyJobState` is exactly:

- `QUEUED`
- `EXECUTING`
- `SUCCEEDED`
- `FAILED`
- `OUTCOME_UNKNOWN`

Allowed transitions are:

- `QUEUED -> EXECUTING` when one worker atomically claims the still-admitted job and persists a fresh attempt id;
- `QUEUED -> FAILED` only when WAG proves no execution began and a pre-execution/recovery constraint fails;
- `EXECUTING -> SUCCEEDED` only after exact completion evidence is observed;
- `EXECUTING -> OUTCOME_UNKNOWN` whenever completion/non-effect cannot be proven.

Terminal states never transition. V1 deliberately has no cancellation state and no `EXECUTING -> FAILED` transition.

A completed command with exit code 0 or non-zero becomes `SUCCEEDED`; the exit code belongs to the result. A transport/backend exception after claim is not enough evidence for `FAILED`.

Immediately before every claim, initial or recovered, the coordinator re-reads the durable workspace and current trusted profile, verifies exact job/workspace authority, backend kind, and effective-plan hash, and fails the still-`QUEUED` job before any backend call if those constraints drift. The restart-only `resumeQueuedAfterRestart` flag is additionally required only for recovered dispatch.

Claim persists `attemptId` and `executionStartedAt` in the same conditional transaction that changes `QUEUED -> EXECUTING`, before any execution-port call.
## SQLite storage

Extend the accepted `SqliteDurableStore` additively. Do not rename or rewrite existing workspace/mutation semantics in this milestone.

Add `verify_jobs` with columns for job id, exact authority tuple, workspace id, backend kind, profile name, plan hash, state, created/start/completion timestamps, attempt id, exit code, bounded output, truncation flag, and bounded error class.

Add `verify_job_events` for ordered transition evidence. Events contain job id, timestamp, from/to state, attempt id when present, and bounded reason/error class only.

`verify_jobs.workspace_id` references the existing durable `workspaces` table. Existing `workspaces`, `mutations`, and mutation `audit_events` table definitions and row semantics remain untouched.

No raw argv, environment values, canonical root, backend workspace id, backend session id, request id, provider metadata, or command output may appear in `verify_job_events`.

Job creation must insert the `QUEUED` row before returning its WAG job id. V1 sets `dispatchDeadline = createdAt + 300_000` ms. The stored deadline is never refreshed by reconnect, retry, recovery, or repeated dispatch attempts. State transitions use conditional SQL inside an immediate transaction so competing workers cannot both claim or finish one job.
## Restart reconciliation

`reconcile()` processes non-terminal jobs before any recovered dispatch.

For `EXECUTING`, current v1 has no accepted exact reattach/status proof for the DevSpace session. Recovery therefore atomically records `OUTCOME_UNKNOWN` with an explicit restart-unverifiable error class and never invokes the backend again.

For `QUEUED`, recovery re-reads the durable workspace and current trusted verify profile. It requires the stored dispatch deadline to remain live, exact owner/session/adapter equality between job and workspace, supported backend kind, profile presence, exact effective-plan hash match, and `resumeQueuedAfterRestart === true`.

If the dispatch deadline has expired, or any other queued recovery check fails, the record becomes `FAILED` before execution and the execution port is not called. This classification is safe because the row was never claimed. `reconcile()` sweeps expired queued rows at startup; every dispatch path also checks the same stored deadline immediately before claim, so a stale row can never execute even if no periodic worker sweep ran.

If every check passes, recovery may claim and execute the original job id exactly once. No fresh job id, refreshed caller identity, or relaxed policy is minted during recovery.

V1 intentionally does not freeze repository contents when a verify job is queued. The restart-resume flag therefore means the local operator accepts delayed execution of that trusted profile against the current contents of the same owned workspace.

## Verify execution port

Introduce a narrow verify-specific execution port rather than a generic command/process port. It receives only an already-resolved trusted profile and the owned workspace context needed by the backend.

A DevSpace implementation may reopen the stored canonical workspace internally, execute the trusted profile, and return either exact completed evidence or unconfirmed/ambiguous evidence. Backend workspace/session handles never cross into host-visible results and never become ownership ids.
If DevSpace reports the command still running at the bounded yield timeout, the adapter may issue the existing same-runtime Ctrl-C attempt. Because `write_stdin` does not prove termination, the execution evidence remains unconfirmed and the job becomes `OUTCOME_UNKNOWN`.

Any execution-port throw after the job was claimed is also `OUTCOME_UNKNOWN`, including ordinary same-runtime transport/backend exceptions, unless a future port contract supplies independently reviewed no-side-effect evidence. This conservative classification is intentionally broader than restart-only ambiguity in v1; WAG does not infer non-execution from transport error wording.

## Durable result bounds

A `SUCCEEDED` record persists `exitCode`, bounded UTF-8 output, and an `outputTruncated` flag.

Set an independent persisted-output limit of 64 KiB UTF-8. The implementation truncates on a valid UTF-8 boundary and sets `outputTruncated=true` when backend output exceeds that bound, regardless of the executor token limit.

Result lookup requires the exact caller tuple before returning state or output. Wrong owner, session, or adapter must fail with the same bounded identity denial and must not disclose whether the job id exists for another caller.

Audit/event rows never contain result output. Error classes are a closed v1 union, never raw backend exception names/messages: `WORKSPACE_MISSING`, `WORKSPACE_OWNERSHIP_MISMATCH`, `PROFILE_MISSING`, `PROFILE_PLAN_DRIFT`, `UNSUPPORTED_BACKEND`, `RESTART_RESUME_DISABLED`, `DISPATCH_DEADLINE_EXPIRED`, `EXECUTION_TIMEOUT_UNCONFIRMED`, `EXECUTION_PORT_ERROR_UNCONFIRMED`, and `RESTART_EXECUTION_UNVERIFIABLE`.

The current environment scrub remains mandatory. Acceptance must include a sentinel-secret regression proving parent/runtime secrets do not appear in persisted job output or event rows under the existing configured verification path.
## MCP Tasks and host-visible surfaces

This milestone does not replace `NonCancellingTaskStore`, does not change `registerToolTask`, and does not map MCP task ids to WAG job ids yet.

Current SDK v1 MCP task compatibility tests remain regression coverage only. The durable verify core is independent state that future protocol adapters may project after a separate review.

Default MCP and Business stdio remain exactly `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`. Browser Adapter v1 remains exactly `health`, `workspace.open`, and `file.read`.

The historical synchronous/default `verify.run` path remains behaviorally compatible in this first milestone. Durable execution is exercised only through tests or an explicit non-production harness with trusted composition. V1 ships zero production call sites for the new coordinator and is not silently activated for transports that lack a reviewed `GatewayCallerContext` binding.

No tool input gains `owner_id`, `session_id`, `adapter_id`, `job_id`, argv, env, restart policy, backend handle, or cancellation fields.

## Error and redaction rules

Unknown job ids and wrong-owner job ids fail through the exact same bounded caller-facing denial (for example, `Gateway denied verify job`). This is intentionally stricter than the current durable-mutation precedent, whose missing-id and wrong-owner errors are distinguishable; verify-job lookup MUST NOT reuse that behavior unmodified.

Profile drift, workspace ownership drift, unsupported backend kind, and restart-resume-disabled are persisted as bounded internal error classes only after WAG proves no execution began.

Raw backend errors, tokens, canonical roots, environment values, command strings, backend ids, and unrelated ownership tuples must not cross remote boundaries or enter transition-event rows.
## Expected implementation footprint

Create, names may be refined only without widening semantics:

- `src/verify-profile.ts` for trusted profile normalization, command construction, and plan hashing;
- `src/durable-verify-job.ts` for coordinator/state/recovery policy;
- `src/verify-execution-port.ts` for the narrow capability contract;
- `src/executor/devspace-verify.ts` for the current backend adapter;
- focused unit and acceptance tests for those contracts.

Modify:

- `src/durable-store.ts` only for additive verify-job/event schema and methods;
- `src/server.ts` only as needed to consume the shared profile resolver while preserving the existing exported `VerifyProfile` compatibility and current `verify.run` behavior;
- existing verify/environment tests where needed to prove behavior preservation.

Do not modify `src/task-store.ts`, `src/http-server.ts`, `src/stdio-server.ts`, browser extension/runtime/native-host production code, private config, OAuth, package manifest/lockfile, mutation state-machine semantics, or installation/distribution code unless a RED type-level regression proves an unavoidable dependency. Any such surprise requires design review before widening scope.

## Verification strategy

Store tests must prove create-before-id-return, exact tuple persistence, foreign workspace linkage, exact 300,000 ms dispatch deadline persistence with no extension, conditional single claim, terminal immutability, additive schema, event redaction, and reopen persistence.
Profile tests must prove deterministic hashing, env-key ordering independence, bounds/defaults, unsafe argv/env rejection, secret-like env-key rejection, and that toggling restart-resume policy changes the hash.

Coordinator tests must independently reject wrong owner, session, and adapter for creation/result lookup; prove unknown-id and wrong-owner result lookup return the same bounded denial; prove profile/workspace drift between enqueue and initial claim fails before the port is called; prove non-zero exit is a successful job result; prove only one concurrent claim executes; and prove output persistence/truncation at the exact byte boundary.

Recovery tests must prove:

- `QUEUED` + unchanged plan + matching ownership + live dispatch deadline + resume enabled executes the same job id once after reopen;
- expired `QUEUED` fails before the port is called and reconnect/recovery never extends its stored deadline;
- `QUEUED` + resume disabled fails before the port is called;
- `QUEUED` + profile removal/hash drift fails before the port is called;
- `EXECUTING` after reopen becomes `OUTCOME_UNKNOWN` with no replay;
- a timeout/unconfirmed interrupt in the same runtime becomes `OUTCOME_UNKNOWN`;
- no recovery path refreshes caller identity or creates a replacement job id.

Exact-pinned DevSpace acceptance must prove one configured verification can complete through the verify-specific port and persist bounded result evidence without leaking parent secret sentinels.

Regression gates must retain current synchronous `verify.run`, current MCP v1 task reconnect/cancellation-denial behavior, default/Business five-tool surfaces, Browser Adapter v1 three-tool surface, durable mutation tests, and full repository verification.

Full candidate verification remains `npm test`, `npm run typecheck`, `npm run build`, `npm run test:business`, `git diff --check`, plus focused durable verify gates and independent review.
## Acceptance gate

`DURABLE_VERIFY_JOB_CORE_V1 = PASS` requires all of the following on one exact candidate:

1. WAG-owned verify job ids/state/results survive SQLite close/reopen and are fenced by exact caller authority;
2. job creation persists before returning an id, and claim persists one WAG attempt id before execution;
3. effective trusted profile hashing is deterministic and raw argv/env are not persisted in job/event rows;
4. only explicitly opted-in unchanged `QUEUED` profiles with a still-live stored dispatch deadline resume after restart; expiry/profile/policy/ownership drift fails before execution and no path extends that deadline;
5. recovered `EXECUTING` work and same-runtime unconfirmed timeout/interruption become `OUTCOME_UNKNOWN` with no blind replay;
6. exact completed execution, including non-zero exit, persists as `SUCCEEDED` with a bounded 64 KiB UTF-8 result and truncation evidence;
7. transition events contain no raw output, roots, commands, env values, secrets, backend handles, or unrelated identity data;
8. current MCP Tasks behavior, default/Business five-tool surfaces, Browser Adapter three-tool surface, and durable mutation semantics remain unchanged;
9. no SDK/dependency upgrade, public job/cancel/process/PTY/Git/browser authority, or broad cleanup capability is introduced;
10. focused/full verification and an independent exact-diff review have zero blocking findings.

Passing this gate authorizes only the internal durable verify-job core and later separately reviewed projections. It does not authorize default/Business activation or a generic durable job/process manager.

## Approaches rejected

**Generic job/process framework first:** rejected because command, PTY, browser, and mutation capabilities have different replay/completion/cleanup evidence and are not yet authorized under one generic execution contract.

**Make SDK v1 `TaskStore` persistent:** rejected because its ids and lifecycle are protocol/library compatibility state, and the implementation disappears in SDK v2.

**Upgrade SDK v2 first:** rejected because the Tasks extension is a separate interoperability concern and an SDK migration would widen scope without solving WAG-owned recovery authority.

**Replay every queued profile after restart:** rejected because delayed execution against changed workspace contents must be an explicit trusted local policy, not an implicit property of durability.
## Non-goals

This milestone does not implement:

- persistent owner/account registry or browser session admission;
- public `job.*` tools or MCP Tasks extension projection;
- task cancellation or confirmed process-tree interruption;
- process/session reattachment after WAG restart;
- arbitrary shell, persistent PTY, generic process management, or Git writes;
- browser jobs, browser mutation, or Playwright ownership management;
- mutation refactoring onto the verify job state machine;
- default or Business durable-job activation;
- MCP SDK upgrade or dependency changes;
- Remote Desktop Commander replacement.

## Follow-up sequence

After this core passes, the next design should choose one of two separately reviewed paths based on need: a trusted transport/session admission binding that can safely project WAG-owned jobs to host clients, or an exact-owner process manager that supplies stronger inspect/interrupt/reattach evidence. Neither is implied by this milestone.

Browser/profile ownership remains a later independent capability and must continue following the current Playwright handoff policy until WAG browser authority is explicitly accepted.