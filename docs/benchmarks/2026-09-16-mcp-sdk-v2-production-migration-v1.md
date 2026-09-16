# MCP SDK v2 Production Migration v1 Acceptance Receipt

Date: 2026-09-16
Repository base: `ebca9ddf8d684052d65a72d3309a99cf43912412`
Implementation commit: `08e0e1b18839ae8dc66445f014b7362b7458efe7`
Branch: `feat/mcp-sdk-v2-production-migration-v1`

## Goal

Migrate WAG from monolithic `@modelcontextprotocol/sdk` v1.29.0 to the split TypeScript MCP SDK v2 packages without widening WAG authority or changing its accepted tool surfaces.

This milestone is a package/runtime migration only. It does not separately opt WAG into MCP protocol revision `2026-07-28`, add Tasks, enable mutation on a production host, or change the accepted native-host installation identity.

## Package migration

Removed direct dependency:

- `@modelcontextprotocol/sdk` `1.29.0`.

Added exact-pinned direct dependencies:

- `@modelcontextprotocol/client` `2.0.0`;
- `@modelcontextprotocol/server` `2.0.0`;
- `@modelcontextprotocol/node` `2.0.0`.

The v2 split removes unused transitive dependencies from the old monolithic SDK. The direct package policy remains exact-pin rather than a caret range.

## Runtime changes

The official v1-to-v2 codemod was applied, then reviewed manually.

- server/client imports now use the split v2 packages;
- Browser Admission HTTP uses `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`;
- stdio uses `StdioServerTransport` from `@modelcontextprotocol/server/stdio`;
- in-memory tests use `Client` and `InMemoryTransport` from `@modelcontextprotocol/client`;
- v2 tool registration receives Standard Schema objects via `z.object(...)` where v1 accepted raw shapes.

No `@mcp-codemod-error` marker remains in live source or tests.

## TDD evidence

RED was observed before the production migration:

- the v1 tool list still exposed `verify.run.execution.taskSupport = 'forbidden'`;
- an unavailable browser tool resolved to an MCP error result instead of the v2 client rejecting with protocol error code `-32602`.

After migration, both regressions pass under v2 semantics while the allowed tool inventories remain unchanged.

## Verification evidence

On the exact implementation candidate:

- `npm run typecheck` - PASS;
- `npm run build` - PASS;
- focused MCP/Browser/synchronous verify - PASS, 17/17;
- `npm run test:business` - PASS, 1/1;
- durable mutation/verify regression - PASS, 21/21;
- Browser Admission/native-host focused regression - PASS, 19/19;
- `npm test` - PASS, 193/193;
- `git diff --check` - PASS.

The full-suite count remains 193. No test was skipped or disabled.

Default/private MCP remains exactly `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`. Browser Admission remains exactly `health`, `workspace.open`, and `file.read`.

## Decision

`MCP_SDK_V2_PRODUCTION_MIGRATION_V1 = PASS`

`MCP_SDK_V2_PACKAGES = EXACT_PINNED_2_0_0`

`MCP_2026_07_28_PROTOCOL_ENABLEMENT = NOT_INCLUDED`

`DEFAULT_MCP_SURFACE = FIVE_TOOLS_UNCHANGED`

`BROWSER_ADAPTER_SURFACE = THREE_TOOLS_UNCHANGED`

`VERIFY_RUN_SYNC_CONTRACT = PRESERVED`

`DURABLE_VERIFY_JOB_CORE = PRESERVED`

`DURABLE_MUTATION_CORE = PRESERVED`

`AUTHORITY_WIDENING = NONE`

`BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`BUSINESS_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`NATIVE_HOST_IDENTITY_CHANGE = NONE`
