# Candidate-Evidence-Bound Release Readiness Gate — 2026-09-18

Status: implemented and locally verified. No product version was selected in the real readiness branch and no release/signing action was performed.

## Problem found during review

The first pre-public checker revision hardcoded the historical unsigned-candidate source commit `e296da1`.

That was safe while the historical candidate was current, but after checkout-normalization hardening and any future real product-version commit it would permanently report stale continuity. Replacing the hardcoded SHA with an arbitrary CLI SHA would be weaker: a caller could point the checker at a commit that never produced a recorded candidate.

Therefore release readiness must bind to real candidate evidence, not to an operator-supplied SHA alone.

## Implemented contract

Commit `2a3d145` changes `scripts/check-pre-public-readiness.ts` so:

- source/publication readiness can still be checked with no candidate arguments;
- release readiness requires both:
  - `--candidate-receipt <absolute path>`
  - `--candidate-exe <absolute path to wag-native-host.exe>`
- the receipt must parse as the strict unsigned-candidate schema;
- repository must equal `ShenJun93/web-agent-gateway`;
- source commit's exact `package-lock.json` Git blob must hash to the receipt's recorded lock hash;
- exact EXE flat SHA-256 must equal `preSignSha256`;
- the existing Windows signature inspector must confirm `NotSigned`;
- independently computed Authenticode SHA-256 must equal the receipt value;
- the candidate source must be an ancestor of current HEAD;
- no `NATIVE_HOST_BUILD_INPUTS` may change after candidate source;
- when continuity holds, the existing independent VersionInfo verifier must pass against current `package.json`.

Release blockers distinguish:
- `native-host-candidate-evidence-missing`
- `native-host-candidate-evidence-invalid`
- `native-host-candidate-continuity-failed`

Candidate evidence is intentionally a release gate, not a source-publication gate.

## Regression verification

After the hardening:

```text
diff --check = PASS
typecheck = PASS
focused candidate/readiness = 25/25 PASS
full suite = 282/282 PASS
failures = 0
```

## Positive E2E rehearsal

A temporary shared clone of real readiness commit `2a3d145` was created outside the real worktree.

Only inside that temporary clone:

1. `package.json` / lockfile were changed to `0.1.0`;
2. the change was committed as an ephemeral local temp commit;
3. native-host license compliance passed;
4. `wag-native-host.exe` was built;
5. the production unsigned-candidate recorder created a strict receipt;
6. the readiness checker consumed the exact receipt and EXE.

Observed:

```text
temp source SHA        = 14a349b19eb0ba8b3833361e00c211c521ea49f4
temp product version   = 0.1.0
candidate record       = PASS
publicationReady       = true
releaseReady           = true
blockers               = []
candidateEvidenceValid = true
candidateContinuity    = true
```

This proves the release gate is reachable after a real non-placeholder version and real candidate recording.

The temp source SHA is rehearsal-only and has no authority or release significance.

## Negative E2E: tampered receipt

The temp receipt's `preSignSha256` was replaced with a syntactically valid but incorrect SHA-256 value.

Observed:

```text
publicationReady       = true
releaseReady           = false
blocker                = native-host-candidate-evidence-invalid
candidateEvidenceValid = false
```

## Negative E2E: build-input drift

After recording the valid `0.1.0` candidate, the temp clone committed a `0.1.1` package/lock version change without rebuilding the candidate.

Observed:

```text
publicationReady       = true
releaseReady           = false
blocker                = native-host-candidate-continuity-failed
candidateEvidenceValid = true
candidateContinuity    = false
```

This distinction is intentional: the receipt/EXE evidence remains internally valid, but it no longer represents the current build inputs.

## Real repository state remains unchanged in authority

```text
REAL_PRODUCT_VERSION = 0.0.0
PRODUCT_VERSION_SELECTED = NO
REAL_CURRENT_RELEASE_CANDIDATE = NONE
PUBLICATION = NOT_PERFORMED
RELEASE = NOT_PERFORMED
SIGNPATH_APPLICATION = NOT_SUBMITTED
SIGNING = NOT_PERFORMED
```

The `0.1.0` temp rehearsal does not select `0.1.0`; it only demonstrates that the proposed gate and existing build pipeline work together correctly.
