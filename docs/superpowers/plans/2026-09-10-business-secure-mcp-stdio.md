# Business Secure MCP Stdio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and locally prove a production-built stdio Web Agent Gateway that OpenAI Secure MCP Tunnel can launch for private ChatGPT Business use, without changing the five-tool safety surface.

**Architecture:** Add a strict non-secret private config, a refreshable DevSpace OAuth token source, a reusable stdio MCP runtime, and a small `serve-stdio`/`doctor` CLI. DevSpace stays separately supervised on loopback; Gateway owns no public listener, no durable job database, and no provider-session runtime beyond its in-memory DevSpace OAuth session.

**Tech Stack:** Node.js `>=22.19 <27`, TypeScript `6.0.3`, `@modelcontextprotocol/sdk` `1.29.0`, Zod `4.5.4`, exact-pinned DevSpace `33d6d0bcc2256024484d2456da924af8afd814ed`.

**Spec:** `docs/superpowers/specs/2026-09-10-business-secure-mcp-stdio-design.md`

## Global Constraints

- Preserve exactly five public tools: `health`, `workspace.open`, `repo.snapshot`, `file.read`, `verify.run`.
- Preserve current verify bounds, including the 30,000 ms maximum timeout; do not broaden raw shell, env, mutation, patch, or Git-write authority.
- DevSpace remains a separate exact-pinned localhost MCP process; Gateway does not import or supervise it.
- `serve-stdio` stdout is MCP framing only; operational diagnostics use stderr and contain no secrets, workspace content, or absolute workspace paths.
- `DEVSPACE_OAUTH_OWNER_TOKEN` is the only owner-token input; it is never accepted in JSON or CLI arguments and is removed from the inherited env after bootstrap.
- Access/refresh tokens and OAuth client state remain in process memory only; Gateway restart re-bootstraps.
- Reuse PFP production patterns only: strict config, exact-SHA evidence, explicit cleanup ownership, and fail-closed behavior. Do not import PFP runtime/DB/governance code.
- Keep current `npm test` and `npm run typecheck` semantics; add production build and Business-specific acceptance separately.

---
## File Structure

- Create `src/private-config.ts`: strict JSON config schema, loopback DevSpace URL validation, canonical allowed-root loading.
- Create `src/executor/devspace-oauth.ts`: in-memory PKCE/owner-token bootstrap, refresh rotation, single-flight refresh, token release.
- Modify `src/executor/devspace.ts`: consume a token source while preserving static-token compatibility and add one-time 401 refresh/retry.
- Create `src/task-store.ts`: shared non-cancelling MCP task store used by HTTP and stdio transports.
- Modify `src/http-server.ts`: import the shared task store; behavior otherwise unchanged.
- Create `src/private-runtime.ts`: compose config + OAuth + executor + gateway + health preflight; own only resources it creates.
- Create `src/stdio-server.ts`: connect `createGatewayMcpServer()` to official `StdioServerTransport` with shared task store.
- Create `src/cli.ts`: parse `serve-stdio` and `doctor`, emit sanitized diagnostics, own signal/EOF shutdown.
- Create `tsconfig.build.json`: emit only `src/**` to `dist/`.
- Modify `package.json`: add `build` and `test:business` scripts.
- Create focused tests under `test/` for config, token source/OAuth, stdio runtime, CLI/build, and exact-pinned integration.
- Modify `test/devspace-fixture.ts` only where needed to parameterize OAuth TTL and expose deterministic test-only owner-token setup.
- Add `docs/benchmarks/2026-09-10-business-stdio-preupgrade.md` only after exact candidate verification.

### Task 1: Strict Private Configuration

**Files:**
- Create: `src/private-config.ts`
- Test: `test/private-config.test.ts`

