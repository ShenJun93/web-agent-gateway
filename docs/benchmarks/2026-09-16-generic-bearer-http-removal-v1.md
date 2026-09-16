# Generic Bearer HTTP Removal v1 Acceptance Receipt

Date: 2026-09-16
Repository base: `5f5cda38684f60b378f77946ee9f8636250cdce2`
Implementation commit: `68cc98e8947892d36660d74edde259962fcd8346`
Branch: `feat/remove-generic-bearer-http-v1`

## Goal

Remove the non-product generic bearer-authenticated HTTP MCP compatibility mode after MCP v1 Tasks removal left it with only historical benchmark/spike consumers.

This milestone preserves Browser Admission HTTP, Business/private stdio MCP, synchronous `verify.run`, the durable verify core, and the durable mutation core. It does not enable mutation on any current host or widen authority.

## Removed compatibility surface

The implementation removes `GatewayHttpServerOptions` and `startGatewayHttpServer(...)` from `src/http-server.ts` and deletes the generic bearer `/mcp` routing branch.

Historical `scripts/benchmark-gateway.ts`, `scripts/durable-mutation-browser-spike.ts`, and `test/http-transport.test.ts` are removed. No CLI/product entrypoint used those paths at the accepted base.

`startBrowserAdmissionHttpServer(...)` remains the only HTTP server entrypoint. Its exact IPv4-loopback, Host, Origin, bootstrap credential, admitted bearer, release, and browser-MCP behavior is preserved.

## Preserved acceptance coverage

Synchronous `verify.run` coverage now uses MCP `InMemoryTransport`, proving the tool contract independently from any HTTP transport.
The durable mutation end-to-end acceptance still uses the real private runtime, SQLite durable store, DevSpace file-mutation backend, local operator approval server, and MCP tool surface. Only its retired bearer HTTP bridge was replaced by a test-only in-memory MCP fixture.

The accepted Browser Adapter still uses real Streamable HTTP through Browser Admission and remains exactly `health`, `workspace.open`, and `file.read`.

## TDD evidence

RED was observed before production removal:

- runtime regression failed because the HTTP module still exported `startGatewayHttpServer`;
- TypeScript failed with an unused `@ts-expect-error` because `startGatewayHttpServer` was still a valid module export key.

GREEN removed the public generic HTTP API and routing while preserving Browser Admission HTTP.

## Verification evidence

On the exact implementation candidate:

- `npm run typecheck` — PASS;
- focused browser/synchronous-verify/durable acceptance — PASS, 9/9;
- `npm run build` — PASS;
- `npm run test:business` — PASS, 1/1;
- durable mutation/verify regression — PASS, 21/21;
- Browser Admission/native-host focused regression — PASS, 26/26;
- `npm test` — PASS, 193/193;
- `git diff --check` — PASS.

The full-suite count decreases from 195 to 193 because three tests dedicated to the removed generic bearer HTTP transport were retired and one module-only regression was added. Durable acceptance tests were migrated, not removed. No test was skipped or disabled.
No package or lockfile changed. The SDK remains exact-pinned at `1.29.0`. Registry state, installed native-host state, and accepted Task 9C/9D distribution identity are unchanged.

## Decision

`GENERIC_BEARER_HTTP_REMOVAL_V1 = PASS`

`GENERIC_BEARER_HTTP = REMOVED`

`BROWSER_ADMISSION_HTTP = PRESERVED`

`VERIFY_RUN_SYNC_CONTRACT = PRESERVED`

`DURABLE_MUTATION_ACCEPTANCE = PRESERVED`

`DURABLE_VERIFY_JOB_CORE = PRESERVED`

`DEFAULT_MCP_SURFACE = FIVE_TOOLS_UNCHANGED`

`BROWSER_ADAPTER_SURFACE = THREE_TOOLS_UNCHANGED`

`MCP_V2_PRODUCTION_MIGRATION = DEFER`

`AUTHORITY_WIDENING = NONE`

`PACKAGE_CHANGE = NONE`

`NATIVE_HOST_IDENTITY_CHANGE = NONE`
