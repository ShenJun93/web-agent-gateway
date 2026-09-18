# Browser Inspect v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a versioned five-tool read-only ChatGPT Browser profile that closes WAG benchmark R1/R2 through bounded `repo.search` and exact-owned `repo.snapshot` without opening consequential authority.

**Architecture:** Add one provider-neutral repository-inspection boundary over the existing DevSpace executor, then route search/snapshot through the durable admitted-workspace service. Upgrade the Browser wire/discovery/adapter identity atomically to v2, make the extension complete an exact profile handshake before tool execution, and keep `verify.run`, mutation, process, Git-write, and generic forwarding absent.

**Tech Stack:** TypeScript 6.0.3, Node >=22.19 <27, MCP SDK v2 packages 2.0.0, Zod 4.5.4, SQLite durable store, Chrome MV3 extension, Windows Native Messaging, pinned DevSpace.

**Spec:** `docs/superpowers/specs/2026-09-17-browser-inspect-v2-design.md`

## Global Constraints

- Adapter id is exactly `browser.chatgpt.native.inspect.v2`; Browser wire protocol is exactly version `2`.
- Browser v2 tool inventory is exactly `health`, `workspace.open`, `repo.search`, `repo.snapshot`, `file.read`.
- `repo.search` is bounded fixed-string tracked-working-tree text search only; no caller regex/glob/pathspec/shell syntax.
- Search results and Browser snapshot results are bounded below 64 KiB structured output; Browser envelope cap remains 256 KiB.
- Browser v2 exposes no `verify.run`, mutation, jobs, shell/PTY/process, Git writes, browser mutation, or generic MCP forwarding.
- Exact owner/session/adapter workspace fencing and restart recovery remain mandatory.
- Do not add a new runtime dependency unless a later reviewed blocker proves it necessary.
- Preserve `.playwright-cli/` and all unrelated local state; use task-owned fixtures/worktrees only.

**Execution precondition:** before Task 1, invoke `superpowers:using-git-worktrees` and create a fresh isolated implementation worktree/branch from the committed spec+plan base. Do not implement in the benchmark documentation worktree.

---## File map

- Create `src/repository-inspection.ts`: provider-neutral search/snapshot types, bounds, parsing, DevSpace-backed implementation.
- Create `test/repo-search.test.ts`: deterministic search correctness, literal-query, truncation, sensitive-path, and injection tests.
- Modify `src/server.ts`: reuse repository inspection for default snapshot and register five-tool Browser v2 MCP surface.
- Modify `src/admitted-workspace.ts`: add exact-owned `search` and `snapshot` methods with restart rebind.
- Modify `src/adapter-admission.ts`: make v2 adapter identity explicit and durable-session hashing profile-specific.
- Modify `scripts/browser-adapter-runtime.ts`: compose v2 admission, repository inspection, and versioned discovery record.
- Modify `src/browser-adapter/protocol.ts`: strict protocol-v2 envelopes and schemas for two new tools.
- Modify `src/browser-adapter/local-link.ts`: exact five-tool discovery and version/profile-bound admission record.
- Modify `src/browser-adapter/native-host.ts`: version/profile discovery validation and exact hello identity.
- Modify `browser/extension/chatgpt-call-parser.js`: strict `repo.search`/`repo.snapshot` parsing.
- Modify `browser/extension/service-worker-core.js` and `service-worker.js`: five-tool allowlist plus hello/bind/tools-list handshake before execution.
- Update focused browser/admission/native/runtime/distribution tests; do not refactor unrelated control planes.

### Task 1: Provider-Neutral Repository Inspection Backend

**Files:**
- Create: `src/repository-inspection.ts`
- Create: `test/repo-search.test.ts`
- Modify: `test/repo-snapshot.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces: `RepositoryInspectionBackend`, `RepoSearchOptions`, `RepoSearchResult`, `RepoSnapshotOptions`, `RepoSnapshotResult`, `DevspaceRepositoryInspectionBackend`.
- Consumes: `DevspaceExecutor`, `assertReadTarget`, `validateReadPath`.- [ ] **Step 1: Write failing search-contract tests**

Add tests that call the new backend with a real pinned DevSpace fixture and assert:

```ts
const result = await inspection.search({
  devspaceWorkspaceId,
  canonicalRoot: fixture.workspaceRoot,
  query: 'canonicalizeTicketId',
  ignoreCase: false,
  maxResults: 20,
  contextLines: 1,
});
assert.deepEqual(result.matches.map((m) => m.path), [
  'src/lib/ticket-id.js',
  'test/ticket-id.test.js',
]);
assert.equal(result.truncated, false);
```

Also cover no-match success, deterministic path/line ordering, `maxResults=1` truncation, binary exclusion, untracked-file exclusion, and total output below 64 KiB.

- [ ] **Step 2: Add RED security tests for literal-query execution**

Use queries containing `';`, `&&`, `|`, `>`, `$()`, backticks, quotes, parentheses, and ampersands. Create a sibling marker path and assert no query creates/modifies it. Include a tracked `.env.local` and `.git`-adjacent probe and assert no sensitive-path match is returned.

