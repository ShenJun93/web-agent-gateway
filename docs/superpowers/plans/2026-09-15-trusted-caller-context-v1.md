# Trusted Caller Context v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce one validated immutable WAG caller-context contract and migrate durable mutation to use it without changing any host-visible tool surface or authority.

**Architecture:** Add a small `caller-context` module that owns authority-id validation and optional non-authoritative correlation metadata. Durable store records derive their persisted authority tuple from this contract; durable mutation consumes the trusted context directly, while MCP/HTTP composition injects it outside tool arguments. Existing MCP Tasks, browser/native transport, OAuth, and tool registration semantics remain unchanged.

**Tech Stack:** Node.js 22.19–26, TypeScript 6, Zod 4, Node test runner via `tsx`, existing SQLite durable store, MCP SDK 1.29.0.

**Spec:** `docs/superpowers/specs/2026-09-15-trusted-caller-context-v1-design.md`

## Global Constraints

- `ownerId`, `sessionId`, `adapterId`: 1-128 ASCII characters matching `^[A-Za-z0-9._:-]+$`.
- `correlation.provider`: optional, 1-64 characters matching the same ASCII-safe character set.
- `correlation.clientId`: optional, 1-128 characters matching the same ASCII-safe character set.
- `correlation.conversationRef`: optional, at most 512 UTF-8 bytes and no C0 control characters or NUL.
- Outer context and nested `correlation` are strict; unknown keys are rejected.
- Factory output is deeply immutable for all values introduced by this contract.
- Persist only the required authority tuple; correlation metadata does not trigger a database migration.
- No new environment variable, private-config field, browser discovery field, or model-facing parameter.
- Default and Business MCP surfaces stay at five tools; Browser Adapter v1 stays at three tools.
- Browser mutation, generic durable jobs, shell, PTY, Git-write, SDK upgrade, and process/browser ownership managers remain out of scope.

---
### Task 1: Trusted Caller Context Contract

**Files:**
- Create: `src/caller-context.ts`
- Create: `test/caller-context.test.ts`

**Interfaces:**
- Produces: `GatewayCallerContext` with readonly `ownerId`, `sessionId`, `adapterId`, and optional readonly `correlation`.
- Produces: `GatewayAuthority = Pick<GatewayCallerContext, 'ownerId' | 'sessionId' | 'adapterId'>` as the derived persisted-authority shape.
- Produces: `createGatewayCallerContext(value: unknown): GatewayCallerContext`.

- [ ] **Step 1: Write RED tests for valid construction and deep immutability.**

```ts
const input = {
  ownerId: 'owner_a', sessionId: 'session_a', adapterId: 'adapter_a',
  correlation: { provider: 'chatgpt', clientId: 'client_a', conversationRef: 'conv/123' },
};
const context = createGatewayCallerContext(input);
assert.deepEqual(context, input);
assert.equal(Object.isFrozen(context), true);
assert.equal(Object.isFrozen(context.correlation), true);
assert.throws(() => { (context as any).ownerId = 'other'; });
assert.throws(() => { (context.correlation as any).provider = 'other'; });
```

- [ ] **Step 2: Add RED validation cases covering every exact v1 bound.**
Use table-driven assertions for empty ids, 129-character ids, unsafe spaces/slashes, provider length 65, clientId length 129, conversationRef above 512 UTF-8 bytes, C0 controls, NUL, unknown outer keys, and unknown nested keys.

```ts
for (const bad of [
  { ...input, ownerId: '' },
  { ...input, ownerId: 'x'.repeat(129) },
  { ...input, sessionId: 'bad value' },
  { ...input, adapterId: 'bad/value' },
  { ...input, correlation: { provider: 'x'.repeat(65) } },
  { ...input, correlation: { clientId: 'x'.repeat(129) } },
  { ...input, correlation: { conversationRef: 'é'.repeat(257) } },
  { ...input, correlation: { conversationRef: 'bad\u0001ref' } },
  { ...input, extra: true },
  { ...input, correlation: { provider: 'chatgpt', extra: true } },
]) assert.throws(() => createGatewayCallerContext(bad));
```

- [ ] **Step 3: Run the focused test and require RED because the module does not exist.**

Run: `npx tsx --test test/caller-context.test.ts`
Expected: FAIL with module-not-found / missing export evidence.

