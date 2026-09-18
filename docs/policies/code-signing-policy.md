# Code signing policy

## Current status

Web Agent Gateway is preparing a public Windows code-signing path. No current WAG release should be treated as Authenticode-trusted unless its release notes explicitly say otherwise and the signature verifies independently.

The intended zero-cost signing provider is SignPath Foundation. This document does not claim SignPath acceptance before that acceptance exists.

## Signing scope

Only WAG-owned release artifacts may be submitted for WAG signing.

The Windows native-host signing scope is the exact release candidate `wag-native-host.exe` produced by the reviewed native-host build pipeline. Upstream third-party executables are not independently re-signed as WAG artifacts.

## Roles and approval

The project maintainer acts as Author and release Approver unless a future governance change assigns those responsibilities separately.

Every signing request requires an explicit manual approval event. A Git push, merge, CI success, tag, or artifact upload does not itself authorize signing.

Untrusted pull-request jobs must not receive signing authority or signing credentials.

## Build provenance

Native-host signing must consume an artifact produced by the repository's reviewed GitHub-hosted Windows build.

The build records source identity and executable hashes before signing. After signing, WAG independently verifies the signed artifact and must reject trust-chain, algorithm, hash-continuity, or execution-probe failures.

## Official releases

Only assets attached to the project's official GitHub Releases are release artifacts.

GitHub Actions artifacts are build evidence and are not supported releases unless an official release explicitly promotes the exact bytes.

## Verification target

The accepted Windows signature must use SHA-256 Authenticode and an RSA code-signing certificate chaining to a Windows-trusted public root. Timestamping is required by the final provider profile.

The project will not weaken these checks to accommodate a signer.
