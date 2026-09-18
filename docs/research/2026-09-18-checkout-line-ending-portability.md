# Native-Host Checkout Line-Ending Portability — 2026-09-18

Status: implemented and locally verified. This does not select a product version or authorize publication/signing.

## Trigger

A dry-run of the recommended `0.1.0` product version was performed in a fresh temporary clone of readiness HEAD `d7fa1d1`.

The version command itself behaved as expected:

```text
npm version 0.1.0 --no-git-tag-version
changed files:
  package-lock.json
  package.json
```

Typecheck passed and the Windows native host built successfully with:

```text
ProductName      = Web Agent Gateway
ProductVersion   = 0.1.0.0
FileVersion      = 0.1.0.0
OriginalFilename = wag-native-host.exe
InternalName     = wag-native-host
```

However, before the portability fix the fresh clone failed `verify:native-host-licenses`.
## Root cause

The readiness worktree held root `LICENSE` with LF bytes:

```text
bytes  = 11358
LF     = 202
CRLF   = 0
SHA256 = cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30
```

The pre-fix temporary clone checked out the same tracked text as CRLF under Windows checkout behavior:

```text
bytes  = 11560
LF     = 202
CRLF   = 202
SHA256 = 3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5
```

The compliance manifest intentionally hashes exact tracked license bytes, so the clone failed with `Project license hash mismatch`.

The same class of risk also applied to the tracked Node/npm license copies and to text files included in deterministic outer release ZIPs.
## Fix

Commit `eb5393ff2cb2e07e195f2851be76b73b98aa0038` adds:

```gitattributes
* text=auto eol=lf
```

This keeps text files canonical LF on checkout while leaving binary files under Git's automatic binary detection.

`.gitattributes` is itself included in `NATIVE_HOST_BUILD_INPUTS` because checkout normalization can affect native-host build/provenance inputs. The previous `e296da1` candidate is therefore intentionally no longer considered current-continuous after this hardening.

The pre-public checker was also refined:
- candidate continuity is a release gate;
- stale candidate evidence does not by itself block publishing source/docs;
- a supported binary release still requires a current candidate.
## Verification

After the fix:

```text
native-host license compliance = PASS
typecheck                      = PASS
focused candidate/readiness    = 23/23 PASS
full suite                     = 280/280 PASS
```

A fresh clone of `eb5393f` produced canonical root license bytes:

```text
LICENSE bytes  = 11358
LF             = 202
CRLF           = 0
SHA256         = cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30
license gate   = PASS
```

The same fresh clone was then dry-run at `0.1.0`:
- only `package.json` and `package-lock.json` changed;
- native-host license gate: PASS;
- typecheck: PASS;
- native-host build: PASS;
- PE ProductVersion/FileVersion: `0.1.0.0`.
Finally, the temp clone was explicitly configured with:

```text
core.autocrlf=true
```

Then `LICENSE` and `third_party/native-host` were deleted and checked out again from HEAD.

Observed:

```text
LICENSE                                      LF=202  CRLF=0
third_party/native-host/NODE-v24.20.0-LICENSE LF=2946 CRLF=0
native-host license compliance              PASS
```

This directly reproduces the earlier Windows line-ending condition and confirms that the repository-level attribute now dominates it.

## Release consequence

```text
CHECKOUT_TEXT_NORMALIZATION = LF
GITATTRIBUTES_IS_NATIVE_HOST_BUILD_INPUT = YES
E296DA1_CURRENT_CONTINUITY = STALE_AFTER_EB5393F
E296DA1_HISTORICAL_READINESS_EVIDENCE = RETAIN
RECOMMENDED_0_1_0_DRY_RUN = PASS
PRODUCT_VERSION_SELECTED = NO
FRESH_RELEASE_CANDIDATE_REQUIRED_AFTER_VERSION_SELECTION = YES
```

Do not restore candidate continuity by excluding `.gitattributes` from the build-input set. The line-ending rule materially affects reproducibility/provenance and belongs in that trust boundary.
