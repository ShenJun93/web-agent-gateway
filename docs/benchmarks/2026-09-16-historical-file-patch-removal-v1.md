# Historical `file.patch` Removal v1 Acceptance Receipt

Date: 2026-09-16
Repository base: `fb81d15bb13c7270a73f2fbd99795f1eff4626d3`
Implementation commit: `daaa7341cf237252b48faceb65f06c1c451cbda4`
Branch: `feat/remove-historical-file-patch-v1`

## Goal

Remove the historical opt-in `file.patch` protocol after the mutation-legacy sunset spike established that it is superseded by the accepted durable reviewed-change control plane.

This removal does not enable durable mutation on any current host, widen authority, change MCP Tasks, alter the default five-tool or Browser Adapter three-tool surfaces, change package dependencies, or alter accepted native-host distribution/install identity.

## Removed legacy surface

The candidate removes the historical `FilePatchController`, `PatchApprovalStore`, `file.patch` MCP registration and opt-in configuration, the dedicated browser-spike runner, and tests whose only purpose was the retired protocol.

`GatewayHttpServerOptions`, `PrivateRuntimeOptions`, `createGateway(...)`, and `createGatewayMcpServer(...)` no longer accept or forward historical `file.patch` composition knobs.

A stale JavaScript/config caller that supplies `enableFilePatch: true` cannot resurrect a sixth MCP tool. Compile-time guards also require the generic HTTP options type to reject that option.

## Preserved contracts

The durable mutation control plane remains the only accepted mutation architecture. Its immutable reviewed record, WAG-owned caller/resource identity, existing-file-only backend, path and sensitive-file policy, local operator review, bounded deadlines, post-write hash verification, restart reconciliation, and `OUTCOME_UNKNOWN` handling are unchanged.

The default/private MCP surface remains exactly `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`. Browser Adapter v1 remains exactly `health`, `workspace.open`, and `file.read`. Durable `mutation.preview` / `mutation.result` remain opt-in internal/control-plane projection only and are not enabled on Browser or Business paths by this milestone.

MCP v1 Tasks reconnect/result recovery and cancellation denial are unchanged. Generic bearer HTTP remains available for its retained compatibility consumers.

## TDD evidence

RED was observed before production removal:

- runtime MCP surface test failed because stale `enableFilePatch: true` still produced a sixth `file.patch` tool;
- TypeScript failed with an unused `@ts-expect-error` because `GatewayHttpServerOptions` still accepted `enableFilePatch`.

After the minimal removal, the focused durable/HTTP/local-adapter/MCP/operator/backend set passed 24/24 and TypeScript typecheck passed.

## Verification evidence

On the removal candidate before docs-only receipt integration:

- `npm run typecheck` - PASS;
- focused removal/durable regression set - PASS, 24/24;
- `npm run build` - PASS;
- `npm run test:business` - PASS, 1/1;
- `npm test` - PASS, 198/198;
- `git diff --check` - PASS.

The repository test count intentionally decreased from 221 to 198 because 23 tests exclusively exercised the retired `file.patch` controller, process-memory approval store, and historical browser-spike runner. No tests were skipped or disabled.

The full suite retained Browser Admission/session ownership, exact three-tool browser isolation, durable mutation acceptance/recovery, durable verify, MCP v1 Tasks reconnect and cancellation denial, generic HTTP/default five-tool behavior, native-host artifact/distribution/install verification, path containment, secret isolation, and security regressions.

No package or lockfile changed. The MCP SDK remains exact-pinned at `1.29.0`. No registry or installed native-host state changed.

## ADR lifecycle reconciliation

ADR-0008 and ADR-0009 are retained as historical records but marked Superseded. ADR-0011 is marked Accepted because its durable reviewed-change design is implemented and verified by the Durable Mutation Control Plane acceptance and locked by ADR-0014's normative mutation contract.

## Decision

`HISTORICAL_FILE_PATCH_REMOVAL_V1 = PASS`

`LEGACY_FILE_PATCH_RUNTIME = REMOVED`

`PATCH_APPROVAL_STORE = REMOVED`

`DURABLE_MUTATION_CORE = PRESERVED`

`DEFAULT_MCP_SURFACE = FIVE_TOOLS_UNCHANGED`

`BROWSER_ADAPTER_SURFACE = THREE_TOOLS_UNCHANGED`

`MCP_V1_TASKS = UNCHANGED`

`BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`BUSINESS_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`AUTHORITY_WIDENING = NONE`

`PACKAGE_CHANGE = NONE`

`NATIVE_HOST_IDENTITY_CHANGE = NONE`
