# SignPath Foundation Pre-Application Dossier — 2026-09-18

Status: local readiness packet only; not an application and not authority to contact, create, configure, or sign with SignPath.

## Purpose

Collect the exact facts and unresolved fields needed for a SignPath Foundation application so the eventual submission can be short, verifiable, and consistent with WAG's source/build evidence.

Official policy sources:
- https://signpath.org/terms.html
- https://signpath.org/apply.html
- https://docs.signpath.io/trusted-build-systems/github
- https://docs.signpath.io/origin-verification/
- https://docs.signpath.io/projects

## Candidate application facts

### Project

Project name: Web Agent Gateway

Repository: https://github.com/ShenJun93/web-agent-gateway

Repository owner / sole source-code maintainer: `ShenJun93`

Repository created: 2026-09-09

Current local readiness branch commit count at dossier creation: 248

Current remote `main` commit count at dossier creation: 208

Project status: actively developed, but very young. Do not inflate age, users, stars, downloads, contributors, or adoption.

### License

Project license: Apache-2.0.

The remote default branch now contains:
- root `LICENSE`;
- `package.json` / lockfile Apache-2.0 metadata;
- exact Node 24.20.0 license material;
- exact bundled npm dependency license material;
- fail-closed native-host license-compliance verification.

GitHub detects Apache-2.0 on the public default branch. The public license URL is https://github.com/ShenJun93/web-agent-gateway/blob/main/LICENSE.
### Project description

Suggested concise description for application review:

> Web Agent Gateway (WAG) is a local, provider-neutral trust and capability gateway for Web AI clients that need bounded access to user-approved local development resources. The Windows native host connects a Chromium extension to a local WAG runtime and exposes a narrow read-only Browser Inspect v2 surface: health, workspace open, bounded repository search, bounded repository snapshot, and bounded file read. Identity, authority, workspace ownership, secrets, and policy remain under WAG control. The browser profile does not expose raw shell, process/PTY, Git writes, file mutation, browser mutation, or generic forwarding.

Do not describe WAG as a vulnerability scanner, security-bypass utility, hacking tool, generic remote shell, or autonomous unrestricted local agent. Those descriptions would be inaccurate and can conflict with SignPath Foundation's policy.

### Intended Windows artifact

Primary artifact to sign:
- `wag-native-host.exe`;
- Windows x64;
- Node.js 24.20.0 Single Executable Application;
- WAG JavaScript bundle injected into the pinned Node runtime;
- WAG-owned PE VersionInfo applied before unsigned-candidate recording;
- SHA-256 Authenticode required;
- RSA public-key algorithm required by WAG verifier;
- Windows-trusted public certificate chain required;
- timestamp required by the final signing profile.

The executable is built from WAG source plus the pinned upstream Node runtime. WAG does not modify Node source.

### Provider policy question

Ask SignPath during eligibility review, without arguing policy:

> WAG uses Node's documented Single Executable Application flow: it copies the official pinned Node executable, removes the source signature, injects the WAG SEA blob, applies WAG VersionInfo, and then treats that output as the WAG application binary. WAG does not modify or fork Node source and preserves the exact Node license notices. Does SignPath Foundation treat this application packaging model as WAG's own application binary for signing, or as a modified upstream binary subject to the visible-upstream-fork condition in the Foundation terms?

Provide:
- Node SEA docs: https://nodejs.org/api/single-executable-applications.html
- WAG builder path: `scripts/build-native-host.ts`
- WAG metadata mutator path: `scripts/native-host-pe-metadata.ts`
- license manifest: `browser/native-host/third-party-components.json`
- unsigned-candidate receipt for the exact application candidate.

Favorable, non-binding precedent:
- SignPath Foundation publicly lists Super Productivity and Heroic Games Launcher as Foundation projects;
- both public repositories use Electron-based Windows packaging and submit resulting application executables to SignPath for Authenticode signing;
- Heroic explicitly uploads unsigned packaged `Heroic.exe` application binaries to SignPath before installer construction;
- Super Productivity uploads its unsigned Electron-built Windows executables to SignPath and verifies the returned signatures.