**Interfaces:**
- Produces: `PrivateGatewayConfig`, `loadPrivateGatewayConfig(configPath: string): Promise<PrivateGatewayConfig>`.
- Consumes later: `PrivateGatewayConfig.allowedRoots`, `.devspace.baseUrl`, `.devspace.resourceUrl`, and `.verifyProfiles`.
- [ ] **Step 1: Write config RED tests**

```ts
await assert.rejects(() => loadPrivateGatewayConfig('relative.json'), /absolute/i);
await assert.rejects(() => loadPrivateGatewayConfig(nonLoopbackConfig), /loopback/i);
await assert.rejects(() => loadPrivateGatewayConfig(unknownFieldConfig), /unrecognized|unknown/i);
await assert.rejects(() => loadPrivateGatewayConfig(driveRootAllowedConfig), /drive-root|workspace/i);
const loaded = await loadPrivateGatewayConfig(validConfig);
assert.deepEqual(loaded.verifyProfiles.test.argv, ['node', '--version']);
assert.ok(loaded.allowedRoots.every(isAbsolute));
```

- [ ] **Step 2: Run focused RED**

Run: `npx tsx --test test/private-config.test.ts`
Expected: FAIL because `src/private-config.ts` does not exist.

- [ ] **Step 3: Implement strict schema and canonical roots**

```ts
const verifyProfileSchema = z.object({
  argv: z.array(z.string().min(1)).min(1).max(16),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  maxOutputTokens: z.number().int().min(100).max(10_000).optional(),
}).strict();
```

Require an absolute config path, reject secrets/unknown keys including per-profile `env`, require `baseUrl` hostname to be `127.0.0.1`, `localhost`, or `[::1]`, require `resourceUrl` path to end in `/mcp`, and resolve each allowed root through `realpath()` before requiring `canonicalWorkspace(root, [root])` to succeed. This reuses the existing drive-root/UNC/system/sensitive policy instead of duplicating it.
- [ ] **Step 4: Run focused GREEN + typecheck**

Run: `npx tsx --test test/private-config.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/private-config.ts test/private-config.test.ts
git commit -m "feat: add strict private gateway config"
```

### Task 2: Shared Non-Cancelling Task Store

**Files:**
- Create: `src/task-store.ts`
- Modify: `src/http-server.ts`
- Test: `test/mcp-tasks.test.ts`

**Interfaces:**
- Produces: `NonCancellingTaskStore extends InMemoryTaskStore`.
- Consumes later: both HTTP and stdio MCP transports.

- [ ] **Step 1: Add a focused import/behavior test**

```ts
const store = new NonCancellingTaskStore();
const task = await store.createTask({ ttl: 5_000, pollInterval: 100 });
await assert.rejects(() => store.updateTaskStatus(task.taskId, 'cancelled'), /not supported/i);
```
- [ ] **Step 2: Run focused RED**

Run: `npx tsx --test test/mcp-tasks.test.ts`
Expected: FAIL because `src/task-store.ts` does not exist.

- [ ] **Step 3: Extract existing behavior without changing HTTP semantics**

```ts
export class NonCancellingTaskStore extends InMemoryTaskStore {
  override async updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string, sessionId?: string) {
    if (status === 'cancelled') throw new Error('Task cancellation is not supported until executor interruption is implemented');
    return super.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }
}
```

Delete the private duplicate class from `src/http-server.ts` and import this one.

- [ ] **Step 4: Run MCP/HTTP regression GREEN**

Run: `npx tsx --test test/mcp-tasks.test.ts test/http-transport.test.ts test/task-recovery.test.ts`
Expected: PASS with unchanged five-tool/task behavior.

- [ ] **Step 5: Commit**

```bash
git add src/task-store.ts src/http-server.ts test/mcp-tasks.test.ts
git commit -m "refactor: share non-cancelling MCP task store"
```

### Task 3: DevSpace Token Source Boundary and One-Time 401 Retry