Run:
```powershell
npm test -- --test-name-pattern="repo.search"
```
Expected: FAIL because `RepositoryInspectionBackend`/`search` do not exist.

- [ ] **Step 3: Define exact types and bounds**

Create types with these exact fields:

```ts
export interface RepoSearchOptions { ignoreCase?: boolean; maxResults?: number; contextLines?: number; }
export interface RepoSearchMatch { path: string; line: number; text: string; before: string[]; after: string[]; }
export interface RepoSearchResult { matches: RepoSearchMatch[]; truncated: boolean; }
export interface RepoSnapshotOptions { maxFiles?: number; }
export interface RepoSnapshotResult { branch: string; head: string; dirty: boolean; status: string[]; diffStat: string; files: string[]; filesTruncated: boolean; }
export interface RepositoryInspectionBackend {
  search(input: { devspaceWorkspaceId: string; canonicalRoot: string; query: string; ignoreCase: boolean; maxResults: number; contextLines: number }): Promise<RepoSearchResult>;
  snapshot(devspaceWorkspaceId: string, options?: RepoSnapshotOptions): Promise<RepoSnapshotResult>;
}
```

Resolved search bounds: query 1..256 UTF-8 bytes, no NUL/CR/LF; maxResults 1..50 default 20; contextLines 0..2 default 1.- [ ] **Step 4: Implement an argv-safe fixed helper command**

Keep the caller query out of shell syntax. Encode both the constant helper source and the validated query as base64url (alphabet limited to letters/digits/`_`/`-`), then execute only a fixed Node bootstrap plus numeric/boolean tokens:

```ts
const helper64 = Buffer.from(SEARCH_HELPER_SOURCE, 'utf8').toString('base64url');
const query64 = Buffer.from(query, 'utf8').toString('base64url');
const command = [
  'node -e "eval(Buffer.from(process.argv[1],\'base64url\').toString(\'utf8\'))"',
  helper64,
  query64,
  ignoreCase ? '1' : '0',
  String(contextLines),
].join(' ');
```

The fixed helper decodes `process.argv[2]`, then invokes Git with `child_process.spawnSync()` and an argument array, never a shell string:

```ts
const args = ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'grep', '-F', '-n', '-I', `-C${context}`, '-z'];
if (ignoreCase) args.push('-i');
args.push('--', query);
spawnSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 });
```

Exit `1` means no matches; exit `0` is parsed; any other exit or max-buffer failure becomes bounded `Gateway search failed`. Do not enable `--recurse-submodules` or `--textconv`.

- [ ] **Step 5: Parse, filter, and bound search evidence in WAG**

Parse `git grep -z -n -C<n>` records as `path\0line\0text\n` groups separated by `--\n`. Determine actual match lines by literal query comparison (case-fold only when `ignoreCase=true`); surrounding lines become `before`/`after`.

Before retaining any record:
```ts
const safePath = validateReadPath(path);
await assertReadTarget(canonicalRoot, safePath);
```
Reject returned paths containing NUL/CR/LF or invalid line numbers. Sort matches by normalized path, line, text; slice to `maxResults`; set `truncated` when extra valid matches exist. Reject/trim per-line evidence so serialized result cannot exceed 64 KiB.

- [ ] **Step 6: Move snapshot execution/parsing behind the same backend**

Move `SNAPSHOT_COMMAND` and `parseSnapshot()` from `src/server.ts` into `src/repository-inspection.ts`. Preserve all existing Git hardening and default semantics; Browser-specific `maxFiles<=200` is enforced by the Browser schema/service, not by weakening the default/private surface.

Inside `createGateway`, instantiate `const inspection = new DevspaceRepositoryInspectionBackend(executor)` once and make the existing default/private `repoSnapshot()` delegate to `inspection.snapshot(binding(workspaceId).devspaceWorkspaceId, options)`. Do not change the default/private MCP tool list.

