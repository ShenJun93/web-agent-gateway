# Durable Local Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the timing-sensitive remote apply step with a durable, locally reviewed immutable mutation transaction while keeping the default and Business surfaces non-mutating.

**Architecture:** WAG owns durable workspace and mutation records in SQLite, exposes only opt-in `mutation.preview` / `mutation.result` remotely, and uses a loopback-only operator service to advance an exact pending mutation to local execution. File mutation is behind a narrow backend port; DevSpace is the first adapter, not permanent authority.

**Tech Stack:** TypeScript 6, Node.js 22.19–26, built-in `node:sqlite`, MCP SDK 1.29.0 for this slice, Node HTTP server, existing DevSpace fixture/executor.

**Spec:** `docs/superpowers/specs/2026-09-13-durable-local-control-plane-design.md`

## Global Constraints

- Default MCP and Business stdio remain exactly five non-mutation tools.
- Do not expose local review as MCP, model text, repository state, or verification output.
- Review deadline is 60,000 ms; first successful review creates one 60,000 ms execution-admission deadline; retries never extend either deadline.
- No raw shell, Git writes, file create/delete/move, multi-file mutation, persistent PTY, generic scheduler, or browser-extension rewrite.
- Durable WAG state is authoritative; MCP/browser/backend connection state is not.
- Backend outputs are evidence only; WAG independently revalidates target state and final SHA-256.
- No merge/push or production mutation enablement in this plan.

---
### Task 1: SQLite DurableStore and Record Schema

**Files:**
- Create: `src/durable-store.ts`
- Create: `test/durable-store.test.ts`

**Interfaces:**
- Produces: `DurableStore`, `WorkspaceRecord`, `MutationRecord`, `MutationState`, `MutationIdentity`.
- Produces: `openWorkspaceRecord`, `createMutation`, `getMutation`, `listPendingMutations`, `approveMutation`, `rejectMutation`, `claimMutation`, `finishMutation`, `listRecoverableMutations`, `appendAuditEvent`, `close`.

- [ ] **Step 1: Write failing persistence/state tests**
  - Prove workspace records survive close/reopen.
  - Prove mutation plans are immutable after insert.
  - Prove approval is conditional on `PENDING_APPROVAL` and `reviewDeadline > now`.
  - Prove two approval attempts cannot both advance the record.
  - Prove claim requires live `QUEUED` admission deadline.
  - Prove audit rows are append-only and omit `before` / `after` contents.
- [ ] **Step 2: Run `tsx --test test/durable-store.test.ts` and verify RED.**
- [ ] **Step 3: Implement `SqliteDurableStore` with `node:sqlite` `DatabaseSync`.**
  - Use WAL mode, foreign keys, prepared statements, and conditional `UPDATE ... WHERE state = ? AND deadline > ?` transitions.
  - Schema: `workspaces`, `mutations`, `audit_events`; store bounded text only in `mutations`.
  - Generate opaque ids as `ws_...` and `mut_...` outside SQL.
- [ ] **Step 4: Run the task test and `npm run typecheck`; verify GREEN.**
- [ ] **Step 5: Commit `feat: add durable mutation store`.**

### Task 2: Capability-Specific File Mutation Backend

**Files:**
- Create: `src/file-mutation-backend.ts`
- Create: `src/executor/devspace-file-mutation.ts`
- Create: `test/file-mutation-backend.test.ts`

**Interfaces:**
```ts
export interface FileMutationBackend {
  readonly kind: string;
  readExact(root: string, path: string): Promise<string>;
  updateExisting(root: string, path: string, original: string, candidate: string): Promise<void>;
}
```
- Produces: `DevspaceFileMutationBackend` wrapping the existing `DevspaceExecutor`.

- [ ] **Step 1: Write failing contract tests** for exact reads, one-file update, wrong-target donor metadata, post-write mismatch, LF and CRLF preservation.
- [ ] **Step 2: Run `tsx --test test/file-mutation-backend.test.ts`; verify RED.**
- [ ] **Step 3: Implement the narrow backend.** Rebind DevSpace from canonical root per operation; do not persist DevSpace workspace ids as authority.
- [ ] **Step 4: Run task tests plus existing `test/file-patch.test.ts`; verify GREEN.**
- [ ] **Step 5: Commit `refactor: add file mutation backend port`.**

