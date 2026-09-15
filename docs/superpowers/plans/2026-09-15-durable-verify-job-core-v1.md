# Durable Verify Job Core v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WAG-owned, SQLite-durable job core for the existing configured `verify.run` capability without changing any host-visible tool surface or adding generic process authority.

**Architecture:** Extract current verify-profile policy into one deterministic resolver, extend `SqliteDurableStore` additively with verify-job/event records, then add a verify-specific coordinator and execution port. A DevSpace adapter supplies bounded execution evidence; restart reconciliation never replays `EXECUTING` work and only resumes unchanged `QUEUED` work when the trusted profile explicitly opts in.

**Tech Stack:** TypeScript, Node.js 24, `node:sqlite` `DatabaseSync`, Node test runner via `tsx --test`, existing pinned `@modelcontextprotocol/sdk` 1.29.0, existing DevSpace MCP executor.

**Spec:** `docs/superpowers/specs/2026-09-15-durable-verify-job-core-v1-design.md`

## Global Constraints

- Dependency parent is `b1b6dcae175b3f7c2ff704161e9d683afafbee89`; do not drop Trusted Caller Context v1.
- Authority is exactly `ownerId` + `sessionId` + `adapterId` from validated `GatewayCallerContext`; model/tool arguments never choose these fields.
- Dispatch deadline is fixed at `300_000` ms from creation and is never refreshed.
- Persisted successful output is capped at `64 * 1024` UTF-8 bytes and truncated only on a valid UTF-8 boundary.
- `EXECUTING` restart recovery and any post-claim unconfirmed execution become `OUTCOME_UNKNOWN`; there is no blind replay.
- `resumeQueuedAfterRestart` defaults to `false`, is trusted local configuration only, participates in the plan hash, and must also be explicitly `true` for recovered dispatch.
- Default MCP and Business stdio remain five tools; Browser Adapter v1 remains three tools.
- No public `job.*`, cancellation, shell, PTY, Git, browser-control, SDK upgrade, dependency change, or broad cleanup authority.
- `src/task-store.ts`, `src/http-server.ts`, and `src/stdio-server.ts` remain unchanged unless a RED type-level failure proves an unavoidable dependency; such a surprise stops execution for design review.

---

### Task 1: Shared Verify Profile Resolver

**Files:**
- Create: `src/verify-profile.ts`
- Create: `test/verify-profile.test.ts`
- Modify: `src/server.ts:21,95-111,255-266`
- Regression: `test/verify.test.ts`, `test/environment-policy.test.ts`

**Interfaces:**
- Produces `VerifyProfile`, `ResolvedVerifyProfile`, and `resolveVerifyProfile(profile)` from `src/verify-profile.ts`.
- `ResolvedVerifyProfile` contains normalized `argv`, `env`, `timeoutMs`, `maxOutputTokens`, `resumeQueuedAfterRestart`, `command`, and `planSha256`.
- `src/server.ts` re-exports `VerifyProfile` for compatibility and calls the resolver from historical synchronous `verify.run`.

- [ ] **Step 1: Write RED resolver tests**

```ts
const a = resolveVerifyProfile({ argv: ['node', 'verify.mjs'], env: { B: '2', A: '1' } });
const b = resolveVerifyProfile({ argv: ['node', 'verify.mjs'], env: { A: '1', B: '2' } });
assert.equal(a.planSha256, b.planSha256);
assert.equal(a.timeoutMs, 10_000);
assert.equal(a.maxOutputTokens, 4_000);
assert.equal(a.resumeQueuedAfterRestart, false);
assert.notEqual(a.planSha256, resolveVerifyProfile({ argv: ['node', 'verify.mjs'], env: { A: '1', B: '2' }, resumeQueuedAfterRestart: true }).planSha256);
assert.throws(() => resolveVerifyProfile({ argv: ['node', 'x'], env: { API_KEY: 'secret' } }), /Invalid verify profile env/);
```

Also assert argv count/syntax, env count/key/value bounds, timeout clamp 100-30,000, output clamp 100-10,000, stable SHA-256 format, and owner-token scrub in `command`.

