# SignPath Foundation Application Answer Draft — 2026-09-18

Status: draft only. Not submitted. This file is a factual answer bank for the public SignPath Foundation application and does not imply acceptance.

## Form-discovery note

The current SignPath application page embeds a HubSpot EU1 form:
- portal id: `145110231`
- form id: `bf62807d-bb72-4e45-9bde-1f3a53ba2472`

The public page/embed source does not expose a static field schema. HubSpot's official form-definition API requires authenticated HubSpot access. No attempt was made to bypass that access or submit the form.

Therefore this draft is organized by SignPath's documented eligibility/configuration requirements, not by guessed HubSpot field names.

Official sources:
- https://signpath.org/apply.html
- https://signpath.org/terms.html
- https://docs.signpath.io/trusted-build-systems/github
- https://docs.signpath.io/origin-verification/
- https://docs.signpath.io/projects

## Contact / applicant identity

Maintainer / repository owner:
- GitHub: `ShenJun93`

Contact name:
- UNKNOWN_FORM_VALUE

Contact email:
- UNKNOWN_FORM_VALUE

Do not substitute a GitHub noreply commit address unless the maintainer explicitly chooses it as the application contact.

## Project identity

Project name:
- Web Agent Gateway

Repository:
- `https://github.com/ShenJun93/web-agent-gateway`

Repository state at draft time:
- private
- publication authorized in principle but not executed

License:
- Apache-2.0 on the local readiness branch
- public license URL unavailable until readiness changes are pushed and repository is public

Project homepage:
- recommended initial homepage: the public GitHub repository README
- UNKNOWN_PUBLIC_URL until repository publication is complete

Download/release page:
- UNKNOWN_PUBLIC_URL
- no official GitHub Release exists yet

## Project description

Suggested concise answer:

> Web Agent Gateway (WAG) is a local, provider-neutral trust and capability gateway for Web AI clients that need bounded access to user-approved local development resources. Its Windows native host connects a Chromium extension to a local WAG runtime. The current Browser Inspect v2 profile exposes only health, workspace open, bounded repository search, bounded repository snapshot, and bounded file read. Identity, authority, workspace ownership, secrets, and policy remain under WAG control. The browser profile does not expose raw shell/process access, Git writes, file mutation, browser mutation, or generic forwarding.

Suggested shorter answer if the form has a tight field limit:

> Local least-authority gateway that lets Web AI clients access explicitly approved development resources through a narrow read-only Chromium native-host interface.

## What should be signed?

Artifact:
- `wag-native-host.exe`

Platform:
- Windows x64

Artifact type:
- PE executable / Authenticode

Runtime/packaging:
- Node.js 24.20.0 Single Executable Application
- WAG bundle injected using Node's documented SEA process
- WAG-owned PE VersionInfo applied before unsigned-candidate recording

Required signing properties:
- SHA-256 Authenticode
- RSA signing certificate
- Windows-trusted public chain
- timestamp
- no weakening of WAG's existing post-sign verification

## Build system

Source control:
- GitHub

CI:
- GitHub Actions

Release build runner:
- GitHub-hosted `windows-2025`

Build characteristics:
- pinned GitHub Action commit SHAs
- pinned Node 24.20.0
- `npm ci`
- package-manager cache disabled for the native-host distribution workflow
- source-controlled build scripts
- typecheck/build/focused tests
- native-host license-compliance gate
- independent PE VersionInfo verification
- exact artifact execution test
- strict distribution verification

SignPath compatibility:
- Open Source Code Signing requires a trusted build system and origin verification
- SignPath's GitHub connector verifies that the artifact is a GitHub workflow artifact and, for OSS projects, that all jobs leading to the signing request ran on GitHub-hosted runners

## Signing governance

Authors / committers:
- `ShenJun93`

Reviewer for non-committer contributions:
- `ShenJun93`

Approver for signing requests:
- `ShenJun93`

Policy:
- every signing request requires explicit manual approval
- push, merge, CI success, tag creation, or artifact upload does not itself approve signing
- non-committer contributions require maintainer review before merge
- WAG does not invent a second maintainer or self-review requirement

Public policy location after publication:
- `docs/policies/code-signing-policy.md`
- linked from README under the exact heading `Code signing policy`

Required attribution already prepared conditionally:
- “Free code signing provided by SignPath.io, certificate by SignPath Foundation.”

The public policy must continue to state that this attribution is conditional until SignPath accepts WAG.

## Privacy

Public policy:
- `docs/policies/privacy.md`

Suggested summary:

> WAG is local software and the project does not operate a centralized telemetry collection service. WAG may transmit data only when the user invokes a capability whose result is intentionally returned to a user-selected provider/backend; that provider's privacy terms then apply. Secrets and bearer credentials are intended to remain local and are excluded from project telemetry.

Do not claim that WAG never transfers information to networked systems; that would be inaccurate for provider-mediated workflows explicitly requested by users.

## Installation / removal

Public documentation:
- `docs/native-host-installation.md`