**Files:**
- Modify: `src/executor/devspace.ts`
- Create: `test/devspace-token-source.test.ts`
**Interfaces:**
- Produces: `DevspaceTokenSource` with `getAccessToken()` and optional `refreshAfterUnauthorized()` / `close()` hooks.
- Preserves: current `{ baseUrl, accessToken }` constructor callers through a fixed-token adapter.
- Consumes later: `DevspaceOAuthSession` from Task 4.

- [ ] **Step 1: Write RED tests for dynamic tokens and retry cardinality**

```ts
const tokens = ['expired-token', 'fresh-token'];
const source: DevspaceTokenSource = {
  async getAccessToken() { return tokens[0]; },
  async refreshAfterUnauthorized() { tokens.shift(); return tokens[0]; },
};
const executor = new DevspaceExecutor({ baseUrl, tokenSource: source });
assert.deepEqual((await executor.listTools()).map(t => t.name), expectedTools);
assert.equal(requestCount, 2, '401 must retry exactly once');
```

Also assert a second 401 fails and never triggers a third request; static `accessToken` callers must still make only one request on ordinary success.

- [ ] **Step 2: Run focused RED**

Run: `npx tsx --test test/devspace-token-source.test.ts`
Expected: FAIL because `tokenSource` is not supported.

- [ ] **Step 3: Implement the narrow token source**

```ts
export interface DevspaceTokenSource {
  getAccessToken(): Promise<string>;
  refreshAfterUnauthorized?(): Promise<string>;
  close?(): void | Promise<void>;
}
```

Normalize constructor options to a private token source. `request()` obtains the bearer immediately before each HTTP call. On HTTP 401 only, call `refreshAfterUnauthorized()` when present and retry the exact request once; all other failures preserve current behavior.
- [ ] **Step 4: Run executor regressions**

Run: `npx tsx --test test/devspace-token-source.test.ts test/devspace-compat.test.ts test/health.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/executor/devspace.ts test/devspace-token-source.test.ts
git commit -m "refactor: add refreshable DevSpace token source"
```

### Task 4: In-Memory DevSpace OAuth Session

**Files:**
- Create: `src/executor/devspace-oauth.ts`
- Create: `test/devspace-oauth.test.ts`
- Modify: `test/devspace-fixture.ts`

**Interfaces:**
- Produces: `createDevspaceOAuthSession(options: DevspaceOAuthOptions): Promise<DevspaceOAuthSession>`.
- `DevspaceOAuthOptions = { baseUrl: string; resourceUrl: string; ownerToken: string; fetchFn?: typeof fetch; now?: () => number }`.
- `DevspaceOAuthSession` implements `DevspaceTokenSource` and adds `close(): void`.
- Consumes exact DevSpace OAuth endpoints `/register`, `/authorize`, `/token`.

- [ ] **Step 1: Write fake-server RED tests for bootstrap and refresh rotation**

```ts
const session = await createDevspaceOAuthSession({ baseUrl, resourceUrl, ownerToken, now: () => clock.nowMs });
assert.equal(await session.getAccessToken(), 'access-1');
clock.advance(3_600_000);
assert.equal(await session.getAccessToken(), 'access-2');
assert.deepEqual(refreshTokensSeen, ['refresh-1']);
assert.equal(activeRefreshToken, 'refresh-2');
```
Also test three concurrent `getAccessToken()` calls after expiry perform one refresh, refresh failure performs at most one owner-token re-bootstrap, `refreshAfterUnauthorized()` forces rotation once, and `close()` makes later token requests fail without returning prior credentials.

- [ ] **Step 2: Run focused RED**

Run: `npx tsx --test test/devspace-oauth.test.ts`
Expected: FAIL because the OAuth session module does not exist.

- [ ] **Step 3: Implement PKCE bootstrap + single-flight refresh**

