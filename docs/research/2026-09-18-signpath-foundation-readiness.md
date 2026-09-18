# SignPath Foundation Readiness Research — 2026-09-18

## Scope

This is a read-only/provider-readiness research receipt for the zero-cost trusted Windows code-signing path.

It does not authorize or perform:
- repository visibility changes;
- license selection or addition;
- release/tag creation;
- SignPath application/account/project creation;
- identity validation;
- OIDC/federation or credential creation;
- signing;
- trust-store, Smart App Control, installation, or registry mutation.

Research base:
- WAG worktree: `feat/browser-inspect-v2`;
- source HEAD: `e19d57789b03dae36901c633482a89714eb52e11`;
- SignPath terms/docs and Microsoft Windows signing guidance current on 2026-09-18;
- live GitHub repository metadata and current remote Actions/artifact inventory.

## Executive conclusion

SignPath Foundation remains the best verified durable $0 path for WAG's existing PE/Authenticode architecture.
It supports PE Authenticode and verifiable CI provenance, and Microsoft currently lists SignPath Foundation as a free OSS code-signing option.

WAG is not ready to apply today. The remaining gaps are predominantly OSS/release hygiene and artifact identity rather than signer technology.

The strongest unresolved policy question is whether SignPath will treat WAG's Node SEA executable as a modified upstream Node binary requiring the explicit upstream-fork conditions in its policy.
## Binding SignPath Foundation conditions

Current SignPath Foundation terms require, at minimum:
- an OSI-approved Open Source license with no commercial dual-licensing for all project components;
- no proprietary project components;
- active maintenance;
- an existing release in the form that should be signed;
- documented functionality on the download/release page;
- source-repository MFA for all relevant team members;
- clear Author, Reviewer, and Approver roles;
- manual approval of every signing request;
- a project-home-page section or link explicitly named `Code signing policy`;
- privacy-policy disclosure;
- warnings before system-configuration changes;
- uninstall instructions/facilities whenever install instructions/facilities exist;
- verifiable automated build provenance;
- enforced PE metadata, including project product name and consistent product version.

SignPath additionally states that executable projects require a certain verifiable reputation. No numeric age/star/download threshold is published.

Sources:
- https://signpath.org/terms.html
- https://signpath.org/
- https://docs.signpath.io/artifact-configuration/reference
- https://docs.signpath.io/artifact-configuration/examples

## Current WAG OSS/repository state

Live GitHub repository:
- repository: `ShenJun93/web-agent-gateway`;
- visibility: private;
- default branch: `main`;
- license metadata: none;
- GitHub Releases: none found;
- Git tags: none found;
- repository owner has admin/maintain/push authority.

Local source tree:
- no tracked `LICENSE`, `COPYING`, or `NOTICE`;
- `package.json` has `private: true`, which prevents accidental npm publication but does not establish a software license;
- tracked worktree is clean at the research base.
## Pre-public exposure audit

A focused current-tree and Git-history credential scan found no real credential/private-key material using common token/key patterns.

Observed token/password strings are test fixtures, placeholders, or variable names. Examples include:
- `<local-owner-secret>`;
- test-only DevSpace owner/access tokens;
- generated runtime bearer/bootstrap token code.

Commit author emails observed are GitHub noreply addresses or non-routable local fixture addresses.

The repository does contain operational benchmark documentation with local path examples such as `E:\AI-BROWSER\...` and `%LOCALAPPDATA%\...`. These are not credentials, but they will become public operational metadata if the repository is published.

The remote has many historical feature/research branches. Making the repository public makes repository code publicly visible and forkable; GitHub also states that Actions history and logs become visible.

A high-confidence credential-pattern scan across all current remote branch tips found only documentation lines that literally discuss secret-pattern names such as `github_pat_` and `sk-proj-`; it found no credential-shaped values or private-key material.

Current Actions inventory contains 23 unexpired native-host distribution artifacts, primarily historical unsigned Windows executables, expiring around 2026-09-27 through 2026-09-30.

