# MutationCaller Alias Sunset v1 Acceptance Receipt

Date: 2026-09-16
Repository base: `c071f994a364c214b0e6753e0c2c098f90e015f8`
Implementation commit: `24a520f83ca858f37d04e1276968694a0efcffec`
Branch: `feat/mutation-caller-alias-sunset-v1`

## Goal

Remove the zero-consumer `MutationCaller = GatewayCallerContext` compatibility type alias after Trusted Caller Context v1 established `GatewayCallerContext` as the sole normative caller identity contract.

This is a type-surface cleanup only. It does not change runtime mutation behavior, caller authority, MCP tools, protocol negotiation, package dependencies, Browser Admission, Business stdio, native-host identity, registry state, or installed-host state.

## TDD evidence

RED was observed before the production change:

- a compile-time negative import guard expected `MutationCaller` to be absent;
- `npm run typecheck` failed with `TS2578: Unused '@ts-expect-error' directive` because the compatibility alias was still exported.

GREEN removed only the alias declaration from `src/durable-mutation.ts`. The negative import guard then compiled successfully, proving stale re-export would fail typecheck again.

## Verification evidence

On the exact implementation candidate:

- `npm run typecheck` - PASS;
- focused caller-context/durable-mutation regression - PASS, 12/12;
- `npm run build` - PASS;
- `npm run test:business` - PASS, 1/1;
- `npm test` - PASS, 193/193;
- `git diff --check` - PASS;
- `git diff --exit-code -- package.json package-lock.json` - PASS.

The full-suite count remains 193. No test was skipped or disabled.

A live-source search after the change found no `MutationCaller` reference under `src/`. Historical specs, plans, and receipts that describe the former compatibility alias remain unchanged as provenance.

## Decision

`MUTATION_CALLER_ALIAS_SUNSET_V1 = PASS`

`MUTATION_CALLER_COMPAT_ALIAS = REMOVED`

`GATEWAY_CALLER_CONTEXT = SOLE_NORMATIVE_CALLER_CONTRACT`

`DEFAULT_MCP_SURFACE = FIVE_TOOLS_UNCHANGED`

`BROWSER_ADAPTER_SURFACE = THREE_TOOLS_UNCHANGED`

`AUTHORITY_WIDENING = NONE`

`PACKAGE_CHANGE = NONE`

`NATIVE_HOST_IDENTITY_CHANGE = NONE`
