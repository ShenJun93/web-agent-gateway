# File Patch Mutation Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, approval-gated `file.patch` spike that can update one existing text file without changing the default five-tool Business/stdio surface.

**Architecture:** Keep approval state in process memory, keep patch policy in a focused controller, and expose mutation only when the MCP server is explicitly created with `enableFilePatch: true`. The Gateway generates the DevSpace patch and verifies the resulting file hash; callers never pass raw `apply_patch` text.

**Tech Stack:** Node.js 24, TypeScript 6, official MCP SDK, Zod, exact-pinned DevSpace fixture, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-11-file-patch-mutation-spike-design.md`

## Global Constraints

- Default MCP and Business stdio continue exposing exactly five tools.
- Mutation is single existing-file update only; no add/delete/move, Git writes, raw shell, or raw remote patch passthrough.
- Approval is local-only, process-memory, 60-second TTL, fingerprint-bound, and single-use.
- Existing and resulting text are capped at 64 KiB; `before`/`after` are capped at 32 KiB each; NUL content is rejected.
- Every apply revalidates path, target, base hash, unique `before`, fingerprint, approval, executor result metadata, and final hash.

---
### Task 1: In-memory single-use approval store

**Files:**
- Create: `src/patch-approval.ts`
- Create: `test/patch-approval.test.ts`

**Interfaces:**
- Produces `PatchApprovalStore`, `PatchApprovalSummary`, `createPending()`, `approveLocal()`, `consume()`, `revoke()`, and `listPending()`.
- Store constructor accepts `{ ttlMs?: number; now?: () => number }`; default TTL is 60,000 ms.

- [ ] **Step 1: Write the failing tests**

```ts
const store = new PatchApprovalStore({ ttlMs: 1000, now: () => now });
const request = store.createPending({ fingerprint: 'a'.repeat(64), summary: { path: 'note.txt', additions: 1, removals: 1 } });
assert.equal(store.consume(request.approvalId, request.fingerprint), false);
assert.equal(store.approveLocal(request.approvalId, request.fingerprint), true);
assert.equal(store.consume(request.approvalId, request.fingerprint), true);
assert.equal(store.consume(request.approvalId, request.fingerprint), false);
```

Also test fingerprint mismatch, expiry, revoke, and bounded `listPending()` output.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test --test-concurrency=1 test/patch-approval.test.ts`
Expected: FAIL because `src/patch-approval.ts` does not exist.
- [ ] **Step 3: Implement the minimal store**

Use `randomUUID()` for opaque approval ids. Keep entries in a private `Map`; prune expired entries before every public operation. `approveLocal()` must require exact id+fingerprint. `consume()` returns true only for an approved, unexpired exact match and deletes it atomically.

- [ ] **Step 4: Run GREEN**

Run: `npx tsx --test --test-concurrency=1 test/patch-approval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/patch-approval.ts test/patch-approval.test.ts
git commit -m "feat: add single-use patch approval store"
```

### Task 2: Typed DevSpace `apply_patch` wrapper

**Files:**
- Modify: `src/executor/devspace.ts`
- Modify: `test/devspace-compat.test.ts`

**Interfaces:**
- Produces `DevspacePatchResult { result: string; additions: number; removals: number; files: { path: string; previousPath?: string; operation: 'add'|'update'|'delete'|'move' }[] }`.
- Produces `DevspaceExecutor.applyPatch(workspaceId: string, patch: string): Promise<DevspacePatchResult>`.
- [ ] **Step 1: Write the failing contract test**

