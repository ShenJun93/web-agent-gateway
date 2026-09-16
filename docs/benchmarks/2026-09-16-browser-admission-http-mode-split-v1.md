# Browser Admission HTTP Mode Split v1 Acceptance Receipt

Date: 2026-09-16
Repository base: `87e8f22c7d5a0fcbd88d75093d15ee676e906ccb`
Implementation candidate: `1187cf52f826a2ec29819d6f87d545a1732f2d3d`
Branch: `feat/browser-admission-http-mode-split-v1`

## Goal

Implement the single bounded consolidation selected by the redundant-surface audit: make generic bearer HTTP and browser-admission HTTP distinct composition contracts, then remove the browser runtime's unreachable generic bearer.

This milestone does not delete generic HTTP, change MCP Tasks, widen tools or authority, alter native-host distribution/install identity, or enable browser mutation.

## Implementation

`GatewayHttpServerOptions` now describes only the generic bearer-authenticated MCP mode. It retains `bearerToken`, optional historical mutation projection knobs, loopback binding, and the existing default MCP behavior.

A separate `BrowserAdmissionHttpServerOptions` and `startBrowserAdmissionHttpServer(...)` describe the browser-admission mode. That contract requires `browserAdmission` and intentionally has no generic bearer, `enableFilePatch`, or `mutationContext` fields.

Both exported entrypoints share the existing internal loopback HTTP implementation. Browser admission still enforces IPv4 loopback, exact Host, no Origin, bootstrap-only admission, admitted session bearer lookup, exact three-tool browser MCP construction, and authenticated release.

The production browser runtime now mints only its bootstrap credential before starting browser-admission HTTP. The previously generated `internalBearerToken` is removed and is not replaced by any new credential or authority field.

Admission-oriented tests and the native-host artifact harness now use the browser-specific entrypoint. Generic HTTP callers, task recovery tests, benchmark harnesses, historical mutation harnesses, and Business stdio keep their existing entrypoints.

## TDD evidence

RED was observed before production changes:

- the admission test imported `startBrowserAdmissionHttpServer` and `BrowserAdmissionHttpServerOptions` before they existed;
- focused execution failed because the module did not export the new browser entrypoint;
- TypeScript failed on the missing browser-specific API/type;
- compile-time `@ts-expect-error` guards require browser mode to reject generic bearer/mutation fields and generic mode to reject browser-admission composition.

GREEN evidence after the minimal split:

- browser-admission focused tests: 4/4 PASS;
- HTTP/admission/runtime/local-link focused set: 13/13 PASS;
- Windows native-host artifact gate: 2/2 PASS;
- TypeScript typecheck: PASS.

## Full regression evidence

On the exact implementation candidate `1187cf52f826a2ec29819d6f87d545a1732f2d3d`:

- `npm run typecheck` - PASS;
- `npm run build` - PASS;
- `npm run test:business` - PASS, 1/1;
- `npm test` - PASS, 221/221;
- native-host artifact test - PASS, 2/2;
- `git diff --check` - PASS.

The full suite retained v1 MCP Tasks reconnect/result recovery and cancellation denial, generic bearer HTTP, default five-tool MCP, Browser Adapter three-tool isolation, durable mutation/verify cores, native-host artifact/distribution/install checks, and filesystem/security regressions.

No package or lockfile changed. The exact-pinned MCP SDK remains `1.29.0`. No accepted native-host distribution/install identity or registry state changed.

## Decision

The audit-selected consolidation is accepted as a contract split, not a capability change. Generic bearer HTTP remains available to its compatibility consumers while browser admission no longer creates an unreachable generic bearer or accepts generic mutation composition knobs.

This milestone does not authorize removing generic bearer HTTP, removing v1 Tasks, projecting durable mutation/verify into new hosts, browser mutation, process/PTY, Git writes, or MCP v2 production migration.

`BROWSER_ADMISSION_HTTP_MODE_SPLIT_V1 = PASS`

`BROWSER_GENERIC_INTERNAL_BEARER = REMOVED`

`GENERIC_BEARER_HTTP = PRESERVED`

`MCP_V1_TASKS = UNCHANGED`

`TOOL_SURFACE_WIDENING = NONE`

`AUTHORITY_WIDENING = NONE`

`PACKAGE_CHANGE = NONE`

`NATIVE_HOST_IDENTITY_CHANGE = NONE`

`NEXT_FEATURE_GROWTH = NOT_AUTHORIZED_WITHOUT_NEW_EVIDENCE`
