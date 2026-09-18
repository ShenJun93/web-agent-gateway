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

GitHub currently detects Apache-2.0 on the private default branch. The repository is still private, so the public license URL remains unavailable until a separately authorized visibility change.
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

As of 2026-09-18:
- repository visibility: private;
- GitHub-reported license on remote default branch: Apache-2.0;
- GitHub Releases: none;
- repository rulesets: none;
- immutable releases: disabled (`enabled: false`, `enforced_by_owner: false` from the read-only repository endpoint);
- 29 unexpired Actions artifacts exist in the refreshed pre-public audit, including the exact `0.1.0` candidate-evidence, signing-input, and distribution artifacts;
- the current `0.1.0` candidate artifacts expire on 2026-10-02; older historical artifacts expire earlier;
- repository Actions retention setting is 90 days, while these uploaded artifacts carry shorter per-artifact expiry.

GitHub documents that private-to-public conversion makes code and Actions history/logs visible to everyone. Artifact metadata for public repositories can be listed without authentication; downloading workflow artifacts uses the artifact download endpoint and authentication/Actions access rules documented by GitHub.

The 29 current/historical Actions artifacts are build evidence, not release assets, and the repository/source will itself become public. After the credential/history audit found no secret material, their remaining risk is primarily user confusion and accidental treatment as supported binaries, not confidentiality. Therefore artifact expiry/deletion is a **preferred pre-public cleanup**, not an independent hard publication blocker, provided the README and code-signing policy continue to state that Actions artifacts are not supported releases and no current release is Authenticode-trusted.

Official GitHub sources:
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility
- https://docs.github.com/en/rest/actions/artifacts
## Application fields still blocked

### Public repository URL

Known URL, but the repository is still private.

State: BLOCKED_PUBLICATION_SEQUENCE

### License URL

The remote default branch has Apache-2.0, but an anonymously accessible public license URL cannot be supplied until the repository is public.

State: BLOCKED_GIT_PUBLICATION

### Download / release URL

No GitHub Release exists. SignPath terms say the project must already be released in the form that should be signed.

The `0.1.0` candidate and preview tag name `v0.1.0-preview.1` are selected and prepared, but no tag object or GitHub Release exists. The preview and later signed stable release must keep distinct release/tag identities rather than replacing published unsigned bytes.

State: BLOCKED_PUBLICATION_AND_RELEASE_CREATION_AUTHORITY

Do not invent a download URL and do not use historical Actions artifacts as the official release.

### Download counts / user evidence

No public release exists, so there is no honest public binary download count.

State: ZERO / NOT_YET_APPLICABLE

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
1. repository is public and public docs/license links resolve;
2. a real release/download URL exists for the Windows artifact form;
3. MFA requirement is explicitly confirmed;
4. application facts are refreshed from live GitHub evidence.

Historical unsigned Actions artifacts should preferably be expired or explicitly deleted before publication, but they are no longer treated as a hard eligibility blocker after the exposure audit. If publication happens while they still exist, keep them clearly non-release and unsupported.

Because SignPath requires a certain verifiable reputation for executable applications but publishes no numeric threshold, application acceptance remains discretionary. If the project is declined for insufficient public history, continue ordinary public development/releases and reapply later rather than manufacturing stars, downloads, contributors, or activity.

## Authority boundary

This dossier does not authorize:
- Git push or merge;
- repository visibility change;
- artifact/run deletion;
- tag or release creation;
- SignPath contact/application/account/project creation;
- MFA setting changes;
- trusted-build linking;
- signing-policy creation;
- credentials/OIDC/token creation;
- signing.
