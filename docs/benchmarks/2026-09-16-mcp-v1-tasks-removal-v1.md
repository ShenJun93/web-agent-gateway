# MCP v1 Tasks Removal v1 Acceptance Receipt

Date: 2026-09-16
Repository base: `582b27c178c71f6c58ec09460a33619714e9a690`
Implementation commit: `9569230f901f84f4cb804990df816c593e745e5c`
Branch: `feat/remove-mcp-v1-tasks-v1`

## Goal

Remove the historical MCP SDK v1 experimental Tasks compatibility seam while preserving the existing synchronous `verify.run` contract and all accepted WAG authority boundaries.

This milestone does not upgrade `@modelcontextprotocol/sdk`, migrate to the MCP Tasks extension, remove generic bearer HTTP, expose durable jobs to current hosts, add cancellation, or widen tool authority.

## Removed compatibility surface

The candidate removes `NonCancellingTaskStore`, `InMemoryTaskStore`/`TaskStore` composition, `server.experimental.tasks.registerToolTask(...)`, advertised Tasks capabilities, `tasks/get` / `tasks/result` / `tasks/cancel` recovery tests, and the historical transport-interruption Tasks harness.

`verify.run` is now registered as an ordinary MCP tool. Under SDK 1.29.0 its tool metadata reports `execution.taskSupport = forbidden`, which explicitly prevents the retired v1 Tasks contract.

Stdio and generic bearer HTTP no longer allocate or clean up an MCP TaskStore. Generic bearer HTTP itself remains available and is not removed by this milestone.

## Preserved behavior

Default/private MCP remains exactly `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`.

Browser Adapter v1 remains exactly `health`, `workspace.open`, and `file.read`.

An ordinary MCP client continues to call `verify.run` synchronously and receives the same bounded structured result containing profile, exit code, and output.

The accepted Durable Verify Job Core remains unchanged and continues to own durable identity, storage, restart reconciliation, bounded result persistence, and unknown-outcome classification independently from MCP transport state.

The accepted durable mutation core, Browser Admission, native-host distribution/install contracts, path policy, secret isolation, and telemetry boundaries are unchanged.

## TDD evidence

RED was observed before production removal:

- MCP surface regression failed because `verify.run` still advertised `execution.taskSupport = optional`;
- TypeScript failed with an unused `@ts-expect-error` because stdio options still accepted TaskStore injection.

After the minimal removal, SDK 1.29.0 normalized ordinary `registerTool` metadata to `taskSupport = forbidden`; the regression was tightened to that explicit non-Tasks contract.

A direct generic-HTTP regression proves an ordinary non-task client still opens a workspace and receives the synchronous `verify.run` result.

## Verification evidence

On the removal candidate:

- `npm run typecheck` — PASS;
- focused MCP/HTTP/stdio/synchronous verify regression — PASS, 8/8;
- `npm run build` — PASS;
- `npm run test:business` — PASS, 1/1;
- durable mutation/verify regression — PASS, 20/20;
- `npm test` — PASS, 195/195;
- `git diff --check` — PASS.

The full-suite count decreases from 198 to 195 because four tests dedicated to the retired v1 Tasks store/reconnect/cancel behavior were removed and one direct synchronous `verify.run` regression was added. No tests were skipped or disabled.

No package or lockfile changed. The SDK remains exact-pinned at `1.29.0`. No registry, installed native-host state, accepted native-host distribution identity, or browser capability changed.

## ADR lifecycle reconciliation

ADR-0006 is retained as a historical record but marked Superseded. ADR-0016 is updated only to reflect that durable verify-job semantics are independent from the now-retired transport-scoped TaskStore projection.

## Decision

`MCP_V1_TASKS_REMOVAL_V1 = PASS`

`MCP_V1_EXPERIMENTAL_TASKS = REMOVED`

`VERIFY_RUN_SYNC_CONTRACT = PRESERVED`

`DURABLE_VERIFY_JOB_CORE = PRESERVED`

`GENERIC_BEARER_HTTP = PRESERVED_PENDING_SEPARATE_GATE`

`DEFAULT_MCP_SURFACE = FIVE_TOOLS_UNCHANGED`

`BROWSER_ADAPTER_SURFACE = THREE_TOOLS_UNCHANGED`

`MCP_V2_PRODUCTION_MIGRATION = DEFER`

`AUTHORITY_WIDENING = NONE`

`PACKAGE_CHANGE = NONE`

`NATIVE_HOST_IDENTITY_CHANGE = NONE`