- [ ] **Step 2: Run RED tests**

Run:
```powershell
npx tsx --test test/verify-profile.test.ts
```
Expected: FAIL because `src/verify-profile.ts` does not exist.

- [ ] **Step 3: Implement the resolver and migrate synchronous verify**

```ts
export interface VerifyProfile {
  argv: readonly string[];
  timeoutMs?: number;
  maxOutputTokens?: number;
  env?: Readonly<Record<string, string>>;
  resumeQueuedAfterRestart?: boolean;
}
export interface ResolvedVerifyProfile {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputTokens: number;
  resumeQueuedAfterRestart: boolean;
  command: string;
  planSha256: string;
}
export function resolveVerifyProfile(profile: VerifyProfile): ResolvedVerifyProfile;
```

Canonical hash input is JSON of `{ argv, timeoutMs, maxOutputTokens, env: sortedEntries, resumeQueuedAfterRestart }`; use `createHash('sha256')`. Preserve the existing command syntax and `DEVSPACE_OAUTH_OWNER_TOKEN` scrub exactly.

- [ ] **Step 4: Run focused regression**

Run `npx tsx --test test/verify-profile.test.ts test/verify.test.ts test/environment-policy.test.ts` and `npm run typecheck`. Expected: all PASS and historical `verify.run` result/error behavior unchanged.

- [ ] **Step 5: Commit**

```powershell
git add src/verify-profile.ts src/server.ts test/verify-profile.test.ts test/verify.test.ts test/environment-policy.test.ts
git commit -m "refactor: share verify profile policy"
```
### Task 2: Additive SQLite Verify-Job Store

**Files:**
- Modify: `src/durable-store.ts:5-244`
- Create: `test/durable-verify-store.test.ts`
- Regression: `test/durable-store.test.ts`, `test/durable-mutation.test.ts`

**Interfaces:**
- Produces `VerifyJobState`, `VerifyJobErrorClass`, `VerifyJobRecord`, `VerifyJobEvent`, and `CreateVerifyJobRecord`.
- Produces store methods `createVerifyJob`, `getVerifyJob`, `claimVerifyJob`, `failQueuedVerifyJob`, `finishVerifyJob`, `listRecoverableVerifyJobs`, and `listVerifyJobEvents`.

```ts
export interface CreateVerifyJobRecord extends GatewayAuthority {
  workspaceId: string; backendKind: string; profileName: string; planSha256: string;
  createdAt: number; dispatchDeadline: number;
}
export interface VerifyJobRecord extends CreateVerifyJobRecord {
  jobId: string; state: VerifyJobState; attemptId?: string;
  executionStartedAt?: number; completedAt?: number; exitCode?: number;
  output?: string; outputTruncated?: boolean; errorClass?: VerifyJobErrorClass;
}
export interface VerifyJobEvent {
  sequence: number; jobId: string; observedAt: number;
  fromState?: VerifyJobState; toState: VerifyJobState; attemptId?: string;
  errorClass?: VerifyJobErrorClass;
}
```
- Existing workspace/mutation interfaces and SQL semantics remain byte-for-byte behaviorally compatible.

- [ ] **Step 1: Write RED durable-store tests**

```ts
const job = store.createVerifyJob({
  ...identity, workspaceId: workspace.workspaceId, backendKind: 'fake',
  profileName: 'test', planSha256: 'a'.repeat(64),
  createdAt: 1_000, dispatchDeadline: 301_000,
});
assert.match(job.jobId, /^job_/);
assert.equal(job.state, 'QUEUED');
const claimed = store.claimVerifyJob(job.jobId, 2_000, 'attempt_1');
assert.equal(claimed?.state, 'EXECUTING');
assert.equal(claimed?.attemptId, 'attempt_1');
assert.equal(store.claimVerifyJob(job.jobId, 2_001, 'attempt_2'), undefined);
```

Add close/reopen persistence, expired claim denial, conditional `QUEUED -> FAILED`, `EXECUTING -> SUCCEEDED|OUTCOME_UNKNOWN`, terminal immutability, event ordering, and event redaction assertions.