- [ ] **Step 7: Run focused tests GREEN**

Run:
```powershell
npm test -- --test-name-pattern="repo.search|repo.snapshot"
npm run typecheck
```
Expected: all focused tests PASS; no type errors.

- [ ] **Step 8: Commit Task 1**

```powershell
git add src/repository-inspection.ts src/server.ts test/repo-search.test.ts test/repo-snapshot.test.ts
git commit -m "feat: add bounded repository inspection backend"
```

### Task 2: Exact-Owned Search/Snapshot on Durable Admitted Workspaces

**Files:**
- Modify: `src/admitted-workspace.ts`
- Modify: `test/admitted-workspace.test.ts`
- Modify: `test/security.test.ts`

**Interfaces:**
- Consumes: `RepositoryInspectionBackend.search()` / `.snapshot()` from Task 1.
- Produces: `AdmittedWorkspaceService.search(caller, workspaceId, query, options)` and `.snapshot(caller, workspaceId, options)`.

- [ ] **Step 1: Write RED ownership tests**

Extend the admitted-workspace fixture with a fake inspection backend that records the resolved DevSpace workspace id/canonical root. Assert the owner can search/snapshot and a foreign session gets the same denial as an unknown id:

```ts
await assert.rejects(
  service.search(foreignCaller, ownedId, 'needle', {}),
  /Gateway denied workspace/,
);
await assert.rejects(
  service.search(ownerCaller, 'ws_missing', 'needle', {}),
  /Gateway denied workspace/,
);
```

Repeat the same pair for `snapshot` and assert neither denied request reaches the backend.

- [ ] **Step 2: Write RED restart-rebind tests**

Persist a workspace under v2 caller identity, create a fresh `AdmittedWorkspaceService` over the same store after dropping in-memory bindings, then call search and snapshot. Assert exactly one backend `openWorkspace(record.canonicalRoot)` rebind occurs and the same opaque workspace id remains owned by the same caller.

- [ ] **Step 3: Add inspection dependency and one authority resolver**

Change service options to:

```ts
inspection: RepositoryInspectionBackend;
executor: Pick<DevspaceExecutor, 'openWorkspace' | 'readFile'>;
```

Factor the existing ownership + `resolveBinding` sequence into a private method returning `{ record, binding }`. `read`, `search`, and `snapshot` all call that method so their unknown/foreign behavior cannot drift.- [ ] **Step 4: Implement exact-owned methods**

Use these signatures:

```ts
async search(
  caller: GatewayCallerContext,
  workspaceId: string,
  query: string,
  options: RepoSearchOptions = {},
): Promise<RepoSearchResult>

async snapshot(
  caller: GatewayCallerContext,
  workspaceId: string,
  options: RepoSnapshotOptions = {},
): Promise<RepoSnapshotResult>
```

`search` passes `{ devspaceWorkspaceId, canonicalRoot, query, ...resolvedOptions }` to the inspection backend. `snapshot` passes only the resolved DevSpace workspace id plus bounded options. Neither accepts absolute paths or backend identifiers from the caller.

- [ ] **Step 5: Add security regression for sensitive tracked content**

In `test/security.test.ts`, create tracked files including `.env.local` and a safe source file containing the same search needle. Search through the admitted service and assert only the safe path appears. Add a junction/symlink tracked path where the platform permits it and assert outside-workspace content is not returned.

- [ ] **Step 6: Run focused tests GREEN**

Run:
```powershell
npm test -- --test-name-pattern="admitted workspace|repo.search|repo.snapshot|sensitive"
npm run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/admitted-workspace.ts test/admitted-workspace.test.ts test/security.test.ts
git commit -m "feat: add owned repository inspection service"
```

### Task 3: Browser Inspect v2 Admission Identity and Five-Tool MCP Surface

**Files:**
- Modify: `src/adapter-admission.ts`
- Modify: `src/server.ts`
- Modify: `scripts/browser-adapter-runtime.ts`
- Modify: `test/adapter-admission.test.ts`
- Modify: `test/browser-admitted-mcp.test.ts`
- Modify: `test/adapter-admission-http.test.ts`

**Interfaces:**
- Produces: `BROWSER_INSPECT_ADAPTER_ID = 'browser.chatgpt.native.inspect.v2'`.
- Browser MCP context gains `workspaces.search` and `workspaces.snapshot`; exact tool inventory becomes five.- [ ] **Step 1: Write RED admission identity tests**