```ts
export interface DevspaceOAuthSession extends DevspaceTokenSource {
  close(): void;
}

export async function createDevspaceOAuthSession(options: DevspaceOAuthOptions): Promise<DevspaceOAuthSession> {
  const session = new OAuthSession(options);
  await session.bootstrap();
  return session;
}
```

Use a random PKCE verifier/challenge per bootstrap, register a public client, POST the owner token only to `/authorize`, exchange the code at `/token`, and store `{clientId, accessToken, refreshToken, expiresAtMs}` only in object memory. Refresh 30 seconds before expiry (or halfway through TTL when TTL < 60 seconds), atomically replace both rotated tokens, and serialize refreshes through one `refreshPromise`.

If refresh fails, clear the failed token pair and perform one new registration/authorization bootstrap with the in-memory owner token. Do not persist client/tokens or log response bodies.

- [ ] **Step 4: Parameterize exact-pinned fixture TTL for later acceptance**

Extend `StartPinnedDevspaceOptions` with `accessTokenTtlSeconds?: number` and `refreshTokenTtlSeconds?: number`, wiring them only into the generated disposable DevSpace config. Export the existing deterministic test-only owner token constant instead of introducing a second test secret, and return `resourceUrl` from the fixture so acceptance never hardcodes the OAuth resource identity.
- [ ] **Step 5: Run OAuth + fixture regressions GREEN**

Run: `npx tsx --test test/devspace-oauth.test.ts test/devspace-fixture-lifecycle.test.ts && npm run typecheck`
Expected: PASS with no DevSpace child leak.

- [ ] **Step 6: Commit**

```bash
git add src/executor/devspace-oauth.ts test/devspace-oauth.test.ts test/devspace-fixture.ts
git commit -m "feat: add in-memory DevSpace OAuth session"
```

### Task 5: Private Runtime Bootstrap and Doctor Core

**Files:**
- Create: `src/private-runtime.ts`
- Create: `test/private-runtime.test.ts`

**Interfaces:**
- Produces: `bootstrapPrivateGateway(config: PrivateGatewayConfig, options?: PrivateRuntimeOptions): Promise<PrivateGatewayRuntime>`.
- `PrivateRuntimeOptions = { env?: NodeJS.ProcessEnv; telemetry?: TelemetrySink; oauthFactory?: typeof createDevspaceOAuthSession }`.
- Produces `PrivateRuntimeError` with stable codes `DEVSPACE_OWNER_TOKEN_MISSING`, `DEVSPACE_AUTH_FAILED`, or `DEVSPACE_COMPAT_FAILED`; raw causes are retained only as `cause`, never printed by the CLI.
- `PrivateGatewayRuntime` exposes `{ gateway, health, close(): Promise<void> }`.
- Consumes: `PrivateGatewayConfig`, `createDevspaceOAuthSession`, `DevspaceExecutor`, `createGateway`.

- [ ] **Step 1: Write RED tests for secret/env lifecycle and startup ownership**

In `test/private-runtime.test.ts`, define a local `startFakeCompatibleDevspace()` HTTP helper that returns the exact `REQUIRED_DEVSPACE_TOOLS` for `tools/list`, plus a fake OAuth session whose `getAccessToken()` returns `test-access` and whose `close()` flips a boolean. Then assert:

```ts
const env = { ...process.env, DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken };
const runtime = await bootstrapPrivateGateway(config, { env, oauthFactory: async () => fakeSession });
assert.equal(env.DEVSPACE_OAUTH_OWNER_TOKEN, undefined);
assert.equal(runtime.health.status, 'ok');
await runtime.close();
assert.equal(fakeSession.closed, true);
await fakeDevspace.close();
```
Also assert missing owner token fails before OAuth, and an executor/health failure closes the just-created OAuth session before propagating a stable startup-stage error.

- [ ] **Step 2: Run focused RED**

Run: `npx tsx --test test/private-runtime.test.ts`
Expected: FAIL because `src/private-runtime.ts` does not exist.

- [ ] **Step 3: Implement owned-resource bootstrap**

