# Browser Inspect v2 + SignPath Readiness Integration Rehearsal — 2026-09-18

Status: local rehearsal only. No branch was merged, pushed, published, tagged, or released.

## Live branch state

Fresh-read local state:

```text
canonical main                  7950151a41c9cceca2f285b584482130b3702bbd
feat/browser-inspect-v2        e19d57789b03dae36901c633482a89714eb52e11
docs/signpath-foundation-readiness-v1
                               d67fbee226f852bc3ba1fe92c9c1887c173de664
```

Read-only `git ls-remote` observed only:

```text
refs/heads/main = 7950151a41c9cceca2f285b584482130b3702bbd
```

No live remote refs were returned for:
- `refs/heads/feat/browser-inspect-v2`
- `refs/heads/docs/signpath-foundation-readiness-v1`

Therefore both active integration branches are currently local-only from the remote's point of view.

## Topology

The graph is linear:

```text
7950151 main
  -> 38 Browser Inspect v2 commits
e19d577 Browser Inspect v2 checkpoint
  -> 14 SignPath/public-readiness commits
d67fbee readiness HEAD
```

Counts:

```text
main -> Browser Inspect v2 = 38 commits
Browser Inspect v2 -> readiness = 14 commits
main -> readiness = 52 commits
```

## Fast-forward rehearsal

A temporary shared clone was created from the canonical local repository.

Rehearsal A:

```text
checkout e19d577
git merge --ff-only d67fbee
result = PASS
HEAD   = d67fbee
```

Rehearsal B:

```text
checkout 7950151
git merge --ff-only d67fbee
result = PASS
HEAD   = d67fbee
```

No conflicts or merge commits are required by the current graph.

This does **not** authorize bypassing the Browser Inspect v2 acceptance gate. It only proves that once that gate is accepted, readiness can be integrated without conflict if the graph has not moved.

## Readiness commit manifest

| Commit | Purpose | Executable/build-input impact |
| --- | --- | --- |
| `12227f2` | SignPath readiness research/design | none |
| `e296da1` | license/public docs, PE metadata normalization, license gate, workflow/build changes | **yes — native-host build inputs** |
| `2ee93b3` | SignPath dossier/policy wording | none |
| `174ce55` | public readiness docs/contributing | none |
| `660e52a` | deterministic outer release packager | release tooling only; not native-host executable input |
| `102126f` | first-public-release sequencing | none |
| `04c50af` | release blocker documentation | none |
| `16395d7` | application answer draft | none |
| `94ed349` | reputation timing research | none |
| `825a3f8` | pre-public cutover checklist | none |
| `760326c` | unsigned/signed release-note templates | none |
| `d7fa1d1` | pre-public readiness checker | source/release checking only; explicitly not native-host executable input |
| `eb5393f` | repository LF checkout normalization and trust-model update | **yes — `.gitattributes` is native-host build input** |
| `d67fbee` | checkout-portability evidence | none |

## Review consequence

A future integration review should not treat the 14 commits as equally risky.

Priority review surface:

1. `e296da1`
   - `.github/workflows/native-host-distribution.yml`
   - `package.json` / lockfile
   - native-host builder
   - PE metadata mutator
   - license-compliance verifier
   - VersionInfo verifier
   - candidate/distribution trust rules
   - exact third-party license set
2. `eb5393f`
   - `.gitattributes`
   - inclusion of `.gitattributes` in `NATIVE_HOST_BUILD_INPUTS`
   - publication-vs-release readiness semantics

Secondary implementation review:

3. `660e52a`
   - deterministic outer ZIP
   - exact inner distribution preservation
4. `d7fa1d1`
   - fail-closed pre-public checker semantics

The remaining commits are documentation/research/policy wording and should be reviewed for factual consistency rather than executable behavior.

## Current verification evidence

At readiness HEAD after the checkout-normalization fix:

```text
full suite                  = 280/280 PASS
focused candidate/readiness = 23/23 PASS
typecheck                   = PASS
native-host license gate    = PASS
Windows autocrlf=true reproduction = PASS
0.1.0 temp dry-run build    = PASS
0.1.0 PE version            = 0.1.0.0
```

The `0.1.0` result is a temporary dry-run only. The repository remains at product version `0.0.0`.

## Candidate consequence

The historical unsigned candidate at `e296da1` is no longer current-continuous because `eb5393f` introduced a new explicit build input.

Current truth:

```text
HISTORICAL_UNSIGNED_CANDIDATE = e296da1
CURRENT_RELEASE_CANDIDATE = NONE
PRODUCT_VERSION = 0.0.0
RECOMMENDED_PRODUCT_VERSION = 0.1.0
PRODUCT_VERSION_SELECTED = NO
```

A fresh candidate should be recorded only after an authorized real product version is committed.

## Safe future integration sequence

If authority is later granted and live refs remain compatible:

1. fresh-read canonical Git + remote state;
2. complete/confirm Browser Inspect v2 acceptance at `e19d577` or its reviewed successor;
3. review the 14 readiness commits with priority on `e296da1` and `eb5393f`;
4. rerun full regression/license/typecheck on exact readiness HEAD;
5. fast-forward the accepted Browser Inspect feature line to readiness HEAD;
6. push that branch;
7. use the normal PR/review path into `main`;
8. after merge, rerun the pre-public checker on exact merged `main`;
9. only then proceed to separately authorized version/public/release operations.

If `main` or Browser Inspect changes before execution, discard this rehearsal result and recompute topology/conflicts from live Git.

## Authority boundary

This rehearsal does not authorize:
- changing `feat/browser-inspect-v2`;
- merging readiness into that branch;
- pushing either branch;
- creating a PR;
- merging to `main`;
- selecting `0.1.0`;
- changing GitHub visibility/settings;
- creating tags/releases;
- SignPath submission/signing.

## Post-rehearsal delta

The initial fast-forward rehearsal was performed at `d67fbee`, where the Browser Inspect -> readiness delta was 14 commits.

Subsequent local-only readiness commits are:

```text
204c969 docs: rehearse readiness integration
2a3d145 fix: bind release readiness to candidate evidence
8bcd249 docs: record candidate evidence gate
fda6a3f fix: align native host CI trigger coverage
```

At `fda6a3f` the current linear counts are:

```text
Browser Inspect v2 e19d577 -> readiness = 18 commits
main 7950151 -> readiness                 = 56 commits
```

None of these four commits rewrites ancestry. The fast-forward topology conclusion therefore remains valid as long as the target branches have not moved before actual integration.

Additional implementation review priority:
- `2a3d145`: release readiness now requires exact unsigned-candidate receipt + EXE evidence rather than a hardcoded/operator-supplied source SHA;
- `fda6a3f`: main-push workflow paths now cover every `NATIVE_HOST_BUILD_INPUTS` root, including `.gitattributes` and all `src/**`.