Replace implicit v1 identity assumptions with explicit v2 identity. Assert a session admitted under v2 persists `adapterId === BROWSER_INSPECT_ADAPTER_ID` and that a workspace record created under historical v1 identity fails exact authority checks under v2.

Use explicit constants:

```ts
export const BROWSER_ADAPTER_V1_ID = 'browser.chatgpt.native.v1' as const;
export const BROWSER_INSPECT_ADAPTER_ID = 'browser.chatgpt.native.inspect.v2' as const;
```

Make `BrowserAdmissionRegistry` require the adapter id at construction; production runtime passes v2 explicitly. This avoids a future silent default-profile change.

- [ ] **Step 2: Write RED exact five-tool MCP tests**

Expected list:

```ts
assert.deepEqual(tools.tools.map((tool) => tool.name), [
  'health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read',
]);
```

Call `repo.search` and `repo.snapshot` and assert the fixed `GatewayCallerContext` is supplied internally. Attempt `verify.run`, `mutation.preview`, `mutation.result`, `job.get`, and an arbitrary tool; all must reject as tool-not-found.

- [ ] **Step 3: Add strict Browser schemas**

Register:

```ts
'repo.search': z.object({
  workspace_id: z.string().min(1).max(256),
  query: z.string().min(1).refine(validSearchQuery),
  ignore_case: z.boolean().optional(),
  max_results: z.number().int().min(1).max(50).optional(),
  context_lines: z.number().int().min(0).max(2).optional(),
}).strict()
```

and `repo.snapshot` with `workspace_id` plus optional `max_files` 1..200. The query validator uses UTF-8 byte length <=256 and rejects NUL/CR/LF.

All five Browser tools set truthful read-only MCP annotations (`readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false` where supported). Tests must treat annotations as metadata only; authorization remains server-side.

- [ ] **Step 4: Wire Browser MCP handlers only to admitted service**

Handlers call:

```ts
context.workspaces.search(context.callerContext, workspace_id, query, {
  ignoreCase: ignore_case, maxResults: max_results, contextLines: context_lines,
});
context.workspaces.snapshot(context.callerContext, workspace_id, { maxFiles: max_files });
```

Do not call default `gateway.repoSnapshot()` from Browser composition because its workspace map is not durable Browser ownership.- [ ] **Step 5: Compose v2 identity in runtime**

Construct the registry with `BROWSER_INSPECT_ADAPTER_ID`; construct one `DevspaceRepositoryInspectionBackend(privateRuntime.executor)` and pass it into `AdmittedWorkspaceService`. Keep the default/private gateway surface unchanged.

- [ ] **Step 6: Run focused tests GREEN**

Run:
```powershell
npm test -- --test-name-pattern="adapter admission|browser-admitted MCP|repo.search|repo.snapshot"
npm run typecheck
```
Expected: PASS, exact Browser count 5, default/private count unchanged.

- [ ] **Step 7: Commit Task 3**

```powershell
git add src/adapter-admission.ts src/server.ts scripts/browser-adapter-runtime.ts test/adapter-admission.test.ts test/browser-admitted-mcp.test.ts test/adapter-admission-http.test.ts
git commit -m "feat: define Browser Inspect v2 MCP profile"
```

### Task 4: Protocol v2, Versioned Discovery, Local Link, and Native Host

**Files:**
- Modify: `src/browser-adapter/protocol.ts`
- Modify: `src/browser-adapter/local-link.ts`
- Modify: `src/browser-adapter/native-host.ts`
- Modify: `scripts/browser-adapter-runtime.ts`
- Modify: `test/browser-adapter-protocol.test.ts`
- Modify: `test/local-adapter-link.test.ts`
- Modify: `test/native-host.test.ts`
- Modify: `test/browser-adapter-runtime.test.ts`

**Interfaces:**
- `BROWSER_ADAPTER_PROTOCOL_VERSION = 2`.
- `AdapterDiscovery = { admissionUrl, bootstrapToken, protocolVersion: 2, adapterId: 'browser.chatgpt.native.inspect.v2' }`.
- `hello` result is `{ protocolVersion: 2, adapterId: 'browser.chatgpt.native.inspect.v2' }`.

- [ ] **Step 1: Write RED protocol-v2 tool-call tests**

Accept strict `repo.search` and `repo.snapshot` envelopes and reject version 1, extra keys, oversized queries, newline/control queries, out-of-range numeric bounds, and all consequential tools. Update all lifecycle fixtures to `version: 2`.

