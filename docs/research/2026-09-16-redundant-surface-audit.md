# Redundant Surface Audit

Date: 2026-09-16
Status: empirical/read-only audit; no production implementation change
Repository base: `fa44f3167f664600f63fb9e3ef92f996c00efe81`

## Question

After the current-market re-benchmark and multi-host conformance gate, identify which WAG surfaces remain current product/core boundaries, which are retained compatibility/safety contracts, which are historical test harnesses, and which are genuinely redundant enough to justify one bounded consolidation change.

This audit does not authorize deletion, capability growth, authority changes, package upgrades, browser mutation, Process Manager work, or MCP v2 production migration.

## Method

The audit fresh-read canonical Git state, production entrypoints, imports/call sites, package scripts, build scope, GitHub native-host workflow, current tests, accepted ADRs/specs, and benchmark/research receipts.

Each surface was classified as one of:

- `KEEP_CURRENT_CORE`
- `KEEP_COMPATIBILITY_BOUNDARY`
- `HISTORICAL_TEST_ONLY`
- `REDUNDANT_CANDIDATE`
- `UNKNOWN_NEEDS_EVIDENCE`

Reachability alone was not treated as deletion authority. Accepted safety/control-plane contracts remain valid even when not currently projected through a host.
## Current core surfaces

### Default private stdio — `KEEP_CURRENT_CORE`

`src/cli.ts -> src/stdio-server.ts -> createGatewayMcpServer` is the current private host path. The accepted Business stdio test and the Codex/Claude/Gemini conformance spike depend on it.

Its default five-tool semantic surface remains exactly `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`.

### Browser admitted path — `KEEP_CURRENT_CORE`

`scripts/browser-adapter-runtime.ts` composes WAG admission, durable workspace ownership, loopback HTTP admission/MCP routing, and the native/browser adapter. Its server-side surface remains exactly `health`, `workspace.open`, and `file.read`.

The accepted Trusted Adapter Admission and supported-host evidence make this a live product boundary, not historical browser infrastructure.

### Native-host distribution and installation — `KEEP_CURRENT_CORE`

The native-host SEA builder, distribution package/verifier, installation preparation/verifier, native manifest identity, and `Native Host Distribution` GitHub workflow remain active acceptance/release machinery.

The workflow still builds and tests the exact native-host candidate on pull requests and packages/verifies/uploads on `main` pushes. Removing or weakening it requires a separate release/CI decision.
## Compatibility and safety boundaries

### MCP v1 experimental Tasks — `KEEP_COMPATIBILITY_BOUNDARY_PENDING_EVIDENCE`

`src/task-store.ts`, `src/stdio-server.ts`, `src/http-server.ts`, and `src/server.ts` still implement the accepted optional-task projection for `verify.run`. Current tests prove synchronous non-task clients, reconnect result recovery, and fail-closed cancellation semantics.

ADR-0006 remains Accepted, while the newer MCP v2 compatibility receipt establishes that this v1 experimental seam is not wire-compatible with the `io.modelcontextprotocol/tasks` extension. The official TypeScript SDK implementation tracker remains the upstream dependency to revisit before migration.

Removing the v1 Tasks projection is therefore not justified by this audit.

### Generic bearer HTTP mode — `KEEP_COMPATIBILITY_BOUNDARY_PENDING_TASKS_DECISION`

The non-browser `startGatewayHttpServer({ gateway, bearerToken })` mode is no longer the preferred deployment path: Business uses stdio and Browser Adapter v1 uses admission mode. Quick Tunnel is historical benchmark infrastructure.

However, the generic HTTP mode still carries accepted v1 Tasks reconnect tests and historical transport evidence. Delete/consolidate it only with the Tasks compatibility decision, not as incidental cleanup.

### Durable verify core — `KEEP_CURRENT_CORE`

`DurableVerifyJobCoordinator` has no production composition call site today, by design. ADR-0016 and its acceptance receipt explicitly accept it as WAG-owned durable state independent of MCP Tasks and authorize only later separately reviewed projections.

Zero current host projection is therefore not evidence of redundancy.
### Durable mutation core — `KEEP_CURRENT_CORE`

The durable mutation state machine, SQLite ownership, local operator review, backend port, and restart reconciliation are accepted safety/control-plane contracts under ADR-0014 and the durable mutation acceptance receipt.

Default/Business/browser mutation projection remains unauthorized, but the core is not superseded merely because market evidence froze capability growth.

### Historical `file.patch` — `REDUNDANT_CANDIDATE_BLOCKED_BY_UNSATISFIED_CLEANUP_GATE`