This does not prove Node SEA eligibility, because Electron packaging and Node SEA are not identical. It does show that an application executable built on an upstream runtime is not automatically excluded from Foundation signing.

State: `PROVIDER_CONFIRMATION_WITH_FAVORABLE_PRECEDENT`.
## Code-signing policy evidence

Home-page requirement:
- README contains a `Code signing policy` section linking to the dedicated policy.

Policy location:
- `docs/policies/code-signing-policy.md`

Current roles:
- Author/committer: `ShenJun93`
- Reviewer for non-committer contributions: `ShenJun93`
- Approver for signing requests: `ShenJun93`

External contribution expectations are documented in `CONTRIBUTING.md`. SignPath's terms allow trusted Authors to modify source without additional review; the mandatory review rule applies to changes proposed by non-committers. WAG therefore does not invent a second maintainer or self-review requirement.

Signing-request rule:
- every signing request requires a separate manual approval event;
- push, merge, CI success, tag, or artifact upload does not itself approve signing.

Required attribution is documented as the intended post-acceptance statement:
- “Free code signing provided by SignPath.io, certificate by SignPath Foundation.”

The policy explicitly states that this does not claim acceptance before SignPath accepts the project.

## Privacy / system-change / uninstall evidence

Privacy:
- `docs/policies/privacy.md`
- WAG does not operate a centralized project telemetry collector;
- data returned through a user-selected external WebChat/provider can become part of that provider conversation;
- the policy does not falsely claim zero network transfer.

System changes and removal:
- `docs/native-host-installation.md`
- documents exact per-user HKCU Native Messaging registration;
- documents local installation path;
- warns about configuration drift;
- provides ownership-safe removal rules.

## Build provenance

Current native-host workflow:
- GitHub-hosted `windows-2025`;
- pinned action commit SHAs;
- Node 24.20.0;
- `npm ci`;
- license-compliance gate;
- typecheck and build;
- focused tests;
- exact native-host candidate build;
- independent PE VersionInfo verification;
- exact artifact execution test;
- strict unsigned-candidate receipt recording on exact `main` pushes;
- dedicated GitHub Actions signing-input artifact containing only `wag-native-host.exe`;
- strict distribution packaging and verification kept separate from the signing input;
- no signing credentials and no SignPath submission step in the current workflow.

A local SignPath artifact-configuration draft now exists at `.signpath/artifact-configurations/native-host.xml`. It models the GitHub Actions artifact ZIP, permits exactly `wag-native-host.exe`, restricts WAG PE identity/version fields, and requests SHA-256 Authenticode. The draft validates against SignPath's current official v1 XSD, but it has not been uploaded/configured provider-side.

SignPath Open Source Code Signing requires trusted-build verification and origin verification. The future authorized provider integration should extend this workflow, not replace it.

Intended origin restrictions:
- repository URL must equal the public WAG repository;
- release signing restricted to `main` or a deliberately selected release branch;
- GitHub-hosted runner required;
- unsigned artifact must be the artifact produced by the verified build;
- no untrusted pull-request signing;
- manual SignPath approval for every signing request.
## Current unsigned release-candidate evidence

Current candidate:
- source commit: `c1eb195f54864dee1a8997c9baeb0475ce627da6`;
- product/PE version: `0.1.0` / `0.1.0.0`;
- main workflow run: `35345822405` attempt `1` - SUCCESS;
- flat/pre-sign SHA-256: `3a07d599b5ee06d9eaa90a83e9b81f58386f55f383d0d04f5fa04038d02ac8e2`;
- Authenticode/catalog SHA-256: `73de2fbbfe7569478b75ce4ecffdc39503107b47145c792e53ada5cf61ea525d`;
- signature state: `NotSigned`;
- exact main readiness with downloaded receipt + EXE: `publicationReady=true`, `releaseReady=true`, `blockers=[]`.

Published preview identity:
- tag name: `v0.1.0-preview.1`;
- tag target/source candidate: `c1eb195f54864dee1a8997c9baeb0475ce627da6`;
- tag exists and remains anchored to exact `c1eb195f54864dee1a8997c9baeb0475ce627da6`;
- immutable GitHub prerelease exists as release ID `391834069`;
- the published release contains the exact frozen unsigned ZIP and must not be replaced by later signed bytes.