- [ ] **Step 2: Write RED discovery/profile mismatch tests**

`parseAdapterDiscovery()` and `loadAdapterDiscovery()` must reject records missing either v2 field, using wrong version/id, or carrying extra keys. Add explicit tests for old v1 two-field discovery failing under v2.- [ ] **Step 3: Implement strict v2 request schemas**

Change `BrowserToolName` to the exact union:

```ts
export type BrowserToolName =
  | 'health'
  | 'workspace.open'
  | 'repo.search'
  | 'repo.snapshot'
  | 'file.read';
```

Add the two strict call schemas using the same numeric/query bounds as Browser MCP. Keep the response envelope unchanged except `version: 2`.

- [ ] **Step 4: Make local tool discovery exact, not subset-based**

Replace the current `every(required)` check with ordered/set equality:

```ts
const actual = result.tools.map((tool) => tool.name).sort();
const expected = [...BROWSER_INSPECT_TOOLS].sort();
if (!deepEqual(actual, expected)) throw new Error('browser tool profile mismatch');
```

Return the canonical five-tool order after equality succeeds. An extra server tool is a connection/profile failure, not ignored authority.

- [ ] **Step 5: Emit and validate versioned discovery**

Runtime writes exactly:

```ts
{
  admissionUrl: http.admissionUrl,
  bootstrapToken,
  protocolVersion: 2,
  adapterId: BROWSER_INSPECT_ADAPTER_ID,
}
```

`parseAdapterDiscovery()` verifies exact keys, loopback admission URL, token length, exact protocol, exact adapter id. No state path, root, MCP URL, owner/session, or bearer is written.

- [ ] **Step 6: Bind native-host hello to profile identity**

`hello` returns:

```ts
{ protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: BROWSER_INSPECT_ADAPTER_ID }
```

The native host loads only a matching v2 discovery record before processing frames. Preserve duplicate-request, single-bound-session, origin, admission-failure redaction, and close semantics.

- [ ] **Step 7: Run focused tests GREEN**

Run:
```powershell
npm test -- --test-name-pattern="browser adapter protocol|local adapter|native host|browser runtime"
npm run typecheck
```
Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```powershell
git add src/browser-adapter/protocol.ts src/browser-adapter/local-link.ts src/browser-adapter/native-host.ts scripts/browser-adapter-runtime.ts test/browser-adapter-protocol.test.ts test/local-adapter-link.test.ts test/native-host.test.ts test/browser-adapter-runtime.test.ts
git commit -m "feat: version Browser Inspect native protocol"
```

### Task 5: ChatGPT Extension Parsing and Verified Native Session Handshake

**Files:**
- Create: `browser/extension/native-session-core.js`
- Modify: `browser/extension/chatgpt-call-parser.js`
- Modify: `browser/extension/service-worker-core.js`
- Modify: `browser/extension/service-worker.js`
- Modify: `test/chatgpt-provider.test.ts`
- Modify: `test/browser-extension-core.test.ts`
- Modify: `test/browser-extension-session.test.ts`

**Interfaces:**
- Parser produces only the exact five Browser-v2 tool calls.
- `createNativeSessionController()` verifies hello identity, bound session, and exact tool inventory before the service worker sends a tool call.
- Core gains a side-panel-only read/peek of a queued request so failed handshakes do not consume it.

- [ ] **Step 1: Write RED parser tests for the two new tools**

Accept canonical blocks such as:

```json
{"tool":"repo.search","arguments":{"workspace_id":"ws_123","query":"canonicalizeTicketId","max_results":20,"context_lines":1}}
```

and:

```json
{"tool":"repo.snapshot","arguments":{"workspace_id":"ws_123","max_files":100}}
```

Reject unknown/extra authority keys, query >256 UTF-8 bytes, NUL/CR/LF, invalid booleans/numbers, and values outside the Browser schema ranges.

- [ ] **Step 2: Implement parser strictness without generic passthrough**

Add explicit branches for `repo.search` and `repo.snapshot`. Introduce a helper that allows only declared optional keys while requiring the declared required keys; do not accept arbitrary `arguments` and defer validation downstream.

Use `TextEncoder` byte length for the query limit. Return snake-case argument names exactly as the Browser wire/MCP schemas expect.

- [ ] **Step 3: Write RED queue-preservation test**

Add `core.peekForExecution(requestId, 'sidepanel')`. Assert it returns the queued request without moving it to `inflight`; a non-sidepanel actor gets `undefined`. Only existing `takeForExecution` may perform the queued -> inflight transition.- [ ] **Step 4: Write RED native-session-controller tests**

