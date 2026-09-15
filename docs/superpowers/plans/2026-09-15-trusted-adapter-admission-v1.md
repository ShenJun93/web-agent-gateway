# Trusted Adapter Admission v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Browser Adapter v1 a WAG-owned production caller context, server-side read-only capability profile, and exact-owner durable workspace semantics without widening consequential authority.

**Architecture:** Keep MCP HTTP stateless. A bootstrap-only local admission endpoint maps trusted browser correlation to a persisted WAG session, issues one memory-only session bearer, and resolves that bearer to immutable `GatewayCallerContext` before constructing an exact three-tool browser MCP surface. Browser workspace open/read uses the durable store and exact caller fencing; default/Business five-tool behavior remains unchanged.

**Tech Stack:** Node.js 22+, TypeScript 6, `node:sqlite`, `node:crypto`, MCP TypeScript SDK 1.29.0, Zod 4, Chromium MV3 Native Messaging.

**Spec:** `docs/superpowers/specs/2026-09-15-trusted-adapter-admission-v1-design.md`

## Global Constraints

- Design authority is ADR-0014 through ADR-0017 and exact design commit `6d1a9c993d1f0a2124d126354f6cb75c836a6614`.
- Keep `@modelcontextprotocol/sdk` pinned to exactly `1.29.0`; no dependency or lockfile changes.
- Browser admitted MCP exposes exactly `health`, `workspace.open`, `file.read`.
- Browser protocol `sessionId`, tab ids, MCP ids, provider metadata, bearer tokens, and backend handles never become WAG authority.
- Browser adapter id is fixed by trusted runtime composition as `browser.chatgpt.native.v1`.
- Bootstrap and admitted session credentials are separate classes and at least 256 bits each.
- Session bearer/digest state is memory-only and dies on WAG restart.
- Bootstrap discovery on Windows is same-user local trust only and cannot authorize consequential capabilities.
- HTTP listener remains `127.0.0.1` only for Browser Adapter v1 admission.
- Exact runtime `Host` is required; every request carrying `Origin` returns 403 before semantic dispatch.
- Browser correlation is persisted only as a domain-separated SHA-256 digest; raw correlation is not persisted.
- `workspace.open`/`file.read` exact caller ownership is mandatory on admitted browser path; unknown/wrong-owner ids use `Gateway denied workspace`.
- Durable workspace reopen after restart must revalidate current root/backend/policy and never rewrite ownership or canonical root.
- Default MCP and Business stdio remain five tools; durable verify/mutation/process/PTY/Git/browser mutation remain unauthorized.
- No production change may touch operator approval, durable mutation state transitions, durable verify state transitions, native-host distribution identity, or package dependencies.
- TDD is mandatory: every production behavior begins with a focused failing test and each task ends with a focused green gate plus a commit.

## File Structure

- `src/adapter-admission.ts`: WAG principal/session admission, correlation digesting, memory-only bearer issuance/rotation/release.
- `src/admitted-workspace.ts`: caller-fenced durable browser workspace open/read and backend reopen cache.
- `src/durable-store.ts`: additive principal/session persistence only; existing tables/semantics stay intact.
- `src/server.ts`: exact browser-readonly MCP factory; existing default MCP factory remains behaviorally compatible.
- `src/http-server.ts`: raw Host/Origin checks, credential-class routing, strict admission/release endpoints, admitted MCP request composition.
- `src/browser-adapter/local-link.ts`: bootstrap discovery validation, admission request, admitted MCP client creation, exact release.
- `src/browser-adapter/native-host.ts`: bind-time admission and bound-link lifecycle.
- `browser/extension/service-worker.js`: `chrome.storage.session` correlation lifecycle keyed by tab id.
- `scripts/browser-adapter-runtime.ts`: trusted absolute `statePath`, durable store/admission composition, bootstrap-only discovery record.

---

### Task 1: Persist WAG Principal and Adapter Sessions

**Files:**
- Modify: `src/durable-store.ts`
- Create: `test/adapter-admission-store.test.ts`
**Interfaces:**
- Produces `LocalPrincipalRecord { ownerId: string; createdAt: number }`.
- Produces `AdapterSessionRecord { sessionId: string; ownerId: string; adapterId: string; correlationSha256: string; createdAt: number }`.
- Produces `getOrCreateLocalPrincipal(now: number): LocalPrincipalRecord`.
- Produces `getOrCreateAdapterSession(input: { ownerId: string; adapterId: string; correlationSha256: string; createdAt: number }): AdapterSessionRecord`.
- Produces test-only reads `getAdapterSession(sessionId)` and `findAdapterSession(ownerId, adapterId, correlationSha256)`.