```ts
export interface PrivateGatewayRuntime {
  gateway: GatewayApi;
  health: Awaited<ReturnType<GatewayApi['health']>>;
  close(): Promise<void>;
}
```

Require `DEVSPACE_OAUTH_OWNER_TOKEN` from the supplied env or throw `PrivateRuntimeError('DEVSPACE_OWNER_TOKEN_MISSING')`. Wrap OAuth bootstrap failure as `DEVSPACE_AUTH_FAILED`. Delete the env key immediately after successful OAuth bootstrap, create `DevspaceExecutor({ baseUrl, tokenSource: session })`, create the Gateway with config roots/profiles, then call `gateway.health()`; wrap compatibility failure as `DEVSPACE_COMPAT_FAILED`. If any post-session step fails, call `session.close()` before throwing. `close()` releases only the OAuth session; it must never stop DevSpace.

- [ ] **Step 4: Run focused GREEN + health regression**

Run: `npx tsx --test test/private-runtime.test.ts test/health.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/private-runtime.ts test/private-runtime.test.ts
git commit -m "feat: add private gateway runtime bootstrap"
```

### Task 6: Stdio MCP Runtime

**Files:**
- Create: `src/stdio-server.ts`
- Create: `test/stdio-server.test.ts`

**Interfaces:**
- Produces: `startGatewayStdioServer(options: GatewayStdioServerOptions): Promise<GatewayStdioServer>`.
- `GatewayStdioServerOptions = { gateway: GatewayApi; input?: Readable; output?: Writable; taskStore?: NonCancellingTaskStore }`.
- `GatewayStdioServer` exposes `{ close(): Promise<void> }` and owns only MCP server/transport/task-store resources.
- [ ] **Step 1: Write RED lifecycle test with injected streams**

```ts
const input = new PassThrough();
const output = new PassThrough();
const runtime = await startGatewayStdioServer({ gateway, input, output });
assert.equal(output.readableLength, 0, 'stdio runtime must not print diagnostics before MCP traffic');
await runtime.close();
await runtime.close(); // close is idempotent
```

The test also creates a task in the injected `NonCancellingTaskStore`, closes the runtime, and asserts the task store is cleaned without attempting to cancel executor work.

- [ ] **Step 2: Run focused RED**

Run: `npx tsx --test test/stdio-server.test.ts`
Expected: FAIL because `src/stdio-server.ts` does not exist.

- [ ] **Step 3: Connect the official stdio transport**

```ts
const taskStore = options.taskStore ?? new NonCancellingTaskStore();
const server = createGatewayMcpServer(options.gateway, { taskStore });
const transport = new StdioServerTransport(options.input, options.output);
await server.connect(transport);
```

Return an idempotent `close()` that closes transport/server and calls `taskStore.cleanup()`. Do not log, spawn processes, or touch DevSpace lifecycle in this module.

- [ ] **Step 4: Run stdio + MCP surface regressions**

Run: `npx tsx --test test/stdio-server.test.ts test/mcp-surface.test.ts test/mcp-tasks.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stdio-server.ts test/stdio-server.test.ts
git commit -m "feat: add stdio MCP runtime"
```
### Task 7: CLI Commands and Production Build

**Files:**
- Create: `src/cli.ts`
- Create: `tsconfig.build.json`
- Modify: `package.json`
- Create: `test/cli.test.ts`

**Interfaces:**
- Produces: `main(argv?: string[], dependencies?: CliDependencies): Promise<number>` for testable CLI execution.
- `CliDependencies` contains `{ env, stdin, stdout, stderr, loadConfig, bootstrap, startStdio, waitForShutdown, telemetry }` with the exact function types produced by Tasks 1, 5, and 6.
- Commands: `serve-stdio --config <absolute-path>` and `doctor --config <absolute-path>`; global `--help` is non-operational and performs no bootstrap.
- Consumes: `loadPrivateGatewayConfig`, `bootstrapPrivateGateway`, `startGatewayStdioServer`.

