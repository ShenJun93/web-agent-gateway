# WAG Full Harness v1 — Composite integration receipt

Date: 2026-09-24
Branch: feat/full-harness-integration-v1
Integration base: 5444cdb56f2579f2364fa3f662eadaf8fe24870d
Common ancestor with harness lanes: 16c13ab9a30f7a3376aa2dc70fa91916724ea725
Status: SOURCE-GREEN COMPOSITE / NOT MCP-PUBLISHED / NOT RUNTIME-PROMOTED

## Why this branch exists

WAG-Core's active worktree is intentionally not used for integration because it is concurrently
dirty. This branch starts from the latest committed autonomous-local core cut observed during the
integration pass and composes only committed full-harness slices.

No runtime live state, tunnel config, provider config or Desktop Commander state was changed.

## Integrated slices

Common browser/full-harness trunk, replayed in order:
- ca008927 feat: add isolated browser harness foundation
- c5569687 feat: harden browser profile and CDP transport
- b76daa05 feat: add dedicated Edge CDP launch plan
- cf8f6e7 feat: add owned process and Edge lifecycle
- 83e0c5b feat: add semantic browser actions
- 18e395d feat: add durable exact-once effect ledger
- 678be94 feat: add artifact-backed browser upload
- ce53368 feat: add browser download and Notebook99 acceptance contract
- e6c7655 fix: pin command execution to workspace root

Satellite slices:
- 35ffbc0 process recovery identity
- f5f9cb0 fail-closed CDP download driver
- 9e68153 semantic DesktopPort foundation
- f013479 audio and speech harness foundation
- 64e95dd host-side credential broker foundation
- fd57503 sandbox attestation foundation
- 27a0d7a harness trace context and observability
- a8b7a8b MCP trace propagation bridge

All cherry-picks applied cleanly on the committed autonomous-local core. No manual conflict
resolution was required.

## Measured gates

Repository source build:

```text
npm run build
PASS
```

Browser / semantic / upload / download:

```text
35 tests
35 pass
0 fail
```

Notebook99 contract / effect ledger / artifact / process / recovery / command-root / core authority:

```text
52 tests
52 pass
0 fail
```

Desktop / audio / credential / sandbox / observability:

```text
46 tests
46 pass
0 fail
```

Composite focused gate:

```text
133 tests
133 pass
0 fail
```

Whole-repository `npm run typecheck` on the clean integration worktree is not green solely because
the fresh worktree lacks the dev dependency/type resolution for `resedit` used by
scripts/native-host-pe-metadata.ts. Repository source build is green and no full-harness diagnostic
is emitted. No dependency install/package mutation was performed merely to mask that environment
condition.

## Composite architecture now present in source

- autonomous-local workspace/file/command/git foundation;
- BrowserPort, dedicated profile ownership and raw CDP transport;
- owned Edge process lifecycle and semantic DOM actions;
- artifact-backed upload and fail-closed download capture;
- Notebook99 exact-once acceptance contract;
- ProcessPort plus durable Windows process recovery identity;
- DesktopPort semantic-control foundation;
- AudioPort + SpeechPort foundation;
- host-side CredentialBroker;
- SandboxPort attestation/policy foundation;
- durable effect ledger and idempotency;
- W3C trace context, local HarnessTracer and MCP propagation bridge.

## Non-claims

This branch does not claim:
- public MCP tools for the new harness ports;
- server.ts integration;
- a live browser launch;
- authenticated Notebook99 execution;
- live UI Automation desktop execution;
- live audio capture;
- live microVM sandbox backend;
- live credential provider binding;
- production OpenTelemetry exporter;
- runtime promotion.

The new ports remain source-level capabilities until a later single-writer integration slice exposes
them through an accepted MCP surface and runs live acceptance.

## Next integration gate

1. Wait for the active WAG-Core worktree to commit or discard its concurrent dirty changes.
2. Fresh-read the new committed core HEAD.
3. Rebase this branch onto that HEAD.
4. Re-run build + the 133-test composite gate.
5. Add MCP publication/integration in a dedicated single-writer slice.
6. Fresh-read E:/AI-BROWSER/PLAYWRIGHT_HANDOFF.md.
7. Run live owned-browser acceptance, then Notebook99 exact-once H3 acceptance.
8. Only after live acceptance, consider runtime promotion.

Do not merge uncommitted bytes from any parallel worktree into this candidate.

## Rebase refresh — 2026-09-25

The composite was rebased from the preserved candidate
`0a81c428527efc3b887db542b9365ae12d5eca5e` onto the newer committed WAG-Core base:

```text
ac4daf2e20cab4e44623b0359d6728dd221e2772
```

A local safety ref preserves the pre-rebase candidate:

```text
safety/full-harness-pre-rebase-0a81c428
```

The rebase replayed 18 commits and completed without conflict. No bytes from the dirty active
WAG-Core worktree were merged into this integration worktree.

Two integration-only test compatibility fixes were then committed:

- type the CredentialBroker denial fixtures as `CredentialRequest[]`, preserving production broker
  behavior while satisfying the newer core TypeScript environment;
- align the DC replacement acceptance tool inventory with the current 43-tool private-stdio surface.

The worktree dependency environment was synchronized from the existing lockfile with
`npm ci --ignore-scripts`; this changed no tracked package metadata.

Fresh gates on the rebased candidate:

```text
npm run build       PASS
npm run typecheck   PASS
git diff --check    PASS

Full Harness changed test files:
117 / 117 PASS

Current autonomous-local/core regression batch:
16 / 16 PASS

Composite:
133 / 133 PASS
0 FAIL
```

The 16-test current core batch is:

```text
test/activation-step.test.ts
test/autonomous-local-policy.test.ts
test/direct-mcp-readiness.test.ts
test/workspace-identity-effect-revalidation.test.ts
```

The long-form `test/dc-replacement.acceptance.ts` was updated to expect the current 43-tool
surface. A complete runtime result is not claimed here because WAG `command.run` has a 30-second
execution ceiling and the long acceptance exceeds that observation window. Its surface contract is
covered by the green direct-MCP regression above.

This refresh still makes no claim of Full Harness MCP publication, live owned-browser acceptance,
Notebook99 live execution, or runtime promotion. The next source action is the dedicated
single-writer MCP publication/integration slice.

