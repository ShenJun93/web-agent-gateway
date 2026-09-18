# SignPath Foundation Readiness v1 Design

Date: 2026-09-18
Status: Proposed; readiness design only
Research receipt: `docs/research/2026-09-18-signpath-foundation-readiness.md`
Design base: `e19d57789b03dae36901c633482a89714eb52e11`

## Goal

Prepare WAG to become a credible SignPath Foundation applicant without weakening the existing Signed Native Host Candidate v1 trust model.

This design ends before SignPath application/account/project creation, signing integration, credential setup, signing, installation, or browser reacceptance.

## Non-goals

This design does not itself:
- select or add a software license;
- make the repository public;
- delete historical branches, workflow runs, or artifacts;
- create a Git tag or GitHub Release;
- apply to SignPath Foundation;
- create SignPath resources or identities;
- change GitHub OIDC/permissions;
- sign any artifact;
- relax RSA, Windows trust, SHA-256, Authenticode continuity, or execution-probe requirements.

## Primary architectural decision

Keep the existing Node SEA native-host architecture unless SignPath gives project-specific evidence that its modified-upstream policy rejects this form.
The zero-cost path should adapt WAG's OSS/release hygiene and PE identity around the already-reviewed native-host candidate flow, not redesign the runtime preemptively.

Canonical final byte order remains:

`bundle -> SEA blob -> copy Node -> remove source signature -> postject -> WAG PE metadata -> record unsigned receipt -> authorized signer -> verify signed candidate -> acceptance`

The only new production-build operation contemplated before signing is deterministic WAG-owned PE metadata normalization.

## Readiness gates

### Gate A — OSS license authority

Input:
- current project ownership/provenance audit;
- dependency and Node-runtime license inventory;
- explicit user authorization selecting one OSI-approved project license.

Output:
- project license file;
- package metadata updated consistently if appropriate;
- no commercial dual-license clause;
- documented third-party redistribution obligations.

This gate cannot be passed by making the repository public without a license.

Current recommendation for later decision: evaluate Apache-2.0 as the default candidate and MIT as the simplicity fallback. The design does not select either.

### Gate B — third-party redistribution evidence

The native-host release must carry license material for the software actually incorporated into the distributed executable.
At minimum the implementation must account for:
- the exact pinned Node runtime;
- npm packages included in the esbuild SEA bundle;
- any future redistributed binary/tool incorporated into release output.

Preferred implementation direction:
- enable/use esbuild metafile output to identify the actual bundled module set;
- map bundled package roots back to exact package-lock identities;
- collect deterministic license metadata/text from the installed exact packages;
- preserve the exact Node LICENSE corresponding to the Node runtime used to build the SEA;
- fail release packaging if a bundled component's license cannot be classified.

Do not treat the entire devDependency lockfile as the release contents, and do not hand-maintain an incomplete notices list.

The existing verified native-host distribution directory intentionally contains exactly three files: `wag-native-host.exe`, its checksum, and `build-receipt.json`. Do not widen that accepted inner contract merely to carry public-release legal documents. Prefer a new outer release package that contains the unchanged verified distribution payload plus project/runtime/third-party license material. This minimizes churn in the existing distribution and installation verifiers.

### Gate C — public project policy

Before publication, add public-facing documentation sufficient for SignPath and ordinary OSS users:
- project functionality and supported scope;
- `SECURITY.md` vulnerability-reporting policy;
- a README `Code signing policy` section or direct link using that exact term;
- signing roles and manual-approval model;
- privacy behavior;
- explicit warnings for native-host registration/system changes;
- install instructions;
- ownership-safe uninstall instructions;
- release/download trust guidance distinguishing signed releases from CI artifacts.

The privacy statement must reflect actual network behavior. Do not claim zero network transfer if WAG intentionally connects to user-configured/provider systems.
### Gate D — PE identity normalization

Current Node-inherited metadata is not acceptable for a WAG-signed executable.

Required invariant for `wag-native-host.exe` before unsigned-candidate recording:
- ProductName identifies Web Agent Gateway;
- FileDescription identifies the WAG native host;
- OriginalFilename is `wag-native-host.exe`;
- InternalName is WAG-owned rather than `node`;
- ProductVersion and FileVersion derive deterministically from the release version;
- CompanyName/copyright fields, if used, are stable project-authorized values and not inherited Node identity.