System change:
- installs exact-owned files under `%LOCALAPPDATA%\WebAgentGateway\native-host\<source-sha>\`
- may register one per-user Chromium Native Messaging host under HKCU
- no administrator elevation required for the per-user registration path

Removal:
- exact-installation scoped
- fail closed on registry/configuration drift
- do not remove unrelated native-messaging registrations or other installations

## Current release/reputation facts

Repository created:
- 2026-09-09

Project status:
- actively developed
- very young public-history profile

Current official public releases:
- none

Current honest public binary download count:
- none / not yet applicable

Do not manufacture:
- stars
- downloads
- users
- contributors
- issue activity
- project age

SignPath states that executable applications require a certain verifiable reputation but publishes no numeric threshold. Acceptance remains discretionary.

## First-release plan

Recommended but not yet authorized:
- product version: `0.1.0`
- unsigned preview tag: `v0.1.0-preview.1`
- later signed stable tag: `v0.1.0`

Historical local readiness candidate:
- source commit `e296da18400d0f994fb8f086e36936ccd4c6305b`
- package/PE version: `0.0.0` / `0.0.0.0`
- historical readiness evidence only
- continuity intentionally stale after `eb5393f`, which added checkout normalization to the native-host build-input set
- should not be the first public release or a signing input

Reason:
- checkout normalization now participates in release/build provenance;
- selecting a real product version also changes `package.json`, another native-host build input;
- the selected release source therefore requires a fresh candidate and receipt.

## Node SEA policy question for SignPath

Use a concise, neutral question:

> WAG uses Node's documented Single Executable Application flow: we copy the official pinned Node executable, remove its original signature, inject the WAG SEA blob, apply WAG-specific VERSIONINFO, preserve Node and bundled-component license notices, and treat that output as the WAG application executable. WAG does not modify or fork Node source. Does SignPath Foundation consider this resulting application executable to be WAG's own binary for signing, or does the Foundation's modified-upstream visible-fork condition apply to this packaging model?

Supporting evidence:
- Node SEA docs: `https://nodejs.org/api/single-executable-applications.html`
- builder: `scripts/build-native-host.ts`
- PE metadata mutator: `scripts/native-host-pe-metadata.ts`
- third-party manifest: `browser/native-host/third-party-components.json`
- exact unsigned-candidate receipt available for the selected release candidate

Do not argue with SignPath if they interpret the policy differently. Treat their project-specific answer as provider authority.

## GitHub / origin-verification plan

Future SignPath project repository URL:
- `https://github.com/ShenJun93/web-agent-gateway`

Release signing branch:
- recommended: `main`

Trusted build system:
- predefined GitHub.com connector

Origin verification:
- required for OSS signing
- repository URL, branch, commit, workflow/build origin, and artifact lineage must match

Runner policy:
- require GitHub-hosted runners

Pull requests:
- must never receive signing authority

Signing input:
- separate pre-sign candidate artifact
- must exist as a GitHub workflow artifact before the SignPath request

Post-sign:
- WAG independently verifies signed candidate
- only then create a fresh inner distribution binding the signed bytes
- then create deterministic outer release ZIP

## MFA

SignPath requirement:
- MFA for SignPath access and source-repository access for all relevant team members

GitHub MFA state:
- UNKNOWN / not verified

Reason:
- current GitHub OAuth token does not have `read:user`
- GitHub REST therefore does not expose the private `two_factor_authentication` field
- GraphQL does not currently expose a `hasTwoFactorEnabled` User field

Action before application:
- maintainer confirms GitHub MFA in the GitHub UI
- SignPath account MFA must also be enabled/configured according to provider onboarding

Do not widen the current GitHub token scope solely to populate this draft.

## Reputation timing

SignPath publishes no numeric reputation threshold. A sample of comparable accepted executable projects shows public repository ages ranging from roughly two months to well over a year when first observed on the Foundation project list; low-star AMIGOpy had substantially longer history, while shorter-history AI projects had strong visible traction.

WAG is only 9 days old on 2026-09-18. Submitting immediately after repository publication is possible once hard requirements are met, but carries elevated discretionary rejection risk. Prefer to establish a real public preview release and ordinary maintenance evidence first rather than manufacturing popularity or waiting for an invented fixed duration.

See `docs/research/2026-09-18-signpath-reputation-timing.md`.

## Current blockers before submission

1. Explicitly select the public product version.
2. Integrate the readiness branch through the Browser Inspect v2 acceptance/merge path.
3. Push approved readiness work.
4. Make repository public.
5. Verify public README/license/security/privacy/code-signing/install links.
6. Confirm GitHub MFA.
7. Build a fresh non-placeholder release candidate and receipt.
8. Create the first official public unsigned preview release if SignPath still requires an already released binary form.
9. Refresh all application facts from live public GitHub state.
10. Only then submit the SignPath Foundation application.

## Explicitly not authorized by this draft

- product-version selection
- Git commit amendment/rebase of accepted history
- Git push/merge
- repository visibility change
- GitHub ruleset or immutable-release setting changes
- tag/release creation
- SignPath contact/submission
- account/project creation
- API token creation
- GitHub App installation
- trusted-build-system configuration
- signing
