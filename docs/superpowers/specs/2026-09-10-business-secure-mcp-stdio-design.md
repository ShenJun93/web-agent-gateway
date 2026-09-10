# Business Secure MCP Stdio Deployment Design

Date: 2026-09-10
Status: Proposed for implementation
Decision authority: ADR-0007

## Goal

Prepare Web Agent Gateway for the lowest-engineering supported private ChatGPT route: ChatGPT Business developer mode plus OpenAI Secure MCP Tunnel.

The local deployment must remain private, bounded, and usable before any Business purchase. We should be able to prove the complete local stdio path with an MCP test client; upgrading Business should only add OpenAI tunnel/account configuration, not require a gateway redesign.

## Current OpenAI contract

OpenAI currently provides full custom MCP, including write/modify actions, to ChatGPT Business, Enterprise, and Edu on web. ChatGPT cannot connect directly to a local MCP server; Secure MCP Tunnel provides an outbound-only path for private developer-machine MCP servers.

Secure MCP Tunnel supports a local MCP server over either HTTP or stdio. Its documented stdio setup uses `tunnel-client ... --mcp-command "..."`, and the tunnel client forwards MCP requests to that command while the server remains private.

Sources:
- https://help.openai.com/en/articles/12584461
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

## Chosen topology

```text
ChatGPT Business (developer-mode custom app)
        |
OpenAI-hosted Secure MCP Tunnel endpoint
        |
outbound tunnel-client on the Windows developer machine
        |
--mcp-command -> Web Agent Gateway stdio process
        |
localhost MCP -> exact-pinned DevSpace process
        |
approved local workspaces
```

## Why stdio, not the existing benchmark HTTP transport

The HTTP server was built to prove authenticated remote transport and benchmark latency. It requires a local bearer token and a loopback HTTP listener. Secure MCP Tunnel already supports launching a stdio MCP command directly, so retaining HTTP in the private Business path adds a listener and an extra local authentication problem without adding useful isolation.

The stdio path therefore becomes the preferred private deployment surface. The existing HTTP transport remains benchmark/test infrastructure and is not removed.

## Process ownership

DevSpace remains an exact-pinned, separate localhost process. V0.2 does not import DevSpace as a library and does not make Gateway the DevSpace supervisor.

This preserves ADR-0002's process boundary and avoids coupling tunnel-client lifecycle to DevSpace startup/shutdown semantics. The operator can restart Gateway/tunnel-client without terminating local DevSpace jobs.

The stdio Gateway owns only:
- config validation;
- DevSpace OAuth client session;
- the five existing semantic MCP tools;
- MCP task state for the Gateway process lifetime;
- sanitized stderr telemetry and shutdown handling.

It does not own DevSpace configuration, installation, upgrading, or OS sandboxing.

## Runnable interface

Add a buildable CLI entrypoint:

```text
node dist/cli.js serve-stdio --config <absolute-config-path>
node dist/cli.js doctor --config <absolute-config-path>
```

`serve-stdio` reserves stdout exclusively for MCP framing. Human-readable or structured operational logs go only to stderr. A secret value, workspace content, or absolute workspace path must never be logged.

`doctor` performs the same config/auth/executor compatibility checks but does not open stdio MCP. It is the pre-upgrade/private-deployment readiness command.

## Local configuration

Use one explicit JSON config file. No secrets are stored in it.

```json
{
  "allowedRoots": ["C:\\work\\projects"],
  "devspace": {
    "baseUrl": "http://127.0.0.1:7676",
    "resourceUrl": "http://127.0.0.1:7676/mcp"
  },
  "verifyProfiles": {
    "test": {
      "argv": ["npm", "test"],
      "timeoutMs": 30000,
      "maxOutputTokens": 8000
    }
  }
}
```

The config parser is strict: unknown fields fail closed. `baseUrl` must be loopback HTTP/HTTPS. `resourceUrl` must use the configured DevSpace MCP resource. Every configured allowed root must itself pass the existing canonical workspace policy, so drive-root, UNC/device, system, and sensitive roots fail during startup rather than broadening containment. Allowed-root and verify-profile rules reuse the existing gateway policy rather than creating a second policy layer. V0.2 private config does not expose per-profile `env`; adding environment injection to this deployment surface requires a separate security design.

## Production-discipline carry-over from PFP audit

The Project Factory Platform audit reinforces patterns, not code sharing: fail-closed strict config, secrets outside Git, exact-SHA acceptance evidence, and explicit ownership before process/resource cleanup. Web Agent Gateway remains a separate execution-plane repository and does not import PFP PostgreSQL jobs, executor registry, governance tables, schedulers, or runtime state.

## DevSpace authentication lifecycle

The current `DevspaceExecutor` accepts one static access token. That is insufficient for a long-lived private tunnel because exact-pinned DevSpace defaults access tokens to one hour and refresh tokens to 30 days.

Introduce a narrow `DevspaceTokenSource` boundary. Executor requests obtain a current access token from this source instead of storing a fixed bearer.

For the private stdio CLI, implement an in-memory OAuth session:
1. Read `DEVSPACE_OAUTH_OWNER_TOKEN`, copy it into the in-memory OAuth session, then remove that variable from Gateway process environment. Never accept the owner token in command-line arguments or JSON config.
2. Register an OAuth client against localhost DevSpace and complete the existing PKCE/owner-token authorization flow.
3. Keep access token, refresh token, client ID, and expiry only in process memory.
4. Refresh before expiry using DevSpace's refresh-token grant. Exact-pinned DevSpace rotates refresh tokens, so atomically replace both tokens after every refresh.
5. On an executor HTTP 401, refresh once and retry the exact request once. Never loop indefinitely.
6. If refresh fails, re-bootstrap once with the owner token; otherwise fail closed with an actionable stderr error.

