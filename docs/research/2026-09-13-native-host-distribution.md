# Native Host Distribution Research — 2026-09-13

Status: advisory research receipt for design promotion
Scope: Windows WAG browser native-host packaging/distribution and supported-host acceptance prerequisites

## Trigger

Task 10 browser acceptance proved that manual vendor-supported Edge sideload is viable, but fresh local production of `wag-native-host.exe` was blocked by the local safety layer before execution. The block was respected fail-closed; no alternate shell, source-run host, synthetic Native Messaging path, or HKCU registration was used.

The question for this research is whether WAG can establish a normal, reviewable native-host distribution path whose artifacts can later be consumed by Task 10 without treating CI as a workaround around the local safety block.

## Current project facts

- The repository is private and currently has no `.github/workflows` directory.
- `scripts/build-native-host.ts` already implements the Windows Node SEA build and is covered by `test/native-host-artifact.test.ts`.
- The browser adapter stable extension id is `nnhhhppkpogkedpjnijeagcbfjaoogec`.
- The native application name is `com.openai.web_agent_gateway`.
- The local verified Node runtime is `24.20.0`; the current SEA builder targets Node 24.
- The fresh isolated-worktree baseline on merged `main` passed 117/117 tests.
## Official-source findings

### Node SEA

Node 24 documents Windows single-executable applications by generating an SEA blob, copying `node.exe`, and injecting `NODE_SEA_BLOB` into that executable. WAG already follows this architecture with `esbuild` plus `postject`; no second packaging implementation is required.

Source: https://nodejs.org/api/single-executable-applications.html

### GitHub Actions supply-chain guidance

GitHub's Secure Use reference states that actions should be pinned to a full-length commit SHA; this is the immutable way to consume an action release. A new WAG workflow should therefore not rely on mutable major tags such as `@v7` as its committed trust anchor.

Source: https://docs.github.com/en/actions/reference/security/secure-use

`actions/setup-node` supports exact Node versions and recommends explicitly specifying a version instead of relying on the runner image. For this milestone, the artifact build should pin Node `24.20.0` and disable package-manager caching because the build is small and should avoid unnecessary cache trust.

Source: https://github.com/actions/setup-node
### GitHub build artifacts

Current `actions/upload-artifact` uses immutable artifact archives for a completed upload. That is suitable for a bounded distribution artifact containing the executable plus an independently computed executable SHA-256 and a build receipt. The artifact archive digest is useful transport evidence, but the WAG consumer should still verify the executable hash recorded inside the receipt.

Source: https://github.com/actions/upload-artifact

### Artifact attestations

GitHub Artifact Attestations establish where and how a build was produced, but private/internal repository support requires GitHub Enterprise Cloud. The current repository is private, so v1 MUST NOT assume attestations are available. If the account later qualifies, attestation can be layered on without changing the base artifact contract.

Source: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations

### Browser/native-host boundary

Edge Native Messaging still uses a native-host manifest with a local executable path and exact extension origins. The distribution artifact should therefore contain the executable and provenance metadata, not a machine-specific final Native Messaging manifest. That manifest remains generated locally after the executable has been placed at its exact accepted path.

Source: https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging
## Recommended interpretation

A CI distribution pipeline is acceptable only if it is promoted as a normal WAG build/distribution capability with its own tests and provenance contract. It must not exist merely to evade a local safety control that blocked an ad-hoc acceptance build.

The clean v1 design is:

`reviewed source -> Windows GitHub Actions build -> native-host artifact test -> SHA-256 + build receipt -> immutable Actions artifact`

A later supported-host acceptance may consume that artifact only after proving the workflow run source SHA is the intended reviewed `main` commit and the downloaded executable hash matches the receipt. Browser installation and HKCU registration remain separately authorized operational actions.

## Security constraints carried into design

- `pull_request_target` is not required and should not be introduced.
- Workflow permissions stay read-only except capabilities intrinsically needed to upload the run artifact.
- No repository or environment secrets are required for the build.
- All reusable actions are pinned to reviewed full commit SHAs.
- No dependency cache is required in v1.
- The workflow reuses the repository's existing SEA builder rather than implementing another packager.
- Build metadata is evidence, not execution authority; downloading an artifact does not authorize installation or execution.
- Artifact Attestations and Authenticode signing are future hardening layers, not v1 prerequisites.

## Research conclusion

Proceed with a small `Native Host Distribution v1` subsystem. Its first acceptance gate is build/distribution integrity only. It does not change browser authority, WAG tool exposure, mutation authority, terminal/Git authority, HKCU state, or provider integration.