Historical `e296da1` / `0.0.0` candidate evidence remains superseded and must not be published or signed.

## Verification evidence

At the readiness checkpoint:
- full test suite: 274/274 PASS;
- typecheck: PASS;
- build: PASS;
- native-host license compliance: PASS;
- Windows VersionInfo independent verification: PASS;
- exact clean-HEAD SEA execution: 2/2 PASS;
- unsigned signature inspection: PASS as `NotSigned`;
- strict candidate receipt parse: PASS;
- worktree clean after receipt recording.

## Current GitHub publication surface

Post-release reconciliation on 2026-09-19, anchored to remote `main=c37e1e1977d3cd5ed0edb276eb407112a539606e`:
- repository visibility: public;
- GitHub-reported license on remote default branch: Apache-2.0;
- immutable GitHub prerelease `v0.1.0-preview.1`: published as release ID `391834069`;
- release tag target: `c1eb195f54864dee1a8997c9baeb0475ce627da6`;
- release ZIP SHA-256: `3f31ebe7258803aaf44194c05c4ae0ce241f7f2849507f7c0f153b129264e733`;
- GitHub release and asset attestations: independently verified;
- immutable releases: enabled (`enabled: true`, `enforced_by_owner: false`);
- active ruleset `Protect main history` targets `refs/heads/main` and blocks branch deletion and non-fast-forward updates only;
- private vulnerability reporting: enabled;
- Dependabot alerts: enabled with zero open alerts at reconciliation time; automated Dependabot security-update PRs remain disabled;
- secret scanning and repository push protection: enabled, with zero open secret-scanning alerts at reconciliation time;
- fork-PR workflow approval policy: `all_external_contributors`;
- 32 unexpired Actions artifacts remain build evidence at the 2026-09-19 lifecycle checkpoint, including the exact `0.1.0` candidate-evidence, signing-input, and distribution artifacts;
- the three exact `c1eb195f54864dee1a8997c9baeb0475ce627da6` artifacts are still active and expire on 2026-10-02 around 12:41Z; their current artifact IDs are `10546094325` (candidate evidence), `10545804630` (EXE-only signing input), and `10545824818` (distribution);
- artifact expiry is **not** a SignPath application blocker and does not invalidate the immutable preview release or its recorded hashes/attestations;
- artifact expiry does remove the old GitHub artifact ID as a future signing input, so an exact-candidate signing request would require an available regenerated GitHub workflow artifact;
- SHA-anchored Gitleaks evidence remains historical audit evidence: exact `b1576de8e1d74ef6894621d53df9b0309dd6685f` scanned 258 commits; full-clone/all-ref scans at exact `31e76668139e4cc5c742520482fe6743bd91f7e8` each scanned 259 commits with the same five triaged public/non-secret detections;
- a later full all-ref post-merge audit at `b83ba368b990d7518ef430929e77f30d99ca89d5` scanned 260 commits and reported the same five detections, with no credential/private-key finding;
- all 69 historical Actions run logs were separately scanned after publication; Gitleaks reported zero leaks and explicit high-risk token/private-key patterns were absent.

Actions artifacts are build evidence, not release assets. The repository is now public, so their remaining risk is user confusion rather than source confidentiality. README and code-signing policy continue to state that Actions artifacts are not supported releases and no current release is Authenticode-trusted.

### c1eb artifact lifecycle and signing fallback

The `c1eb195f54864dee1a8997c9baeb0475ce627da6` workflow uploads each artifact with `retention-days: 14`. Repository-level Actions retention is currently 90 days, but that does not retroactively extend these existing 14-day artifacts.

Current native-host build-input comparison from `c1eb195f54864dee1a8997c9baeb0475ce627da6` through current `main` reports zero changed `NATIVE_HOST_BUILD_INPUTS` entries. Candidate continuity therefore remains valid even though documentation/workflow-validation files have advanced.

Fallback order if signing is separately authorized later:

1. **Before artifact expiry:** the existing EXE-only signing-input artifact may be used only under a separately authorized SignPath signing flow.
2. **After expiry, while GitHub still permits re-running the original workflow run:** re-run exact run `35345822405` only under explicit workflow-rerun authority. GitHub documents that workflow re-runs are allowed for up to 30 days after the initial run and use the original run's `GITHUB_SHA` / `GITHUB_REF`. WAG artifact names include `github.run_attempt`, so a re-run can produce distinct attempt artifacts while retaining the original `c1eb195f` source identity.
3. **If the exact run can no longer be re-run, or if any native-host build input changes before signing:** record a fresh unsigned candidate from the then-authorized release source and use a distinct signed-release identity. Do not call different build inputs the same `c1eb195f` signing candidate.

The immutable unsigned preview remains historical/public evidence regardless of Actions-artifact expiry. A future signed stable release must remain distinct from `v0.1.0-preview.1`.

Official GitHub sources:
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility
- https://docs.github.com/en/rest/actions/artifacts
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs
## Live application form reconciliation — 2026-09-19

A dedicated read-only browser worker rendered the current SignPath Foundation HubSpot application form. No field was filled and nothing was submitted.

Required live fields:
- Project Name;
- Repository URL;
- Homepage URL;
- Tagline;
- Description;
- Reputation;
- Build System;
- First Name;
- Last Name;
- Email;
- Primary Discovery Channel;
- Code-of-Conduct agreement;
- personal-data processing consent.

Optional or conditional live fields:
- Download URL;
- Privacy Policy URL;
- Wikipedia URL;
- Maintainer Type;
- Company Name;
- exact discovery source;
- marketing-communications consent.

Exact deterministic WAG mappings:
- Project Name: `Web Agent Gateway`;
- Repository URL: public WAG GitHub repository;
- Homepage URL: public WAG GitHub repository;
- Download URL: do not auto-fill pre-acceptance; the live field is optional and requires a supplied download page to mention use of SignPath Foundation for code signing, while WAG's current immutable unsigned preview explicitly says SignPath acceptance is not claimed and the project is preparing an application;
- Privacy Policy URL: public WAG privacy policy;
- Wikipedia URL: blank unless a real English Wikipedia article exists;
- Maintainer Type: `Individual maintainer(s)`;
- Build System: `GitHub Actions`;
- Tagline/Description: use factual project wording already maintained in this dossier.

Human-input-only fields:
- First Name, Last Name, Email;
- Company Name, if applicable;
- Primary Discovery Channel and exact discovery source;
- all consent/agreement choices.

The live form's `Reputation` field is required and is not safely auto-fillable from current WAG evidence.

## Application field readiness

### Public repository URL

Public URL: https://github.com/ShenJun93/web-agent-gateway

Anonymous access was verified after the 2026-09-19 visibility cutover.

State: PASS_PUBLICATION

### Project-name discoverability

GitHub-native repository search finds `ShenJun93/web-agent-gateway` for the project name. General public-web exact-name search is not yet reliably distinctive: similarly named "Web Agent Gateway" projects can surface ahead of WAG.

The live application guidance says the project name should clearly identify the project in a Google search. This is therefore tracked as a supporting application-quality risk, not as a separate published numeric eligibility threshold.

State: `PUBLIC_WEB_DISCOVERABILITY_WEAK`

### License URL

Public Apache-2.0 license URL: https://github.com/ShenJun93/web-agent-gateway/blob/main/LICENSE

Anonymous access was verified after publication.

State: PASS_GIT_PUBLICATION

### Download / release URL

Public immutable prerelease:
- https://github.com/ShenJun93/web-agent-gateway/releases/tag/v0.1.0-preview.1
- release ID: `391834069`
- tag target: `c1eb195f54864dee1a8997c9baeb0475ce627da6`
- asset: `web-agent-gateway-native-host-windows-x64-0.1.0-preview.1-UNSIGNED.zip`
- asset SHA-256: `3f31ebe7258803aaf44194c05c4ae0ce241f7f2849507f7c0f153b129264e733`
- release state: prerelease, published, immutable
- GitHub release/asset attestation verification: PASS

The preview and any future signed stable release must keep distinct release/tag identities rather than replacing the published unsigned bytes.

State: PASS_PUBLIC_RELEASE