- [ ] **Step 2: Run RED store tests**

Run `npx tsx --test test/durable-verify-store.test.ts`. Expected: FAIL because verify-job types/methods do not exist.

- [ ] **Step 3: Implement additive schema and transitions**

```ts
export type VerifyJobState = 'QUEUED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN';
export type VerifyJobErrorClass =
  | 'DISPATCH_DEADLINE_EXPIRED' | 'WORKSPACE_MISSING' | 'WORKSPACE_OWNERSHIP_MISMATCH'
  | 'UNSUPPORTED_BACKEND' | 'PROFILE_MISSING' | 'PROFILE_PLAN_DRIFT'
  | 'RESTART_RESUME_DISABLED' | 'RESTART_EXECUTION_UNVERIFIABLE'
  | 'EXECUTION_TIMEOUT_UNCONFIRMED' | 'EXECUTION_PORT_ERROR_UNCONFIRMED';
```

Use these exact store method signatures:

```ts
createVerifyJob(input: CreateVerifyJobRecord): VerifyJobRecord;
getVerifyJob(jobId: string): VerifyJobRecord | undefined;
claimVerifyJob(jobId: string, now: number, attemptId: string): VerifyJobRecord | undefined;
failQueuedVerifyJob(jobId: string, now: number, errorClass: VerifyJobErrorClass): boolean;
finishVerifyJob(jobId: string, state: 'SUCCEEDED' | 'OUTCOME_UNKNOWN', now: number, result?: { exitCode: number; output: string; outputTruncated: boolean }, errorClass?: VerifyJobErrorClass): boolean;
listRecoverableVerifyJobs(): VerifyJobRecord[];
listVerifyJobEvents(jobId: string): VerifyJobEvent[];
```

`verify_jobs` stores authority tuple, workspace/backend/profile/plan hash, `dispatch_deadline`, state/timestamps, attempt id, exit code, bounded output/truncation flag, and closed error class. `verify_job_events` stores only transition metadata and closed reason; no output/root/command/env/backend handle. Use `BEGIN IMMEDIATE` conditional transitions, foreign-key workspace linkage, and an index on `(state, created_at)`.

- [ ] **Step 4: Run focused persistence regression**

Run:
```powershell
npx tsx --test test/durable-verify-store.test.ts test/durable-store.test.ts test/durable-mutation.test.ts
npm run typecheck
git diff --check
```
Expected: all PASS; existing mutation tests prove the additive schema did not alter mutation behavior.

- [ ] **Step 5: Commit**

```powershell
git add src/durable-store.ts test/durable-verify-store.test.ts
git commit -m "feat: persist durable verify jobs"
```
### Task 3: Durable Verify Coordinator and Narrow Execution Port

**Files:**
- Create: `src/verify-execution-port.ts`
- Create: `src/durable-verify-job.ts`
- Create: `test/durable-verify-job.test.ts`
- Consume: `src/caller-context.ts`, `src/durable-store.ts`, `src/verify-profile.ts`

**Interfaces:**
- `VerifyExecutionPort.kind` identifies the accepted backend kind.
- `execute(canonicalRoot, profile)` returns either exact completion evidence or explicit unconfirmed evidence; it is not a generic command port.
- `DurableVerifyJobCoordinator.enqueue(caller, workspaceId, profileName)` persists and returns the WAG job view.
- `result(caller, jobId)` is caller-fenced and throws exactly `Gateway denied verify job` for both unknown ids and wrong authority tuples; do not reuse the distinguishable durable-mutation lookup precedent.
- `dispatch(jobId)` is trusted local/internal initial dispatch; `reconcile()` performs restart recovery.

```ts
export interface VerifyJobView {
  jobId: string; workspaceId: string; profileName: string; state: VerifyJobState;
  createdAt: number; dispatchDeadline: number; completedAt?: number;
  exitCode?: number; output?: string; outputTruncated?: boolean;
  errorClass?: VerifyJobErrorClass;
}
```

