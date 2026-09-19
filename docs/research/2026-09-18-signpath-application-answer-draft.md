# SignPath Foundation Application Answer Draft — 2026-09-18

Status: draft only. Not submitted. This file is a factual answer bank for the public SignPath Foundation application and does not imply acceptance.

## Live application form schema — 2026-09-19

The current SignPath application page embeds HubSpot EU1 form `bf62807d-bb72-4e45-9bde-1f3a53ba2472` under portal `145110231`.

A dedicated read-only browser worker rendered the live form on 2026-09-19. No field was filled and the form was not submitted.

Rendered fields:
- `Project Name*`
- `Repository URL*`
- `Homepage URL*`
- `Download URL`
- `Privacy Policy URL`
- `Wikipedia URL (optional)`
- `Tagline*`
- `Description*`
- `Reputation*`
- `Maintainer Type`
- `Build System*`
- `First Name*`
- `Last Name*`
- `Email*`
- `Company Name`
- `Primary Discovery Channel*`
- `Please specify the exact source (optional)`
- required Code-of-Conduct agreement
- optional marketing-communications consent
- required personal-data processing consent

Observed select options relevant to WAG:
- `Maintainer Type`: `Individual maintainer(s)` is an exact live option;
- `Build System*`: `GitHub Actions` is an exact live option;
- `Primary Discovery Channel*`: live options include `Organic search`, `AI / LLM tools`, `Developer platforms (e.g. GitHub)`, `Community platforms`, `Social media`, `Events`, `Referral`, `Direct contact`, and `Other`.

Safe deterministic WAG mappings:
- Project Name: `Web Agent Gateway`;
- Repository URL: `https://github.com/ShenJun93/web-agent-gateway`;
- Homepage URL: `https://github.com/ShenJun93/web-agent-gateway`;
- Download URL: do not auto-fill before provider acceptance; the live field is optional and says any supplied download page must mention use of SignPath Foundation for code signing, while WAG's current immutable preview truthfully states that SignPath acceptance is not claimed and that the project is only preparing an application;
- Privacy Policy URL: public WAG privacy policy;
- Wikipedia URL: leave blank unless a real English Wikipedia article exists;
- Maintainer Type: `Individual maintainer(s)`;
- Build System: `GitHub Actions`;
- Tagline and Description: use the factual project wording below.

Human-supplied choices that must not be inferred:
- First Name, Last Name, Email;
- Company Name, if any;
- Primary Discovery Channel and exact discovery source;
- Code-of-Conduct agreement;
- personal-data processing consent;
- optional marketing communications consent.

`Reputation*` is required by the live form. Current submission decision: `WAIT_REPUTATION_SIGNAL`; do not manufacture adoption evidence to satisfy it.

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

Current repository state:
- public since the authorized cutover on 2026-09-19;
- anonymous access to the repository, Apache-2.0 license, README, security policy, privacy policy, code-signing policy, and native-host installation/removal documentation has been verified.

License:
- Apache-2.0 on the public default branch
- public license URL: https://github.com/ShenJun93/web-agent-gateway/blob/main/LICENSE

Project homepage:
- https://github.com/ShenJun93/web-agent-gateway

Download/release page:
- public release index: https://github.com/ShenJun93/web-agent-gateway/releases
- immutable unsigned preview: https://github.com/ShenJun93/web-agent-gateway/releases/tag/v0.1.0-preview.1
- release ID: `391834069`
- tag: `v0.1.0-preview.1` at `c1eb195f54864dee1a8997c9baeb0475ce627da6`
- published asset: `web-agent-gateway-native-host-windows-x64-0.1.0-preview.1-UNSIGNED.zip`
- asset SHA-256: `3f31ebe7258803aaf44194c05c4ae0ce241f7f2849507f7c0f153b129264e733`
- GitHub release and asset attestations: independently verified after publication

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

Public policy location:
- https://github.com/ShenJun93/web-agent-gateway/blob/main/docs/policies/code-signing-policy.md
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
- `v0.1.0-preview.1` - immutable unsigned GitHub prerelease, release ID `391834069`