Pre-public gate:
- either explicitly delete obsolete historical unsigned artifacts/runs after separate authorization;
- or wait for their configured retention expiry;
- then re-audit public exposure immediately before changing visibility.

Source:
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility
- https://docs.github.com/en/rest/actions/artifacts
## License decision analysis

Both MIT and Apache-2.0 are OSI-approved and compatible in principle with the current npm dependency inventory.

Current package-lock license metadata is limited to:
- MIT;
- ISC;
- Apache-2.0.

No GPL/AGPL/proprietary npm dependency was identified in the current lockfile.

### MIT candidate

Advantages:
- minimal text and maintenance burden;
- common across Node/TypeScript tooling;
- broad reuse and commercialization permissions.

Trade-off:
- no explicit patent grant language comparable to Apache-2.0.

### Apache-2.0 candidate

Advantages:
- OSI-approved and already represented in the dependency graph;
- explicit patent license and patent-termination provisions;
- common for infrastructure, protocol, and security-adjacent software;
- already used by accepted SignPath Foundation projects.

Trade-off:
- more notice/compliance text than MIT.

Research recommendation only: Apache-2.0 is the stronger candidate for WAG's long-lived infrastructure/security role, but selecting it is a legal/product decision and remains explicitly unauthorized by this research receipt.

OSI source:
- https://opensource.org/licenses
## Node SEA and third-party licensing

WAG's Windows executable is built by:
1. bundling WAG TypeScript/JavaScript;
2. generating a Node SEA blob;
3. copying the pinned Node executable;
4. removing the source Authenticode signature;
5. injecting the SEA blob with postject;
6. later signing the resulting WAG executable.

This sequence is consistent with Node's documented manual SEA flow, which copies the Node executable, optionally removes the Windows signature, injects the blob, and permits subsequent signing.

Source:
- https://nodejs.org/api/single-executable-applications.html

The distributed executable therefore contains/derives from the Node runtime. Node's official LICENSE includes the Node MIT license plus a substantial set of third-party notices and license texts.

Source:
- https://github.com/nodejs/node/blob/main/LICENSE

A future public binary release must not ship only WAG's own license. The release packaging gate should preserve the exact license obligations for:
- the pinned Node runtime;
- WAG JavaScript dependencies actually bundled into the SEA;
- any other redistributable third-party binary/source incorporated into the release.

Do not hand-maintain an incomplete notice list if the build can derive the actual bundled dependency set deterministically.

A robust later implementation can use the esbuild metafile to identify bundled packages and generate/review a deterministic third-party-license manifest from exact lockfile/package license files.
## SignPath modified-upstream policy risk

SignPath says projects may sign only their own binaries. For a project's modified version of upstream software, its terms describe additional conditions including a visible upstream fork and release branches based on normally signed upstream branches.

Literal application of that clause to Node SEA is unresolved because WAG modifies a copy of `node.exe` by injecting its application blob rather than maintaining a source fork of Node.

Evidence reducing, but not eliminating, this risk:
- SignPath Foundation accepts Electron desktop applications such as Sokuji and PoE Overlay Community Fork;
- these products also distribute application executables incorporating a large upstream runtime/framework;
- SignPath's artifact configuration explicitly supports PE metadata restrictions and application-specific signing.

This is precedent, not a contractual determination for Node SEA.

State:
`NODE_SEA_SIGNPATH_POLICY = UNRESOLVED_PROVIDER_INTERPRETATION`

Do not redesign WAG away from Node SEA solely on this ambiguity before SignPath gives project-specific acceptance guidance.

SignPath's separate exclusion for hacking/vulnerability-exploitation tools does not presently look like a category blocker for WAG. Foundation already lists AI/local-agent infrastructure such as OpenAgents Launcher and MCPProxy. WAG should nevertheless describe itself accurately as a bounded local capability gateway and must not claim vulnerability-scanning or security-bypass behavior it does not implement.