```ts
export type VerifyExecutionEvidence =
  | { status: 'completed'; exitCode: number; output: string }
  | { status: 'unconfirmed'; errorClass: 'EXECUTION_TIMEOUT_UNCONFIRMED' };
export interface VerifyExecutionPort {
  readonly kind: string;
  execute(canonicalRoot: string, profile: ResolvedVerifyProfile): Promise<VerifyExecutionEvidence>;
}
```

- [ ] **Step 1: Write RED coordinator identity/admission tests**

Create a fake port and test enqueue persistence, exact workspace ownership, independent owner/session/adapter mismatch, same denial message for missing job and wrong-owner result lookup, and fixed `createdAt + 300_000` dispatch deadline.

- [ ] **Step 2: Run RED coordinator tests**

Run `npx tsx --test test/durable-verify-job.test.ts`. Expected: FAIL because coordinator/port modules do not exist.

- [ ] **Step 3: Implement pre-claim validation and exact-once claim**

Implement this coordinator surface:

```ts
export class DurableVerifyJobCoordinator {
  enqueue(caller: GatewayCallerContext, workspaceId: string, profileName: string): VerifyJobView;
  result(caller: GatewayCallerContext, jobId: string): VerifyJobView;
  dispatch(jobId: string): Promise<void>;
  reconcile(): Promise<void>;
}
```

Before every claim, including initial dispatch, re-read the workspace and current profile and verify: workspace exists; job/workspace authority tuples match exactly; backend kind is registered and unchanged; profile exists; current `planSha256` equals stored hash; `dispatchDeadline > now`. A failed check transitions still-`QUEUED` work to `FAILED` with the corresponding closed error class and never calls the port.

`reconcile()` applies the same checks to recovered `QUEUED` work plus the independent `resolved.resumeQueuedAfterRestart === true` gate. The flag is also hashed, so configuration drift is detectable even if the boolean remains true.

- [ ] **Step 4: Implement post-claim outcomes and bounded result**

After `claimVerifyJob` commits a fresh `attemptId`, dispatch follows this shape:

```ts
const evidence = await port.execute(workspace.canonicalRoot, resolved);
if (evidence.status === 'completed') {
  const bounded = boundUtf8Output(evidence.output, 64 * 1024);
  store.finishVerifyJob(jobId, 'SUCCEEDED', now(), {
    exitCode: evidence.exitCode, output: bounded.output, outputTruncated: bounded.truncated,
  });
} else {
  store.finishVerifyJob(jobId, 'OUTCOME_UNKNOWN', now(), undefined, evidence.errorClass);
}
```

Exact completed evidence writes `SUCCEEDED` even for non-zero exit codes. `boundUtf8Output` must truncate on a valid UTF-8 code-point boundary. A thrown port error becomes `OUTCOME_UNKNOWN` with `EXECUTION_PORT_ERROR_UNCONFIRMED`. Recovered `EXECUTING` rows become `OUTCOME_UNKNOWN` with `RESTART_EXECUTION_UNVERIFIABLE` and the port is never invoked.

- [ ] **Step 5: Add recovery/concurrency RED→GREEN coverage**

Tests must prove: two concurrent `dispatch(jobId)` calls cause one port execution; expired initial dispatch fails before the port; initial profile drift fails before claim; recovered queued resume-disabled/profile-missing/profile-drift/ownership-drift all fail before port; recovered opted-in unchanged queued executes the original job id once; recovered executing never replays; non-zero exit succeeds; exact 64 KiB and 64 KiB+multibyte output truncate correctly; terminal rows never transition.

- [ ] **Step 6: Run focused gate and commit**

Run `npx tsx --test test/durable-verify-job.test.ts test/durable-verify-store.test.ts test/verify-profile.test.ts test/durable-mutation.test.ts` plus `npm run typecheck` and `git diff --check`.

```powershell
git add src/verify-execution-port.ts src/durable-verify-job.ts test/durable-verify-job.test.ts
git commit -m "feat: add durable verify job coordinator"
```
### Task 4: DevSpace Verify Execution Adapter and Exact-Pinned Acceptance