Live public-signal snapshot on 2026-09-19:
- GitHub stars: `0`;
- forks: `0`;
- subscribers/watchers: `0`;
- contributor list: `ShenJun93` only;
- preview ZIP counter: `4` downloads at this checkpoint.

The preview ZIP counter includes project-owner verification downloads performed during release validation and therefore must not be represented as external-user adoption or reputation evidence.

The live application form makes `Reputation*` a required field and asks for links or information showing that the project is widely used or trusted. WAG does not currently have verified external adoption evidence that would justify claiming it is widely used.

Decision state:
- `WAIT_REPUTATION_SIGNAL`

Reason:
- the live form requires `Reputation*`;
- SignPath publishes no numeric executable-project reputation threshold;
- WAG's current public footprint does not yet provide a genuine independent trust/adoption signal;
- GitHub-native repository search can find `ShenJun93/web-agent-gateway`, but general public-web exact-name discoverability is still weak/ambiguous against similarly named projects.

Truthful candidate answer if submission is later authorized before stronger reputation evidence appears:

> Web Agent Gateway is a newly public open-source project with an immutable Windows preview release, public Apache-2.0 source, documented security/privacy/code-signing policies, GitHub Actions build provenance, and independently verifiable GitHub release attestations. The project became public on September 19, 2026, so we do not yet claim broad external adoption; current release download counts include maintainer verification traffic. We are providing the public repository and release evidence for SignPath Foundation to assess whether the project's current verifiable history is sufficient.

This candidate is disclosure, not a claim that WAG is widely used. Refresh it only with genuine independent evidence.

Do not manufacture:
- stars
- downloads
- users
- contributors
- issue activity
- project age
- media/community references

## First-release plan

Selected/published:
- product version: `0.1.0` - merged on `main`;
- unsigned preview tag: `v0.1.0-preview.1` - published as immutable prerelease;
- preview source/tag target: `c1eb195f54864dee1a8997c9baeb0475ce627da6`;
- GitHub release ID: `391834069`;
- release asset SHA-256: `3f31ebe7258803aaf44194c05c4ae0ce241f7f2849507f7c0f153b129264e733`;
- GitHub release/asset attestation verification: PASS;
- later signed stable tag: not selected (`v0.1.0` remains the recommendation).

Current unsigned candidate:
- source commit `c1eb195f54864dee1a8997c9baeb0475ce627da6`;
- package/PE version: `0.1.0` / `0.1.0.0`;
- main workflow run `35345822405` attempt `1` - SUCCESS;
- flat/pre-sign SHA-256 `3a07d599b5ee06d9eaa90a83e9b81f58386f55f383d0d04f5fa04038d02ac8e2`;
- Authenticode/catalog SHA-256 `73de2fbbfe7569478b75ce4ecffdc39503107b47145c792e53ada5cf61ea525d`;
- exact main readiness - `releaseReady=true`, `blockers=[]`.

Historical `e296da1` / `0.0.0` readiness evidence remains superseded.

## Node SEA policy question for SignPath

Use a concise, neutral question:

> WAG uses Node's documented Single Executable Application flow: we copy the official pinned Node executable, remove its original signature, inject the WAG SEA blob, apply WAG-specific VERSIONINFO, preserve Node and bundled-component license notices, and treat that output as the WAG application executable. WAG does not modify or fork Node source. Does SignPath Foundation consider this resulting application executable to be WAG's own binary for signing, or does the Foundation's modified-upstream visible-fork condition apply to this packaging model?

Supporting evidence:
- Node SEA docs: `https://nodejs.org/api/single-executable-applications.html`
- builder: `scripts/build-native-host.ts`
- PE metadata mutator: `scripts/native-host-pe-metadata.ts`
- third-party manifest: `browser/native-host/third-party-components.json`
- exact unsigned-candidate receipt available for the selected release candidate

Favorable but non-binding Foundation precedent:
- SignPath Foundation's public project list includes Super Productivity and Heroic Games Launcher;
- both projects publicly build Windows Electron applications from an upstream runtime and submit resulting application executables to SignPath for Authenticode signing;
- Heroic's workflow packages unpacked Electron applications, uploads unsigned `Heroic.exe` binaries, signs those application binaries with SignPath, then builds/signs installers;
- Super Productivity's workflow builds Electron Windows executables, uploads the unsigned executables, submits them to SignPath, then verifies the returned Authenticode signatures.

