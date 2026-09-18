# SignPath GitHub Signing-Input Shape — 2026-09-18

Status: local readiness implementation only. No SignPath signing request, provider account/project mutation, secret/token, or GitHub remote workflow mutation was performed.

## Official connector constraint

SignPath's current GitHub trusted-build-system documentation requires the unsigned artifact to be uploaded to GitHub first with `actions/upload-artifact` v4 or newer. The SignPath GitHub action then receives the uploaded artifact ID through `github-artifact-id`.

Official references:
- https://docs.signpath.io/trusted-build-systems/github
- https://docs.signpath.io/artifact-configuration/reference
- schema validated locally against https://app.signpath.io/Web/artifact-configuration/v1.xsd

The connector documentation also makes the provider-bound values explicit:
- API token;
- organization ID;
- project slug;
- signing-policy slug;
- optional artifact-configuration slug.

Those values are intentionally absent from the WAG readiness branch because no SignPath project/application/configuration has been authorized or provisioned.

## Why the existing distribution artifact is not the signing input

The current WAG native-host distribution is an integrity envelope for the unsigned executable.

It contains exactly:
- `wag-native-host.exe`
- `wag-native-host.exe.sha256`
- `build-receipt.json`

The checksum and receipt bind the exact unsigned executable bytes.

Authenticode signing mutates the PE file. If SignPath were asked to sign `wag-native-host.exe` *inside that already-packaged distribution*, the resulting signed executable would no longer match the existing checksum/receipt.

Therefore this shape is invalid:

```text
unsigned distribution ZIP
  -> SignPath mutates nested EXE
  -> original checksum/receipt become stale
```

WAG keeps the unsigned distribution as build/provenance evidence and creates a separate signing input instead.

## Dedicated signing input

Commit `751d40e` adds a main-push-only workflow step that:

1. records the exact unsigned candidate using the existing production recorder;
2. uploads only `wag-native-host.exe` as a dedicated GitHub Actions artifact;
3. names the artifact with source SHA + workflow attempt;
4. leaves the existing unsigned distribution packaging flow unchanged.

Current artifact name:

```text
wag-native-host-signing-input-${github.sha}-attempt-${github.run_attempt}
```

The signing artifact intentionally excludes:
- candidate receipt;
- distribution receipt;
- checksum file;
- legal/release payload;
- unrelated files.

This minimizes the mutation surface that a future SignPath request can return.

## Candidate receipt remains separate evidence

The workflow records:

```text
artifacts/native-host-build/unsigned-candidate-receipt.json
```

before uploading the signing input.

The receipt is not included in the SignPath artifact because SignPath should mutate only the executable. The receipt remains independent evidence that can later be paired with the returned signed executable for WAG's signed-candidate verification.

Future downstream flow remains:

```text
build unsigned EXE
  -> verify PE identity / exact candidate tests
  -> record unsigned receipt
  -> upload dedicated EXE artifact
  -> [future authorized SignPath request]
  -> download signed artifact
  -> WAG independently verifies signed candidate
  -> package/publish signed release material
```

## Artifact configuration draft

Commit `b98b3b7` adds:

```text
.signpath/artifact-configurations/native-host.xml
```

The artifact configuration models the GitHub Actions artifact as a ZIP root and permits exactly one:

```text
wag-native-host.exe
```

It restricts:
- ProductName = `Web Agent Gateway`;
- ProductVersion = required `windowsVersion` parameter;
- FileVersion = required `windowsVersion` parameter;
- OriginalFilename = `wag-native-host.exe`;
- Authenticode digest = SHA-256.

It intentionally does not claim:
- CompanyName;
- copyright holder;
- SignPath organization/project/policy identity.

Those values either are not presently encoded in WAG's normalized PE metadata or require later provider/legal authority.

## Schema validation

The committed artifact configuration was validated against SignPath's current official XSD:

```text
https://app.signpath.io/Web/artifact-configuration/v1.xsd
XSD_VALID = PASS
```

Focused tests:

```text
workflow + artifact config = 9/9 PASS
typecheck                  = PASS
diff --check               = PASS
```

Full regression after the artifact-config addition:

```text
tests = 287
pass  = 287
fail  = 0
```

## Security properties retained

The readiness workflow still:
- uses GitHub-hosted `windows-2025`;
- uses immutable action commit pins;
- keeps `permissions: contents: read`;
- has no `pull_request_target`;
- exposes no SignPath token or other provider secret;
- performs publication steps only on pushes to exact `refs/heads/main`;
- continues to run unfiltered validation for pull requests.

The new signing-input artifact does **not** sign anything by itself.

## Explicit provider boundary

Not implemented:

```text
signpath/github-action-submit-signing-request
api-token
organization-id
project-slug
signing-policy-slug
artifact-configuration-slug
github-artifact-id -> SignPath submission wiring
signed artifact download
```

Those operations would create/use provider authority and remain outside `tt`.

## Current state

```text
DEDICATED_UNSIGNED_SIGNING_INPUT = IMPLEMENTED_LOCAL
UNSIGNED_CANDIDATE_RECORDING_IN_WORKFLOW = IMPLEMENTED_LOCAL
SIGNPATH_ARTIFACT_CONFIG_DRAFT = XSD_VALID
SIGNPATH_GITHUB_SUBMISSION = NOT_IMPLEMENTED
SIGNPATH_PROVIDER_IDS = UNKNOWN
SIGNPATH_API_TOKEN = NOT_CONFIGURED
REMOTE_WORKFLOW_CHANGED = NO
PUSH = NOT_DONE
SIGNING = NOT_PERFORMED
```