Use a fake Chrome Native Messaging port. Before `ensureReady(sessionId)` resolves, assert the controller sends, in order:

```text
hello(version=2)
session.bind(version=2, exact session/provider/origin)
tools.list(version=2, exact session)
```

Feed responses and require:

```ts
hello.result.protocolVersion === 2
hello.result.adapterId === 'browser.chatgpt.native.inspect.v2'
tools.result.tools === ['health','workspace.open','repo.search','repo.snapshot','file.read']
```

Test wrong protocol, wrong adapter id, missing/extra/reordered-duplicate tool names, error responses, disconnect during handshake, and session switch requiring unbind -> bind -> tools.list. All must reject without treating the session as ready.

- [ ] **Step 5: Implement `createNativeSessionController()`**

Use a pure module around an injected `connectNative()` and UUID source. Maintain one port, one verified-hello flag, one bound session, and a map of pending control request resolvers. `onMessage()` resolves control requests by request id; non-control responses are passed to an injected `onToolResponse` callback.

Conceptual API:

```js
const native = createNativeSessionController({
  connectNative: () => chrome.runtime.connectNative('com.openai.web_agent_gateway'),
  randomUUID: () => crypto.randomUUID(),
  onToolResponse: (response) => deliverToolResponse(response),
});
await native.ensureReady(sessionId);
native.postTool(request);
```

On disconnect, reject every pending control promise, clear hello/bound state, and require a full new handshake next time.

- [ ] **Step 6: Make `panel.execute` handshake before consuming the queue**

Service-worker flow becomes:

```js
const pending = core.peekForExecution(requestId, 'sidepanel');
if (!pending) return sendResponse({ accepted: false });
void native.ensureReady(pending.sessionId).then(() => {
  const request = core.takeForExecution(requestId, 'sidepanel');
  if (!request) return sendResponse({ accepted: false });
  native.postTool(request);
  sendResponse({ accepted: true });
}).catch(() => sendResponse({ accepted: false }));
return true;
```

Thus a handshake/profile failure leaves the provider request queued rather than creating a silent inflight orphan.

- [ ] **Step 7: Update service-worker request version and allowlist**

Every provider-generated request uses `version: 2`. `service-worker-core.js` allows exactly the five v2 tools. Preserve trusted ChatGPT-origin checking, request-id dedupe, tab correlation, side-panel-only execution, and result-to-originating-tab correlation.

- [ ] **Step 8: Run focused tests GREEN**

Run:
```powershell
npm test -- --test-name-pattern="chatgpt parser|extension core|session correlation|native session"
npm run typecheck
```
Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```powershell
git add browser/extension/native-session-core.js browser/extension/chatgpt-call-parser.js browser/extension/service-worker-core.js browser/extension/service-worker.js test/chatgpt-provider.test.ts test/browser-extension-core.test.ts test/browser-extension-session.test.ts
git commit -m "feat: verify Browser Inspect extension profile"
```

### Task 6: Runtime, Native-Host, and Local Acceptance Coverage

**Files:**
- Modify: `test/browser-adapter-runtime.test.ts`
- Modify: `test/browser-adapter.acceptance.test.ts`
- Modify: `test/native-host-artifact.test.ts`
- Modify: `test/native-host-distribution.test.ts`
- Modify: `test/native-host-distribution-cli.test.ts`
- Modify: `test/native-host-installation-verifier.test.ts` only if profile/version identity is part of the verified artifact contract

**Interfaces:**
- Consumes the complete five-tool Browser Inspect v2 path from Tasks 1-5.
- Produces local evidence that runtime restart, native-host reconnect, exact profile discovery, R1 search, and R2 snapshot work without mutation.

- [ ] **Step 1: Upgrade runtime restart fixture to v2 discovery**

Assert discovery contains exactly:

```ts
{
  admissionUrl: /^http:\/\/127\.0\.0\.1:\d+\/adapter\/admit$/,
  bootstrapToken: <>=32-byte secret,
  protocolVersion: 2,
  adapterId: 'browser.chatgpt.native.inspect.v2',
}
```

Assert it contains no state path, workspace root, MCP URL, owner/session, or bearer. All link calls use protocol v2.

- [ ] **Step 2: Prove search/snapshot ownership across restart**

In the runtime test, create a small committed repo with `src/lib/ticket-id.js`, `test/ticket-id.test.js`, and one dirty tracked file. Through caller A, open a workspace, run `repo.search`, and run `repo.snapshot`. Caller B must fail on A's workspace for both tools.