### Task 3: Durable Mutation Coordinator

**Files:**
- Create: `src/durable-mutation.ts`
- Create: `test/durable-mutation.test.ts`

**Interfaces:**
```ts
export interface MutationCaller { ownerId: string; sessionId: string; adapterId: string; }
export class DurableMutationCoordinator {
  preview(caller: MutationCaller, workspaceId: string, input: FilePatchInput): Promise<MutationPreview>;
  result(caller: MutationCaller, mutationId: string): MutationResultView;
  approveLocal(mutationId: string): Promise<boolean>;
  rejectLocal(mutationId: string): boolean;
  reconcile(): Promise<void>;
}
```

- [ ] **Step 1: Write failing tests** for immutable preview, identity mismatch, stale target, duplicate/overlap match, sensitive/escape/binary/size rejection, 60s review expiry, 60s admission expiry, single approval, single claim, final hash verification and bounded result/error fields.
- [ ] **Step 2: Add restart tests:** `EXECUTING + result hash -> SUCCEEDED`; `EXECUTING + base hash + live admission -> QUEUED`; divergent hash -> `OUTCOME_UNKNOWN`; recovery never extends deadlines.
- [ ] **Step 3: Run the test file; verify RED.**
- [ ] **Step 4: Implement preview using the existing path policy and the new backend port; persist before returning `mutationId`.**
- [ ] **Step 5: Implement local approval as `PENDING_APPROVAL -> QUEUED`, then asynchronously claim and execute the exact stored plan.**
- [ ] **Step 6: Implement `result()` as a read-only bounded projection with no local paths or stored `before`/`after` content.**
- [ ] **Step 7: Implement restart reconciliation exactly as the spec state machine requires.**
- [ ] **Step 8: Run task tests, `npm run typecheck`, and existing file-patch tests; verify GREEN.**
- [ ] **Step 9: Commit `feat: add durable mutation coordinator`.**

### Task 4: Loopback Operator Review Service

**Files:**
- Create: `src/operator-server.ts`
- Create: `test/operator-server.test.ts`

**Interfaces:**
```ts
export interface OperatorServer {
  origin: string;
  bootstrapUrl: string;
  close(): Promise<void>;
}
export function startOperatorServer(options: { coordinator: DurableMutationCoordinator; host?: string; port?: number }): Promise<OperatorServer>;
```

