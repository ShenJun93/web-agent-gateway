# WAG Pre-Public Cutover Checklist — 2026-09-18

Status: execution checklist only. It does not authorize Git push/merge, repository settings changes, version selection, release creation, or SignPath submission.

## Current facts

Repository:
- `ShenJun93/web-agent-gateway`
- visibility: private
- default branch: `main`
- live remote branch inventory relevant to this integration: `main` only; `feat/browser-inspect-v2` and `docs/signpath-foundation-readiness-v1` are currently local-only
- GitHub repository description: unset
- homepage: unset
- topics: none
- remote GitHub-reported license: none because readiness work has not been pushed
- GitHub Releases: none
- repository rulesets: none
- immutable releases: disabled
- Pages: not configured

Checkout-normalization implementation checkpoint:
- `eb5393ff2cb2e07e195f2851be76b73b98aa0038`

Current Browser Inspect v2 base:
- `e19d57789b03dae36901c633482a89714eb52e11`

Historical local unsigned readiness candidate:
- source: `e296da18400d0f994fb8f086e36936ccd4c6305b`
- product/package version: `0.0.0`
- historical readiness evidence only
- continuity intentionally stale after `eb5393f`, which made checkout normalization an explicit native-host build input
- not a public-release/signing candidate

## Integration topology

The readiness branch is a strict descendant of `feat/browser-inspect-v2`.

At the 2026-09-18 audit:
- `e19d577` is an ancestor of readiness HEAD;
- `main@7950151` is also an ancestor;
- readiness adds a small linear stack after Browser Inspect v2;
- no merge commit is required to integrate readiness into the Browser Inspect v2 line if the target branch has not moved.

Therefore the safe future integration order is:

1. re-fetch and fresh-read remote/main/feature state;
2. complete the Browser Inspect v2 review/acceptance gate;
3. integrate the readiness commits into that accepted feature line (prefer fast-forward when still valid);
4. rerun acceptance on the exact integrated commit;
5. only then push/merge according to the project's normal reviewed Git flow.

Do not bypass the Browser Inspect v2 gate by merging the readiness branch directly to `main` merely because `main` is an ancestor.

## Remote-branch disclosure audit

The remote currently has 32 non-main refs in the local inventory.

At audit time:
- all but one remote non-main branch are already ancestors of `origin/main`;
- the only unmerged remote branch is `origin/docs/dc-replacement-live-benchmark-a1`, 15 commits ahead of remote main;
- high-confidence secret scan of that branch found no credential/private-key matches;
- it contains operational paths/session evidence such as `E:\AI-BROWSER\...`, benchmark worker/profile names, and a benchmark sentinel value.

This material is operational metadata, not a credential.

Those benchmark/Browser Inspect commits are also part of the local Browser Inspect/readiness ancestry that is intended for eventual integration, so deleting only the old remote branch would not remove the same history from the future public repository.

Decision:
- do not rewrite accepted Git history solely to hide benign local paths/session names;
- if a real credential/private datum is discovered, stop publication and handle it as a credential/privacy incident;
- otherwise treat operational path exposure as an accepted consequence of publishing the existing development history.

## Suggested GitHub About metadata

These values are drafts only.

Description:

> Local least-authority gateway connecting Web AI clients to user-approved developer resources.

Initial homepage:
- use the repository URL itself until/unless a maintained project site exists;
- do not create a placeholder website solely for SignPath.

Suggested topics:
- `ai-agents`
- `browser-extension`
- `developer-tools`
- `local-first`
- `mcp`
- `native-messaging`
- `security`
- `typescript`

GitHub permits up to 20 topics; topic names should use lowercase letters/numbers/hyphens and be no longer than 50 characters. Topics are public even for a private repository.

Do not add terms like `hacking`, `exploit`, `vulnerability-scanner`, or `remote-shell`: they are inaccurate for WAG's accepted capability surface and could misrepresent the project.

## Public repository content gate

Before visibility change, verify the exact public commit contains:
- Apache-2.0 root `LICENSE`;
- root README describing current Browser Inspect v2 rather than historical Browser Adapter v1;
- `SECURITY.md`;
- `CONTRIBUTING.md`;
- `THIRD_PARTY_NOTICES.md`;
- exact Node/native-host third-party license tree;
- `docs/policies/code-signing-policy.md`;
- `docs/policies/privacy.md`;
- `docs/native-host-installation.md`;
- deterministic release-package tooling/tests;
- no real credential/private-key material.