- [ ] **Step 1: Write CLI RED tests with injected dependencies/streams**

Define a local `makeCliDeps()` helper returning `{ deps, stdout, stderr, requestShutdown, readyEvent }`, where `deps` supplies in-memory writable streams, a successful fake runtime, and a controllable shutdown promise. Then assert:

```ts
const doctorHarness = makeCliDeps();
const code = await main(['doctor', '--config', configPath], doctorHarness.deps);
assert.equal(code, 0);
assert.match(doctorHarness.stdout.text(), /"status":"ok"/);
assert.equal(doctorHarness.stderr.text().includes(ownerToken), false);

const serveHarness = makeCliDeps();
const serve = main(['serve-stdio', '--config', configPath], serveHarness.deps);
await serveHarness.readyEvent;
assert.equal(serveHarness.stdout.text(), '', 'serve diagnostics must never use stdout');
serveHarness.requestShutdown();
assert.equal(await serve, 0);
```

Also assert unknown commands/flags and relative config paths return non-zero with a stable diagnostic code rather than dumping stack traces or config contents.

- [ ] **Step 2: Run focused RED**

Run: `npx tsx --test test/cli.test.ts`
Expected: FAIL because `src/cli.ts` does not exist.
- [ ] **Step 3: Implement sanitized CLI lifecycle**

```ts
export async function main(argv = process.argv.slice(2), deps = defaultCliDependencies): Promise<number> {
  const parsed = parseCli(argv);
  const config = await deps.loadConfig(parsed.configPath);
  const runtime = await deps.bootstrap(config, { env: deps.env, telemetry: deps.telemetry });
  if (parsed.command === 'doctor') {
    deps.stdout.write(JSON.stringify(runtime.health) + '\n');
    await runtime.close();
    return 0;
  }
  const stdio = await deps.startStdio({ gateway: runtime.gateway, input: deps.stdin, output: deps.stdout });
  deps.stderr.write(JSON.stringify({ type: 'gateway.ready', mode: 'stdio' }) + '\n');
  await deps.waitForShutdown();
  await stdio.close();
  await runtime.close();
  return 0;
}
```

In the real dependency set, `waitForShutdown()` resolves on stdin EOF, SIGINT, or SIGTERM and removes only listeners installed by this CLI. Map config errors to `CONFIG_INVALID`, preserve the stable `PrivateRuntimeError.code`, map stdio-connect failure to `STDIO_START_FAILED`, and map argument errors to `CLI_USAGE`. Print only `{type:'gateway.error', code, errorClass}` to stderr; never print exception response bodies, environment values, config JSON, or stack traces. The default telemetry sink writes `{type:'gateway.telemetry', ...event}` JSON lines to stderr; `GatewayTelemetryEvent` already contains no path/content/secret fields.

- [ ] **Step 4: Add production build config and scripts**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist", "declaration": false, "sourceMap": false },
  "include": ["src/**/*.ts"],
  "exclude": ["test", "scripts", "docs", "dist", "node_modules"]
}
```

Add `"build": "tsc -p tsconfig.build.json"` and `"test:business": "npm run build && tsx --test --test-concurrency=1 test/business-stdio.acceptance.ts"`.

- [ ] **Step 5: Run CLI/build GREEN**

Run: `npx tsx --test test/cli.test.ts && npm run typecheck && npm run build && node dist/cli.js --help`
Expected: tests/typecheck/build PASS; `--help` exits 0 with usage on stdout and no secrets.
- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tsconfig.build.json package.json package-lock.json test/cli.test.ts
git commit -m "feat: add Business stdio CLI and production build"
```

### Task 8: Exact-Pinned Business Stdio Acceptance