- [ ] **Step 4: Implement `src/caller-context.ts` with strict Zod schemas and explicit freezing.**
```ts
import { z } from 'zod';

const authorityId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const providerId = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);
const conversationRef = z.string().refine((value) =>
  Buffer.byteLength(value, 'utf8') <= 512 && !/[\u0000-\u001F]/.test(value));

const correlationSchema = z.object({
  provider: providerId.optional(),
  clientId: authorityId.optional(),
  conversationRef: conversationRef.optional(),
}).strict();

const callerContextSchema = z.object({
  ownerId: authorityId,
  sessionId: authorityId,
  adapterId: authorityId,
  correlation: correlationSchema.optional(),
}).strict();
```

Add the public types and factory in the same module:

```ts
export interface GatewayCallerCorrelation {
  readonly provider?: string;
  readonly clientId?: string;
  readonly conversationRef?: string;
}

export interface GatewayCallerContext {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly correlation?: GatewayCallerCorrelation;
}

export type GatewayAuthority = Pick<GatewayCallerContext, 'ownerId' | 'sessionId' | 'adapterId'>;

export function createGatewayCallerContext(value: unknown): GatewayCallerContext {
  const parsed = callerContextSchema.parse(value);
  const correlation = parsed.correlation === undefined
    ? undefined
    : Object.freeze({ ...parsed.correlation });
  return Object.freeze({
    ownerId: parsed.ownerId,
    sessionId: parsed.sessionId,
    adapterId: parsed.adapterId,
    ...(correlation === undefined ? {} : { correlation }),
  });
}
```

Parse from `unknown`; do not export the Zod schemas and do not add defaults or coercions.

- [ ] **Step 5: Run focused tests and typecheck; require GREEN.**

Run: `npx tsx --test test/caller-context.test.ts && npm run typecheck`
Expected: all caller-context tests pass; typecheck exits 0.
- [ ] **Step 6: Commit the caller-context contract.**

```powershell
git add src/caller-context.ts test/caller-context.test.ts
git commit -m "feat: add trusted caller context"
```

### Task 2: Make Durable Mutation Consume the Shared Authority Contract

**Files:**
- Modify: `src/durable-store.ts:9-56`
- Modify: `src/durable-mutation.ts:4-10,69-99,302-306`
- Modify: `test/durable-store.test.ts:1-78`
- Modify: `test/durable-mutation.test.ts:1-141`
- Modify: `test/durable-mutation.acceptance.test.ts:1-25` and caller construction sites

**Interfaces:**
- Consumes: `GatewayAuthority`, `GatewayCallerContext`, `createGatewayCallerContext` from Task 1.
- Produces: durable records whose identity type is derived from `GatewayCallerContext` with no SQLite schema changes.
- Preserves: optional deprecated `MutationCaller = GatewayCallerContext` type alias only for historical script compatibility; production coordinator signatures use `GatewayCallerContext` directly.

- [ ] **Step 1: Strengthen durable-mutation ownership regression tests before changing production types.**
Replace the single owner-only mismatch assertion with independent owner/session/adapter cases using validated contexts:

```ts
const caller = createGatewayCallerContext({
  ownerId: 'owner-a', sessionId: 'session-a', adapterId: 'adapter-a',
});
for (const denied of [
  createGatewayCallerContext({ ...caller, ownerId: 'owner-b' }),
  createGatewayCallerContext({ ...caller, sessionId: 'session-b' }),
  createGatewayCallerContext({ ...caller, adapterId: 'adapter-b' }),
]) {
  assert.throws(() => coordinator.result(denied, preview.mutationId), /identity/);
}
```

In `test/durable-mutation.acceptance.test.ts`, import the factory and replace the raw caller constant with:

```ts
const caller = createGatewayCallerContext({
  ownerId: 'owner_accept',
  sessionId: 'session_accept',
  adapterId: 'browser_accept',
});
```

- [ ] **Step 2: Run durable tests before the type migration and capture the current GREEN baseline.**

Run: `npx tsx --test test/durable-store.test.ts test/durable-mutation.test.ts test/durable-mutation.acceptance.test.ts`
Expected: existing behavior remains GREEN; the new imports/signatures are not introduced yet.

- [ ] **Step 3: Replace the independent store identity interface with the derived shared authority type.**
In `src/durable-store.ts`, import the derived type and use it directly:

Import the derived type, then replace only these four declaration lines; leave each existing interface body unchanged:

```ts
import type { GatewayAuthority } from './caller-context.js';
export interface WorkspaceRecord extends GatewayAuthority {
export interface MutationRecord extends GatewayAuthority {
export interface CreateWorkspaceRecord extends GatewayAuthority {
export interface CreateMutationRecord extends GatewayAuthority {
```

Delete the standalone `MutationIdentity` interface. Do not change table definitions, SQL statements, row mapping, ids, state transitions, or stored values.

- [ ] **Step 4: Run typecheck and require RED at the remaining old `MutationIdentity` import.**

Run: `npm run typecheck`
Expected: FAIL in `src/durable-mutation.ts` because `MutationIdentity` is no longer exported; this proves the remaining independent seam is located.

- [ ] **Step 5: Migrate `DurableMutationCoordinator` to the shared context.**

Import the shared types and retain only a derived compatibility alias:

```ts
import type { GatewayAuthority, GatewayCallerContext } from './caller-context.js';
export type MutationCaller = GatewayCallerContext; // deprecated compatibility alias only
```

Replace the three production signatures exactly:

```diff
- async preview(caller: MutationCaller, workspaceId: string, input: DurableMutationInput): Promise<MutationPreview> {
+ async preview(caller: GatewayCallerContext, workspaceId: string, input: DurableMutationInput): Promise<MutationPreview> {
- result(caller: MutationCaller, mutationId: string): MutationResultView {
+ result(caller: GatewayCallerContext, mutationId: string): MutationResultView {
- function assertIdentity(expected: MutationCaller, actual: MutationIdentity): void {
+ function assertIdentity(expected: GatewayCallerContext, actual: GatewayAuthority): void {
```
Do not persist `correlation`, and do not alter `assertIdentity` semantics beyond typing it from the shared contract.

- [ ] **Step 6: Run durable unit/acceptance tests plus typecheck; require GREEN.**

Run: `npx tsx --test test/caller-context.test.ts test/durable-store.test.ts test/durable-mutation.test.ts test/durable-mutation.acceptance.test.ts && npm run typecheck`
Expected: all tests pass; typecheck exits 0; SQLite reopen/reconciliation behavior is unchanged.

- [ ] **Step 7: Commit the durable-authority migration.**

```powershell
git add src/durable-store.ts src/durable-mutation.ts test/durable-mutation.test.ts test/durable-mutation.acceptance.test.ts
git commit -m "refactor: share durable caller authority"
```

### Task 3: Inject Trusted Context Through the Existing Mutation Composition Seam

**Files:**
- Modify: `src/server.ts:10,154-159,193-214`
- Modify: `src/http-server.ts:4-13,43-47` only for renamed type/field propagation; no HTTP auth behavior change.
- Modify: `scripts/durable-mutation-browser-spike.ts:4,22,56`
- Modify: `test/mcp-surface.test.ts:59-107`
- Modify: `test/http-transport.test.ts:53-77`
- Modify: `test/browser-adapter-protocol.test.ts:20-39`

**Interfaces:**
- Consumes: `GatewayCallerContext` and `createGatewayCallerContext`.
- Produces: `MutationMcpContext { callerContext: GatewayCallerContext; coordinator: Pick<DurableMutationCoordinator, 'preview' | 'result'> }`.
- Preserves: all tool names, annotations, argument/result schemas, HTTP bearer behavior, browser protocol version, and browser three-tool allowlist.
- [ ] **Step 1: Change composition tests to require the new trusted-context field and extend schema-denial coverage.**

In `test/mcp-surface.test.ts`, construct a validated context and pass `callerContext`:

```ts
const callerContext = createGatewayCallerContext({
  ownerId: 'owner_test', sessionId: 'session_test', adapterId: 'adapter_test',
  correlation: { provider: 'chatgpt', clientId: 'test-client' },
});
const server = createGatewayMcpServer(gateway, {
  mutationContext: { callerContext, coordinator },
});
```

Extend the forbidden schema names to include both authority and correlation candidates:

```ts
for (const forbidden of [
  'owner_id', 'session_id', 'adapter_id', 'ownerId', 'sessionId', 'adapterId',
  'provider', 'client_id', 'clientId', 'conversation_ref', 'conversationRef',
]) assert.doesNotMatch(schemas, new RegExp(`"${forbidden}"`));
```

Add one explicit strict-schema rejection:

