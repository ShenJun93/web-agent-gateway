# SignPath readiness refresh — 2026-10-02

Status: CURRENT READINESS SNAPSHOT / NOT SUBMITTED / NOT SIGNED

This document supersedes only the **current-state** and **candidate-continuity** claims in the
2026-09-18 SignPath readiness/application documents. Those older files remain historical evidence.

## Current public state

- repository: `ShenJun93/web-agent-gateway`
- repository visibility: public
- current public `main`: `bb9cffd3ad89b5f67955b48be59b53d0c13019d4`
- Public Launch P0 PR: #67, merged
- SignPath docs refresh PR: #68, merged
- native-host PR-path filter PR: #69, merged
- live local runtime remains at `4645aeef1edd21b6193b31029b74a94f85ee0438`; no runtime promotion is required for #68/#69 because they changed only docs/workflow/test files
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

Candidate continuity from `4645aeef1edd21b6193b31029b74a94f85ee0438` to current main
`bb9cffd3ad89b5f67955b48be59b53d0c13019d4` is PASS for native-host build inputs:
an exact diff restricted to `NATIVE_HOST_BUILD_INPUTS` is empty.

GitHub Actions workflow **Native Host Distribution #110** ran on current main:

- run ID: `36944044667`
- source: `bb9cffd3ad89b5f67955b48be59b53d0c13019d4`
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
   - artifact ID: `11201696202`
   - name: `wag-native-host-signing-input-bb9cffd3ad89b5f67955b48be59b53d0c13019d4-attempt-1`
   - digest: `sha256:39ac4a1031c1083a2ed3f32cb3a4f9a00a873861e0fface6c79d8400df1a04b1`
   - expiry: `2026-10-16T00:05:06Z`

2. verified Windows x64 distribution
   - artifact ID: `11201656390`
   - name: `wag-native-host-windows-x64-bb9cffd3ad89b5f67955b48be59b53d0c13019d4-attempt-1`
   - digest: `sha256:e3a8a7ed0a624a0344540bffc3a46a02f998c21d5a5e248db8a067bcd6e3c0bf`
   - expiry: `2026-10-16T00:05:12Z`

3. candidate evidence
   - artifact ID: `11201725978`
   - name: `wag-native-host-candidate-evidence-bb9cffd3ad89b5f67955b48be59b53d0c13019d4-attempt-1`
   - digest: `sha256:fe981f83090351ba66f9773353bb2564dbddba78aef5ee688baf94bd3f24e8e9`
   - expiry: `2026-10-16T00:05:05Z`

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


## Live application-form recheck — 2026-10-02

A WAG Browser v2 headless read-only check loaded `https://signpath.org/apply.html` successfully.
The page exposes a third-party semantic node `Iframe: Form`, but the current WAG semantic snapshot
does not traverse the embedded form frame.

Therefore:

```text
APPLICATION_PAGE_REACHABLE = YES
FORM_IFRAME_PRESENT = YES
FORM_FIELD_SCHEMA_REMEASURED_2026_10_02 = NO
LAST_MEASURED_FIELD_SCHEMA = 2026-09-19
FORM_SUBMISSION = NO
```

Do not claim the 2026-09-19 field list was re-verified on 2026-10-02.