- [ ] **Step 1: Write failing additive-store tests**

```ts
const first = store.getOrCreateLocalPrincipal(1000);
const second = store.getOrCreateLocalPrincipal(2000);
assert.equal(second.ownerId, first.ownerId);
assert.equal(second.createdAt, 1000);
assert.match(first.ownerId, /^owner_[0-9a-f-]{36}$/);

const a = store.getOrCreateAdapterSession({
  ownerId: first.ownerId, adapterId: 'browser.chatgpt.native.v1',
  correlationSha256: 'a'.repeat(64), createdAt: 1000,
});
const again = store.getOrCreateAdapterSession({
  ownerId: first.ownerId, adapterId: 'browser.chatgpt.native.v1',
  correlationSha256: 'a'.repeat(64), createdAt: 2000,
});
assert.equal(again.sessionId, a.sessionId);
```

- [ ] **Step 2: Run RED gate**

Run: `npx tsx --test --test-concurrency=1 test/adapter-admission-store.test.ts`
Expected: FAIL because the new records/store methods/tables do not exist.
- [ ] **Step 3: Implement additive SQLite schema and atomic get-or-create**

```ts
CREATE TABLE IF NOT EXISTS gateway_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adapter_sessions (
  session_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  correlation_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, adapter_id, correlation_sha256)
);
```

Use `BEGIN IMMEDIATE` for both get-or-create paths so concurrent callers cannot mint duplicate principal/session rows. Generate ids with `randomUUID()` and preserve the first row's `createdAt`.

- [ ] **Step 4: Add persistence/reopen and data-minimization assertions**

Reopen the same SQLite file and prove the same principal/session rows remain. Query `sqlite_master`/table rows in the test and assert no column/value contains raw correlation text, bearer material, tab ids, provider conversation ids, MCP ids, or backend handles.

- [ ] **Step 5: Run GREEN gate**

Run: `npx tsx --test --test-concurrency=1 test/adapter-admission-store.test.ts test/durable-store.test.ts test/durable-verify-store.test.ts`
Expected: all pass; existing workspace/mutation/verify persistence semantics unchanged.

- [ ] **Step 6: Commit**

```powershell
git add src/durable-store.ts test/adapter-admission-store.test.ts
git commit -m "feat: persist adapter admission identity"
```

### Task 2: Implement Admission Registry and Ephemeral Bearer Lifecycle

**Files:**
- Create: `src/adapter-admission.ts`
- Create: `test/adapter-admission.test.ts`
**Interfaces:**
- Consumes `SqliteDurableStore` Task 1 methods and `createGatewayCallerContext(...)`.
- Produces `BROWSER_ADAPTER_ID = 'browser.chatgpt.native.v1'`.
- Produces `BrowserAdmissionRegistry` with:

```ts
interface AdmitBrowserSessionResult {
  mcpToken: string;
  callerContext: GatewayCallerContext;
}
class BrowserAdmissionRegistry {
  admit(rawCorrelation: string): AdmitBrowserSessionResult;
  resolveMcpToken(rawToken: string): GatewayCallerContext | undefined;
  releaseMcpToken(rawToken: string): boolean;
  close(): void;
}
```

- [ ] **Step 1: Write failing digest/session/credential tests**

```ts
const first = registry.admit('session_corr_A');
const rotated = registry.admit('session_corr_A');
assert.equal(first.callerContext.sessionId, rotated.callerContext.sessionId);
assert.notEqual(first.mcpToken, rotated.mcpToken);
assert.equal(registry.resolveMcpToken(first.mcpToken), undefined);
assert.equal(registry.resolveMcpToken(rotated.mcpToken)?.sessionId,
  first.callerContext.sessionId);
assert.notEqual(registry.admit('session_corr_B').callerContext.sessionId,
  first.callerContext.sessionId);
```

Also assert raw correlation is rejected outside 8-128 ASCII-safe characters, tokens decode to at least 32 random bytes, and `close()` invalidates every in-memory token without modifying persisted adapter sessions.

- [ ] **Step 2: Run RED gate**

Run: `npx tsx --test --test-concurrency=1 test/adapter-admission.test.ts`
Expected: FAIL because `BrowserAdmissionRegistry` does not exist.