This precedent reduces the concern that any application executable containing an upstream runtime must automatically be treated as a prohibited modified-upstream binary. Electron packaging is not identical to Node SEA, so it does not decide WAG's classification.

State:
- `PROVIDER_CONFIRMATION_WITH_FAVORABLE_PRECEDENT`

Do not argue with SignPath if they interpret the policy differently. Treat their project-specific answer as provider authority.

## GitHub / origin-verification plan

SignPath project repository URL:
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
- PASS_VERIFIED_UI

Verification:
- verified directly in GitHub `Settings -> Password and authentication` on 2026-09-19 using a dedicated read-only browser worker;
- source-repository account MFA is enabled;
- configured MFA methods and recovery details are intentionally not recorded in this public repository.

SignPath account MFA:
- must be enabled/configured according to provider onboarding if and when provider-side setup is separately authorized.

The GitHub API token scope was not widened for this verification.

## Reputation timing

SignPath publishes no numeric reputation threshold, while the live application form requires a `Reputation*` answer. A sample of comparable accepted executable projects shows public repository ages ranging from roughly two months to well over a year when first observed on the Foundation project list; low-star AMIGOpy had substantially longer history, while shorter-history AI projects had strong visible traction.

WAG was created on 2026-09-09 and became public on 2026-09-19. Its public-history profile is therefore still very young, and current live GitHub signals do not establish broad external adoption.

Decision state:
- `WAIT_REPUTATION_SIGNAL`

Current search/discovery evidence:
- GitHub-native search finds the exact `ShenJun93/web-agent-gateway` repository;
- general public-web exact-name discoverability remains weak/ambiguous because similarly named projects can outrank WAG;
- treat discoverability as a supporting application-quality risk, separate from reputation itself.

Do not invent a fixed waiting period or manufacture popularity. Resume application-readiness review when at least one genuine independent signal appears or exact-project public-web discoverability materially improves. Suitable signals include independent user/reference activity, non-maintainer issue/contribution activity, independent community/blog/media discussion, or uncontaminated usage evidence.

See `docs/research/2026-09-18-signpath-reputation-timing.md`.

## Current blockers before submission

Completed publication prerequisites:
- repository is public;
- public README/license/security/privacy/code-signing/install links were verified anonymously;
- immutable releases are enabled before the first public binary release;
- private vulnerability reporting, Dependabot alerts, secret scanning, push protection, stricter fork-PR approval, and a minimal `main` history-protection ruleset are enabled.

Repository-side technical prerequisites:
- no unresolved repository-side hard blocker is currently identified.

Application-completion inputs that remain outside repository authority:
- First Name, Last Name, Email;
- optional Company Name;
- Primary Discovery Channel and optional exact discovery source;
- required Code-of-Conduct agreement;
- required personal-data processing consent;
- optional marketing-communications choice.

Submission-decision gate:
- `Reputation*` is a required live form field;
- WAG currently lacks a genuine independent trust/adoption signal;
- exact-project public-web discoverability is still weak/ambiguous;
- state: `WAIT_REPUTATION_SIGNAL`.

Provider-policy question to carry into eligibility/application review:
- obtain SignPath's project-specific interpretation of whether WAG's Node SEA executable is WAG's own application binary or falls under the modified-upstream visible-fork condition;
- current risk classification: `PROVIDER_CONFIRMATION_WITH_FAVORABLE_PRECEDENT`, based on accepted Foundation Electron projects whose runtime-based Windows application executables are publicly submitted to SignPath for signing.

The public release/download facts are refreshed from the immutable release. SignPath submission still requires separate explicit authority.

## Explicitly not authorized by this draft

- further product-version or stable-tag selection
- Git commit amendment/rebase of accepted history
- Git push/merge
- further repository security/settings changes
- tag/release creation
- SignPath contact/submission
- account/project creation
- API token creation
- GitHub App installation
- trusted-build-system configuration
- signing
