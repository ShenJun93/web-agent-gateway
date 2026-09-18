# Unsigned Preview Release Preparation v1 - 2026-09-18

## Scope

This receipt freezes the pre-public release preparation for Web Agent Gateway Native Host `0.1.0` without creating or publishing any release object.

Explicitly selected under current authority:
- product version: `0.1.0`;
- preview tag name: `v0.1.0-preview.1`;
- preview tag target/source candidate: `c1eb195f54864dee1a8997c9baeb0475ce627da6`.

Not performed or authorized by this receipt:
- repository visibility change;
- Git tag creation or push;
- GitHub Release creation/publication;
- immutable-release setting changes;
- SignPath contact/application/project creation;
- MFA/account changes;
- OIDC, credentials, signing, or provider mutation.

## Authoritative source candidate

Remote `main` candidate:
- source SHA: `c1eb195f54864dee1a8997c9baeb0475ce627da6`;
- product version: `0.1.0`;
- PE Product/FileVersion: `0.1.0.0`;
- main workflow run: `35345822405` attempt `1` - SUCCESS;
- exact main readiness with downloaded candidate receipt + signing-input EXE: `publicationReady=true`, `releaseReady=true`, `blockers=[]`;
- flat/pre-sign executable SHA-256: `3a07d599b5ee06d9eaa90a83e9b81f58386f55f383d0d04f5fa04038d02ac8e2`;
- Authenticode/catalog SHA-256: `73de2fbbfe7569478b75ce4ecffdc39503107b47145c792e53ada5cf61ea525d`;
- signature state: `NotSigned`.

The preparation branch changes only release/research metadata, tests, and workflow validation. It does not modify any `NATIVE_HOST_BUILD_INPUTS` entry, so it does not supersede the `c1eb195f` candidate.

## Workflow artifacts

Candidate evidence:
- artifact id: `10546094325`;
- name: `wag-native-host-candidate-evidence-c1eb195f54864dee1a8997c9baeb0475ce627da6-attempt-1`;
- artifact digest: `sha256:8d29063f619868db3696c766e6c308315a6bd3667af8165cc0afb05c90d1cf88`.

Signing input:
- artifact id: `10545804630`;
- name: `wag-native-host-signing-input-c1eb195f54864dee1a8997c9baeb0475ce627da6-attempt-1`;
- artifact digest: `sha256:4a71705fd74824022507b01b526ed225b522b6304ffb254965ac3cd9bf0b5420`.

Distribution:
- artifact id: `10545824818`;
- name: `wag-native-host-windows-x64-c1eb195f54864dee1a8997c9baeb0475ce627da6-attempt-1`;
- artifact digest: `sha256:c90c404b3ff0b224f8d92742f5cf3e908861888bac9b4613aa4832ef72acfd8d`.

## Frozen unsigned preview asset

Selected filename:

`web-agent-gateway-native-host-windows-x64-0.1.0-preview.1-UNSIGNED.zip`

Deterministic packaging rehearsal from the exact verified main distribution was run twice and produced byte-identical output:
- SHA-256: `3f31ebe7258803aaf44194c05c4ae0ce241f7f2849507f7c0f153b129264e733`;
- size: `35,173,661` bytes;
- entry count: `18`.

The package contains the unchanged verified three-file native-host distribution plus project/runtime/dependency license material and public install/security/privacy/code-signing documentation.

Concrete machine-readable release facts are frozen in `docs/releases/v0.1.0-preview.1.json`. The intended GitHub prerelease body is frozen in `docs/releases/v0.1.0-preview.1.md`. Neither file contains release placeholders.

## Pre-public exposure state

Refreshed live GitHub facts:
- repository visibility: private;
- GitHub-detected license: Apache-2.0;
- Git tags: none;
- GitHub Releases: none;
- repository rulesets: none;
- immutable releases: disabled;
- unexpired Actions artifacts: 29.

Refreshed Gitleaks 8.30.1 all-history scan of exact `main`:
- 257 commits scanned;
- two generic-key detections;
- both detections match previously triaged public/non-secret material (the Chromium extension public key and provenance/hash documentation);
- no credential/private-key finding was identified.