**Files:**
- Create: `src/executor/devspace-verify.ts`
- Create: `test/durable-verify-job.acceptance.test.ts`
- Consume only: `src/executor/devspace.ts`, `src/verify-profile.ts`, `src/verify-execution-port.ts`, `src/durable-verify-job.ts`
- Regression: `test/devspace-compat.test.ts`, `test/verify.test.ts`, `test/environment-policy.test.ts`

**Interfaces:**
- Produces `DevspaceVerifyExecutionPort implements VerifyExecutionPort` with `kind = 'devspace'`.
- The adapter reopens only the supplied canonical workspace, executes only the already-resolved trusted command, and never exposes DevSpace workspace/session ids to durable results.
- A timeout/running result may send the existing same-runtime Ctrl-C attempt, but always returns unconfirmed `EXECUTION_TIMEOUT_UNCONFIRMED`; successful Ctrl-C is not treated as cancellation proof.

- [ ] **Step 1: Write RED adapter tests with a fake DevSpace executor**

```ts
const evidence = await port.execute('E:/fixture', resolvedProfile);
assert.deepEqual(evidence, { status: 'completed', exitCode: 1, output: 'failed check' });
```

Add a running-session case that asserts `interruptCommand` is attempted only for the returned exact session id and evidence remains `{ status: 'unconfirmed', errorClass: 'EXECUTION_TIMEOUT_UNCONFIRMED' }`.

- [ ] **Step 2: Run RED adapter test**

Run `npx tsx --test test/durable-verify-job.acceptance.test.ts`. Expected: FAIL because `DevspaceVerifyExecutionPort` does not exist.

- [ ] **Step 3: Implement the minimal adapter**

Implement the adapter with this control flow:

```ts
export class DevspaceVerifyExecutionPort implements VerifyExecutionPort {
  readonly kind = 'devspace';
  constructor(private readonly executor: Pick<DevspaceExecutor, 'openWorkspace' | 'execCommand' | 'interruptCommand'>) {}
  async execute(canonicalRoot: string, profile: ResolvedVerifyProfile): Promise<VerifyExecutionEvidence> {
    const workspaceId = await this.executor.openWorkspace(canonicalRoot);
    const result = await this.executor.execCommand(workspaceId, profile.command, profile.maxOutputTokens, profile.timeoutMs);
    if (!result.running) return { status: 'completed', exitCode: result.exitCode ?? -1, output: result.output.trimEnd() };
    if (result.sessionId !== undefined) await this.executor.interruptCommand(workspaceId, result.sessionId, profile.maxOutputTokens);
    return { status: 'unconfirmed', errorClass: 'EXECUTION_TIMEOUT_UNCONFIRMED' };
  }
}
```

Never infer cancellation success from `interruptCommand`; even a successful call returns unconfirmed evidence.

- [ ] **Step 4: Add exact-pinned end-to-end acceptance**

Using `startPinnedDevspace`, create a durable workspace record under a validated caller, enqueue a configured verify job, dispatch through `DevspaceVerifyExecutionPort`, close/reopen SQLite, and assert the same `jobId` returns `SUCCEEDED`, exit code/output, and no backend handle.

Set `process.env.WAG_TEST_SECRET = 'sentinel-secret'` before fixture startup and run a repository script that prints `WAG_TEST_SECRET` and `DEVSPACE_OAUTH_OWNER_TOKEN`; persisted output must show both absent. Also assert `JSON.stringify(store.listVerifyJobEvents(jobId))` contains neither sentinel nor command/env/root text.

- [ ] **Step 5: Run adapter/acceptance regression**

Run:
```powershell
npx tsx --test test/durable-verify-job.acceptance.test.ts test/devspace-compat.test.ts test/verify.test.ts test/environment-policy.test.ts
npm run typecheck
git diff --check
```
Expected: PASS with no change to the pinned DevSpace six-tool executor contract or synchronous verify behavior.

- [ ] **Step 6: Verify zero production activation and commit**