Close runtime A, restart from the same SQLite state, re-admit correlation A, and repeat search/snapshot on the same opaque workspace id. Assert the results remain correct and the stale pre-restart bearer returns HTTP 401.

- [ ] **Step 3: Upgrade native-host acceptance to the five-tool workflow**

The first native-host process performs `hello -> bind -> tools.list -> health -> workspace.open -> repo.search -> repo.snapshot`. Assert exact tool list and R1/R2 evidence. Close it.

The second native-host process performs a fresh `hello -> bind -> tools.list -> file.read` using the same workspace id to prove reconnect. A third session attempts search/snapshot/read with that id and receives bounded errors.

- [ ] **Step 4: Add zero-mutation residue check**

After every local acceptance flow run:

```ts
const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, 'status', '--porcelain']);
assert.equal(stdout, expectedPreexistingDirtyState);
```

Search/snapshot/read must not add files, alter index/config, or change the task-owned dirty marker.- [ ] **Step 5: Update native-host artifact/distribution fixtures for versioned discovery**

Where tests construct `browser-adapter.json`, write the exact four-field v2 record. Preserve stable extension id, manifest origin constraints, single-file executable checks, checksum/receipt checks, and no floating CI action tags.

Do not change install root or auto-register a newly built artifact as part of unit/integration tests.

- [ ] **Step 6: Run the local acceptance slice**

Run:
```powershell
npm test -- --test-name-pattern="browser runtime|browser adapter local path|native host|distribution"
npm run build:native-host
npm run typecheck
```
Expected: all tests PASS and native-host build completes.

- [ ] **Step 7: Commit Task 6**

```powershell
git add test/browser-adapter-runtime.test.ts test/browser-adapter.acceptance.test.ts test/native-host-artifact.test.ts test/native-host-distribution.test.ts test/native-host-distribution-cli.test.ts test/native-host-installation-verifier.test.ts
git commit -m "test: accept Browser Inspect v2 local path"
```

### Task 7: Full Regression, Security Review, and Implementation Receipt

**Files:**
- Create: `docs/benchmarks/2026-09-17-browser-inspect-v2-local-gate.md`
- Modify: `README.md` only if its current Browser tool inventory is normative/user-facing and now stale
- Modify: `AGENTS.md` only if an existing exact-surface rule must be updated from historical v1 to active v2 while preserving the v1 receipt history

**Interfaces:**
- Produces a local implementation gate receipt; does not claim supported-host or Tier-R acceptance.

- [ ] **Step 1: Run the entire repository verification suite**

Run using the implementation worktree's dependencies:
```powershell
npm test
npm run typecheck
npm run build
npm run build:native-host
git diff --check
```
Expected: every command exits 0. Retain failures and fix only causes within this milestone; do not weaken tests or tool bounds to obtain GREEN.

- [ ] **Step 2: Re-run security-specific tests explicitly**

Run:
```powershell
npm test -- --test-name-pattern="security|sensitive|workspace|repo.search|repo.snapshot|adapter admission|protocol"
```
Confirm zero search command-injection marker, zero foreign-workspace exposure, exact five-tool profile, v1/v2 mismatch fail-closed, and no consequential tool discoverability.

- [ ] **Step 3: Inspect final diff for authority drift**

Use `git diff --stat`, `git diff --check`, and focused review of every changed production file. Reject any accidental addition of model-supplied commands, generic executor forwarding, mutation/verify projection, provider policy in core, or new dependency.- [ ] **Step 4: Write the local gate receipt**

Record exact implementation HEAD, Node/npm versions, dependency lock state, DevSpace pin/identity, Browser v2 adapter id/protocol/tool list, focused/full test commands and outcomes, native-host local artifact hash, security negative-test outcomes, and explicit non-claims:

```text
BROWSER_INSPECT_V2_LOCAL_GATE = PASS|FAIL
SUPPORTED_BROWSER_HOST_V2 = NOT_RUN
TIER_R = NOT_PROMOTED
CONSEQUENTIAL_BROWSER_AUTHORITY = STILL_BLOCKED
```

Do not copy secrets, discovery bootstrap tokens, OAuth owner tokens, browser cookies, or account identifiers into the receipt.

- [ ] **Step 5: Update only stale normative docs**

If README/AGENTS currently say the *active production* Browser profile is permanently three tools, update them to distinguish historical Browser Adapter v1 from candidate Browser Inspect v2. Keep ADR-0017/0018 history intact; do not rewrite old benchmark receipts.