The code-signing policy must continue to state that SignPath acceptance is pending until acceptance actually occurs.

## Actions/artifact gate

Historical unsigned Actions artifacts are build evidence, not releases.

Preferred:
- allow them to expire naturally; or
- delete them only under explicit deletion authority.

They are not an independent hard security blocker after a clean secret audit.

If visibility changes before expiry:
- README and signing policy must clearly state that Actions artifacts are unsupported;
- no historical Actions artifact may be linked as an official download;
- official user downloads must come from GitHub Releases.

## Product-version gate

Current `0.0.0` is a placeholder.

Internal repository history already contains a completed “V0.1” milestone from 2026-09-10, so `0.1.0` is semantically consistent with project history as a first public pre-1.0 product line.

Recommended candidate:
- product version: `0.1.0`
- unsigned preview tag: `v0.1.0-preview.1`
- future signed stable tag: `v0.1.0`

Not selected:
- `0.1.0` remains a recommendation until explicitly authorized.

The `e296da1` executable candidate is already stale for release continuity after the `eb5393f` checkout-normalization hardening. Selecting `0.1.0` additionally modifies `package.json`, another native-host build input, and therefore requires:
1. version change;
2. typecheck/build/full tests;
3. native-host license compliance;
4. clean committed source;
5. fresh native-host build;
6. independent VersionInfo verification for `0.1.0.0`;
7. exact SEA execution;
8. fresh unsigned-candidate receipt.

## Repository-setting recommendations

After the exact readiness commit is public:

### Main branch protection / ruleset

Recommended minimum:
- block deletion of `main`;
- block force pushes to `main`;
- preserve normal maintainer ability to author/merge changes;
- require review for external contributions through the documented governance process;
- do not invent a required second-person approval while only one trusted maintainer exists.

### Immutable releases

Recommended before the first public binary release:
- enable GitHub immutable releases;
- assemble all release assets while draft;
- publish once complete;
- never replace unsigned preview assets with signed assets under the same published release/tag.

### Private vulnerability reporting

Evaluate enabling GitHub private vulnerability reporting after publication so `SECURITY.md` can point to a concrete private reporting path.

This is defense-in-depth/project hygiene, not a documented SignPath eligibility requirement.

## Public cutover verification

Immediately after a future authorized visibility change, verify anonymously/read-only:
- repository opens without authentication;
- Apache-2.0 is detected by GitHub;
- README renders correctly;
- description/topics are correct;
- Code signing policy link works;
- privacy link works;
- security/contributing files are discoverable;
- no draft/internal-only text makes false acceptance/signing claims;
- Actions artifacts are not presented as releases;
- no release exists unless separately authorized.

If any public content is wrong, correct content rather than toggling visibility repeatedly unless there is an actual privacy/security incident.

## First preview release gate

Do not create the preview release until:
- product version is explicitly selected;
- fresh candidate/receipt exists;
- deterministic outer ZIP is built from a verified inner distribution;
- release notes identify it as unsigned;
- ZIP/executable hashes are recorded;
- installation/removal/privacy/code-signing links resolve publicly;
- GitHub MFA is confirmed by the maintainer;
- exact tag/release name is authorized.

SignPath states the project must already be released in the form that should be signed. The preview therefore needs to be a real downloadable Windows release form, not a source-only tag or workflow artifact.

## Reputation timing

WAG is unusually young relative to the sampled accepted executable projects.

Do not:
- create fake stars/downloads/issues;
- create artificial contributors;
- spam releases solely to age the project;
- invent a minimum wait duration that SignPath does not publish.

Prefer:
- public repository continuity;
- one honest preview release;
- real maintenance/bug-fix/documentation activity;
- real users/downloads when they occur;
- then application when the public record is credible enough to review.

## Explicit execution stop points

Each item below still requires explicit authority:
- select `0.1.0`;
- integrate/merge Browser Inspect/readiness branches;
- push;
- delete remote branches or Actions artifacts;
- modify GitHub description/topics/homepage;
- create branch rulesets;
- enable immutable releases;
- enable private vulnerability reporting;
- change repository visibility;
- create/push tags;
- create/publish GitHub Releases;
- submit SignPath application;
- create/configure SignPath resources;
- install SignPath GitHub integration;
- sign binaries.