**Files:**
- Create: `test/business-stdio.acceptance.ts`
- Modify: `test/devspace-fixture.ts` if Task 4 did not already expose `resourceUrl` and test owner token.

**Interfaces:**
- Consumes built `dist/cli.js`, exact-pinned DevSpace fixture, official SDK `StdioClientTransport` and `Client`.
- Produces no new production API; this task proves the local pre-upgrade path.

Define these local acceptance helpers before the first test:

```ts
const fiveTools = ['health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run'];
async function connectBuiltCli(configPath: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'dist', 'cli.js'), 'serve-stdio', '--config', configPath],
    env: { ...getDefaultEnvironment(), DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'business-stdio-acceptance', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, stderrText: () => stderr, close: async () => { await client.close(); } };
}
async function waitUntilProcessGone(pid: number) {
  for (let i = 0; i < 30; i += 1) { try { process.kill(pid, 0); } catch { return true; } await new Promise(r => setTimeout(r, 100)); }
  return false;
}
```

- [ ] **Step 1: Write the acceptance test before changing production behavior**

```ts
const fixture = await startPinnedDevspace({ accessTokenTtlSeconds: 1, refreshTokenTtlSeconds: 60 });
await writeFile(join(fixture.workspaceRoot, 'sample.txt'), 'sample\n');
const configPath = join(tempRoot, 'private.json');
await writeFile(configPath, JSON.stringify({
  allowedRoots: [fixture.workspaceRoot],
  devspace: { baseUrl: fixture.baseUrl, resourceUrl: fixture.resourceUrl },
  verifyProfiles: { version: { argv: ['node', '--version'], timeoutMs: 5_000, maxOutputTokens: 1_000 } },
}));
const first = await connectBuiltCli(configPath);
assert.deepEqual((await first.client.listTools()).tools.map(t => t.name), fiveTools);
const opened = await first.client.callTool({ name: 'workspace.open', arguments: { path: fixture.workspaceRoot } });
const workspaceId = opened.structuredContent?.workspaceId as string;
assert.match((await first.client.callTool({ name: 'file.read', arguments: { workspace_id: workspaceId, path: 'sample.txt' } })).structuredContent?.content as string, /sample/);
```

Wait past two short access-token lifetimes and call `health` after each wait. Both calls must pass; the second refresh proves exact-pinned DevSpace accepted the rotated refresh token from the first refresh.
- [ ] **Step 2: Extend the acceptance with verify, stderr redaction, and restart re-bootstrap**

```ts
const verify = await first.client.callTool({ name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'version' } });
assert.equal(verify.isError === true, false);
assert.equal((verify.structuredContent as { exitCode: number }).exitCode, 0);
assert.equal(first.stderrText().includes(DEVSPACE_TEST_OWNER_TOKEN), false);
assert.equal(first.stderrText().includes(fixture.workspaceRoot), false);
assert.match(first.stderrText(), /gateway\.(ready|telemetry)/);
const firstPid = first.transport.pid!;
await first.close();
assert.equal(await waitUntilProcessGone(firstPid), true);

const second = await connectBuiltCli(configPath);
assert.equal((await second.client.callTool({ name: 'health', arguments: {} })).isError === true, false);
await second.close();
```

The config used by acceptance includes only `version: { argv: ['node', '--version'] }`; no arbitrary shell command is introduced.

- [ ] **Step 3: Add built `doctor` acceptance**

Spawn `node dist/cli.js doctor --config <path>` with the same test owner-token env. Assert exit 0 and parse stdout as `{status:'ok', executor:'devspace', ...}`. Then run once without `DEVSPACE_OAUTH_OWNER_TOKEN`; assert non-zero and stderr contains the stable missing-secret code but neither config contents nor any token.

- [ ] **Step 4: Run Business acceptance GREEN**

Run: `npm run test:business`
Expected: PASS against exact-pinned DevSpace; CLI child PIDs disappear after close; fixture cleanup leaves no `dist/cli.js serve` process.

