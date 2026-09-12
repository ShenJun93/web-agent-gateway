# File Patch Approval Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the file-patch approval clock into a 60-second pending-preview window and a separate 60-second approved-use window without changing the remote MCP contract or production Business surface.

**Architecture:** `PatchApprovalStore` remains the sole owner of approval timing and state. Preview creates a pending request with an immutable pending deadline; the first exact local approval records an independent approved-use deadline; apply consumes only an approved unexpired request after existing fresh validation. `FilePatchController`, the browser spike runner, DevSpace adapter, and default five-tool surfaces retain their existing responsibilities.

**Tech Stack:** TypeScript, Node.js `node:test`, MCP server surface, pinned DevSpace fixture.

**Spec:** `docs/superpowers/specs/2026-09-12-file-patch-approval-timing-design.md`

**Implementation SHA:** `53d398a2d42c530f2a710bb244cbac99a5386ea4`

**Current gate:** local verification PASS; supported-host browser mutation acceptance remains incomplete/fail-closed.

## Global Constraints

- Pending-preview TTL remains exactly 60,000 ms from preview creation.
- Approved-use TTL is exactly 60,000 ms from the first successful local approval.
- Re-approving the same exact request must never extend approved authority.
- `preview.expiresAt` remains the pending-approval deadline; the remote `file.patch` schema does not change.
- Approval remains process-memory, local-only, fingerprint-bound, and single-use.
- Default MCP and Business stdio remain exactly five non-mutation tools.
- No executor, path-policy, HTTP-authentication, raw-patch, persistence, or production-mutation scope is added.

---

### Task 1: Split the Approval Store Clocks

**Files:**
- Modify: `test/patch-approval.test.ts`
- Modify: `src/patch-approval.ts`

**Interfaces:**
- Consumes: `PatchApprovalStore({ ttlMs, now })`, `createPending`, `approveLocal`, `consume`, `get`, `listPending`, `revoke`.
- Produces: approval records with immutable `pendingExpiresAt`, optional `approvedAt` / `approvedExpiresAt`, compatibility `expiresAt` equal to the pending deadline, and state-aware expiry behavior.
- [x] **Step 1: Write failing approval-store timing tests**

Add tests that use an injected `now` value to prove all clock boundaries explicitly:

```ts
const store = new PatchApprovalStore({ ttlMs: 1_000, now: () => now });
const pending = store.createPending({ fingerprint, summary });
assert.equal(pending.pendingExpiresAt, 2_000);
assert.equal(pending.expiresAt, 2_000);
now = 1_999;
assert.equal(store.approveLocal(pending.approvalId, fingerprint), true);
const approved = store.get(pending.approvalId)!;
assert.equal(approved.pendingExpiresAt, 2_000);
assert.equal(approved.approvedAt, 1_999);
assert.equal(approved.approvedExpiresAt, 2_999);
now = 2_001;
assert.equal(store.consume(pending.approvalId, fingerprint), true);
```

Also prove exact re-approval at `now = 2_500` does not change `approvedAt` or `approvedExpiresAt`, and that consume/approve fail at `now >= approvedExpiresAt`.

- [x] **Step 2: Run the targeted tests and verify RED**

Run: `npx tsx --test test/patch-approval.test.ts`

Expected: FAIL because current records have only one `expiresAt` and the store prunes approved requests against the original pending deadline.

- [x] **Step 3: Implement the minimal state-machine change**

In `src/patch-approval.ts`, preserve `expiresAt` as the compatibility pending deadline and add explicit timing fields. `approveLocal` must set the approved timestamps only on the first transition. Expiry pruning must use `pendingExpiresAt` for pending requests and `approvedExpiresAt` for approved requests.

- [x] **Step 4: Run targeted tests and typecheck**

Run: `npx tsx --test test/patch-approval.test.ts && npm run typecheck`

Expected: all approval-store tests PASS and typecheck exits 0.

- [x] **Step 5: Commit Task 1**

```bash
git add src/patch-approval.ts test/patch-approval.test.ts
git commit -m "feat: split file patch approval timing windows"
```

### Task 2: Prove Controller and Runner Compatibility