Sources:
- https://signpath.org/terms.html
- https://signpath.org/projects/sokuji/
- https://signpath.org/projects/poe-overlay-cf/
- https://signpath.org/projects/openagents-launcher/
- https://signpath.org/projects/mcpproxy/
## PE metadata gap

The current installed WAG native-host executable still reports inherited Node metadata:
- FileDescription: `Node.js JavaScript Runtime`;
- ProductName: `Node.js`;
- ProductVersion: `24.20.0`;
- CompanyName: `Node.js`;
- OriginalFilename: `node.exe`;
- InternalName: `node`.

SignPath requires signed PE metadata restrictions and specifically requires product name to identify the project and product versions to be consistent within a build.

Source:
- https://signpath.org/terms.html
- https://docs.signpath.io/artifact-configuration/reference

Required future build order:

`bundle -> SEA blob -> copy node.exe -> remove upstream signature -> postject -> set WAG PE metadata -> record unsigned candidate -> SignPath sign -> verify`

PE metadata mutation must occur before the unsigned-candidate receipt. Mutating PE resources after that receipt would invalidate the current Authenticode-hash continuity design.

No metadata mutator is selected by this research. Prefer a deterministic, reviewed mechanism with minimal dependency/supply-chain surface.
## CI/provenance fit

The current native-host distribution workflow is already a strong starting point:
- GitHub-hosted Windows runner;
- exact Node version;
- `npm ci`;
- package-manager cache disabled;
- pinned GitHub Actions commit SHAs;
- typecheck/build/focused tests;
- exact candidate build;
- deterministic receipt verification;
- artifact upload from main pushes;
- repository permissions limited to `contents: read`.

SignPath's model requires verifiable build provenance and manual signing approval.

Future SignPath integration should therefore extend, not replace, this pipeline:
- build the exact unsigned candidate on GitHub-hosted Windows;
- record unsigned provenance before signing;
- upload/submit exactly that artifact through the supported SignPath GitHub integration;
- require manual SignPath approval for signing;
- download/consume only the resulting signed artifact;
- run WAG's independent RSA/AuthentiCode/content-continuity verifier;
- only then create release evidence.

No OIDC/SignPath workflow mutation is authorized yet.
## Release prerequisite

SignPath requires the project to already be released in the same form that should be signed.

For WAG, the qualifying release form should be the Windows native-host distribution containing the executable plus required provenance/license material, not merely a source-only GitHub tag.

A first unsigned public release may therefore be needed before the SignPath application unless SignPath accepts a clearly documented pre-sign release candidate as satisfying the policy.

Because releasing an unsigned executable can confuse users, the preferred readiness design is:
- make the project OSS/public only after license/policy/pre-public gates pass;
- document the native-host artifact as pre-signing/preview if an unsigned release is needed solely to establish release form;
- avoid presenting historical unsigned CI artifacts as supported releases;
- obtain provider clarification before deliberately publishing an unsigned executable merely to satisfy wording.

Release creation remains an external mutation requiring separate explicit authorization.

## Reputation evidence

SignPath publishes no hard threshold for stars or downloads.

Accepted-project sampling shows that high popularity is not required:
- AMIGOpy is an accepted SignPath Foundation project and currently has single-digit GitHub stars;
- older low-to-moderate-star projects are also accepted.

This suggests project history, transparent maintenance, release provenance, documentation, and reviewer/maintainer accountability matter more than raw star count.

WAG's principal reputation weakness is therefore its very young public history, not a zero-star count by itself.
## Other durable $0 options

### OSSign

OSSign remains a legitimate free trusted-signing fallback, but current applications are suspended and its published eligibility has project/account age requirements that WAG cannot satisfy near-term.

State:
`OSSIGN = REAL_FALLBACK_NOT_NEAR_TERM`

### Microsoft Store MSIX

