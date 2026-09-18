# Native Host Release Notes Templates — 2026-09-18

Status: templates only. No version/tag/release is selected or created.

These templates are intentionally conservative. Replace every `<PLACEHOLDER>` from verified release evidence before publication. Never publish a template with unresolved placeholders.

## Unsigned preview release

Recommended release class:
- GitHub prerelease
- distinct preview tag, e.g. `v0.1.0-preview.1` only if separately authorized
- never reuse this release/tag for later signed bytes

### Suggested title

```text
Web Agent Gateway Native Host <VERSION> Preview — UNSIGNED
```

### Suggested body

```markdown
# UNSIGNED PREVIEW — NOT AUTHENTICODE TRUSTED

This is a pre-signing Windows preview of the Web Agent Gateway native host.

It is intentionally **unsigned** and is **not** a Windows-trusted / Smart App Control-ready release. It exists to publish the exact Windows release form while the project prepares its open-source code-signing path.

## Scope

The Browser Inspect v2 native-host path is read-only and exposes exactly:

- `health`
- `workspace.open`
- `repo.search`
- `repo.snapshot`
- `file.read`

It does not expose raw shell/process access, Git writes, file mutation, browser mutation, or generic forwarding.

## Provenance

- Source repository: https://github.com/ShenJun93/web-agent-gateway
- Source commit: `<SOURCE_SHA>`
- Product version: `<PRODUCT_VERSION>`
- Windows PE version: `<WINDOWS_VERSION>`
- Release ZIP: `<ZIP_FILENAME>`
- Release ZIP SHA-256: `<ZIP_SHA256>`
- Native-host executable flat SHA-256: `<EXE_SHA256>`
- Native-host pre-sign Authenticode SHA-256: `<AUTHENTICODE_SHA256>`

The executable was produced by the repository's reviewed GitHub-hosted Windows build path and independently checked for WAG PE VersionInfo and exact native-host execution behavior.

## Signing state

- Authenticode state: **NotSigned**
- SignPath Foundation acceptance: **not claimed by this release**

Do not interpret GitHub Actions artifacts as supported releases. Official user-download artifacts are attached to this GitHub Release only.

## Installation and removal

Read the Windows native-host installation/removal documentation before making the per-user Native Messaging registration change:

- [Windows native-host installation and removal](../../blob/<SOURCE_SHA>/docs/native-host-installation.md)

The installer/preparation path is designed to fail closed on ownership/configuration drift.

## Code signing policy

- [Code signing policy](../../blob/<SOURCE_SHA>/docs/policies/code-signing-policy.md)

The project is preparing an application for free open-source code signing. This preview does not claim that the application has been accepted.

## Privacy

- [Privacy](../../blob/<SOURCE_SHA>/docs/policies/privacy.md)

## Security

- [Security policy](../../blob/<SOURCE_SHA>/SECURITY.md)

## License and notices

Web Agent Gateway is Apache-2.0 licensed.

The release ZIP includes:
- the WAG Apache-2.0 license;
- Node.js 24.20.0 license/third-party notices;
- exact license files for JavaScript dependencies bundled into the native host.

## Known limitation

Because this preview is unsigned, Windows reputation/application-control warnings may occur. Do not weaken Windows security controls to run it.
```

### Preview publication checks

Before publishing:
- no `<PLACEHOLDER>` remains;
- all hashes are computed from the exact attached bytes;
- source commit is immutable/reachable in the public repository;
- ZIP was created from a verified current-schema inner distribution;
- executable signature inspector reports `NotSigned`;
- release is marked prerelease;
- title/body visibly say unsigned;
- links resolve anonymously;
- no text claims SignPath acceptance.

## Signed stable release

Use only after SignPath acceptance and after WAG independently verifies the returned executable.

Recommended release class:
- normal/stable GitHub Release
- distinct stable tag, e.g. `v0.1.0` only if separately authorized
- do not replace the unsigned preview assets

### Suggested title

```text
Web Agent Gateway Native Host <VERSION>
```

### Suggested body

```markdown
# Web Agent Gateway Native Host <VERSION>

This release contains the Windows native host for the read-only Browser Inspect v2 path.

## Code signing

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

The attached native-host executable was accepted only after WAG independently verified the returned signed candidate against the recorded pre-sign candidate.

Verified release requirements:

- Authenticode digest algorithm: SHA-256
- Signing public-key algorithm: RSA
- Windows certificate chain: trusted
- Timestamp: present and valid under the approved SignPath profile
- Pre/post-sign Authenticode content continuity: PASS
- Signed-candidate execution probe: PASS

## Scope

The Browser Inspect v2 native-host path exposes exactly:

- `health`
- `workspace.open`
- `repo.search`
- `repo.snapshot`
- `file.read`

It does not expose raw shell/process access, Git writes, file mutation, browser mutation, or generic forwarding.

## Provenance

- Source repository: https://github.com/ShenJun93/web-agent-gateway
- Source commit: `<SOURCE_SHA>`
- Product version: `<PRODUCT_VERSION>`
- Windows PE version: `<WINDOWS_VERSION>`
- Release ZIP: `<ZIP_FILENAME>`
- Release ZIP SHA-256: `<ZIP_SHA256>`
- Signed executable flat SHA-256: `<SIGNED_EXE_SHA256>`
- Recorded pre-sign executable flat SHA-256: `<UNSIGNED_EXE_SHA256>`
- Recorded pre-sign Authenticode SHA-256: `<AUTHENTICODE_SHA256>`
- Verified post-sign Authenticode SHA-256: `<AUTHENTICODE_SHA256>`

The equal pre/post Authenticode SHA-256 value demonstrates that the executable content covered by WAG's Authenticode-content hash did not change during signing.

## Installation and removal

- [Windows native-host installation and removal](../../blob/<SOURCE_SHA>/docs/native-host-installation.md)

Do not bypass ownership/configuration-drift failures.

## Code signing policy

- [Code signing policy](../../blob/<SOURCE_SHA>/docs/policies/code-signing-policy.md)

## Privacy

- [Privacy](../../blob/<SOURCE_SHA>/docs/policies/privacy.md)

## Security

- [Security policy](../../blob/<SOURCE_SHA>/SECURITY.md)

## License and notices

Web Agent Gateway is licensed under Apache-2.0.

The release ZIP includes exact Node.js and bundled-dependency license material.

## Download guidance

Use only assets attached to this GitHub Release as supported release downloads. GitHub Actions artifacts are build evidence and are not supported releases.
```

### Signed release publication checks

Before publishing:
- SignPath project/application is actually accepted;
- exact attribution is no longer conditional;
- no `<PLACEHOLDER>` remains;
- SignPath returned artifact has passed WAG's signed-candidate verifier;
- RSA/trust/timestamp requirements are verified from the actual signed artifact;
- post-sign Authenticode SHA-256 equals the recorded pre-sign value;
- fresh inner distribution checksum/receipt binds the **signed** executable;
- deterministic outer ZIP is generated only after inner-distribution verification;
- attached ZIP SHA-256 is recorded from the final bytes;
- source/tag points to the authorized release source;
- release is not published until all intended assets are attached;
- if immutable releases are enabled, publish only after the draft is complete.

## Rules shared by both templates

- Never state a signature/trust property based solely on provider intent; inspect the actual artifact.
- Never tell users to disable Smart App Control, App Control, antivirus, certificate validation, or browser/native-host security controls.
- Never promote historical CI artifacts to release assets by wording alone.
- Never reuse an immutable published tag for different artifact bytes.
- Never publish local paths, private receipt paths, provider credentials, bearer tokens, or signing-request secrets.