Historical Actions artifacts remain build evidence and are not the official release.

### Download counts / user evidence

At the 2026-09-19 live-form reconciliation checkpoint:
- stars: `0`;
- forks: `0`;
- subscribers/watchers: `0`;
- contributor list: `ShenJun93` only;
- preview ZIP counter: `4`.

Project-owner verification downloads were performed during release validation, so the preview ZIP counter must not be represented as external-user adoption or reputation evidence.

State: `OPERATOR_VERIFICATION_CONTAMINATED / NOT_REPUTATION_EVIDENCE`

### Reputation

The live SignPath application form requires a `Reputation` answer and asks for evidence that the project is widely used or trusted. SignPath's terms also state that downloadable executable programs require a certain verifiable reputation, without publishing a numeric threshold.

WAG is newly public and the current live public signals above do not establish broad external adoption. Technical quality, security controls, build provenance, and an immutable public release are verifiable project evidence, but must not be relabeled as independent reputation or usage.

Decision state: `WAIT_REPUTATION_SIGNAL`

Truthful candidate answer if a later authorized submission occurs before stronger evidence appears:

> Web Agent Gateway is a newly public open-source project with an immutable Windows preview release, public Apache-2.0 source, documented security/privacy/code-signing policies, GitHub Actions build provenance, and independently verifiable GitHub release attestations. The project became public on September 19, 2026, so we do not yet claim broad external adoption; current release download counts include maintainer verification traffic. We are providing the public repository and release evidence for SignPath Foundation to assess whether the project's current verifiable history is sufficient.

This is a disclosure answer, not external reputation evidence.

Do not manufacture reputation evidence. Resume application-readiness review when a genuine independent signal appears or exact-project public-web discoverability materially improves.

### MFA

SignPath terms require MFA for all relevant SignPath and source-repository accounts.

GitHub source-repository MFA was verified directly in GitHub `Settings -> Password and authentication` on 2026-09-19 using a dedicated read-only browser worker. Configured MFA methods and recovery details are intentionally not recorded in this public repository. No GitHub token scope was widened for the verification.

State: PASS_VERIFIED_UI

### SignPath account / organization / project

None are created or configured by this dossier.

State: REQUIRES_EXPLICIT_EXTERNAL_AUTHORITY

## Recommended application timing

Do not submit yet.

Application completion requires human selection of:
- First Name, Last Name, Email;
- Primary Discovery Channel and optional exact discovery source;
- Company Name if applicable;
- required Code-of-Conduct and personal-data-processing consents;
- optional marketing-communications choice.

Submission additionally requires:
1. separate explicit authority for SignPath submission.

GitHub source-repository MFA is already `PASS_VERIFIED_UI`. SignPath-account MFA remains a provider-onboarding requirement if and when provider-side setup is separately authorized.

Submission-decision state:
- `WAIT_REPUTATION_SIGNAL`: the mandatory Reputation field can be answered truthfully as a disclosure, but WAG still lacks a genuine independent trust/adoption signal;
- `PUBLIC_WEB_DISCOVERABILITY_WEAK`: GitHub-native discovery works, while general exact-name web discovery is still ambiguous.

Provider-side unresolved item:
- Node SEA own-binary versus modified-upstream classification remains a neutral provider question;
- risk classification is `PROVIDER_CONFIRMATION_WITH_FAVORABLE_PRECEDENT` because accepted Foundation Electron projects publicly submit runtime-based Windows application executables to SignPath.

Repository publication, anonymous public docs/license verification, the immutable release/download URL, and live release-fact refresh are complete.

Historical unsigned Actions artifacts remain unsupported build evidence rather than releases. Because SignPath publishes no numeric reputation threshold, acceptance remains discretionary. If current public history is insufficient, continue ordinary public development/releases and refresh only genuine reputation evidence rather than manufacturing stars, downloads, contributors, activity, or media references.

## Authority boundary

This dossier does not authorize:
- Git push or merge;
- further repository security/settings changes;
- artifact/run deletion;
- tag or release creation;
- SignPath contact/application/account/project creation;
- MFA setting changes;
- trusted-build linking;
- signing-policy creation;
- credentials/OIDC/token creation;
- signing.
