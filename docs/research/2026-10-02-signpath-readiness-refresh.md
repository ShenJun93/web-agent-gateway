# SignPath readiness refresh — 2026-10-02

Status: CURRENT READINESS SNAPSHOT / NOT SUBMITTED / NOT SIGNED

This document supersedes only the **current-state** and **candidate-continuity** claims in the
2026-09-18 SignPath readiness/application documents. Those older files remain historical evidence.

## Current public state

- repository: `ShenJun93/web-agent-gateway`
- repository visibility: public
- current public `main`: `4645aeef1edd21b6193b31029b74a94f85ee0438`
- Public Launch P0 PR: #67, merged
- live local runtime promoted from the same main commit
- package version: `0.1.0`
- npm publication: not performed; `package.json` remains `"private": true`

## Existing immutable public release

The existing public release remains valid historical/release-form evidence:

- tag: `v0.1.0-preview.1`
- tag target: `c1eb195f54864dee1a8997c9baeb0475ce627da6`
- release ID: `391834069`
- release class: immutable GitHub prerelease
- signing state: unsigned / not Authenticode-trusted
- release asset:
  `web-agent-gateway-native-host-windows-x64-0.1.0-preview.1-UNSIGNED.zip`
- release asset SHA-256:
  `3f31ebe7258803aaf44194c05c4ae0ce241f7f2849507f7c0f153b129264e733`
- current GitHub download counter observed on 2026-10-02: `4`

The download counter includes prior maintainer verification traffic and is not treated as independent
adoption or reputation evidence.

## Candidate continuity — current result

`v0.1.0-preview.1` is **not** the signing candidate for current main.

Exact comparison from `c1eb195f54864dee1a8997c9baeb0475ce627da6` to
`4645aeef1edd21b6193b31029b74a94f85ee0438` reports many changed
`NATIVE_HOST_BUILD_INPUTS`, including:

- `package.json`
- `package-lock.json`
- `tsconfig.build.json`
- many files under `src/`

Therefore:

```text
PREVIEW_1_RELEASE_EVIDENCE = VALID
PREVIEW_1_CURRENT_SIGNING_CANDIDATE = NO
CURRENT_MAIN_REQUIRES_OWN_UNSIGNED_CANDIDATE = YES
```

Do not claim candidate continuity from `c1eb195f` to current main.

## Current-main unsigned candidate evidence

GitHub Actions workflow **Native Host Distribution #107** ran on current main:

- run ID: `36916880632`
- source: `4645aeef1edd21b6193b31029b74a94f85ee0438`
- conclusion: `SUCCESS`
- GitHub-hosted build path: PASS
- typecheck: PASS
- TypeScript build: PASS
- focused distribution tests: PASS
- publish-candidate build/version/exact-candidate test: PASS
- unsigned signing evidence: PASS
- package/verify distribution: PASS

Unexpired artifacts as of 2026-10-02:

1. signing input
   - artifact ID: `11190685060`
   - name: `wag-native-host-signing-input-4645aeef1edd21b6193b31029b74a94f85ee0438-attempt-1`
   - digest: `sha256:086a152dc3f2cf65f85593c4de535a9e283b7ed77b62b9079d155ab3d0912e3b`
   - expiry: `2026-10-15T19:49:49Z`

2. verified Windows x64 distribution
   - artifact ID: `11189624852`
   - name: `wag-native-host-windows-x64-4645aeef1edd21b6193b31029b74a94f85ee0438-attempt-1`
   - digest: `sha256:d414c938749083fa0d6e4210ae6caf580df251d1b6e1dc793c17f7666671de77`
   - expiry: `2026-10-15T19:49:57Z`

3. candidate evidence
   - artifact ID: `11189244843`
   - name: `wag-native-host-candidate-evidence-4645aeef1edd21b6193b31029b74a94f85ee0438-attempt-1`
   - digest: `sha256:4d7c54df82e236c4808e31a7da0f9b8e362ac7082c5e1e7f651f4c7cbcade3c5`
   - expiry: `2026-10-15T19:49:48Z`

These are build/signing evidence, not official release assets.

## SignPath eligibility/readiness

Current SignPath Foundation public terms still require an OSS project to be:

- open source under an eligible license;
- actively maintained;
- already released in the form that should be signed;
- documented;
- governed by a public code signing policy;
- privacy/security respectful;
- built through verifiable source-controlled automation;
- manually approved for every signing request.

WAG currently has:

- public Apache-2.0 repository: PASS
- active maintenance: PASS
- public immutable unsigned release: PASS
- documented functionality: PASS
- README `Code signing policy` link: PASS
- privacy policy: PASS
- install/removal documentation: PASS
- current policy roles for Author/Reviewer/Approver: PASS
- explicit manual approval requirement for every signing request: PASS
- GitHub Actions / GitHub-hosted provenance path: PASS
- current-main unsigned candidate workflow evidence: PASS

## Reputation

Current GitHub repository metadata observed on 2026-10-02:

- stars: `1`
- forks: `0`
- subscribers: `0`
- open issues: `1`

The identity/independence of the single star has not been established. It must not be represented as
independent reputation evidence.

State remains:

```text
SIGNPATH_REPUTATION_GATE = WAIT_REPUTATION_SIGNAL
```

A truthful application may disclose that WAG is newly public and ask SignPath to assess its current
verifiable history, but WAG must not manufacture or overstate adoption.

## Node SEA provider question

Provider interpretation remains unresolved:

> WAG uses Node's documented Single Executable Application flow: it copies the official pinned Node
> executable, removes its original signature, injects the WAG SEA blob, applies WAG VERSIONINFO and
> preserves applicable licenses. Does SignPath Foundation consider the resulting executable WAG's
> own application binary, or does the modified-upstream visible-fork condition apply?

State:

```text
NODE_SEA_SIGNPATH_POLICY = PROVIDER_CONFIRMATION_WITH_FAVORABLE_PRECEDENT
```

Do not redesign away from Node SEA solely on this ambiguity before provider guidance.

## Submission boundary

```text
SIGNPATH_APPLICATION = NOT_SUBMITTED
SIGNPATH_ACCOUNT_OR_PROJECT = NOT_CREATED_BY_THIS_REFRESH
SIGNING = NOT_PERFORMED
GITHUB_RELEASE_FOR_CURRENT_MAIN = NOT_CREATED
NPM_PUBLISH = NOT_PERFORMED
```

A SignPath form submission remains an external/legal-consent action. Required personal/contact,
discovery-channel, Code-of-Conduct and personal-data-processing choices must be made by the operator.

## Recommended next sequence

1. Keep the existing immutable `preview.1` unchanged as released-form evidence.
2. Use this current-state refresh instead of the stale `c1eb195f` continuity claim.
3. When submission is explicitly authorized, fill the SignPath application truthfully and carry the
   Node SEA classification question into provider review.
4. Do not submit a signing request until SignPath accepts/configures the project and the signing
   integration is separately reviewed.
5. For any future signed stable release, use an exact current candidate with origin verification,
   manual approval, post-sign verification and a distinct release identity.