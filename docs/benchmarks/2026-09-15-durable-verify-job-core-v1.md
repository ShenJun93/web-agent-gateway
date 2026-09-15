# Durable Verify Job Core v1 Acceptance Receipt

Date: 2026-09-15
Implementation candidate SHA: `f5515d0476a323bd3935e0f30972402229a76278`
Design base SHA: `1254fadbd827859715a00d9f4cc9a4504b84c233`
Branch: `docs/durable-verify-job-core-v1-design`
ADR: `docs/adr/0016-use-wag-owned-durable-verify-jobs.md`
Spec: `docs/superpowers/specs/2026-09-15-durable-verify-job-core-v1-design.md`
Plan: `docs/superpowers/plans/2026-09-15-durable-verify-job-core-v1.md`

## Candidate scope

This candidate adds a WAG-owned durable control-plane core for the already configured `verify.run` capability. It does not activate durable jobs on default MCP, Business stdio, or Browser Adapter v1 and adds no public `job.*` surface.

Production/runtime implementation footprint:

- `src/verify-profile.ts`: trusted profile normalization, effective defaults, deterministic plan hash, and command construction;
- `src/durable-store.ts`: additive `verify_jobs` / `verify_job_events` tables and conditional transitions;
- `src/verify-execution-port.ts`: verify-only execution evidence contract;
- `src/durable-verify-job.ts`: caller-fenced enqueue/result plus internal dispatch/reconcile state machine;
- `src/executor/devspace-verify.ts`: narrow DevSpace adapter;
- `src/server.ts`: extraction-only reuse of the shared verify-profile policy for existing synchronous `verify.run`.

There are zero production call sites for `DurableVerifyJobCoordinator`; activation remains intentionally absent in v1.

## Durable identity and admission evidence

Each durable verify job is minted by WAG and persists exact `ownerId`, `sessionId`, `adapterId`, `workspaceId`, backend kind, profile name, plan hash, creation time, and a fixed dispatch deadline. Caller correlation metadata is not persisted or used for authorization.

`enqueue()` requires exact caller/workspace ownership. `result()` returns the same exact error message, `Gateway denied verify job`, for both an unknown job id and a wrong caller authority tuple. Tests independently reject owner/session/adapter mismatch on creation and prove the unknown-id/wrong-owner read denial is non-distinguishing.

Creation inserts the job row before returning its WAG `jobId`. Dispatch re-reads current workspace/profile policy before claim, then `claimVerifyJob()` atomically performs `QUEUED -> EXECUTING`, persists one fresh WAG `attemptId`, and rechecks `dispatch_deadline > now` inside `BEGIN IMMEDIATE` before any backend execution.

The dispatch deadline is exactly `createdAt + 300_000` ms. No code path refreshes or extends it.

## Profile, restart, and replay evidence

`resolveVerifyProfile()` hashes canonical effective policy: ordered argv, clamped timeout, clamped max-output setting, sorted env pairs, and `resumeQueuedAfterRestart`. Raw argv/env and generated command text are not persisted in verify job or event rows.

Recovered `QUEUED` work must satisfy both gates: its current plan hash must exactly match the stored hash and the current trusted local profile must still have `resumeQueuedAfterRestart === true`. Workspace, authority, backend, profile existence, plan drift, and deadline are revalidated before claim.

Recovered `EXECUTING` work is never replayed. `reconcile()` transitions it to `OUTCOME_UNKNOWN` with `RESTART_EXECUTION_UNVERIFIABLE` and never invokes the execution port. Same-runtime unconfirmed timeout/interruption becomes `OUTCOME_UNKNOWN` with `EXECUTION_TIMEOUT_UNCONFIRMED`; a thrown execution-port error becomes `EXECUTION_PORT_ERROR_UNCONFIRMED` with raw exception text discarded.

The closed v1 error-class union in code now exactly matches the approved spec. The earlier CamelCase implementation-plan drift was caught during review, reproduced by RED tests, corrected, committed as `f5515d0`, and all candidate gates were rerun from scratch.

## Result and persistence evidence

Exact completed execution persists `SUCCEEDED` even when the verification process exits non-zero; the exit code is verification evidence rather than a control-plane failure classification.

Persisted output is bounded to 64 KiB of UTF-8. Tests prove an exact 65,536-byte result remains untruncated and a 65,537-byte result ending in a multibyte code point truncates at the prior valid boundary with `outputTruncated: true`.

`verify_job_events` stores only transition metadata: job id, observed time, from/to state, attempt id, and closed error class. It has no output/root/command/env/backend-handle columns.

Exact-pinned DevSpace acceptance creates a durable workspace and verify job, executes through `DevspaceVerifyExecutionPort`, closes/reopens SQLite, and retrieves the same WAG `jobId` with persisted `SUCCEEDED` result. The acceptance path also runs a repository script that attempts to print `WAG_TEST_SECRET` and `DEVSPACE_OAUTH_OWNER_TOKEN`; persisted output shows both absent. Event serialization is asserted to exclude sentinel secrets, command text, env names, and the canonical workspace root.

The DevSpace adapter may attempt same-runtime interrupt only for the exact returned session id. A running result remains unconfirmed regardless of interrupt success; this does not establish cancellation authority.