- [ ] **Step 5: Run full regression + build**

Run: `npm test && npm run typecheck && npm run build && git diff --check`
Expected: all repository tests PASS, typecheck/build PASS, diff check clean.

- [ ] **Step 6: Commit**

```bash
git add test/business-stdio.acceptance.ts test/devspace-fixture.ts
git commit -m "test: prove Business stdio gateway path"
```
### Task 9: Private Deployment Docs and Pre-Upgrade Receipt

**Files:**
- Modify: `README.md`
- Create: `docs/benchmarks/2026-09-10-business-stdio-preupgrade.md`

**Interfaces:**
- Documents the built local command and the exact evidence required before recommending Business purchase.
- Does not create or configure an OpenAI tunnel, Platform API key, Business workspace, or ChatGPT app.

- [ ] **Step 1: Document the private local commands with placeholders only**

Add a `Business private MCP readiness` section showing:

```powershell
npm ci
npm run build
$env:DEVSPACE_OAUTH_OWNER_TOKEN = '<local-owner-secret>'
node .\dist\cli.js doctor --config C:\path\to\private.json
node .\dist\cli.js serve-stdio --config C:\path\to\private.json
```

Document the future Secure MCP Tunnel shape exactly as `tunnel-client ... --mcp-command "node ... dist/cli.js serve-stdio --config ..."`, while explicitly marking tunnel/account commands as post-upgrade external steps. Never put a real owner token, control-plane API key, tunnel ID, or machine-specific absolute path in Git.

- [ ] **Step 2: Commit README before acceptance so the candidate SHA is stable**

```bash
git add README.md
git commit -m "docs: document Business stdio readiness"
```

Record `CANDIDATE_SHA=$(git rev-parse HEAD)` (PowerShell equivalent on Windows) and use that exact SHA in the receipt.
- [ ] **Step 3: Run exact-candidate pre-upgrade acceptance**

From a clean tree at `CANDIDATE_SHA`, run in this order:

```text
npm ci
npm test
npm run typecheck
npm run build
npm run test:business
git diff --check
```

Then verify: working tree clean; local HEAD still equals `CANDIDATE_SHA`; no test Gateway/DevSpace child remains; no tracked file contains `DEVSPACE_OAUTH_OWNER_TOKEN=` with a value, `CONTROL_PLANE_API_KEY=` with a value, `sk-proj-`, `github_pat_`, or a private-key header.

- [ ] **Step 4: Write the exact-SHA receipt**

Create `docs/benchmarks/2026-09-10-business-stdio-preupgrade.md` containing: candidate SHA, exact DevSpace pin, Node/npm versions, commands run, pass/fail counts, build result, short-TTL OAuth refresh result, stdio five-tool result, restart re-bootstrap result, doctor result, secret scan result, and process-leak result. State explicitly:

```text
LOCAL_BUSINESS_STDIO_READINESS = PASS
CHATGPT_BUSINESS_END_TO_END = NOT_YET_TESTED
BUSINESS_PURCHASE_RECOMMENDATION = ALLOWED_FOR_EXTERNAL_ACCEPTANCE_ONLY
```

Do not claim ChatGPT effectiveness until the post-upgrade Secure MCP Tunnel test passes.

- [ ] **Step 5: Commit receipt and re-check docs-only delta**

```bash
git add docs/benchmarks/2026-09-10-business-stdio-preupgrade.md
git commit -m "bench: record Business stdio pre-upgrade gate"
git diff HEAD^ --check
git status --short
```

Expected: receipt commit is docs-only and tree is clean.

## Implementation Stop Conditions

Return to design instead of expanding scope if implementation requires a public listener, a PFP database/runtime dependency, persistent OAuth credential storage, DevSpace library embedding, arbitrary shell/env input, mutation/Git writes, a durable task database, or Secure MCP Tunnel account access before the local pre-upgrade gate is complete.