The old opt-in `file.patch` protocol is compatibility-only and is enabled only by the historical browser spike runner. The durable mutation control plane is the newer design.

However, the canonical durable-mutation receipt explicitly says the supported-browser-host mutation gate remained `BLOCKED_FAIL_CLOSED` and did not authorize removal of the historical protocol. This audit does not override that gate.

## Historical-only harnesses

`benchmark-gateway.ts` and `transport-interruption.ts` are retained benchmark/recovery harnesses; Quick Tunnel is no longer current production transport. The historical `file-patch-browser-spike.ts` and `durable-mutation-browser-spike.ts` runners are likewise acceptance/reproducibility harnesses rather than current host entrypoints.

Classification: `HISTORICAL_TEST_ONLY`.

Deleting historical harnesses is not selected because preserving reproducibility costs little and produces no meaningful thin-gateway simplification.
## Selected redundant candidate

### Browser runtime generic internal bearer — `REDUNDANT_CANDIDATE`

The browser runtime currently generates `internalBearerToken` and passes it as `bearerToken` while also enabling `browserAdmission`.

In `startGatewayHttpServer`, browser-admission mode branches before generic bearer routing and returns after `handleBrowserRequest`. The generic bearer is therefore never consulted on that runtime's request path.

This exact condition was already retained as Minor finding 6 during Trusted Adapter Admission source acceptance: the browser runtime keeps an unreachable generic internal bearer while admission mode handles all requests.

The discovery record contains only `admissionUrl` plus bootstrap token; browser/native code never receives the generic bearer. Current admission tests also pass a legacy bearer only because the HTTP options shape requires one, not because admitted routing consumes it.

The smallest consolidation is therefore to make the two HTTP composition modes explicit and remove the unreachable generic bearer from browser-admission composition while preserving generic bearer HTTP behavior unchanged.

This candidate does not delete `http-server.ts`, does not change admitted bootstrap/session credentials, and does not change any tool or authority surface.

## Baseline verification

On exact base `fa44f3167f664600f63fb9e3ef92f996c00efe81`, the full suite completed 221 tests with 220 pass / 1 fail. The only failure was `pinned DevSpace process listens only on Windows loopback` because `startPinnedDevspace()` exceeded its 30-second readiness deadline; the assertion never reached the listener check.
The full run lasted about 851 seconds and the failed fixture took about 31.4 seconds. After that load ended, the exact Windows loopback test was rerun three times and passed 3/3, with observed test durations about 3.64 s, 4.46 s, and 3.71 s.

This is recorded as a load/startup transient, not a listener-policy regression. No source was changed between runs.

Additional baseline evidence:

- `npm run typecheck` — PASS
- `npm run test:business` — PASS, 1/1
- exact `pinned DevSpace process listens only on Windows loopback` test repeated independently — PASS, 3/3
- canonical Git state remained unchanged except the pre-existing untracked `.playwright-cli/` artifact

## Decision

The repository contains historical and compatibility surfaces, but evidence does not justify broad deletion. In particular, accepted durable control-plane cores and the v1 Tasks compatibility seam must not be removed merely to reduce file count.

One bounded cleanup is justified: discriminate generic bearer HTTP from browser-admission HTTP and remove the unreachable browser-runtime generic bearer. Implementation remains a separate task requiring its own design/approval and full regression evidence.

No other production consolidation is authorized by this audit.

`REDUNDANT_SURFACE_AUDIT = PASS`

`AUTHORITY_WIDENING = NONE`

`TOOL_SURFACE_WIDENING = NONE`

`PRODUCTION_MUTATION = NONE`
`MCP_V1_TASKS = KEEP_COMPATIBILITY_BOUNDARY_PENDING_EVIDENCE`

`GENERIC_BEARER_HTTP = KEEP_COMPATIBILITY_BOUNDARY_PENDING_TASKS_DECISION`

`DURABLE_VERIFY_CORE = KEEP_CURRENT_CORE`

`DURABLE_MUTATION_CORE = KEEP_CURRENT_CORE`

`HISTORICAL_FILE_PATCH = REDUNDANT_CANDIDATE_BLOCKED_BY_UNSATISFIED_CLEANUP_GATE`

`QUICK_TUNNEL_AND_BROWSER_SPIKE_RUNNERS = HISTORICAL_TEST_ONLY`

`NATIVE_HOST_DISTRIBUTION_INSTALL = KEEP_CURRENT_CORE`

`NEXT_CONSOLIDATION_CHANGE = DISCRIMINATE_HTTP_MODES_AND_REMOVE_UNREACHABLE_BROWSER_GENERIC_BEARER`