## Surface and dependency evidence

Default MCP remains exactly five tools. Business stdio remains the same five-tool path. Browser Adapter v1 remains exactly three read-only tools. Existing MCP v1 task reconnect behavior and cancellation denial remain unchanged, and `src/task-store.ts` is untouched.

No `src/http-server.ts`, `src/stdio-server.ts`, browser extension/runtime/native-host production file, private config/OAuth file, package manifest, or lockfile changed from design base to candidate. Existing mutation tables/transitions are unchanged; the `src/durable-store.ts` candidate diff is additive for verify-job persistence.

There is no new generic command/process API, persistent PTY, Git write path, browser mutation/job authority, cancellation state, broad process cleanup, or SDK/dependency upgrade.

## Exact-candidate verification

Focused contract gate on candidate `f5515d0476a323bd3935e0f30972402229a76278`:

`npx tsx --test test/verify-profile.test.ts test/durable-verify-store.test.ts test/durable-verify-job.test.ts test/durable-verify-job.acceptance.test.ts test/verify.test.ts test/environment-policy.test.ts test/durable-store.test.ts test/durable-mutation.test.ts test/mcp-tasks.test.ts test/task-recovery.test.ts test/mcp-surface.test.ts test/browser-adapter-protocol.test.ts`

Result: PASS — 45 passed, 0 failed, 0 skipped.

Fresh full repository gate on the same candidate:

- `npm test` — PASS: 190 passed, 0 failed, 0 skipped;
- `npm run typecheck` — PASS, exit 0;
- `npm run build` — PASS, exit 0;
- `npm run test:business` — PASS: 1 passed, 0 failed, 0 skipped;
- `git diff --check` — PASS, exit 0;
- end SHA after all gates: `f5515d0476a323bd3935e0f30972402229a76278`.

Scope/security audit from exact design base `1254fadbd827859715a00d9f4cc9a4504b84c233` to candidate found exactly the expected plan, implementation, and test footprint. Forbidden transport/task-store/browser/native/private-runtime/package paths have no diff; `src/durable-store.ts` is 203 additions and 0 deletions relative to the design base; source search finds zero production `DurableVerifyJobCoordinator` call sites and no superseded verify error literals.

## Independent review

A separate read-only reviewer inspected the exact base-to-candidate diff against ADR-0014, ADR-0015, ADR-0016, the approved design spec, implementation plan, live source, and substantive tests.

Disposition:

- Critical: 0;
- Important: 0;
- Minor: 5, non-blocking;
- `INDEPENDENT_REVIEW = PASS`.

Reviewer Minor notes retained for follow-up:

- the DevSpace adapter inherits the existing synchronous `exitCode ?? -1` convention, so a malformed completed response without an exit code is not separately classified as unconfirmed;
- restart resume enforcement is structurally dependent on startup composition calling `reconcile()` before any dispatch of pre-existing queued rows; zero production call sites make this non-reachable in v1;
- `reconcile()` has no once-only guard and is designed as startup recovery, not a periodic worker sweep;
- some shared-path branches are proven by implementation plus adjacent tests rather than every authority/backend/deadline permutation being independently asserted;
- SQLite row reads use the local-trust-domain TypeScript union casts without SQL `CHECK` constraints, matching the existing mutation-store precedent.

None of these findings widens current production authority or invalidates the v1 acceptance criteria. No code changed after the final independent review, so the exact-candidate verification remains applicable.

## Acceptance conditions

1. WAG-owned verify job ids/state/results survive SQLite close/reopen and exact caller authority fencing — PASS.
2. Job creation persists before returning an id; claim persists one attempt id before execution — PASS.
3. Effective profile hashing is deterministic and raw argv/env are absent from job/event persistence — PASS.
4. Restart resumes only explicitly opted-in unchanged queued profiles with an unexpired, non-refreshing deadline; drift/expiry fails before execution — PASS.
5. Recovered executing work and same-runtime unconfirmed timeout/interruption become `OUTCOME_UNKNOWN` without blind replay — PASS.
6. Exact completion, including non-zero exit, persists `SUCCEEDED` with bounded 64 KiB UTF-8 output and truncation evidence — PASS.
7. Transition events contain no raw output, roots, commands, env values, secrets, backend handles, or unrelated identity data — PASS.
8. MCP Tasks compatibility, default/Business five-tool surfaces, Browser Adapter three-tool surface, and durable mutation semantics remain unchanged — PASS.
9. No SDK/dependency upgrade or public job/cancel/process/PTY/Git/browser/cleanup authority is introduced — PASS.
10. Focused/full verification and independent exact-diff review have zero blocking findings — PASS.

## Gate result and authority boundary

This gate accepts only the internal WAG-owned Durable Verify Job Core v1 and permits later separately reviewed milestones to depend on it.

It does **not** authorize host/default/Business projection, public `job.*` APIs, MCP Tasks extension projection, cancellation, generic process management, shell or persistent PTY access, Git writes, browser jobs or mutation, Playwright/browser ownership management, an MCP SDK migration, dependency upgrades, broad cleanup authority, or replacement of Remote Desktop Commander.

`DURABLE_VERIFY_JOB_CORE_V1 = PASS`