No OAuth token is persisted in V0.2. Gateway restart re-authorizes locally. Persistent credential storage is deferred until restart frequency proves this burdensome.

The tunnel client's `CONTROL_PLANE_API_KEY` may be inherited by the stdio child. Gateway must never copy its ambient process environment into DevSpace or verification commands. The separately supervised DevSpace environment remains the existing scrubbed trust boundary.

## Stdio MCP surface

Reuse `createGatewayMcpServer()` and the official SDK `StdioServerTransport`. Expose exactly the existing five public tools:
- `health`
- `workspace.open`
- `repo.snapshot`
- `file.read`
- `verify.run`

No raw shell, arbitrary environment, mutation, patch, or Git-write tool is added.

`verify.run` remains task-capable using the SDK `InMemoryTaskStore`. Task result recovery is guaranteed only while the Gateway stdio process remains alive. Restarting tunnel-client may restart the stdio child and therefore lose in-memory task state; gateway-restart durability remains explicitly out of scope.

## Startup and readiness

`serve-stdio` follows this order:
1. Parse and validate config.
2. Canonicalize and validate allowed roots.
3. Bootstrap DevSpace OAuth session.
4. Run `health` compatibility against the exact expected DevSpace tool contract.
5. Construct Gateway with configured verify profiles.
6. Connect `McpServer` to `StdioServerTransport`.
7. Write one sanitized ready event to stderr.

If steps 1-5 fail, the process exits non-zero before accepting MCP traffic. This makes `tunnel-client doctor` failures actionable rather than presenting a half-ready app.

## Shutdown behavior

On stdio EOF, SIGINT, or SIGTERM:
- stop accepting new MCP work;
- close the MCP server/transport;
- clean the Gateway task store;
- erase in-memory OAuth references by releasing the session;
- exit without killing separately supervised DevSpace.

Gateway starts no OS child process in this topology and therefore terminates only MCP/task/OAuth resources it owns. A DevSpace command already delegated before Gateway shutdown is DevSpace-owned and may continue under the separately supervised executor; V0.2 does not invent cross-process cancellation on Gateway exit. Gateway task/result recovery remains process-lifetime only, so the post-upgrade interruption gate must record what happens if tunnel-client restarts the stdio child.

## Packaging

Add a production build target that emits only `src/**` to `dist/`, while retaining the existing no-emit typecheck for source/tests/scripts. The documented tunnel command targets built JavaScript, not `tsx` or another dev dependency.

Expected private deployment shape after build:

```text
set CONTROL_PLANE_API_KEY=<runtime-key>
set DEVSPACE_OAUTH_OWNER_TOKEN=<local-owner-secret>

tunnel-client init ^
  --profile web-agent-gateway ^
  --tunnel-id <tunnel-id> ^
  --mcp-command "node C:\\work\\projects\\web-agent-gateway\\dist\\cli.js serve-stdio --config C:\\path\\to\\private.json"

tunnel-client doctor --profile web-agent-gateway --explain
tunnel-client run --profile web-agent-gateway
```

Secrets in this example are placeholders only. Real values are never committed or printed by Gateway.

## Testing strategy

Implementation follows TDD and adds separate tests for:
- strict config validation and loopback-only DevSpace URL policy;
- OAuth bootstrap, access-token refresh, refresh-token rotation, one-time 401 retry, and failure cleanup;
- executor token-source behavior without regressing the pinned DevSpace compatibility contract;
- stdio MCP client listing exactly five tools;
- real stdio `workspace.open` + `file.read` + `verify.run` against exact-pinned DevSpace;
- stdout containing only MCP traffic while diagnostics remain on stderr;
- `doctor` success/failure exit codes;
- production `npm run build` output and a built-CLI smoke test;
- graceful shutdown with no leaked Gateway-owned process.

## Pre-upgrade acceptance gate

Before recommending that the user buy ChatGPT Business, all local evidence must pass without Business access:
- built stdio Gateway starts from a clean checkout;
- exact-pinned DevSpace is reachable only on loopback;
- OAuth survives an artificially short access-token TTL by refreshing during continued MCP use;
- a real stdio MCP client completes the read/verify scenario through Gateway;
- Gateway restart re-bootstrap works without persisted OAuth tokens;
- no secret appears in stdout/stderr/test receipts;
- no Gateway-owned or test DevSpace process leaks after shutdown;
- full repository suite, typecheck, build, and diff checks pass.

Only after this gate should the external Business test be requested.

## Post-upgrade acceptance gate

After the user chooses Business:
1. Enable developer mode as the Business workspace admin/owner.
2. Create/associate an OpenAI Secure MCP Tunnel with the target workspace and Platform organization.
3. Run `tunnel-client doctor` against the built stdio command.
4. Create a developer-mode ChatGPT app using Tunnel as the connection.
5. Prove tool discovery and `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run` from ChatGPT web.
6. Repeat transport interruption around a task-backed `verify.run` and record the result boundary.

No claim of Business effectiveness is accepted until this end-to-end ChatGPT evidence exists.

## Explicit non-goals

V0.2 does not add mutation, raw shell, Git writes, public hosting, public-plugin submission, OAuth for public end users, a universal relay, DevSpace library embedding, OS sandboxing, or durable task storage across Gateway restart.