The exact copyright/legal-holder string is a separate project/legal decision and is not selected here.

Version rule:
- source release version is one SemVer `X.Y.Z`;
- Windows numeric metadata uses a deterministic four-component mapping such as `X.Y.Z.0`;
- every PE signed in one release uses the same product-version value.

Implementation status update (2026-09-18): under separate explicit authority, the release-candidate branch selects product version `0.1.0`; `main` adoption remains pending PR merge. This does not select a release tag or authorize publication.

### Metadata implementation choice

Do not use the deprecated npm `rcedit` wrapper as the default merely for convenience.
The underlying `electron/rcedit` project is proven and MIT-licensed but is now archived, so adopting it creates a frozen binary/tool dependency.

Before implementation, run a bounded spike comparing:
- exact-pinned/hash-verified upstream `electron/rcedit` v2.0.0;
- a minimal WAG-owned Windows resource updater using standard Win32 APIs;
- any maintained standard alternative found at implementation time.
Selection criteria:
- deterministic output;
- no network dependency during the accepted release build after dependency acquisition;
- small supply-chain surface;
- easy hash/version pinning;
- supports all required VERSIONINFO fields;
- preserves the injected SEA and passes the existing Authenticode hash machinery;
- maintainable by a solo operator.

Whichever mechanism wins becomes a native-host build input and must be covered by the existing source/build-input continuity rules.

### Gate E — metadata verification

Add a read-only PE metadata inspector/test independent of the mutator.

The acceptance test must prove:
- current source binary has WAG identity, not Node identity;
- version fields equal the release-derived expected values;
- executable basename is exact;
- postject payload still executes in the existing unsigned SEA tests;
- Authenticode SHA-256 is recorded only after metadata normalization.

Do not infer success merely because the mutator command exits zero.

## Public-repository cutover

Repository publication is already authorized in principle but remains blocked by safety prerequisites.

Immediately before changing visibility:
1. fresh-read canonical Git state and GitHub repository metadata;
2. re-run high-confidence secret/private-key scans across all reachable remote refs;
3. review outstanding remote branches for material not intended for publication;
4. inspect current Actions run/artifact inventory;
5. inventory obsolete unsigned native-host artifacts and confirm they contain no secret/private material; prefer expiry or separately authorized deletion before publication, but do not treat non-release unsigned build artifacts as an independent hard blocker after a clean exposure audit;
6. confirm license/policy gates are merged into the exact branch that will become public;
7. confirm no real credentials exist in Actions variables/logs/artifacts.
GitHub notes that private-to-public conversion exposes code to everyone, permits public forking, and makes Actions history/logs visible. Treat publication as effectively irreversible disclosure even though visibility can technically be changed again.

No force-push/history rewrite is planned merely to cosmetically remove benign local-path evidence. Rewrite history only if an actual credential/private datum is discovered, and then treat rotation/remediation as a separate incident.

## Public CI posture

The existing pull-request workflow is suitable as a starting point because it:
- runs on GitHub-hosted Windows;
- uses read-only repository permission;
- does not expose signing credentials;
- uses pinned action commits;
- builds/tests without a privileged signing step.

After publication:
- untrusted pull requests must never receive signing authority;
- signing must not run on `pull_request_target`;
- signer authority belongs only to an explicit protected release/manual path;
- ordinary PR CI remains unsigned;
- all release-signing source/build scripts require elevated review attention because SignPath provenance includes them.

## Historical artifact policy

Current historical Actions artifacts are unsigned distribution artifacts, not supported signed releases.

Preferred pre-public cleanup:
- wait for retention expiry; or
- separately authorize deletion of obsolete artifacts/runs.

After a clean credential/history audit, remaining historical unsigned artifacts are not themselves a hard publication blocker because they are build evidence derived from source that will become public. Their primary risk is user confusion. If publication precedes expiry, README/release policy must continue to state that Actions artifacts are unsupported and not Authenticode-trusted.

Do not silently re-label or promote historical unsigned CI artifacts as releases.

## First public release form