- [ ] **Step 3: Implement domain-separated correlation digest**

```ts
function correlationSha256(ownerId: string, adapterId: string, raw: string): string {
  return createHash('sha256')
    .update('wag.adapter-correlation.v1\0', 'utf8')
    .update(ownerId, 'utf8').update('\0')
    .update(adapterId, 'utf8').update('\0')
    .update(raw, 'utf8')
    .digest('hex');
}
```
- [ ] **Step 4: Implement memory-only bearer digest map and rotation**

Generate `randomBytes(32).toString('base64url')`. Store only `sha256('wag.mcp-session-token.v1\0' + token)` in a `Map`, mapped to the frozen caller context. Track the active digest by WAG `sessionId`; admitting that session again deletes its previous digest before adding the new one.

`resolveMcpToken` and `releaseMcpToken` digest incoming raw tokens before lookup. They must not expose whether a different session/correlation exists.

- [ ] **Step 5: Prove no credential persistence/leak**

Read the SQLite bytes/rows after admission and assert neither raw token nor token digest occurs. Serialize returned caller-visible objects and ensure they do not contain correlation digest or store internals.

- [ ] **Step 6: Run GREEN gate**

Run: `npx tsx --test --test-concurrency=1 test/adapter-admission.test.ts test/adapter-admission-store.test.ts test/caller-context.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add src/adapter-admission.ts test/adapter-admission.test.ts
git commit -m "feat: add browser adapter admission registry"
```

### Task 3: Add Exact-Owner Durable Browser Workspace Seam

**Files:**
- Create: `src/admitted-workspace.ts`
- Create: `test/admitted-workspace.test.ts`
- Modify: `src/durable-store.ts` only if a narrow exact test/read helper is required.

**Interfaces:**
- Consumes `GatewayCallerContext`, `SqliteDurableStore`, `DevspaceExecutor`, `canonicalWorkspace`, `validateReadPath`, `assertReadTarget`.
- Produces:

```ts
class AdmittedWorkspaceService {
  open(caller: GatewayCallerContext, path: string): Promise<{ workspaceId: string }>;
  read(caller: GatewayCallerContext, workspaceId: string, path: string): Promise<{ content: string }>;
}
```

- [ ] **Step 1: Write failing ownership and restart tests**

Create two caller contexts. Assert same root opened by each gets different `workspaceId`; caller B reading caller A's id rejects with `Gateway denied workspace`; unknown id returns the same error. Independently vary owner/session/adapter and assert all fail before `executor.readFile`.

Close/recreate the service with the same SQLite store and empty runtime cache, then assert caller A can read its original id only after backend reopen.

- [ ] **Step 2: Run RED gate**

Run: `npx tsx --test --test-concurrency=1 test/admitted-workspace.test.ts`
Expected: FAIL because the admitted workspace service does not exist.

- [ ] **Step 3: Implement caller-fenced open**

`open()` must canonicalize against trusted allowed roots, call `executor.openWorkspace(canonicalRoot)`, then persist `store.openWorkspaceRecord({ ...caller, canonicalRoot, backendKind: 'devspace', createdAt: now() })`. Cache `{ workspaceId -> { canonicalRoot, devspaceWorkspaceId } }` only after durable persistence succeeds.

- [ ] **Step 4: Implement caller-fenced read/reopen**

Load the durable workspace first. If missing or tuple mismatch, throw exactly `Gateway denied workspace`. If no cache entry, revalidate `canonicalWorkspace(record.canonicalRoot, allowedRoots)` and require exact equality with stored root and `backendKind === 'devspace'` before reopening via DevSpace.
After backend binding resolution, perform the existing relative-path normalization, sensitive-path policy, resolved-containment check, bounded read, CRLF normalization, NUL rejection, and 64 KiB UTF-8 output bound. Never rewrite the durable workspace row during reopen.

- [ ] **Step 5: Add policy-drift negative tests**

After persisting a workspace, recreate the service with an allowed-root set that excludes the stored root and assert no backend read occurs. Add unsupported backend and canonical-root mismatch fixtures and assert both fail before content access while the stored row remains byte-for-byte unchanged.

- [ ] **Step 6: Run GREEN gate**

Run: `npx tsx --test --test-concurrency=1 test/admitted-workspace.test.ts test/workspace.test.ts test/file-read.test.ts test/security.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add src/admitted-workspace.ts src/durable-store.ts test/admitted-workspace.test.ts
git commit -m "feat: fence admitted browser workspaces"
```

