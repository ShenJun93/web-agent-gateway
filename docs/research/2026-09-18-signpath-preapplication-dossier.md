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

Selected preview identity:
- tag name: `v0.1.0-preview.1`;
- intended tag target/source candidate: `c1eb195f54864dee1a8997c9baeb0475ce627da6`;
- tag object: not created;
- GitHub Release: not created.

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
- 32 unexpired Actions artifacts remain build evidence, including the exact `0.1.0` candidate-evidence, signing-input, and distribution artifacts;
- the exact `c1eb195f54864dee1a8997c9baeb0475ce627da6` candidate artifacts expire on 2026-10-02;
- SHA-anchored Gitleaks evidence remains historical audit evidence: exact `b1576de8e1d74ef6894621d53df9b0309dd6685f` scanned 258 commits; full-clone/all-ref scans at exact `31e76668139e4cc5c742520482fe6743bd91f7e8` each scanned 259 commits with the same five triaged public/non-secret detections;
- a later full all-ref post-merge audit at `b83ba368b990d7518ef430929e77f30d99ca89d5` scanned 260 commits and reported the same five detections, with no credential/private-key finding;
- all 69 historical Actions run logs were separately scanned after publication; Gitleaks reported zero leaks and explicit high-risk token/private-key patterns were absent.

Actions artifacts are build evidence, not release assets. The repository is now public, so their remaining risk is user confusion rather than source confidentiality. README and code-signing policy continue to state that Actions artifacts are not supported releases and no current release is Authenticode-trusted.

Official GitHub sources:
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility
- https://docs.github.com/en/rest/actions/artifacts
## Application fields still blocked

### Public repository URL

Public URL: https://github.com/ShenJun93/web-agent-gateway

Anonymous access was verified after the 2026-09-19 visibility cutover.

State: PASS_PUBLICATION

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

GitHub currently reports `3` downloads for the preview ZIP at this reconciliation checkpoint. Project-owner verification downloads were performed during draft/post-publication validation, so this counter must not be represented as external-user adoption or reputation evidence.

State: OPERATOR_VERIFICATION_CONTAMINATED / NOT_REPUTATION_EVIDENCE

Do not manufacture reputation evidence.

### MFA

SignPath terms require MFA for all relevant SignPath and source-repository accounts.

Current GitHub MFA status remains unverified. A read-only `gh api user` query authenticated as `ShenJun93`, but the active OAuth token has `repo`, `workflow`, `read:org`, and `gist` scopes and lacks `read:user`; GitHub therefore returned no private `two_factor_authentication` value. Per GitHub's REST documentation, `read:user` (or broader `user`) is required for that private field.

Do not infer enabled or disabled from the missing field, and do not widen the token scope merely for this dossier.

State: REQUIRES_MAINTAINER_CONFIRMATION_BEFORE_APPLICATION

### SignPath account / organization / project

None are created or configured by this dossier.

State: REQUIRES_EXPLICIT_EXTERNAL_AUTHORITY

## Recommended application timing

Do not submit yet.

Submit only after:
1. GitHub MFA is explicitly confirmed;
2. separate explicit authority is granted for SignPath submission.

Repository publication, anonymous public docs/license verification, the real immutable release/download URL, and live release-fact refresh are complete. Carry the unresolved Node SEA ownership classification as a neutral provider question; do not manufacture a policy answer.

Historical unsigned Actions artifacts were a preferred pre-public cleanup, not a hard eligibility blocker after the exposure audit. The repository is now public while they remain active; keep them clearly non-release and unsupported until they expire naturally or are separately deleted under explicit authority.

Because SignPath requires a certain verifiable reputation for executable applications but publishes no numeric threshold, application acceptance remains discretionary. If the project is declined for insufficient public history, continue ordinary public development/releases and reapply later rather than manufacturing stars, downloads, contributors, or activity.

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
