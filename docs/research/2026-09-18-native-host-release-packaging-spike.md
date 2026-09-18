# Native Host Release Packaging Spike — 2026-09-18

## Goal

Validate a release-package shape that preserves WAG's strict three-file native-host distribution contract, carries required legal/public documentation, and remains compatible with SignPath Foundation without introducing another build dependency.

## SignPath findings

SignPath artifact configurations allow a ZIP archive as the root artifact and support nested PE Authenticode signing.

Relevant official documentation:
- https://docs.signpath.io/artifact-configuration/syntax
- https://docs.signpath.io/artifact-configuration/reference
- https://docs.signpath.io/artifact-configuration/examples
- https://docs.signpath.io/trusted-build-systems/github

SignPath's GitHub trusted-build connector additionally requires the artifact to exist as a GitHub workflow artifact before signing and verifies that OSS signing-request lineage uses GitHub-hosted runners.

The GitHub action supports either:
- the default GitHub-generated ZIP artifact, requiring a SignPath `zip-file` root; or
- direct artifact mode using `archive: false`, with the SignPath action's corresponding `skip-decompress` behavior.

## WAG packaging consequence

Do not sign a finalized WAG three-file distribution in place.

The existing inner distribution binds:
- `wag-native-host.exe`;
- `wag-native-host.exe.sha256`;
- `build-receipt.json`.

Authenticode changes executable bytes. If SignPath signs the executable after the checksum and receipt have been finalized, those adjacent files become stale and the existing verifier must reject the distribution.

Required future byte order:

1. build unsigned `wag-native-host.exe`;
2. verify license/build/test/VersionInfo gates;
3. record unsigned-candidate receipt;
4. upload a separate signing-input workflow artifact;
5. SignPath origin-verifies and signs that candidate;
6. WAG verifies the returned signed executable, including RSA/trust/AuthentiCode continuity and execution probe;
7. package a **new** inner distribution whose checksum and receipt bind the signed executable;
8. verify that inner distribution;
9. create the public outer release ZIP from that verified inner distribution plus legal/public documentation.

The first pre-SignPath unsigned preview can use the same outer distribution shape, but its inner distribution binds the unsigned executable and its release notes must state that it is unsigned.

## Proposed outer ZIP shape

Conceptual structure:

```text
web-agent-gateway-native-host-windows-x64-<version>.zip
├── native-host/
│   ├── wag-native-host.exe
│   ├── wag-native-host.exe.sha256
│   └── build-receipt.json
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── SECURITY.md
├── docs/
│   ├── native-host-installation.md
│   └── policies/
│       ├── code-signing-policy.md
│       └── privacy.md
└── third_party/
    └── native-host/
        ├── NODE-v24.20.0-LICENSE
        └── npm/...
```

The exact inner `native-host/` directory remains independently verifiable and must still contain exactly three files.

## Deterministic ZIP spike

Two packaging mechanisms were tested locally against the same ~95 MB WAG native-host executable and fixed legal files.

### Windows `tar.exe -a`

Inputs were copied into two independent staging directories and all input modification timestamps were normalized before creating ZIP archives.

Result:

```text
HASH_A=A2B9734E6AE3F43E5B8B05E14128094D017C9DC5BCCF4A0C1ACF0F11E50A3164
HASH_B=0067D2D24F4FFD475D934AD17F538A264D6938FF7434CF744930005E4B11ACF4
MATCH=False
```

Conclusion: reject Windows `tar.exe` as the deterministic release packager.

### .NET `System.IO.Compression.ZipArchive`

The spike:
- created entries in a fixed explicit order;
- used `CompressionLevel.Optimal`;
- assigned every ZIP entry the same fixed DOS-compatible timestamp;
- copied identical source bytes.

Result:

```text
HASH_A=3888B40A2743A5E6C3F692839552AE951A77BBBB3AD9869F86CB1C2F9180A271
HASH_B=3888B40A2743A5E6C3F692839552AE951A77BBBB3AD9869F86CB1C2F9180A271
MATCH=True
```

Conclusion: .NET ZipArchive is the preferred no-new-dependency implementation direction for a deterministic Windows release ZIP.

The ZIP format stores DOS-style local timestamps without a timezone. The implementation should therefore write one fixed wall-clock entry timestamp and test deterministic byte output on the supported GitHub Windows runner rather than comparing displayed UTC conversions across machines.

## Implementation constraints

A future packager should:
- run only after `verifyNativeHostDistributionDirectory` passes;
- reject a pre-existing/non-empty output path rather than overwrite silently;
- enumerate legal/public files from an explicit allowlist plus the exact sorted `third_party/native-host/` tree;
- reject missing expected files;
- reject symlinks/reparse points in packaging inputs;
- normalize every ZIP entry timestamp to one fixed value;
- use deterministic path separators and sorted entry order;
- write to a temporary file and atomically rename only after successful close;
- independently reopen the ZIP and verify the exact expected entry set and uncompressed SHA-256 values;
- package the inner distribution as files under `native-host/`, without altering its bytes;
- keep release packaging outside `NATIVE_HOST_BUILD_INPUTS` for executable continuity, while treating it as release-provenance input.

## SignPath artifact-configuration direction

The signing request should target the pre-sign candidate, not the final distribution receipt.

Two viable future modes are:

1. Direct candidate artifact:
   - GitHub upload uses direct/non-archive mode;
   - SignPath root artifact is `pe-file`;
   - output is the signed executable.

2. GitHub-generated signing ZIP:
   - ZIP contains only the candidate executable (and narrowly required signing inputs);
   - SignPath root is `zip-file`;
   - nested `pe-file path="wag-native-host.exe"` applies WAG metadata restrictions and `authenticode-sign hash-algorithm="sha256"`;
   - pipeline extracts the returned signed executable and verifies it before final distribution packaging.

Mode selection belongs in the provider-specific integration design after SignPath acceptance.

## Decision

```text
FINAL_RELEASE_OUTER_FORMAT = ZIP
INNER_DISTRIBUTION_CONTRACT = UNCHANGED_EXACT_THREE_FILES
SIGNING_INPUT = SEPARATE_PRE_SIGN_CANDIDATE_ARTIFACT
POST_SIGN_DISTRIBUTION_REPACKAGE = REQUIRED
WINDOWS_TAR_PACKAGER = REJECTED_NONDETERMINISTIC
DOTNET_ZIPARCHIVE = PREFERRED_IMPLEMENTATION_DIRECTION
RELEASE_CREATION = NOT_AUTHORIZED
SIGNPATH_INTEGRATION = NOT_AUTHORIZED
```