Extend the exact-pinned fixture test to open a workspace, write `note.txt`, call `executor.applyPatch()` with one `*** Update File` hunk, assert structured metadata reports one `update`, and read back the changed file.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test --test-concurrency=1 test/devspace-compat.test.ts`
Expected: FAIL because `applyPatch` is missing.

- [ ] **Step 3: Implement the narrow wrapper**

Call existing `callTool('apply_patch', { workspaceId, patch })`. Validate `structuredContent.result`, numeric additions/removals, and the files array before returning typed data; malformed donor output throws a stable error.

- [ ] **Step 4: Run GREEN**

Run: `npx tsx --test --test-concurrency=1 test/devspace-compat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/executor/devspace.ts test/devspace-compat.test.ts
git commit -m "feat: wrap DevSpace apply_patch"
```

### Task 3: File patch policy/controller
**Files:**
- Create: `src/file-patch.ts`
- Create: `test/file-patch.test.ts`

**Interfaces:**
- Consumes `DevspaceExecutor`, `PatchApprovalStore`, and `{ canonicalRoot, devspaceWorkspaceId }` workspace bindings.
- Produces `FilePatchController.preview(binding, input)` and `FilePatchController.apply(binding, input)`.
- `FilePatchInput` fields are `path`, `baseSha256`, `before`, `after`; apply also accepts `approvalId`.

- [ ] **Step 1: Write RED tests for preview**

Use the pinned fixture and real files. Assert preview does not modify the file; returns approval metadata; rejects sensitive/escape paths, wrong hash, duplicate `before`, NUL content, oversized before/after/file, and a missing target.

- [ ] **Step 2: Run preview RED**

Run: `npx tsx --test --test-concurrency=1 test/file-patch.test.ts`
Expected: FAIL because `FilePatchController` is missing.

- [ ] **Step 3: Implement preview minimally**

Reuse `validateReadPath()` and `assertReadTarget()`. Read exact executor text, enforce byte bounds, compute SHA-256 with `createHash('sha256')`, require exactly one `before`, build candidate text, line stats, stable fingerprint, and `approvalStore.createPending()`.

- [ ] **Step 4: Run preview GREEN**

Run: `npx tsx --test --test-concurrency=1 test/file-patch.test.ts`
Expected: preview cases PASS.
- [ ] **Step 5: Add RED tests for apply**

Assert apply fails before mutation without local approval, with wrong fingerprint/id, after TTL expiry, after target content changes, and on approval replay. Assert a valid approved LF fixture and CRLF fixture each update exactly one file and return the expected final SHA-256.

Also inject a fake executor result that reports add/delete/move or the wrong target and assert Gateway rejects it. After any successful donor call, require a read-back hash match.

- [ ] **Step 6: Run apply RED**

Run: `npx tsx --test --test-concurrency=1 test/file-patch.test.ts`
Expected: new apply cases FAIL.

- [ ] **Step 7: Implement apply and generated patch**

Recompute preview state from fresh executor content. Revoke stale/mismatched approval ids. Consume only the exact approved fingerprint immediately before `applyPatch()`. Generate one `*** Update File` patch from the validated original/candidate text, validate donor metadata, then read back and verify the final hash.

- [ ] **Step 8: Run Task 3 GREEN and commit**

Run: `npx tsx --test --test-concurrency=1 test/file-patch.test.ts`
Expected: PASS.

```powershell
git add src/file-patch.ts test/file-patch.test.ts
git commit -m "feat: add approval-gated file patch controller"
```

### Task 4: Opt-in MCP mutation surface without Business regression
**Files:**
- Modify: `src/server.ts`
- Modify: `src/http-server.ts`
- Modify: `test/mcp-surface.test.ts`
- Modify: `test/stdio-server.test.ts`

**Interfaces:**
- `createGateway({... patchApprovals? })` wires a `FilePatchController` only when an approval store is supplied.
- `createGatewayMcpServer(gateway, { taskStore?, enableFilePatch?: boolean })` defaults `enableFilePatch` to false.
- `startGatewayHttpServer({ ..., enableFilePatch?: boolean })` forwards the opt-in flag; default false.

- [ ] **Step 1: Write RED MCP surface tests**

Keep the existing default assertion exactly five tools. Add an opt-in server case asserting a sixth `file.patch` tool appears with `readOnlyHint:false`, `destructiveHint:true`, `idempotentHint:false`, `openWorldHint:false`, and a schema containing phase/workspace/path/hash/before/after/approval fields but no raw `patch` field.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test --test-concurrency=1 test/mcp-surface.test.ts test/stdio-server.test.ts`
Expected: opt-in mutation assertion FAIL while existing five-tool assertions remain green.

- [ ] **Step 3: Register the optional tool**