Historical unsigned Actions artifacts remain unsupported build evidence. They are not release assets.

### Post-merge reconciliation

The pre-public exposure counts above are the preparation-time snapshot and remain part of this historical receipt. After PR #36 merged, exact remote `main` became `b1576de8e1d74ef6894621d53df9b0309dd6685f`.

SHA-anchored read-only reconciliation on 2026-09-18:
- at audit baseline `b1576de8e1d74ef6894621d53df9b0309dd6685f`, 32 unexpired Actions artifacts were present, with the exact `c1eb195f` candidate/evidence/signing-input artifacts still expiring on 2026-10-02;
- Gitleaks 8.30.1 on exact `b1576de8e1d74ef6894621d53df9b0309dd6685f` scanned 258 commits and reported five `generic-api-key` detections;
- after the evidence-reconciliation merge, fresh full-clone and all-ref scans anchored at `31e76668139e4cc5c742520482fe6743bd91f7e8` each scanned 259 commits and reported the same five detections;
- three detections are the same public preview Authenticode SHA-256 in release metadata/tests, one is a historical Authenticode SHA-256, and one is the stable Chromium extension public key;
- no credential or private-key finding was identified.

These counts are intentionally tied to immutable commit SHAs rather than described as the dynamic current branch state. This reconciliation does not change the frozen preview tag target, source candidate, ZIP bytes, hashes, release notes, or release identity.

### Post-public cutover reconciliation — 2026-09-19

Live public state after the authorized cutover and security hardening:
- remote `main=b83ba368b990d7518ef430929e77f30d99ca89d5`;
- repository visibility: public;
- anonymous repository, license, README, security, privacy, code-signing, installation/removal, Actions, and Releases access verified;
- Git tags: none; GitHub Releases: none;
- immutable releases: enabled;
- active `main` ruleset blocks deletion and non-fast-forward updates only;
- private vulnerability reporting: enabled;
- Dependabot alerts: enabled with automated security-update PRs disabled;
- secret scanning + repository push protection: enabled, with zero open secret-scanning alerts at reconciliation time;
- fork-PR workflow approval policy: `all_external_contributors`;
- 32 active Actions artifacts remain build evidence;
- exact `c1eb195f` candidate/evidence/signing-input artifacts remain active until 2026-10-02;
- all 69 historical Actions run logs were scanned after publication with zero Gitleaks findings.

The pre-public snapshots above remain historical receipts and are intentionally not rewritten. No post-public setting change altered the frozen preview tag target, source candidate, ZIP bytes, hashes, release notes, or release identity.

### Post-release reconciliation - 2026-09-19

Live release state:
- remote `main=c37e1e1977d3cd5ed0edb276eb407112a539606e` before this reconciliation branch;
- tag `v0.1.0-preview.1` exists at exact `c1eb195f54864dee1a8997c9baeb0475ce627da6`;
- GitHub release ID `391834069` is published as an immutable prerelease;
- release ZIP SHA-256 is `3f31ebe7258803aaf44194c05c4ae0ce241f7f2849507f7c0f153b129264e733`;
- release and asset attestations independently verify the exact tag commit and ZIP digest;
- the published release notes identify the preview as unsigned and not Authenticode-trusted;
- the supported download is the immutable GitHub Release asset, not an Actions artifact;
- the live asset counter includes project-owner verification downloads and is not treated as external-user/reputation evidence.

## Remaining gates before SignPath application

Hard pre-submission gate:
1. GitHub MFA confirmation.

Application/provider gates:
1. separate explicit authority for SignPath submission;
2. neutral provider determination of the Node SEA own-binary versus modified-upstream question.

Provider-discretion risks:
- SignPath publishes no numeric executable-project reputation threshold;
- WAG's public history is still very young;
- Node SEA ownership treatment remains a provider-specific question and should be asked neutrally during eligibility review.

Do not manufacture stars, downloads, contributors, public age, or provider acceptance evidence.

## Release identity invariant

The selected preview tag must not later be reused for signed bytes. A future signed stable release requires a distinct release identity and must pass the existing signed-candidate verifier without relaxing RSA, public trust, SHA-256 Authenticode continuity, timestamp, or execution requirements.