### Task 4: Create Exact Browser-Readonly MCP Surface

**Files:**
- Modify: `src/server.ts`
- Modify: `test/mcp-surface.test.ts`
- Create: `test/browser-admitted-mcp.test.ts`

**Interfaces:**
- Consumes `GatewayApi.health()` and `AdmittedWorkspaceService`.
- Produces:

```ts
interface BrowserAdmittedMcpContext {
  callerContext: GatewayCallerContext;
  workspaces: Pick<AdmittedWorkspaceService, 'open' | 'read'>;
}
export function createBrowserAdmittedMcpServer(
  gateway: Pick<GatewayApi, 'health'>,
  context: BrowserAdmittedMcpContext,
): McpServer;
```
- [ ] **Step 1: Write failing exact-surface tests**

Connect an MCP client to the new factory and assert tool names are exactly:

```ts
['health', 'workspace.open', 'file.read']
```

Call `workspace.open` and `file.read` through fake admitted workspace methods and prove the fixed caller context is supplied internally. Attempt `repo.snapshot` and `verify.run`; assert MCP reports unknown/unavailable tool rather than routing to the default gateway.

- [ ] **Step 2: Run RED gate**

Run: `npx tsx --test --test-concurrency=1 test/browser-admitted-mcp.test.ts test/mcp-surface.test.ts`
Expected: FAIL because the browser-admitted factory does not exist.

- [ ] **Step 3: Implement a separate three-tool factory**

Create a fresh `McpServer` that registers only `health`, `workspace.open`, and `file.read`. Reuse the exact existing input schemas/descriptions where compatible, but route workspace methods through `context.workspaces.open(context.callerContext, path)` and `.read(...)`.

Do not register Tasks capability, `verify.run`, repo snapshot, mutation/file.patch, or any generic forwarding seam on this factory.

- [ ] **Step 4: Add authority-schema regression**

Inspect returned tool schemas and assert none contain `owner_id`, `session_id`, `adapter_id`, camelCase equivalents, `correlation_id`, `bearer`, `adapter`, `provider`, or `tab` fields.

- [ ] **Step 5: Run GREEN gate**

Run: `npx tsx --test --test-concurrency=1 test/browser-admitted-mcp.test.ts test/mcp-surface.test.ts test/mcp-tasks.test.ts`
Expected: browser factory exactly three tools; default factory retains five-tool/task compatibility.

- [ ] **Step 6: Commit**

```powershell
git add src/server.ts test/browser-admitted-mcp.test.ts test/mcp-surface.test.ts
git commit -m "feat: add admitted browser mcp surface"
```

### Task 5: Harden HTTP and Add Credential-Class Admission Routes

**Files:**
- Modify: `src/http-server.ts`
- Modify: `test/http-transport.test.ts`
- Create: `test/adapter-admission-http.test.ts`
**Interfaces:**
- Keep existing `startGatewayHttpServer(...)` compatibility path intact for default tests.
- Add an opt-in browser-admission composition, conceptually:

```ts
interface BrowserAdmissionHttpContext {
  bootstrapToken: string;
  admission: BrowserAdmissionRegistry;
  browserMcp(caller: GatewayCallerContext): McpServer;
}
```

- Return `admissionUrl` and `mcpUrl` from the listener so discovery can contain the admission endpoint explicitly.

- [ ] **Step 1: Write failing Host/Origin/route credential tests**

Start a browser-admission HTTP server on port 0, capture its actual port, then assert:

```ts
await post('/adapter/admit', { host: exactHost, bootstrap: good }).status === 200;
await post('/adapter/admit', { host: 'localhost:' + port, bootstrap: good }).status === 403;
await post('/adapter/admit', { host: exactHost, origin: 'https://chatgpt.com', bootstrap: good }).status === 403;
await post('/mcp', { host: exactHost, bearer: bootstrapToken }).status === 401;
```

Also cover missing/malformed Host, any present Origin (including `null`), wrong method, wrong content type, body >4096 decoded bytes, malformed JSON, extra admission fields, missing/invalid correlation, and wrong/released session bearer.

- [ ] **Step 2: Run RED gate**

Run: `npx tsx --test --test-concurrency=1 test/adapter-admission-http.test.ts`
Expected: FAIL because routes/guards/browser credential composition do not exist.

- [ ] **Step 3: Implement raw-request Host/Origin guard**

