# Native-Host CI Trigger Coverage — 2026-09-18

Status: implemented and locally verified. No remote workflow was changed because the readiness branch remains local-only.

## Gap found

The native-host trust model defines these executable build-input roots:

```text
.gitattributes
src/
browser/native-host/
scripts/build-native-host.ts
scripts/native-host-pe-metadata.ts
package.json
package-lock.json
tsconfig.json
tsconfig.build.json
```

Before commit `fda6a3f`, the main-push path filter in `.github/workflows/native-host-distribution.yml` had two mismatches:

1. `.gitattributes` was absent even though checkout normalization is now an explicit build input.
2. The workflow watched only `src/browser-adapter/**`, while candidate continuity treats the entire `src/` tree as build input.

That meant a standalone main-branch change to `.gitattributes`, or to another file under `src/`, could change the candidate trust boundary without triggering the native-host distribution workflow.

## Fix

Commit `fda6a3f` changes the push paths to include:

```yaml
- '.gitattributes'
- 'src/**'
```

instead of the narrower `src/browser-adapter/**`.

The workflow test now imports `NATIVE_HOST_BUILD_INPUTS`, converts directory roots such as `src/` into GitHub Actions path patterns such as `src/**`, and asserts that every build-input root is present in the workflow push allowlist.

This makes future build-input expansion fail a test until CI trigger coverage is updated.

## Why PR behavior is unchanged

The `pull_request` trigger remains unfiltered.

Therefore:
- every PR to `main` still validates the native-host job;
- the path allowlist applies only to main pushes that can publish a distribution artifact;
- no `pull_request_target` trigger was introduced;
- workflow permissions remain `contents: read`;
- no secrets or signing authority were added.

## Verification

After the fix:

```text
diff --check                   = PASS
typecheck                      = PASS
focused workflow/readiness     = 30/30 PASS
full suite                     = 283/283 PASS
failures                       = 0
```

The new coverage regression test itself passed in the full suite:

```text
native host main push covers every native-host build-input root = PASS
```

## Authority state

```text
LOCAL_WORKFLOW_HARDENING = IMPLEMENTED
REMOTE_WORKFLOW_CHANGED = NO
PUSH = NOT_DONE
MERGE = NOT_DONE
SIGNING_AUTHORITY = NOT_ADDED
```
