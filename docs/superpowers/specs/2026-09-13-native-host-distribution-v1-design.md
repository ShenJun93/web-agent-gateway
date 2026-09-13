# Native Host Distribution v1 — Design

Date: 2026-09-13
Status: Proposed for written review
Decision authority: ADR-0013, ADR-0014
Research basis: `docs/research/2026-09-13-native-host-distribution.md`

## Goal

Create a normal, reviewable Windows distribution path for `wag-native-host.exe` so supported-browser acceptance can consume a verified artifact without rebuilding the executable during the browser-install operation.

This milestone is a build/distribution capability, not a new execution capability. It does not authorize browser installation, HKCU registration, host execution, mutation, terminal, Git, or broader filesystem access.

## Context

The existing SEA builder and real executable test already pass locally. A later Task 10 attempt proved that the vendor-supported manual Edge extension-sideload path is viable, but a fresh local native-host build was blocked by the local safety layer before execution. The attempt stopped fail-closed and left no installation state.

The design therefore separates two concerns that were previously coupled in one acceptance run:

1. producing and identifying the reviewed native-host binary;
2. installing and exercising that binary through a supported browser host.

The first concern becomes this milestone. The second remains a separately authorized Task 10 gate.
## Design principles

The distribution path MUST be useful independently of the earlier safety block. It is part of WAG's normal release/build architecture and must remain valid if local builds later become available again.

The pipeline reuses `scripts/build-native-host.ts`; CI MUST NOT maintain a second SEA packaging implementation. The existing builder remains the single implementation seam for native-host packaging.

The artifact is traceable, not claimed bit-for-bit reproducible until separate evidence proves reproducibility across fresh runners. The contract is exact source identity plus exact produced-binary hash plus successful artifact-specific tests.

Third-party and GitHub-authored Actions are supply-chain dependencies. Every committed `uses:` entry MUST be pinned to a reviewed full commit SHA, with an adjacent comment naming the human-readable release/version used for research.

The build requires no repository secrets, browser credentials, WAG owner tokens, signing keys, or deployment credentials.

## Pipeline topology

`reviewed source commit -> Windows GitHub-hosted runner -> exact Node/npm dependencies -> existing SEA builder -> native-host tests -> executable hash + build receipt -> immutable Actions artifact`

The workflow runs on Windows x64 only in v1. macOS/Linux native hosts are outside this milestone.
## Workflow triggers and trust

The initial workflow MUST run on `pull_request` for verification and on `push` to `main` for distributable artifacts. It MUST NOT use `pull_request_target`.

Pull-request runs prove that the proposed source can build and pass the distribution-specific tests, but they do not upload a distributable native-host artifact.

Only a successful `push` run whose `github.sha` is the exact intended reviewed `main` commit may publish a Task-10-consumable artifact. Re-running that same workflow run is allowed because it preserves the source SHA; silently substituting a different branch/ref is not.

Workflow permissions are explicitly `contents: read`. No write-capable repository token operation is part of the job.

## Build environment

The workflow pins Node exactly to `24.20.0` for v1, matching the locally verified SEA runtime. Changing the native-host Node version is a reviewed distribution change and must rerun artifact acceptance.

Dependency installation uses the committed `package-lock.json` and `npm ci`. Package-manager dependency caching is disabled in v1 to reduce cache-poisoning surface and because this job is small enough not to require a cache optimization.

The build invokes the existing `scripts/build-native-host.ts` once into a clean workflow-owned output directory.
## Distribution-specific verification

The workflow MUST run `npm run typecheck` and `npm run build` plus the self-contained browser/native-host tests that do not depend on a separately provisioned DevSpace checkout.

At minimum the CI gate covers browser adapter protocol bounds, Native Messaging framing, native-host origin/session/request validation, native-host manifest identity, extension stable-id constraints, and the existing Windows SEA artifact integration test.

The workflow does not claim full repository acceptance from this subset. Full WAG gates remain required for feature integration; this subset is the artifact-publication gate.

If any distribution-specific check fails, no Task-10-consumable artifact is published from that run.
## Published artifact

A successful `main` job publishes one immutable Actions artifact named with the exact source SHA, for example `wag-native-host-windows-x64-<40-hex-sha>`.

The artifact contains the Windows native-host binary, a SHA-256 checksum file for that binary, and `build-receipt.json`. It does not contain a machine-specific Native Messaging manifest, local discovery state, browser profile, token, credential, signing key, or installer.

The final Native Messaging manifest remains generated on the target machine only after the artifact has passed local consumption verification and a separate installation authorization exists.
## Build receipt contract

`build-receipt.json` is bounded metadata and MUST contain enough information to bind the artifact to its reviewed source and packaging inputs without embedding secrets or machine-specific local state.

Minimum fields:

- schema version;
- repository identity;
- exact 40-hex source commit SHA and source ref;
- GitHub workflow run id and run attempt;
- runner OS/architecture plus available hosted-runner image identity;
- exact Node version;
- SHA-256 of `package-lock.json`;
- artifact filename and executable SHA-256;
- native application name;
- stable browser extension id;
- named verification gates that passed before publication.

Timestamps are audit metadata only and are not artifact identity. Run id, ref, or artifact name alone MUST NOT substitute for the source SHA and executable hash checks.
## Consumer verification contract

A local consumer MUST verify the artifact before any browser or registry installation step.

Verification order:

1. identify the intended reviewed WAG commit;
2. select a successful distribution workflow run for that exact `main` commit;
3. download the uniquely named artifact from that run;
4. parse the bounded build receipt and require the exact repository, source SHA, native application name, and extension id;
5. compute SHA-256 of the downloaded native-host binary and require exact equality with the receipt/checksum;
6. reject extra unexpected executable payloads or ambiguous duplicate artifacts;
7. only then allow a separately authorized installation flow to generate a local native-host manifest for the exact verified binary path.

A successful hash/provenance check does not itself authorize execution, HKCU registration, browser installation, or WAG tool exposure.

If artifact provenance, hash, stable extension identity, or source lineage is ambiguous, consumption fails closed. There is no fallback to a locally rebuilt, source-run, or differently packaged host inside the same acceptance attempt.
## Attestation and signing

GitHub Artifact Attestations are not a v1 requirement because the repository is private and private-repository attestation availability depends on GitHub Enterprise Cloud. The workflow MUST NOT request `id-token: write` or attestation permissions merely in anticipation of a feature that may not be available.

If repository/account eligibility later changes, provenance attestation may be added as an additional verification layer after separate research and review. It does not replace the executable SHA-256/source-SHA contract.

Authenticode/code signing is also deferred. v1 proves build lineage and integrity for an owned acceptance environment; it does not claim public end-user distribution readiness or SmartScreen reputation.

## Failure and cleanup behavior

Failed build/test jobs publish no consumable artifact. Partial local downloads are not installation candidates. Consumer verification failures leave HKCU and browser installation state unchanged.

Workflow artifacts are build outputs, not durable WAG runtime resources. Their retention/deletion lifecycle does not affect WAG durable identities or control-plane state.

No CI job may contact a browser profile, local WAG runtime, DevSpace owner token, or operator approval surface.
## Acceptance gate

`NATIVE_HOST_DISTRIBUTION = PASS` requires all of the following:

- the workflow is merged through normal review;
- a `main` workflow run builds from its exact recorded source SHA;
- distribution-specific tests pass on the Windows runner;
- the published artifact contains only the expected binary/checksum/receipt payload;
- the receipt binds exact source SHA, Node version, lockfile hash, extension id, native app name, and executable hash;
- a downloaded artifact can be locally verified against that receipt without rebuilding it;
- no browser profile, NativeMessagingHosts key, enterprise policy, or WAG capability is changed by this gate.

This gate does not require supported-host execution. It proves that Task 10 can begin from an identified reviewed native-host artifact rather than an ad-hoc local build.

## Relationship to Task 10

After this gate passes, supported-host acceptance may start a new separately authorized attempt using the verified distribution artifact plus the already researched vendor-supported manual unpacked-extension flow.

Task 10 still requires exact extension-id verification before native-host registration, exact per-user registration scope, read-only `health`/`workspace.open`/`file.read`, owned disposable browser state, reconnect evidence, and exact cleanup.

Any new browser-control safety block remains fail-closed. Distribution PASS never converts a browser-control block into permission to use an alternate activation mechanism.
## Non-goals

This milestone does not add an installer, auto-update service, package manager, public release channel, code-signing service, enterprise browser policy, automated extension sideload, Chrome DevTools MCP backend, or browser store publication.

It does not change the native-host protocol, LocalAdapterLink, WAG control-plane identities, filesystem policy, durable mutation lifecycle, or host-visible tool allowlist.

It does not make an unsigned binary suitable for untrusted public distribution, and it does not claim a GitHub Actions artifact is a sandbox or a security review of the executable's behavior.

## Implementation boundary

Expected implementation changes are limited to a small GitHub Actions workflow, bounded build-receipt generation/validation support, distribution-focused tests, and a benchmark/receipt after the first successful artifact run. Existing SEA packaging logic should change only if implementation evidence exposes a real portability defect.

No implementation step may write HKCU, load an extension, start a supported browser acceptance, or widen WAG authority. Those remain after the distribution gate.

## Consequence

WAG gains a reviewable native-host supply path independent of the browser acceptance harness. Browser installation can then verify and consume a named binary tied to one reviewed source commit instead of producing executable code during the installation attempt.