After `listen()` resolves the actual port, require `req.headers.host === `127.0.0.1:${port}`` for the browser-admission server. Reject mismatch with 403 before auth/body processing. Reject every request with `req.headers.origin !== undefined` with 403.
- [ ] **Step 4: Implement strict `/adapter/admit`**

Require `POST`, `Content-Type: application/json`, exact bootstrap bearer, and at most 4096 decoded body bytes. Compare the supplied bootstrap token to the configured token with equal-length `Buffer`s plus `timingSafeEqual`; malformed or wrong-length bearer values fail before schema/body effects. Parse with a strict Zod object `{ correlation_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/) }`. On success call `admission.admit(correlation_id)` and return only:

```json
{ "mcp_url": "http://127.0.0.1:<port>/mcp", "bearer_token": "<fresh-token>" }
```

Do not return WAG owner/session/adapter ids or correlation digest.

- [ ] **Step 5: Implement admitted `/mcp` and `/adapter/release` routing**

For `/mcp`, reject bootstrap token; resolve session bearer through `BrowserAdmissionRegistry`, then construct the exact browser MCP server for that caller and run stateless `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`.

For `/adapter/release`, require `POST` and the current session bearer, call `releaseMcpToken(rawToken)`, and return bounded `{ released: true }`. An already stale/unknown token returns 401 and must not affect another session.

- [ ] **Step 6: Preserve generic/default HTTP compatibility**

Existing non-admission `startGatewayHttpServer({ gateway, bearerToken })` tests must retain current `/mcp` behavior. Do not reinterpret a default runtime bearer as a browser bootstrap credential.

- [ ] **Step 7: Run GREEN gate**

Run: `npx tsx --test --test-concurrency=1 test/adapter-admission-http.test.ts test/http-transport.test.ts test/browser-admitted-mcp.test.ts`
Expected: all pass; all denial bodies bounded and free of token/authority/root material.

- [ ] **Step 8: Commit**

```powershell
git add src/http-server.ts test/http-transport.test.ts test/adapter-admission-http.test.ts
git commit -m "feat: admit browser sessions over guarded http"
```

### Task 6: Move Native Host and Local Link to Bind-Time Admission

**Files:**
- Modify: `src/browser-adapter/local-link.ts`
- Modify: `src/browser-adapter/native-host.ts`
- Modify: `src/browser-adapter/native-host-main.ts`
- Modify: `test/local-adapter-link.test.ts`
- Modify: `test/native-host.test.ts`
**Interfaces:**
- Replace discovery shape with bootstrap-only:

```ts
interface AdapterDiscovery {
  admissionUrl: string;
  bootstrapToken: string;
}
```

- Add `McpLocalAdapterLink.admit(discovery, correlationId): Promise<McpLocalAdapterLink>`.
- `McpLocalAdapterLink.close()` closes the stateless MCP client first, then performs best-effort `/adapter/release` with the still-held admitted bearer and finally clears local token state.
- Native host owns `LocalAdapterLink | undefined` only after successful `session.bind`.

- [ ] **Step 1: Write failing discovery/admission tests**

Assert discovery rejects an `/mcp` URL, non-loopback/credentialed URL, short bootstrap token, and extra fields. Mock `/adapter/admit` returning an admitted MCP URL/token and assert only that token is attached to subsequent MCP requests.

- [ ] **Step 2: Write failing native bind lifecycle tests**

Start `runNativeHost` with a `linkFactory(correlationId)` test double. Assert `hello` does not create a link; `session.bind` creates exactly one link for that correlation; tool calls before successful bind fail; `session.unbind` closes/releases only the bound link; reconnect + same correlation calls factory again without changing browser protocol session id.

- [ ] **Step 3: Run RED gate**

Run: `npx tsx --test --test-concurrency=1 test/local-adapter-link.test.ts test/native-host.test.ts`
Expected: FAIL against pre-admission link construction.

- [ ] **Step 4: Implement admission-aware local link**

Use `fetch` to POST strict `{ correlation_id }` to `discovery.admissionUrl` with bootstrap bearer and no Origin. Validate returned `mcp_url` is exact loopback `/mcp` and returned bearer has at least 32 bytes before creating `StreamableHTTPClientTransport` with the admitted token.

Keep `BROWSER_TOOLS` exactly `health`, `workspace.open`, `file.read` and continue redacting underlying transport errors to `Local WAG request failed`.
- [ ] **Step 5: Refactor native host to create link on `session.bind`**