- [ ] **Step 6: Commit Task 7**

```powershell
git add docs/benchmarks/2026-09-17-browser-inspect-v2-local-gate.md README.md AGENTS.md
git commit -m "docs: record Browser Inspect v2 local gate"
```

Only add README/AGENTS to the command when actually changed.

### Task 8: Publication, Explicit Promotion Gate, and Real WebChat Tier-R Acceptance

**Files:**
- Update/create acceptance receipt under `docs/benchmarks/` after evidence exists.
- No production code change is expected in this task unless acceptance reveals a real defect; any defect returns to the relevant earlier TDD task.

**Authority gate:**
- CI publication may run from the implementation branch/PR according to the existing workflow.
- **STOP before install/register/re-accept:** do not replace the currently accepted native host or browser profile until the user explicitly authorizes promotion of the exact candidate source SHA/artifact hashes.

- [ ] **Step 1: Push branch and obtain CI artifact evidence**

Push the implementation branch, wait for required checks, and record candidate source SHA, workflow run, artifact id, executable SHA-256, manifest SHA-256, extension id, and build receipt. Do not describe the candidate as accepted yet.

- [ ] **Step 2: Request exact candidate promotion authorization**

Present the candidate SHA/hashes and local-gate result. Continue only after explicit user authorization to install/register that candidate. If authorization is absent, stop with `CANDIDATE_READY_FOR_PROMOTION`.- [ ] **Step 3: Install/register only the authorized candidate and verify receipt**

Use the existing native-host installation/verifier workflow with the exact authorized artifact. Require verifier MATCH for executable/manifest/source/extension identity. Preserve the previous accepted install for rollback according to existing installation semantics; do not delete historical receipts.

Record:
```text
source SHA
workflow run/artifact
exe SHA256
manifest SHA256
extension id
adapter id = browser.chatgpt.native.inspect.v2
protocol = 2
install root
install receipt
verifier = MATCH
```

- [ ] **Step 4: Perform supported-host v2 smoke acceptance**

Before any Playwright browser command, fresh-read `E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md` using Remote Desktop Commander. The first Playwright command must be exactly:

```powershell
playwright-cli list --all --json
```

Use a uniquely owned profile/session and never touch unrelated workers. Through real ChatGPT Web, require a rendered v2 WAG call, extension queue, verified native handshake, exact five-tool discovery, `workspace.open`, `repo.search`, `repo.snapshot`, `file.read`, reconnect, and same-workspace read/inspect. No direct MCP/native shortcut may substitute.

- [ ] **Step 5: Run formal Layer-B Attempt 2 with five paired repetitions**

Follow the canonical benchmark design: fresh chats + fresh fixture copies, five paired repetitions by default, alternating order (`WAG/DC`, then `DC/WAG`). Retain every failure/contamination/environment interruption.

For WAG use the unchanged canonical prompts with the path label set exactly to `WAG`:

```text
R0: bounded sentinel read
R1: locate canonicalizeTicketId implementation + outer-whitespace test
R2: report branch/full HEAD/changed tracked files/bounded diff/status
```

Do not hint tool syntax after a run begins. A missing/incorrect capability is classified, not rescued with DC or direct local calls.

- [ ] **Step 6: Run/retain Tier-R security companion evidence**

Use the canonical S1 untrusted-repository-content prompt on a fresh fixture and prove WAG reports the outside-access request without disclosing outside-canary content. Cross-session/resource ownership negatives remain part of local/native acceptance evidence; any leak is `SECURITY_FAILURE` and blocks promotion.

- [ ] **Step 7: Compute the Tier-R decision from raw evidence**

Promote Tier R only when R0, R1, R2 complete through WAG with no DC in-path, no security failure, correct residue, and benchmark failure accounting retained. Record completion counts, elapsed/round-trip data available from each run, retries/failed calls, relay/click count, and whether workflow economics are materially worse/equal/better than the DC baseline.

Do not claim Tier V/C/D. Those remain blocked pending the separately reviewed consequential Browser admission/isolation gate.

- [ ] **Step 8: Commit the acceptance receipt separately**

```powershell
git add docs/benchmarks/2026-09-17-browser-inspect-v2-supported-host-and-tier-r.md
git commit -m "bench: accept Browser Inspect v2 Tier R"
```

Use a non-PASS commit message if the gate does not pass; never relabel retained failures to obtain a clean result.