SignPath requires an existing release in the form to be signed.
WAG therefore needs a documented Windows native-host distribution form, not only a source tag.
The public release should use an outer package containing at least:
- the unchanged verified inner native-host distribution payload;
- project license;
- exact Node/runtime and bundled-dependency license material;
- concise install/uninstall/trust documentation or links;
- release/provenance metadata needed to bind the outer package to the verified inner receipt.

The outer package must not cause the existing inner verifier to accept extra files. The installer can continue consuming only the extracted verified inner distribution directory.

SignPath supports a ZIP root artifact with nested `pe-file` signing, but WAG must **not** submit its already-finalized three-file distribution for nested signing. Authenticode changes `wag-native-host.exe` bytes, which would invalidate the adjacent checksum and distribution receipt. The signing input therefore remains a separate pre-sign candidate artifact. Only after the returned executable passes WAG's signed-candidate verifier may the pipeline create a new final inner distribution whose checksum/receipt bind the signed executable, then wrap that verified distribution in the outer release ZIP.

The numeric product version `0.1.0` is now explicitly selected for the release-candidate branch under separate authority. The exact preview/stable tag identities and any release publication remain unauthorized.

Because publishing an unsigned executable can create user confusion, do not create an unsigned release solely to satisfy the word "Released" until the SignPath interpretation is clarified.

Preferred sequence:
- establish the public OSS repository and release documentation;
- prepare an exact release-candidate artifact;
- ask/apply with a clearly described intended release form;
- publish the first generally supported binary only after the signer path is accepted where possible.

If SignPath explicitly requires a downloadable pre-existing unsigned release, label it unambiguously as unsigned/pre-signing and never claim Windows trust.

## Code signing policy structure

The eventual README/home page should contain an exact `Code signing policy` heading or direct link.

The policy must identify:
- free signing by SignPath.io / certificate by SignPath Foundation if and only if the application is accepted;
- current Authors/Reviewers/Approvers;
- manual approval requirement for every signing request;
- privacy behavior/link;
- exact official release location;
- statement that CI artifacts are not supported releases unless explicitly promoted;
- signature-verification guidance.

Do not claim SignPath service before acceptance.
## Solo-maintainer role model

A solo maintainer is not automatically excluded.
For WAG v1, one person may hold Author and Approver responsibilities if SignPath accepts the arrangement.

Review semantics:
- outside contributions require maintainer review before merge;
- maintainer-authored changes are covered by the project's Author role;
- every signing request still requires an explicit manual approval event;
- signing approval is never inferred from push/merge alone.

Do not fabricate a second reviewer identity merely to appear multi-person.

## SignPath artifact configuration

After provider acceptance, use the narrowest artifact configuration possible:
- exact `wag-native-host.exe` path/name;
- PE metadata restrictions matching WAG release identity;
- Authenticode SHA-256;
- no wildcard signing of arbitrary PE files;
- no signing of upstream third-party executables with the WAG subscription.

Conceptual only:

```xml
<pe-file path="wag-native-host.exe"
         product-name="Web Agent Gateway"
         product-version="${version}"
         original-filename="wag-native-host.exe">
  <authenticode-sign hash-algorithm="sha256" />
</pe-file>
```

The real configuration must also bind the final approved metadata fields and version mapping. This example is not provider configuration authority.

## Node SEA provider question

Before SignPath integration design is finalized, obtain a provider-specific answer to one question:

> Does a Node Single Executable Application produced by copying the official signed Node executable, removing its signature, and injecting the project's SEA blob count as the project's own application binary, or as a modified upstream binary requiring the visible-fork conditions in the Foundation policy?
Supporting context for that question should include:
- link to Node's official SEA documentation;
- exact WAG builder source;
- statement that WAG does not modify Node source;
- exact Node version pin;
- plan to preserve Node and third-party licenses;
- plan to replace inherited Node VERSIONINFO with WAG metadata before signing;
- WAG's independent pre/post Authenticode content-continuity verification.

Do not redesign around the answer until the answer exists.

## Reputation posture

Do not manufacture stars, downloads, accounts, or artificial activity.

Build verifiable reputation through normal project evidence:
- public source history;
- useful README/docs;
- real releases;
- transparent issues/changes;
- reproducible CI;
- security policy;
- actual users/contributors when they occur.