```ts
await assert.rejects(client.callTool({
  name: 'mutation.preview',
  arguments: {
    workspace_id: workspace.workspaceId,
    path: 'note.txt',
    base_sha256: baseSha256,
    before: 'beta',
    after: 'BETA',
    owner_id: 'attacker-selected-owner',
  },
}), /Invalid arguments for tool mutation\.preview/);
```

- [ ] **Step 2: Update HTTP composition test input to `callerContext` and run typecheck for RED.**

In `test/http-transport.test.ts`, import the factory and construct the context outside tool arguments:

```ts
const callerContext = createGatewayCallerContext({
  ownerId: 'owner_http', sessionId: 'session_http', adapterId: 'adapter_http',
});
const mutationContext = {
  callerContext,
  coordinator: {
    preview: async () => { throw new Error('not called'); },
    result: () => { throw new Error('not called'); },
  },
};
```
Run: `npm run typecheck`
Expected: FAIL because `MutationMcpContext` still requires `caller`, proving the old composition seam remains.

- [ ] **Step 3: Rename the MCP composition seam and keep identity outside tool arguments.**

In `src/server.ts`:

```ts
import type { GatewayCallerContext } from './caller-context.js';

export interface MutationMcpContext {
  callerContext: GatewayCallerContext;
  coordinator: Pick<DurableMutationCoordinator, 'preview' | 'result'>;
}
```

Use `mutationContext.callerContext` for both `coordinator.preview(...)` and `coordinator.result(...)`. Remove the production import of `MutationCaller` from `server.ts`.

In `scripts/durable-mutation-browser-spike.ts`, retain its external `caller` option for historical harness compatibility but map it explicitly at composition:

```ts
mutationContext: { callerContext: options.caller, coordinator },
```

`src/http-server.ts` continues forwarding the typed `mutationContext` unchanged; do not alter bearer authentication, binding, task-store lifetime, or request routing.

- [ ] **Step 4: Strengthen Browser Adapter regression coverage without changing browser production code.**
In `test/browser-adapter-protocol.test.ts`, keep the existing three-tool allowlist and add table-driven rejection for ownership/correlation-like extra arguments on `file.read`:

```ts
for (const extra of [
  { owner_id: 'owner' }, { session_id: 'session' }, { adapter_id: 'adapter' },
  { provider: 'chatgpt' }, { client_id: 'client' }, { conversation_ref: 'conv' },
]) {
  assert.throws(() => parseBrowserAdapterRequest({
    version: 1, type: 'tool.call', requestId: rid, sessionId: sid,
    tool: 'file.read', arguments: { workspace_id: 'ws_123', path: 'note.txt', ...extra },
  }));
}
```

Do not change `src/browser-adapter/protocol.ts`; this test is a regression lock on its existing strictness.

- [ ] **Step 5: Run focused composition/surface tests plus typecheck; require GREEN.**

Run: `npx tsx --test test/mcp-surface.test.ts test/http-transport.test.ts test/browser-adapter-protocol.test.ts test/durable-mutation-runtime.test.ts test/durable-mutation.acceptance.test.ts && npm run typecheck`
Expected: all focused tests pass; typecheck exits 0; default/HTTP/browser behavior remains unchanged except the internal field name.

- [ ] **Step 6: Commit the trusted composition seam.**

```powershell
git add src/server.ts scripts/durable-mutation-browser-spike.ts test/mcp-surface.test.ts test/http-transport.test.ts test/browser-adapter-protocol.test.ts
git commit -m "refactor: inject trusted mutation caller context"
```

### Task 4: Exact-Candidate Acceptance Gate and Receipt
**Files:**
- Create after verification: `docs/benchmarks/2026-09-15-trusted-caller-context-v1.md`
- No production code changes in this task.

**Interfaces:**
- Consumes: exact candidate produced by Tasks 1-3.
- Produces: evidence for `TRUSTED_CALLER_CONTEXT_V1 = PASS` only; grants no later capability authority.

- [ ] **Step 1: Run the complete focused contract gate on the exact candidate.**

Run:

```powershell
npx tsx --test test/caller-context.test.ts test/durable-store.test.ts test/durable-mutation.test.ts test/durable-mutation.acceptance.test.ts test/durable-mutation-runtime.test.ts test/mcp-surface.test.ts test/http-transport.test.ts test/browser-adapter-protocol.test.ts
```