Change `runNativeHost` input from one preconnected `link` to a trusted `linkFactory(correlationId)`. On bind, await factory before recording `boundSession`. If admission fails, return a bounded browser-protocol error and keep the host unbound. On unbind/finally, close only the exact current link.

`native-host-main.ts` loads discovery once, validates the exact Chrome extension origin as today, and passes a factory that calls `McpLocalAdapterLink.admit(discovery, correlationId)`.

- [ ] **Step 6: Run GREEN gate**

Run: `npx tsx --test --test-concurrency=1 test/local-adapter-link.test.ts test/native-host.test.ts test/native-messaging-framing.test.ts`
Expected: all pass; no raw admission/MCP token appears in browser responses.

- [ ] **Step 7: Commit**

```powershell
git add src/browser-adapter/local-link.ts src/browser-adapter/native-host.ts src/browser-adapter/native-host-main.ts test/local-adapter-link.test.ts test/native-host.test.ts
git commit -m "feat: admit native host sessions on bind"
```

### Task 7: Persist Browser Correlation in `chrome.storage.session`

**Files:**
- Modify: `browser/extension/service-worker.js`
- Modify: `browser/extension/service-worker-core.js` only if lifecycle seams need deterministic testing.
- Modify: `test/browser-extension-core.test.ts`
- Create: `test/browser-extension-session.test.ts`

**Interfaces:**
- Extension-local storage key format: `wag.session.tab.<numeric-tab-id>`.
- Stored value: browser protocol correlation id `session_<uuid>` only.
- `tabs.onRemoved` removes only that tab's key.

- [ ] **Step 1: Write failing service-worker lifecycle tests**

With a fake `chrome.storage.session`, call the session resolver twice across simulated service-worker object recreation and assert the same live-tab correlation is reused. Simulate `tabs.onRemoved(tabId)` and assert only that key is removed. Start with empty session storage and assert a fresh correlation is minted.
Also assert content-script/provider messages cannot submit a correlation id or storage key; the service worker continues to derive correlation from trusted tab context only.

- [ ] **Step 2: Run RED gate**

Run: `npx tsx --test --test-concurrency=1 test/browser-extension-session.test.ts test/browser-extension-core.test.ts`
Expected: FAIL because correlation currently lives only in an in-memory `Map`.

- [ ] **Step 3: Implement async `chrome.storage.session` resolver**

Use the numeric tab id only to construct the extension-local lookup key. On miss generate `session_${crypto.randomUUID()}`, write that value to `chrome.storage.session`, and return it. Never send the tab id or storage key to WAG.

Adapt the `provider.observed_text` message branch to start the async resolver, call `sendResponse(...)` from that promise chain, and return `true` from the listener so Chrome keeps the response channel open. Do not return a Promise from the listener. Preserve current origin/tool/request validation and side-panel execution gate.

- [ ] **Step 4: Add exact tab-removal cleanup**

Register `chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(keyForTab(tabId)))`. Do not iterate/delete other entries and do not close native/WAG resources as a side effect of tab removal.

- [ ] **Step 5: Run GREEN gate**

Run: `npx tsx --test --test-concurrency=1 test/browser-extension-session.test.ts test/browser-extension-core.test.ts test/chatgpt-provider.test.ts test/chatgpt-content-observer.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add browser/extension/service-worker.js browser/extension/service-worker-core.js test/browser-extension-session.test.ts test/browser-extension-core.test.ts
git commit -m "feat: persist browser session correlation"
```

### Task 8: Compose Durable Browser Runtime and End-to-End Restart Isolation

**Files:**
- Modify: `scripts/browser-adapter-runtime.ts`
- Modify: `test/browser-adapter-runtime.test.ts`
- Modify: `test/browser-adapter.acceptance.test.ts`
- Modify: `test/native-host-artifact.test.ts` to replace direct `/mcp` discovery fixtures with bootstrap admission fixtures while preserving SEA framing and credential-redaction assertions.
**Interfaces:**
- Extend runtime options with trusted `statePath: string` and require it to be absolute.
- Runtime owns one `SqliteDurableStore`, one `BrowserAdmissionRegistry`, one `AdmittedWorkspaceService`, private gateway/executor, and browser-admission HTTP server.
- Discovery file contains only `{ admissionUrl, bootstrapToken }`.

- [ ] **Step 1: Write failing runtime composition tests**