**Files:**
- Modify: `test/file-patch.test.ts`
- Modify: `test/file-patch-browser-spike.test.ts` only if the stored-record shape requires assertion updates.
- Modify: `scripts/file-patch-browser-spike.ts` only if TypeScript requires a compatibility adjustment; do not add a new remote field or command.

**Interfaces:**
- Consumes: unchanged `FilePatchController.preview/apply` and local `approve <approvalId> <fingerprint>` command.
- Produces: apply remains valid after the original preview deadline when the request was approved in time and its approved-use deadline remains live.
- [x] **Step 1: Write the failing controller integration test**

Change the existing expiry test so the timeline distinguishes the two clocks:

```ts
let now = 1_000;
const approvals = new PatchApprovalStore({ ttlMs: 10, now: () => now });
const preview = await controller.preview(binding, input);
now = 1_009;
assert.equal(approvals.approveLocal(preview.approvalId, preview.fingerprint), true);
now = 1_011;
const result = await controller.apply(binding, { ...input, approvalId: preview.approvalId });
assert.equal(result.status, 'applied');
```

Add a second preview proving apply fails at the approved-use deadline after a timely local approval.

- [x] **Step 2: Run the controller/browser-spike tests and verify RED or compatibility**

Run: `npx tsx --test test/file-patch.test.ts test/file-patch-browser-spike.test.ts`

Expected before Task 1 implementation: the cross-pending-deadline apply case fails. After Task 1, it must PASS without changing the MCP input schema.

- [x] **Step 3: Make only compatibility changes required by the new stored-record shape**

Do not move clock ownership into `FilePatchController`. Keep `preview.expiresAt` sourced from the pending deadline and keep the runner command syntax unchanged.
- [x] **Step 4: Run targeted controller and runner verification**

Run: `npx tsx --test test/patch-approval.test.ts test/file-patch.test.ts test/file-patch-browser-spike.test.ts && npm run typecheck`

Expected: all targeted tests PASS; no schema or Business-surface regressions.

- [x] **Step 5: Commit Task 2**

```bash
git add test/file-patch.test.ts test/file-patch-browser-spike.test.ts scripts/file-patch-browser-spike.ts
git commit -m "test: prove approved file patch window"
```

Only stage files that actually changed.

### Task 3: Full Gate and Fresh Browser Acceptance

**Files:**
- Modify: `docs/benchmarks/2026-09-11-file-patch-mutation-spike.md`

**Interfaces:**
- Consumes: the completed split-clock implementation, existing disposable browser fixture/harness, SuperAssistant host path, and local approval stdin.
- Produces: exact implementation SHA plus fresh local/browser evidence; no production enablement.

- [x] **Step 1: Run the complete local gate on the implementation SHA**

Run in order:

```bash
npm test
npm run typecheck
npm run build
npm run test:business
git diff --check
```
- [ ] **Step 2: Run fresh browser acceptance from a clean disposable fixture**

Use the existing local browser-spike runner and supported browser host path. Prove, with matching Gateway execution history and filesystem evidence:

```text
preview -> local approve -> apply within approved-use TTL -> file.read -> repo.snapshot
```

The first local approval must occur before the unchanged pending deadline. Record both preview-to-apply and approval-to-apply timing. Do not patch the adapter to synthesize acceptance and do not relax either 60-second window.

- [ ] **Step 3: Independently verify the disposable fixture**

Verify exact post-write content/SHA, `git status`, and `git diff` outside the browser. A model success message without matching Gateway history and local read-back is not evidence.

- [x] **Step 4: Update the benchmark receipt honestly**

Record the exact implementation SHA, local gate results, browser sequence/timing, final file SHA/diff, and whether ChatGPT/Gemini acceptance passed or remained fail-closed. Keep `BUSINESS_MUTATION_ENABLEMENT = NOT_AUTHORIZED` unless a later ADR explicitly changes it.

- [x] **Step 5: Re-run documentation integrity and commit the receipt**

Run: `git diff --check`

Then commit only the receipt change:

```bash
git add docs/benchmarks/2026-09-11-file-patch-mutation-spike.md
git commit -m "bench: record split-window browser acceptance"
```

- [x] **Step 6: Final branch verification**

Re-run the complete local gate on final HEAD, verify the feature worktree is clean, and verify canonical `main` has not moved as part of this work. Do not merge or push mutation capability unless separately authorized.
