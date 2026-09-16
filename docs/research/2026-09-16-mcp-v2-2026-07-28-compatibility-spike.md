# MCP v2 / 2026-07-28 Compatibility Spike — 2026-09-16

Status: empirical compatibility research; no production dependency migration

Repository base: `9f6697823282719bc31a395b999ce920700a1021`

## Question

Determine whether WAG can move from exact-pinned `@modelcontextprotocol/sdk@1.29.0` to the TypeScript SDK v2 package split and serve MCP protocol `2026-07-28` without changing WAG-owned authority, silently dropping compatibility, or coupling production to an immature Tasks implementation.

This spike is deliberately non-mutating for canonical source. All package/code experiments ran in a disposable exact-main clone.

## Current WAG dependency boundary

Canonical WAG remains pinned to `@modelcontextprotocol/sdk@1.29.0`.

The current MCP surface uses ordinary client/server/transport APIs plus the v1 experimental Tasks seam:

- `McpServer`, `Client`, Streamable HTTP, stdio, and in-memory transports;
- `InMemoryTaskStore` / `TaskStore`;
- `server.experimental.tasks.registerToolTask` for `verify.run`;
- `client.experimental.tasks.callToolStream`, `getTask`, and `getTaskResult` in recovery/interruption evidence;
- `NonCancellingTaskStore` to keep cancellation fail-closed.

WAG durable authority remains separate from these protocol task handles.
## Official upstream findings

Primary sources:

- TypeScript SDK v2 migration: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md>
- 2026-07-28 adoption guide: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md>
- Protocol-era matrix: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md>
- SEP-2663 Tasks Extension: <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md>
- TypeScript SDK Tasks implementation tracker: <https://github.com/modelcontextprotocol/typescript-sdk/issues/2189>
- Tasks reference repository: <https://github.com/modelcontextprotocol/ext-tasks>

SDK v2 replaces the monolithic v1 package with separate client/server/core packages plus environment adapters such as `@modelcontextprotocol/node`. The official migration guide provides a codemod for the mechanical import/package changes.

The v1 experimental Tasks API has no mechanical v2 equivalent. SEP-2663 moves Tasks out of the core protocol into the Extensions Track under `io.modelcontextprotocol/tasks`; that extension is not wire-compatible with the old v1 experimental Tasks surface.

As observed on 2026-09-16, the TypeScript SDK tracking issue for SEP-2663 remains open/in progress, and the `ext-tasks` reference repository explicitly labels itself experimental and subject to significant change or discontinuation. Production WAG must not treat that reference implementation as a stable replacement merely to unblock an SDK version bump.

Protocol `2026-07-28` starts the SDK's modern era. It uses `server/discover` rather than the legacy `initialize` handshake and per-request `_meta` state rather than MCP session identity. The v2 client defaults to legacy behavior unless version negotiation opts into modern support.
For HTTP, the modern v2 entry point is `createMcpHandler(factory)`. The same handler can serve modern `2026-07-28` requests and legacy stateless clients, which aligns with WAG's existing per-request stateless HTTP composition.

`requestState` and protocol task identifiers remain peer-supplied or protocol-scoped compatibility state. They do not replace WAG `owner_id`, `session_id`, `adapter_id`, durable workspace ownership, mutation ids, or durable verify-job ids.

## Disposable codemod experiment

Disposable clone:

`%TEMP%\wag-mcp-v2-spike-d350001b73734b84b44ed6b67eb3e2e5`

The clone was checked out at exact base `9f6697823282719bc31a395b999ce920700a1021`. Baseline `npm ci` and `npm run typecheck` passed before any experiment.

The official command:

`npx --yes @modelcontextprotocol/codemod@2.0.0 v1-to-v2 .`

reported 39 changes across 16 files, six warnings, and four `@mcp-codemod-error` markers. Three markers were conservative schema-analysis warnings on WAG values that were already Zod schema objects. The architectural marker was the removed experimental Tasks seam.

The codemod replaced the monolithic SDK dependency with v2 client/core/node/server packages. Exact `npm view` observations on the spike date returned `2.0.0` for all four packages, and the disposable clone installed exact `2.0.0` versions for measurement.
## Measured migration breakage

After codemod + exact v2 package installation, `npm run typecheck` failed with 30 compiler errors.

Every observed error was in the legacy Tasks seam or a direct dependent test/script:

- missing `Client.experimental.tasks` methods;
- missing `McpServer.experimental.tasks` registration;
- missing `InMemoryTaskStore` / `TaskStore`;
- invalid `taskStore` `McpServer` option;
- obsolete task-store cleanup/override methods;
- task recovery/cancel and transport-interruption code that calls the removed v1 Tasks client API.

No unrelated client/server/Streamable HTTP/stdio/in-memory transport compile failure appeared after the codemod's mechanical package/import changes.

This is important because the observed blocker is architectural and bounded: WAG is not generally incompatible with v2; its v1 experimental Tasks projection is.

## Task-free compatibility measurement

A second disposable-only patch removed the legacy protocol TaskStore wiring and exposed `verify.run` as an ordinary synchronous tool, preserving its configured-profile safety boundary. This was a measurement patch, not a proposed production migration.

With that patch:

- source-only v2 typecheck passed;
- `npm run build` passed;
- browser-admitted MCP remained exactly three tools;
- default MCP remained exactly five tools;
- authenticated HTTP and Browser Adapter admission tests continued to pass;
- synchronous non-task `verify.run` executed successfully.
The first targeted run passed 17/19 tests. Both failures were expected v2 contract differences rather than execution failures: v2 throws a `ProtocolError` for unavailable tools where the v1 test expected an `isError` tool result, and the removed legacy Tasks projection no longer advertises `execution.taskSupport = optional`.

After changing only those disposable test expectations, the same targeted set passed **19/19**, with zero failures and zero skips.

## 2026-07-28 modern-era smoke

A disposable HTTP smoke used official v2 `createMcpHandler`, `toNodeHandler`, and the task-free WAG MCP server factory. A v2 client pinned with:

`versionNegotiation: { mode: { pin: '2026-07-28' } }`

connected successfully, reported `era = modern`, listed the expected five WAG tools, and successfully called `health`.

Observed modern result:

`{"era":"modern","tools":["health","workspace.open","repo.snapshot","file.read","verify.run"],"health":{"status":"ok","executor":"devspace","protocolVersion":"2026-07-28","toolCount":8}}`

A second smoke used the same handler for both a default legacy client and a pinned modern client. Both negotiated successfully, both listed the same five WAG tools, and both returned `health.status = ok`.

This proves the core stateless WAG server shape can be served dual-era without treating MCP transport/session state as authority.

## Authority interpretation

SDK/package migration does not change WAG ownership. Modern `_meta`, `requestState`, protocol-era identity, extension task ids, and transport correlation remain replaceable compatibility state. WAG-owned durable ids and exact caller tuples remain authoritative.
Do not persist or expose modern request state merely because the protocol can round-trip it. Any future use must be integrity-protected and must remain non-authoritative unless a new reviewed ADR explicitly changes the trust model.

## Decision

The v2 core/package migration is technically feasible and the `2026-07-28` modern protocol can coexist with WAG's legacy clients through a dual-era stateless handler.

Production migration is deferred for now. Migrating immediately would force one of two undesirable choices: drop the currently accepted v1 Tasks compatibility/recovery projection, or bind production to a Tasks extension implementation whose official TypeScript SDK integration is still in progress and whose reference repository is explicitly experimental.

The accepted `@modelcontextprotocol/sdk@1.29.0` dependency therefore remains unchanged by this spike. No package, lockfile, source, tool-surface, or authority change is authorized here.

Revisit the production migration when at least one of these becomes true:

- official TypeScript SDK support for `io.modelcontextprotocol/tasks` reaches an accepted stability level for WAG's needs;
- product evidence shows the existing MCP Tasks compatibility projection is no longer needed and a separately reviewed removal is justified;
- a security/compatibility requirement makes v2 migration materially necessary before then.

The next evidence gate is the **current-market viability re-benchmark**. That research should determine whether present-day host/platform capabilities change WAG's required scope before selecting another implementation milestone.

`MCP_V2_CORE_COMPATIBILITY = PASS`

`MCP_2026_07_28_DUAL_ERA_SMOKE = PASS`

`MCP_V2_TASKS_MIGRATION = DEFER_UPSTREAM_EXTENSION_SUPPORT`

`MCP_V2_PRODUCTION_MIGRATION = DEFER`

`MCP_V2_COMPATIBILITY_SPIKE = PASS`