The Store can sign MSIX packages at no signing-certificate cost, but that changes WAG's distribution/installation architecture and does not directly satisfy the current standalone `wag-native-host.exe` Authenticode gate.

State:
`STORE_MSIX = FREE_BUT_NON_DROPIN`

### Azure Artifact Signing

Current Microsoft guidance excludes free/trial/sponsored subscription paths for this service.

State:
`AZURE_FREE_CREDIT_PATH = CLOSED`

## Readiness matrix

| Requirement | Current WAG state | Readiness |
| --- | --- | --- |
| Durable $0 PE signer exists | SignPath Foundation | PASS |
| OSI-approved project license | none | BLOCKED_DECISION |
| Proprietary WAG component | none identified; license absent | BLOCKED_LICENSE |
| Public/source-verifiable project | currently private; public authorized | READY_AFTER_GATES |
| Existing release in signed form | none | BLOCKED |
| Documented functionality | README/specs strong; no public download page | PARTIAL |
| Code signing policy | absent | BLOCKED |
| Privacy disclosure | no SignPath-format public policy | BLOCKED |
| Install/uninstall disclosure | internal semantics exist; user-facing docs incomplete | PARTIAL |
| MFA | not verified in this receipt | EXTERNAL_CHECK |
| Signing roles | solo-owner model possible; not documented | BLOCKED_DOC |
| Verifiable automated build | strong existing workflow | PASS_BASE |
| Manual signing approval | no SignPath project yet | NOT_CONFIGURED |
| PE product metadata | inherited Node identity | BLOCKED_BUILD |
| Node SEA policy interpretation | unresolved | PROVIDER_QUESTION |
| Reputation | very young project | RISK |
## Minimal no-cost path

The smallest credible path is:

1. Complete pre-public exposure audit, including remote branches and Actions history/artifacts.
2. Obtain explicit license selection authority.
3. Add the selected OSI license and deterministic third-party licensing/notice strategy.
4. Add public `SECURITY.md`, code-signing policy, privacy behavior, installation/system-change warning, and uninstall documentation.
5. Add a bounded PE metadata normalization design and implementation before candidate recording.
6. Re-run full native-host build/signing-candidate verification.
7. Ensure obsolete unsigned CI artifacts are expired or explicitly removed.
8. Change repository visibility to public using the already-granted publication authority only after the above safety gates.
9. Establish one documented public release form without misrepresenting unsigned artifacts as trusted.
10. Ask SignPath the exact Node SEA/upstream-policy question or submit only after the project clearly meets all other conditions.
11. If accepted, design the exact SignPath GitHub/manual-approval integration.
12. Only after separate authorization, create provider resources/integration and sign.
13. Require WAG's current RSA/trust/AuthentiCode/content-continuity verifier to pass without relaxation.

## Authority boundaries

Already authorized:
- read-only research;
- readiness/design work;
- eventual repository publication, subject to pre-public safety gates.

Still requires explicit authorization:
- selecting/adding the project license;
- deleting GitHub workflow runs/artifacts or remote branches;
- creating a tag/release;
- applying to SignPath;
- account/project creation;
- SignPath/GitHub integration or OIDC changes;
- credentials;
- signing;
- install/register/reacceptance.

## Current decision state

```text
ZERO_COST_SIGNING_PRIMARY = SIGNPATH_FOUNDATION
SIGNPATH_READINESS = MATERIAL_GAPS_BUT_FEASIBLE
PUBLIC_REPOSITORY = AUTHORIZED_NOT_EXECUTED
LICENSE_SELECTION = NOT_AUTHORIZED
NODE_SEA_SIGNPATH_POLICY = UNRESOLVED_PROVIDER_INTERPRETATION
SIGNED_NATIVE_HOST_CANDIDATE_V1 = BLOCKED_SIGNER_SELECTION_AUTHORITY
BROWSER_INSPECT_V2_TASK6 = BLOCKED_APPLICATION_CONTROL
```