Assert relative `statePath` is rejected before startup. Start runtime, inspect discovery, and assert it contains `admissionUrl` + `bootstrapToken` only: no `/mcp` credential, state path, WAG authority id, DevSpace token, or local root.

Admit two correlations, open the same root under both, and assert distinct workspace ids and cross-session reads fail.

- [ ] **Step 2: Write failing restart-continuity test**

Start runtime A with a file-backed `statePath`, admit correlation A, open/read a workspace, save its opaque id, then close runtime A. Start runtime B with the same `statePath` and same trusted config, re-admit correlation A, and assert the original workspace id reads successfully after backend reopen. Assert A's old session bearer is rejected by runtime B.

- [ ] **Step 3: Run RED gate**

Run: `npx tsx --test --test-concurrency=1 test/browser-adapter-runtime.test.ts test/browser-adapter.acceptance.test.ts`
Expected: FAIL because browser runtime has no durable state/admission composition.

- [ ] **Step 4: Implement trusted runtime composition**

Open `SqliteDurableStore(options.statePath)` before serving. Construct `BrowserAdmissionRegistry(store)`, `AdmittedWorkspaceService({ store, executor, allowedRoots })`, and browser-admission HTTP composition using fixed adapter id. Reconcile no mutation/verify work here; this milestone does not activate those capabilities.

Generate a fresh 32-byte bootstrap token each runtime start and write only bootstrap discovery. Ensure shutdown removes discovery, closes HTTP, drops admission bearer map, closes private runtime, then closes store exactly once.

- [ ] **Step 5: Update real native-host/browser acceptance fixtures**

Adapt Windows SEA/native-host tests to bind via admission. Preserve exact extension-origin, framing, reconnect, no-local-token-in-wire, no-root-in-response, and clean-repository assertions. Add same-correlation reconnect and second-correlation isolation evidence.
- [ ] **Step 6: Run GREEN runtime/acceptance gate**

Run: `npx tsx --test --test-concurrency=1 test/browser-adapter-runtime.test.ts test/browser-adapter.acceptance.test.ts test/native-host-artifact.test.ts test/native-host.test.ts test/local-adapter-link.test.ts`
Expected: all pass on the exact candidate; browser surface remains read-only.

- [ ] **Step 7: Commit**

```powershell
git add scripts/browser-adapter-runtime.ts test/browser-adapter-runtime.test.ts test/browser-adapter.acceptance.test.ts test/native-host-artifact.test.ts
git commit -m "feat: compose durable browser admission runtime"
```

### Task 9: Exact-Candidate Security Gate, Independent Review, and Acceptance Receipt

**Files:**
- Modify tests only if a final uncovered acceptance assertion is discovered before candidate freeze.
- Create: `docs/benchmarks/2026-09-15-trusted-adapter-admission-v1.md`

**Interfaces:**
- Consumes the exact implementation candidate SHA after Tasks 1-8.
- Produces the final acceptance label only after all evidence below is green.

- [ ] **Step 1: Freeze candidate and audit diff scope**

Record `CANDIDATE_SHA=$(git rev-parse HEAD)` and compare `6d1a9c9...$CANDIDATE_SHA`. Verify no changes to `package.json`, `package-lock.json`, durable mutation/verify state-machine semantics, operator approval, native-host distribution/installation identity, or Business stdio unless already explicitly reviewed as unavoidable.

Run: `git diff --check 6d1a9c9...HEAD`
Expected: exit 0.

- [ ] **Step 2: Run focused admission/security gate**

Run all new/affected tests in one command:

```powershell
npx tsx --test --test-concurrency=1 `
  test/adapter-admission-store.test.ts test/adapter-admission.test.ts `
  test/admitted-workspace.test.ts test/browser-admitted-mcp.test.ts `
  test/adapter-admission-http.test.ts test/local-adapter-link.test.ts `
  test/native-host.test.ts test/browser-extension-session.test.ts `
  test/browser-extension-core.test.ts test/browser-adapter-runtime.test.ts `
  test/browser-adapter.acceptance.test.ts test/native-host-artifact.test.ts
```
Expected: 0 failures/skips except platform-gated cases that were already accepted as Windows-only and are actually running on the Windows target for the final acceptance gate.
- [ ] **Step 3: Run full repository verification on the same SHA**

```powershell
npm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run test:business
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git diff --check 6d1a9c9...HEAD
```

Expected: full suite 0 failures, typecheck/build/Business exit 0, diff-check exit 0, and ending HEAD identical to frozen `CANDIDATE_SHA`.