- [ ] **Step 1: Write failing HTTP tests** proving non-loopback bind is rejected, bootstrap token is one-time, session cookie is `HttpOnly; SameSite=Strict`, wrong/missing Origin is rejected, wrong/missing CSRF is rejected, and no operator credential appears in page URLs after bootstrap.
- [ ] **Step 2: Write rendering tests** proving the page exposes only mutation id, relative path, bounded summary, hashes/fingerprint, line counts and state; escape every rendered value.
- [ ] **Step 3: Run `tsx --test test/operator-server.test.ts`; verify RED.**
- [ ] **Step 4: Implement GET bootstrap/session establishment, pending list/detail pages, approve and reject POST forms, exact Origin checks and per-session CSRF.**
- [ ] **Step 5: Add restrictive response headers:** `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- [ ] **Step 6: Run task tests and typecheck; verify GREEN.**
- [ ] **Step 7: Commit `feat: add local mutation review service`.**

### Task 5: Opt-In MCP Projection Without Remote Apply

**Files:**
- Modify: `src/server.ts`
- Modify: `src/http-server.ts`
- Modify: `test/mcp-surface.test.ts`
- Modify: `test/http-transport.test.ts`

**Interfaces:**
```ts
export interface MutationMcpContext {
  caller: MutationCaller;
  coordinator: DurableMutationCoordinator;
}
```

- [ ] **Step 1: Write failing MCP tests** proving default tool list is unchanged and opt-in list adds only `mutation.preview` and `mutation.result`.
- [ ] **Step 2: Prove the new schemas contain no approval id, apply phase, raw patch, local root, owner id, session id or adapter id fields.** Identity is adapter/server context, not model input.
- [ ] **Step 3: Prove `mutation.preview` is non-read-only/destructive-capability annotated while `mutation.result` is read-only.**
- [ ] **Step 4: Implement optional mutation context wiring in MCP and HTTP server factories; leave historical `file.patch` behind its separate old spike flag until new acceptance passes.**
- [ ] **Step 5: Run `test/mcp-surface.test.ts`, `test/http-transport.test.ts`, typecheck; verify GREEN.**
- [ ] **Step 6: Commit `feat: expose durable mutation result protocol`.**

### Task 6: Experimental Durable-Mutation Runtime

**Files:**
- Create: `scripts/durable-mutation-browser-spike.ts`
- Create: `test/durable-mutation-runtime.test.ts`
- Modify: `src/private-runtime.ts`

**Interfaces:**
```ts
export interface DurableMutationSpikeRuntime {
  mcpUrl: string;
  operatorOrigin: string;
  operatorBootstrapUrl: string;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write failing lifecycle tests** proving the runtime creates a disposable SQLite database, starts loopback MCP plus operator service, runs reconciliation before accepting new mutation work, and closes only resources it owns.
- [ ] **Step 2: Prove operator bootstrap URL is emitted only to the local launcher return value/stderr path and is never returned by MCP.**
- [ ] **Step 3: Run the task test; verify RED.**
- [ ] **Step 4: Implement the experimental runner using a fixed local `MutationCaller` supplied by the adapter configuration, not by tool arguments.**
- [ ] **Step 5: Wire `SqliteDurableStore`, `DevspaceFileMutationBackend`, `DurableMutationCoordinator`, operator server and authenticated loopback MCP server.**
- [ ] **Step 6: Run task tests, typecheck and build; verify GREEN.**
- [ ] **Step 7: Commit `feat: add durable mutation spike runtime`.**

### Task 7: End-to-End Local Gate and Migration Evidence

**Files:**
- Create: `test/durable-mutation.acceptance.test.ts`
- Create: `docs/benchmarks/2026-09-13-durable-mutation-control-plane.md`
- Modify: `docs/superpowers/plans/2026-09-13-durable-local-control-plane.md` only to check completed steps.

- [ ] **Step 1: Write an acceptance test** using a fresh disposable Git fixture and pinned DevSpace: open durable workspace -> preview -> local operator approval -> local execution -> `mutation.result` -> file read-back -> repository snapshot.
- [ ] **Step 2: Add restart cases** with a file-backed SQLite database: recover queued work; reconcile executing/result-hash to success; divergent content to `OUTCOME_UNKNOWN`; verify no blind second write.
- [ ] **Step 3: Verify exactly one expected file changes and expected result SHA-256 matches.**
- [ ] **Step 4: Run full repository gate:** `npm test`, `npm run typecheck`, `npm run build`, `npm run test:business`, exact-pinned DevSpace compatibility checks, `git diff --check`.
- [ ] **Step 5: Record latency and failure spans against the historical two-step browser receipt; do not claim browser-host acceptance yet.**
- [ ] **Step 6: Commit `bench: verify durable mutation control plane`.**

### Task 8: Supported-Host Acceptance Checkpoint

**Files:**
- Modify: `docs/benchmarks/2026-09-13-durable-mutation-control-plane.md`

- [ ] **Step 1: Fresh-read browser policy and preflight owned browser sessions before automation.**
- [ ] **Step 2: Use a fresh disposable fixture and obtain explicit authorization for that exact fixture mutation before consequential execution.**
- [ ] **Step 3: Through the supported browser-adapter path, execute only `mutation.preview`; use the WAG local operator page for the physical human review action; then call `mutation.result`, `file.read`, and `repo.snapshot`.**
- [ ] **Step 4: If host/control safety blocks an action, stop fail-closed; do not synthesize MCP calls or route around the control.**
- [ ] **Step 5: Only after this passes, mark the old remote `file.patch` protocol removable in a separate cleanup commit/spec follow-up.**

## Plan Self-Review

- Spec coverage: durable state, identity, immutable plan, local review, execution/reconciliation, backend replacement boundary, remote preview/result, migration and acceptance all map to Tasks 1–8.
- Intentional deferrals: MCP SDK v2 migration, WAG-owned browser extension/native messaging, generic durable jobs, PTY, Git mutation and SWE-ReX are outside this candidate so the mutation/control-plane semantics can be measured independently.
- Runtime choice: use built-in `node:sqlite` behind `DurableStore`; package replacement remains possible because no caller imports SQLite types outside `durable-store.ts`.
- Existing `file.patch` remains historical/opt-in until the new supported-host gate passes; it is not promoted or used by the new protocol.