Route `phase:"preview"` to Gateway preview and `phase:"apply"` to apply. Zod must enforce lowercase 64-hex `base_sha256`, input byte-size limits, and `approval_id` only for apply. Do not change the default stdio call site.
- [ ] **Step 4: Run GREEN and regression tests**

Run: `npx tsx --test --test-concurrency=1 test/mcp-surface.test.ts test/stdio-server.test.ts test/business-stdio.acceptance.ts`
Expected: PASS; Business stdio still lists five tools.

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts src/http-server.ts test/mcp-surface.test.ts test/stdio-server.test.ts
git commit -m "feat: add opt-in file patch MCP surface"
```

### Task 5: Local browser-spike approval runner

**Files:**
- Create: `scripts/file-patch-browser-spike.ts`
- Create: `test/file-patch-browser-spike.test.ts`

**Interfaces:**
- Starts the authenticated loopback HTTP Gateway with `enableFilePatch:true` and an in-memory `PatchApprovalStore`.
- Reads operator commands from terminal stdin in the form `approve <approvalId> <fingerprint>` and writes only bounded status lines to stderr.
- Does not enter the production build and does not expose any approval HTTP/MCP endpoint.

- [ ] **Step 1: Write RED runner tests**

Inject streams and dependencies. Assert an `approve` line changes the matching pending entry to approved, malformed/mismatched lines fail, and no workspace content or absolute root is printed.
- [ ] **Step 2: Run RED**

Run: `npx tsx --test --test-concurrency=1 test/file-patch-browser-spike.test.ts`
Expected: FAIL because the spike runner does not exist.

- [ ] **Step 3: Implement the runner minimally**

Reuse the existing private config/OAuth bootstrap only if needed for the live environment; keep parsing and approval command handling in exported pure helpers so tests do not need a browser. The runner must print the loopback MCP URL, pending approval id/fingerprint/path summary, and approval outcome without printing file contents or canonical roots.

- [ ] **Step 4: Run GREEN and commit**

Run: `npx tsx --test --test-concurrency=1 test/file-patch-browser-spike.test.ts`
Expected: PASS.

```powershell
git add scripts/file-patch-browser-spike.ts test/file-patch-browser-spike.test.ts
git commit -m "test: add local file patch browser spike runner"
```

### Task 6: Full local gate and browser acceptance

**Files:**
- Create: `docs/benchmarks/2026-09-11-file-patch-mutation-spike.md`

- [ ] **Step 1: Run repository verification**

Run, in order: `npm test`, `npm run typecheck`, `npm run build`, `npm run test:business`, and `git diff --check`. All must exit 0.
- [ ] **Step 2: Run disposable browser mutation acceptance**

Use a disposable Git fixture/worktree, never the canonical repo. Required sequence on each supported host: `workspace.open` → `file.read` → `file.patch preview` → local terminal approval → `file.patch apply` → `file.read` → `repo.snapshot`. Evidence must show the exact Gateway execution history plus changed file content/diff; model text alone is insufficient.

Run ChatGPT first because its fresh four-tool readonly loop is already proven on the patched adapter. Run Gemini only in a genuinely visible browser tab; treat its known background rendering stall and model schema drift as host evidence, not Gateway failures.

- [ ] **Step 3: Record the receipt**

Document exact Gateway SHA, DevSpace revision, browser adapter spike hash, host results, approval friction, mutation/read-back evidence, full local verification outputs, and whether mutation remains spike-only or merits a separate Business enablement decision.

- [ ] **Step 4: Final commit**

```powershell
git add docs/benchmarks/2026-09-11-file-patch-mutation-spike.md
git commit -m "bench: record file patch mutation spike gate"
```

## Plan self-review checklist

- Spec coverage: approval TTL/single-use/fingerprint, stale-target rejection, path containment, bounded text, generated patch, donor metadata validation, post-write hash, default five-tool regression, browser local approval, and non-goals are each assigned to a task.
- Type consistency: `PatchApprovalStore`, `FilePatchController`, `DevspacePatchResult`, `enableFilePatch`, `approvalId`, and `fingerprint` names are used consistently across tasks.
- Scope: no Business mutation enablement, raw shell, Git write, persistent approval service, or production UI is included.