SignPath's accepted AMIGOpy project demonstrates that single-digit stars do not automatically prevent acceptance, but WAG's very young age remains a legitimate discretionary risk.

## Minimal GitHub protection posture

SignPath's OSS terms distinguish Authors from external contributors: trusted Authors may modify source without additional review, while non-committer contributions require review. A solo-maintainer project therefore must not fabricate a second reviewer or impose an impossible self-approval workflow merely for appearance.

For WAG, the minimal compatible public GitHub posture is:
- keep `main` free of force pushes;
- prevent deletion of `main`;
- keep external pull requests subject to maintainer review as documented in `CONTRIBUTING.md`;
- do not require a second-person approval for maintainer-authored changes unless another trusted maintainer actually exists;
- keep release signing restricted by SignPath origin verification to `main` (or a future explicitly approved `release/*` branch);
- require GitHub-hosted runners for every job leading to an OSS signing request;
- do not allow untrusted PR jobs to submit signing requests.

GitHub branch/tag rulesets are available on public repositories even on GitHub Free. A future active `main` ruleset with non-fast-forward/force-push protection and deletion protection is useful defense-in-depth, but it is not a prerequisite for the current local readiness checkpoint and is not authorized by this design alone.

Do not add a SignPath `pull_request` ruleset constraint with a non-zero approving-review count while WAG has only one trusted maintainer; that would either deadlock releases or require a bypass that misrepresents the actual governance model.

SignPath origin verification itself can bind repository URL, branch, commit, GitHub workflow origin, artifact upload, and GitHub-hosted runner provenance without inventing a second reviewer.

## Downstream signing integration gate

Only after SignPath accepts the project:
1. write a separate provider-specific integration design;
2. enumerate exact SignPath/GitHub permissions and credential/federation model;
3. preserve `contents: read` and add only strictly required signing permissions;
4. keep PR jobs incapable of signing;
5. build and verify the exact unsigned candidate;
6. record its unsigned-candidate receipt before any signing mutation;
7. upload the candidate as the GitHub workflow artifact used for the SignPath request (direct artifact or GitHub-generated ZIP, according to the final SignPath action mode);
8. require SignPath origin verification for the exact repository/branch/commit and GitHub-hosted runner lineage;
9. require manual provider approval for every release signing request;
10. download/extract the returned signed executable and verify it with WAG's existing signed-candidate verifier;
11. only after verification, package a fresh inner distribution whose checksum/receipt bind the signed bytes;
12. verify that inner distribution and then create the outer release ZIP with project/runtime licenses and public installation/privacy/signing-policy documentation;
13. keep signing evidence free of credentials/local machine paths.

No step in this design grants that authority.
## Acceptance criteria for readiness v1

Readiness v1 may be marked PASS only when:
- an explicitly authorized OSI license is present;
- third-party license packaging is deterministic and verified;
- public policy/security/install/uninstall docs satisfy SignPath requirements;
- PE metadata is WAG-owned and deterministic;
- focused native-host tests/typecheck/build pass;
- no credential/private-key exposure is found across publication surface;
- historical unsigned artifacts are no longer an accidental public download surface;
- repository publication has been deliberately executed and verified;
- exact release form is documented;
- Node SEA policy question is either resolved or explicitly accepted as application-time risk.

Readiness PASS does not mean signer selection/signing PASS.

## Explicit stop points

STOP before each of:
- license selection/addition without explicit authorization;
- destructive GitHub cleanup;
- visibility change if the immediate pre-public audit fails;
- tag/release creation without explicit authorization;
- SignPath application/account/project creation;
- provider integration/OIDC/credential mutation;
- signing;
- native-host install/register/reacceptance.

## Current state

```text
SIGNPATH_FOUNDATION_READINESS_V1 = DESIGNED_NOT_AUTHORIZED_FOR_IMPLEMENTATION
PUBLIC_REPOSITORY = AUTHORIZED_IN_PRINCIPLE_BLOCKED_PREPUBLIC_GATES
LICENSE_SELECTION = NOT_AUTHORIZED
FIRST_PUBLIC_RELEASE = NOT_AUTHORIZED
SIGNPATH_APPLICATION = NOT_AUTHORIZED
SIGNING = NOT_AUTHORIZED
```