Run a source search proving `DurableVerifyJobCoordinator` has no production call site outside its own module/tests, and `git diff 1254fad -- src/task-store.ts src/http-server.ts src/stdio-server.ts package.json package-lock.json` is empty.

```powershell
git add src/executor/devspace-verify.ts test/durable-verify-job.acceptance.test.ts
git commit -m "feat: add devspace verify execution port"
```

### Task 5: Exact-Candidate Acceptance Receipt

**Files:**
- Create: `docs/benchmarks/2026-09-15-durable-verify-job-core-v1.md`
- No production changes are allowed in this task unless a blocking review finding requires returning to the owning implementation task and re-running its gates.
- [ ] **Step 1: Run exact focused candidate gate**

Run all new/changed contract tests together:
```powershell
npx tsx --test test/verify-profile.test.ts test/durable-verify-store.test.ts test/durable-verify-job.test.ts test/durable-verify-job.acceptance.test.ts test/verify.test.ts test/environment-policy.test.ts test/durable-store.test.ts test/durable-mutation.test.ts test/mcp-tasks.test.ts test/task-recovery.test.ts test/mcp-surface.test.ts test/browser-adapter-protocol.test.ts
```
Record exact candidate SHA and pass/fail counts before any later review.

- [ ] **Step 2: Run full repository gate on the same candidate**

```powershell
npm test
npm run typecheck
npm run build
npm run test:business
git diff --check
```
All commands must pass on the same SHA. Do not substitute direct MCP/native calls for Business/default/browser regression evidence.

- [ ] **Step 3: Run scope/security audit**

Compare from `1254fad` through the exact candidate. Required evidence: no changes to `src/task-store.ts`, `src/http-server.ts`, `src/stdio-server.ts`, browser extension/runtime/native-host production files, private config/OAuth, package manifests/lockfile, or existing mutation state semantics; no model-visible authority/job fields; no generic command/process API; event rows contain no raw output/root/command/env/backend handles.

- [ ] **Step 4: Independent exact-diff review**

A separate read-only reviewer must inspect the exact `1254fad...<candidate>` diff against ADR-0014, ADR-0015, ADR-0016, the design spec, and this plan. Blocking classes: authority leak, wrong-owner existence leak, stale/deadline dispatch, replay of `EXECUTING`, open-ended error classes, output-boundary bug, secret/root/backend-handle persistence, surface widening, mutation regression, or cleanup widening.

Expected review label: `INDEPENDENT_REVIEW = PASS` with zero Critical and zero Important findings.
- [ ] **Step 5: Write and self-check the acceptance receipt**

Receipt must name the exact implementation candidate SHA; focused/full command results; caller ownership evidence; 300,000 ms non-refreshing deadline; profile hash/restart double gate; SQLite reopen evidence; same denial for unknown/wrong-owner; `EXECUTING -> OUTCOME_UNKNOWN` no-replay evidence; non-zero-exit success; 64 KiB UTF-8 truncation; event/result redaction; zero production activation; unchanged MCP/Business/browser surfaces; unchanged SDK/dependencies; independent-review disposition.

The receipt must end with:

`DURABLE_VERIFY_JOB_CORE_V1 = PASS`

and explicitly state that this gate does **not** authorize host projection, public job APIs, cancellation, generic process/PTY/Git/browser authority, SDK migration, or Remote Desktop Commander replacement.

- [ ] **Step 6: Commit receipt only**

```powershell
git add docs/benchmarks/2026-09-15-durable-verify-job-core-v1.md
git diff --cached --check
git commit -m "bench: verify durable verify job core v1"
```

- [ ] **Step 7: Final fresh Git verification**

```powershell
git status --short --branch
git log --oneline --decorate -8
git diff --check 1254fad...HEAD
git -C E:\Projects\web-agent-gateway status --short --branch
git -C E:\Projects\web-agent-gateway rev-parse HEAD
git -C E:\Projects\web-agent-gateway rev-parse origin/main
```

Do not touch canonical root `?? .playwright-cli/`. Do not push, open a PR, or merge without separate user authority.