Expected: 0 failed tests. Specifically retain exact owner/session/adapter denial, SQLite reopen/reconciliation, five-tool default MCP, durable mutation preview/result-only projection, authenticated loopback HTTP, and three-tool browser protocol.

- [ ] **Step 2: Run the full repository gate fresh on the same HEAD.**

```powershell
npm test
npm run typecheck
npm run build
npm run test:business
git diff --check
```

Expected: every command exits 0. Do not infer one command from another; retain each exit/result independently.

- [ ] **Step 3: Verify scope and schema non-expansion from Git evidence.**
Run:

```powershell
git diff --name-only b1e725feef09a459666295f2e023c4399580b2ab...HEAD
git diff b1e725feef09a459666295f2e023c4399580b2ab...HEAD -- src/durable-store.ts
```

Require that no browser extension/runtime/native-host production file, private config, OAuth module, `src/task-store.ts`, package manifest/lockfile, or SQL table definition changed. The durable-store diff may change TypeScript identity imports/extends only; any `CREATE TABLE`, `ALTER TABLE`, SQL column, or row-value semantic change fails this milestone.

- [ ] **Step 4: Request independent code review against the accepted spec and this plan before claiming PASS.**

Reviewer input must include base `b1e725feef09a459666295f2e023c4399580b2ab`, exact candidate HEAD, the spec path, and Tasks 1-3. The reviewer must be a separate reviewer capability or an explicit human review of that exact diff; self-review does not qualify. Critical/Important findings are blockers. If neither independent path is available, record `INDEPENDENT_REVIEW = BLOCKED` and do not merge or claim the final gate.

- [ ] **Step 5: After review is clear, rerun any impacted focused tests and the complete full-repository gate.**

If review causes no code changes, record the prior exact-candidate SHA and verification as still applicable. If any code/test file changes, rerun Step 1 and every command in Step 2 on the new SHA before proceeding.

- [ ] **Step 6: Write the acceptance receipt with concrete evidence, not planned results.**

Create `docs/benchmarks/2026-09-15-trusted-caller-context-v1.md` containing: candidate SHA; base/spec/ADR references; changed production/test files; caller-context validation bounds; proof that correlation is non-persisted/non-authoritative; exact owner/session/adapter mismatch evidence; tool-count/schema evidence; no-SQL-migration evidence; focused/full command results; independent review disposition; and the final label.

The final label is exactly one of:

```text
TRUSTED_CALLER_CONTEXT_V1 = PASS
TRUSTED_CALLER_CONTEXT_V1 = BLOCKED
```
`PASS` is permitted only when all seven spec acceptance conditions and independent review are satisfied on the exact candidate. Otherwise use `BLOCKED` with the failed condition; do not widen authority to work around it.

- [ ] **Step 7: Commit the acceptance receipt only after its evidence exists.**

```powershell
git add docs/benchmarks/2026-09-15-trusted-caller-context-v1.md
git commit -m "bench: verify trusted caller context v1"
```

- [ ] **Step 8: Final fresh verification before any integration decision.**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -5
git diff --check main...HEAD
```

Require a clean implementation worktree, no unexpected files, and no authority/surface changes outside this plan. Integration to `main` remains a separate human decision after the gate.

## Plan Self-Review

- Spec coverage: Task 1 implements exact validation/immutability; Task 2 removes the independent mutation/store identity definitions; Task 3 enforces trusted composition and unchanged host schemas; Task 4 proves exact-candidate acceptance and records evidence.
- Trust boundary: no model/page argument gains authority identity; browser protocol `sessionId` remains correlation-only and browser production code is untouched.
- Persistence: no SQLite schema migration and no correlation persistence are permitted.
- Surface compatibility: default/Business five-tool and browser three-tool contracts are explicitly gated.
- SDK boundary: `task-store.ts` and MCP SDK version are intentionally untouched; durable generic jobs remain a later design.
- Type consistency: `GatewayCallerContext` is the normative trusted runtime type; `GatewayAuthority` is a derived persisted shape; `MutationCaller` may exist only as a deprecated alias, never an independent interface.
- Review rule: self-review cannot satisfy the independent-review gate.
- Intentional deferrals: durable `verify.run` jobs, browser session admission, browser mutation projection, process/browser managers, SDK v2 migration, shell/PTY/Git writes, second provider adapter, and DC replacement.
