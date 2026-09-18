# First Public Native-Host Release Sequencing — 2026-09-18

Status: research/design only. This document does not select a release version, create a tag/release, enable GitHub settings, or authorize SignPath submission.

## Problem

SignPath Foundation requires the project to already be released in the form that should be signed.

WAG also needs release provenance that does not silently replace previously published unsigned bytes with signed bytes under the same release identity.

GitHub now supports immutable releases. When enabled, a published immutable release locks:
- its Git tag;
- its release assets;
- the tag name from future reuse after immutable-release deletion.

Official GitHub sources:
- https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
- https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes
- https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases

This model is preferable for WAG because executable provenance should be append-only rather than asset replacement.

## WAG consequence

Do not publish an unsigned Windows ZIP and later replace that release asset with a signed ZIP under the same published release/tag.

The first unsigned release, if SignPath requires one for eligibility review, should have a distinct preview release identity.

A later trusted signed release should have a separate stable release identity.

Conceptual sequence:

1. choose one numeric product version `X.Y.Z`;
2. build the exact candidate with `package.json.version = X.Y.Z`;
3. PE ProductVersion/FileVersion become `X.Y.Z.0`;
4. publish an explicitly unsigned GitHub prerelease under a preview tag;
5. apply to SignPath Foundation using that public release/download form;
6. after acceptance, build/verify/sign the candidate from an authorized source commit;
7. publish a separate stable signed release;
8. never replace the preview release's unsigned assets with signed bytes.

## Version recommendation

Current repository package version is the placeholder `0.0.0`.

For a first externally consumable but pre-1.0 native-host release, the recommended product-version candidate is:

```text
0.1.0
```

Reasoning:
- WAG has a substantial defined feature/trust surface, so `0.1.0` communicates an initial public minor line better than a patch-only `0.0.1`;
- remaining provider/signing/product integration can still evolve under pre-1.0 semantics;
- the existing PE metadata mapper supports numeric `X.Y.Z` without another build-input change.

This is a recommendation only:

```text
FIRST_PRODUCT_VERSION = NOT_SELECTED
RECOMMENDED_CANDIDATE = 0.1.0
```

## Preview-tag recommendation

The unsigned eligibility release should use a tag distinct from the eventual signed stable tag.

Recommended pattern:

```text
preview tag: v0.1.0-preview.1
stable tag:  v0.1.0
```

The GitHub preview release should be marked as a prerelease and titled to state that it is unsigned.

The preview outer ZIP filename should also make that state obvious, for example:

```text
web-agent-gateway-native-host-windows-x64-0.1.0-preview.1-UNSIGNED.zip
```

The executable's internal PE product version can remain `0.1.0.0`. The preview suffix belongs to the publication channel/tag, not the Windows numeric version resource.

Do not relax `windowsFileVersion()` merely to embed a SemVer prerelease suffix in PE numeric version fields.

## Preview release notes requirements

The unsigned preview release notes should include, near the top:

- **UNSIGNED PREVIEW — NOT AUTHENTICODE TRUSTED**
- the exact source commit;
- the ZIP SHA-256;
- the inner executable flat SHA-256;
- the inner executable Authenticode SHA-256 recorded before signing;
- statement that GitHub Actions artifacts are not supported releases;
- install/uninstall warning/link;
- privacy link;
- **Code signing policy** link;
- statement that the preview exists to establish the public Windows release form before trusted code signing;
- no claim that SignPath has accepted WAG.

Do not market the preview as Smart App Control-ready or Windows-trusted.

## Stable signed release requirements

The first stable signed release should be separate from the unsigned preview.

Before publication:
1. SignPath returns the signed executable;
2. WAG signed-candidate verification passes without relaxing RSA, public trust, SHA-256 Authenticode continuity, or execution checks;
3. a fresh inner three-file distribution is created around the signed executable;
4. the inner distribution verifies;
5. the deterministic outer release ZIP is created;
6. the ZIP verifies against its expected contents/hashes;
7. release notes record signature verification facts and source commit;
8. if GitHub release immutability is authorized/enabled, attach all assets while the release is draft, then publish once complete.

Do not publish a stable release first and add/replace binary assets later.

## Source/tag relationship

Two release tags may point to the same source commit if the signed stable binary is derived from the exact same build inputs as the unsigned preview candidate and only the signing transformation changes artifact bytes.

If any `NATIVE_HOST_BUILD_INPUTS` file changes between preview and stable signing, WAG's candidate continuity rule requires a new unsigned candidate/receipt. Do not claim the old preview executable is the same signing candidate.

Docs/release-tool-only changes that are explicitly outside `NATIVE_HOST_BUILD_INPUTS` do not by themselves invalidate the recorded executable candidate, but the published release must still accurately identify the source/build provenance it represents.

## Immutable-release recommendation

Recommended future GitHub setting:

```text
ENABLE_IMMUTABLE_RELEASES = RECOMMENDED_BEFORE_FIRST_PUBLIC_BINARY_RELEASE
```

Reasons:
- prevents moving the release tag after publication;
- prevents replacing/deleting release assets;
- generates GitHub release attestation for immutable releases;
- aligns with WAG's fail-closed supply-chain posture.

This setting is not required by the current SignPath terms and is not authorized by this document.

## Open decisions requiring explicit authority

- select the numeric product version;
- select the exact preview tag/name;
- update `package.json.version` (native-host build input; invalidates the existing `e296da1` candidate);
- enable GitHub immutable releases;
- create/push tag(s);
- create/publish GitHub release(s);
- upload public release assets.

## Current state

```text
FIRST_PRODUCT_VERSION = NOT_SELECTED
FIRST_PREVIEW_TAG = NOT_SELECTED
IMMUTABLE_RELEASES = NOT_CONFIGURED
PUBLIC_RELEASE = NOT_CREATED
CURRENT_E296DA1_CANDIDATE = VALID_ONLY_FOR_PACKAGE_VERSION_0.0.0
```

The existing `e296da1` unsigned candidate remains useful readiness evidence, but it is not the recommended public first-release candidate because the package/PE version is still the placeholder `0.0.0`.
