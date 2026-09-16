# Native Host Publication Trigger Narrowing v1 Acceptance Receipt

Date: 2026-09-17
Gate: `NATIVE_HOST_PUBLICATION_TRIGGER_NARROWING_V1 = PASS`
Implementation base: `9ea2d41667cea076052177ee4a0e3dff3896b2f1`
Implementation commit: `ecefc14bee68123437f2bb81b5105279d1d35fda`
Implementation merge: `ad6e724df340e24753154a64f5b5a5c42e8ac0fc`
Implementation PR: `#28`
Receipt branch: `docs/native-host-publication-trigger-narrowing-v1`

## Goal

Stop docs-only, tests-only, and other native-host-irrelevant pushes to `main` from minting source-SHA-only Native Host Distribution artifacts, while keeping every pull request to `main` on the existing native-host validation workflow.

The change is release-trigger narrowing only. It does not alter the native-host runtime, distribution format, installation contract, registered host, Browser Admission authority, Business authority, or protocol defaults.

## Pre-change evidence

The docs-only Supported Browser Successor Validation receipt merged as `9ea2d41667cea076052177ee4a0e3dff3896b2f1` and still triggered the `Native Host Distribution` main-push workflow.

That run was `35144038221` and published artifact `10466423060`, even though the repository change was documentation-only. The artifact carried a new source SHA while its native-host executable remained byte-identical to the already accepted host.

This demonstrated release-identity churn without a native-host runtime change.

## Accepted trigger contract

Pull-request validation remains unfiltered:

- `pull_request` targets `main` with no `paths` filter;
- permissions, Windows runner, immutable action pins, build steps, tests, and publication conditions remain unchanged.

Only `push` to `main` is path-filtered. Its exact publication input allowlist is:

- `.github/workflows/native-host-distribution.yml`;
- `browser/native-host/**`;
- `src/browser-adapter/**`;
- `scripts/build-native-host.ts`;
- `scripts/package-native-host-distribution.ts`;
- `scripts/verify-native-host-distribution.ts`;
- `package.json`;
- `package-lock.json`;
- `tsconfig.json`;
- `tsconfig.build.json`.

Documentation, tests-only changes, and browser-extension UI files are intentionally outside this main-push publication allowlist.

## TDD evidence

The exact `origin/main` baseline was `9ea2d41667cea076052177ee4a0e3dff3896b2f1`.

Before production mutation, the focused workflow suite passed `3/3` and full `npm test` passed `193/193`, with zero failures and zero skips.

RED added a regression contract requiring the exact `push.paths` allowlist while asserting that `pull_request` stays unfiltered. Against the unchanged workflow it failed `3 pass / 1 fail` with `push trigger must use the exact native-host publication input allowlist`.

GREEN added only the eleven workflow lines needed for the approved filter. The focused suite then passed `4/4`.

Post-change local verification on the exact implementation tree passed:

- `git diff --check`;
- `npm run typecheck`;
- `npm run build`;
- `npm run test:business` - `1/1`;
- `npm test` - `194/194`, fail `0`, skipped `0`.

The implementation commit changed exactly two files with 38 insertions and no deletions: the workflow and its regression contract.

## Pull-request and main-push evidence

PR `#28` held exact head `ecefc14bee68123437f2bb81b5105279d1d35fda`, two changed files, and no review threads or scope drift.

PR workflow run `35154425996` completed successfully: checkout, setup, dependency install, typecheck, TypeScript build, focused distribution tests, native-host publish-candidate build, and exact publish-candidate test all passed. Package, verify, and upload were correctly skipped for the pull-request event.

PR `#28` merged with an expected-head guard as `ad6e724df340e24753154a64f5b5a5c42e8ac0fc`.

Because the workflow file itself is an accepted publication input, that merge correctly triggered one final main-push publication run: `35154563950`, run number `45`.

Main-push run `35154563950` completed successfully through package, distribution verification, and upload. It published exactly one artifact:

- artifact id: `10469943439`;
- artifact name: `wag-native-host-windows-x64-ad6e724df340e24753154a64f5b5a5c42e8ac0fc-attempt-1`;
- artifact digest: `sha256:7abddbfc9111f3b04fc5b65b416bc7a05f7a7e7c7ae960001ec9f646cd7e0108`.

This artifact is publication evidence only. It is not accepted for installation by this gate and does not replace the currently registered accepted native host.

## Decision

`NATIVE_HOST_PUBLICATION_TRIGGER_NARROWING_V1 = PASS`

`PULL_REQUEST_VALIDATION = UNFILTERED`

`MAIN_PUSH_PUBLICATION = EXACT_PATH_FILTERED`

`DOCS_ONLY_PUBLICATION = DISABLED`

`TESTS_ONLY_PUBLICATION = DISABLED`

`NATIVE_HOST_RUNTIME_CHANGE = NONE`

`INSTALLATION_MUTATION = NONE`

`REGISTRY_MUTATION = NONE`

`AUTHORITY_WIDENING = NONE`

`PROTOCOL_DEFAULT_CHANGE = NONE`

`POST_MERGE_DOCS_ONLY_NEGATIVE_PROOF = REQUIRED_BEFORE_INTEGRATION_CLOSE`

The merge of this receipt is intentionally documentation-only. Its resulting `main` SHA must have zero `Native Host Distribution` workflow runs before this integration is considered closed.