- [ ] **Step 4: Run explicit authority/surface audit**

Search production/browser schemas for forbidden authority fields and broader browser tools. Verify:

```powershell
rg -n "owner_id|session_id|adapter_id|ownerId|adapterId|correlation_id|bearer" browser src/browser-adapter
rg -n "repo\.snapshot|verify\.run|mutation\.|job\.|process|pty|git\." src/browser-adapter browser/extension
```

Manually classify every hit. Accept only internal trusted composition/correlation/credential code required by the spec; no model-visible browser tool schema may gain those fields or tools.

- [ ] **Step 5: Run exact-diff independent review**

Give the reviewer only `6d1a9c9...$CANDIDATE_SHA`, ADR-0017, the design spec, and the acceptance checklist. Require explicit severity classification and ask specifically for authority-confusion, token-class substitution, Host/Origin bypass, cross-session workspace access, restart ownership drift, credential leakage, and accidental broader MCP surface.

Acceptance condition: zero Critical and zero Important findings. Minor findings may be retained only when they do not weaken a locked invariant and are recorded in the receipt.

- [ ] **Steps 6-7: Superseded by the 2026-09-16 Task 9 amendment below**

Do not create or commit a final PASS receipt at this point. Continue with Task 9A-9D below.

### Task 9 Amendment — Split Source Acceptance from Native-Host Reacceptance (2026-09-16)

This amendment supersedes original Task 9 Steps 3, 6, and 7 wherever they conflict. Research: `docs/research/2026-09-16-trusted-adapter-admission-native-host-refresh.md`.

Historical distribution and installation receipts remain PASS for their exact artifact. The admission candidate must not overwrite those identities with a local build hash.

#### Task 9A: Correct regression fixtures

Scope: update the installation-verifier test fixture only. Production acceptance constants and verifier behavior remain unchanged.

The previously observed full-suite failure is the RED evidence for this correction.

- Replace the current-source executable rebuild used by execution fixtures with deterministic synthetic executable bytes in a test-owned temporary directory.
- Create a test-owned temporary verifier copy that differs only in the expected executable hash for that synthetic fixture; require exactly one replacement.
- Keep static and AST checks pointed at the committed verifier, not the temporary copy.
- Add a static assertion that the committed verifier still pins the same historical source/hash as the production installation constants.
- Re-run `test/native-host-installation-verifier.test.ts`; all verifier behavior tests must pass without changing production acceptance identity.

#### Task 9B: Re-freeze and complete source acceptance

After the fixture correction commit, freeze a new source candidate SHA. Re-run the focused admission/security gate, full repository tests, typecheck, build, Business acceptance, and diff-check on that exact SHA.

Run the authority/surface audit and exact-diff independent review. Acceptance still requires zero Critical and zero Important findings.

Create `docs/benchmarks/2026-09-16-trusted-adapter-admission-v1-source.md` from observed evidence only. It must state that the candidate still requires native-host distribution/install/host reacceptance and must not use the final PASS label.

The source-phase receipt ends with `TRUSTED_ADAPTER_ADMISSION_V1 = IMPLEMENTED_AWAITING_NATIVE_HOST_REFRESH` and records the candidate distribution state as reacceptance-required.

#### Task 9C: Post-merge successor distribution checkpoint

This task starts only after explicit merge/push authority exists and the source-phase branch has been integrated to `main`.

- Observe the exact `main` merge SHA and its Native Host Distribution workflow run.
- Require the workflow to succeed and publish the exact source-SHA/run-attempt artifact under the existing immutable naming contract.
- Download and verify the artifact with the existing distribution verifier; record repository, source SHA, run id, attempt, executable hash, extension id, and application name from observed evidence.
- Do not accept a feature-branch/local build as a substitute.

#### Task 9D: Successor acceptance metadata and installed-host reacceptance

After the successor artifact identity exists, create a narrow follow-up change that pins only the observed successor distribution/install metadata and read-only verifier expectations. Prove that this follow-up does not change native-host bundle inputs or SEA packaging behavior.

After that metadata change is reviewed/integrated, prepare the successor per-user installation from the verified artifact. Registry switching remains a separately authorized operational action; repository automation must not perform it.

Re-run read-only installation verification and then supported-browser-host acceptance against the successor installed binary. Only after both gates pass may the final admission receipt end with `TRUSTED_ADAPTER_ADMISSION_V1 = PASS`.

Browser mutation remains unauthorized throughout this sequence.
