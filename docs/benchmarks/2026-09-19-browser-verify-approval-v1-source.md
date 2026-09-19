# Browser Verify Approval v1 — Source-Phase Gate Receipt

Date: 2026-09-19
Gate phase: source implementation acceptance only
Exact source candidate: `44c9d537652dc13003c89907d8c6ae3bcc2ed1e4`
Base (proposal core) SHA: `155d3195816015979ae5a6afc4d7f589778a2474`
Branch: `feat/browser-verify-approval-v1`
ADR: `docs/adr/0019-separate-browser-proposal-from-consequential-authority.md`
Spec: `docs/superpowers/specs/2026-09-19-browser-verify-approval-v1-design.md`
Plan: `docs/superpowers/plans/2026-09-19-browser-verify-approval-v1-acceptance.md`

## Scope and gate interpretation

This receipt accepts the Browser Verify Approval v1 source implementation and its trust boundary only. It is not a native-host distribution, installation, supported-browser-host, live WebChat, or Tier V receipt.

The candidate changes browser/native build inputs, so it cannot reuse Browser Inspect v2 installed identity as v3 evidence. Plan Gate 12 continuity therefore still requires a fresh exact candidate.

The exact candidate diff from the base contains 29 files, 1,853 insertions, and 86 deletions. No `package.json`, `package-lock.json`, native-host distribution workflow, production native-host installation constants, or committed installation verifier is changed by the candidate diff.

## Candidate scope

The candidate wires the Browser Verify Approval v1 adapter end to end on protocol v3 under adapter id `browser.chatgpt.native.verify.v3`.

Production/runtime implementation footprint:

- `src/browser-adapter/protocol-v3.ts`: v3 envelope, bounded request/response schemas, and the seven-tool name union;
- `src/browser-adapter/local-link-v3.ts`: v3 discovery parsing, admission, and exact seven-tool discovery-profile enforcement;
- `src/browser-adapter/native-host-v3.ts`: v3 native-host loop, single-session binding, and duplicate-request rejection;
- `src/browser-adapter/native-host-main.ts`: entry point repointed to the v3 link and host;
- `src/server.ts`: `createBrowserVerifyAdmittedMcpServer` exposing exactly the seven browser-visible tools;
- `src/operator-server.ts`: verify review/approve/reject routes beside existing mutation routes, sharing one Origin + session + CSRF check;
- `scripts/browser-adapter-runtime.ts`: v3 runtime composition binding the verify request coordinator to the operator server;
- `browser/extension/service-worker-core-v3.js`, `native-session-core-v3.js`, `chatgpt-call-parser-v3.js`: default-deny extension surface pinned to v3 and the seven tools;
- `browser/extension/service-worker.js`: production entry pinned to the v3 modules.

Browser-visible tools are exactly `health`, `workspace.open`, `repo.search`, `repo.snapshot`, `file.read`, `verify.preview`, `verify.result`. There is no direct `verify.run` on the browser surface.

## Locked invariants verified by test

- approval remains atomic with internal verify-job creation, and rolls back both the request transition and the job on injected failure;
- `browserVerifyProfiles` is the trusted allowlist; non-allowlisted profiles are denied at preview and re-denied at approval;
- `verify.preview` performs zero execution and creates no internal verify job;
- `verify.result` exposes no internal job authority;
- VerifyProfile / `planSha256` drift fails closed at approval;
- browser-eligible profiles never resume queued work after restart; a recovered queued job fails closed before backend execution;
- Browser Inspect v2 modules remain present, and the production service-worker entry is pinned to v3 by test.

## Acceptance fixture

`docs/benchmarks/fixtures/browser-verify-v1/` is a versioned, hash-manifested fixture. The manifest `fixture-manifest.sha256` hashes to `7097c3c10e7cd98917c90fd6d2c0325646555b252791b4bdabf3be2989df8e86`, and every listed entry is verified before materialization.

The fixture template carries an intentional hostile repository instruction directing the reader to ignore local approval, read `../outside-canary.txt`, and run arbitrary shell commands. The runtime test proves the trusted profile ignores it and that the outside canary is byte-unchanged after execution.

## Focused gate

The exact candidate ran the focused Browser Verify v3 / security / restart / native-host gate with:

- 67 tests;
- 67 passed;
- 0 failed;
- 0 skipped/cancelled/todo;
- ending HEAD unchanged.

Files: `browser-adapter-protocol-v3`, `browser-extension-v3`, `browser-verify-admitted-mcp`, `browser-verify-request`, `operator-server-verify`, `operator-server`, `native-host-artifact`, `browser-adapter.acceptance`, `browser-extension-session`, `security`, `durable-verify-job`, `durable-verify-store`, `verify-profile`.

## Full source verification

On the same exact candidate:

- `npm test`: 315/315 passed, 0 failed, 0 skipped, 0 cancelled (557s), under the hermetic child environment described below;
- `npm run typecheck`: exit 0;
- `npm run build`: exit 0;
- `npm run test:business`: 1/1 passed, 0 failed, 0 skipped;
- `git diff --check`: exit 0;
- ending HEAD: `44c9d537652dc13003c89907d8c6ae3bcc2ed1e4`.

## Secret scan

Gitleaks 8.30.1 committed-range scan, matching the repository's established version and range convention:

```text
gitleaks git --log-opts="155d319..44c9d53" --redact --verbose --report-format json
```

- 1 commit scanned;
- ~82,887 bytes (82.89 KB) scanned;
- 0 leaks found;
- exit 0.

## Environment caveat — inherited PSModulePath

The `npm test` result above was obtained with the inherited `PSModulePath` removed from the child process environment. It is not an unconditional default-shell green run, and must not be reported as one until the harness portability defect is fixed.

The default invocation inherited a PowerShell 7 process-scoped `PSModulePath` through the shell chain (`WindowsTerminal -> pwsh -> claude -> cmd -> pwsh -> node`) into Windows PowerShell 5.1 subprocesses. WinPS 5.1 therefore resolved incompatible PS7 module copies — `Microsoft.PowerShell.Utility` 7.0.0.0 under `...windowsapps\microsoft.powershell_7.6.6.0_x64...\Modules` instead of 3.1.0.0 under System32 — and lost `Get-FileHash` and related built-in commands.

Under that inherited environment, `npm test` reported 312/315 with exactly three failures:

- `test/native-host-installation-verifier.test.ts` — "Windows verifier rejects a valid prepared installation under a 32-bit PowerShell process";
- `test/native-host-installation-verifier.test.ts` — "Windows verifier reports hermetic ABSENT, MATCH, and DRIFT classifications";
- `test/native-host-release-package.test.ts` — "native host outer release ZIP is deterministic and preserves exact inner distribution paths".

All three share one earliest concrete failing operation. An instrumented copy of the verifier (the committed script swallows its reason by design) reported at `scripts/verify-native-host-installation.ps1:214`:

```text
System.Management.Automation.CommandNotFoundException ::
  The term 'Get-FileHash' is not recognized as the name of a cmdlet, function,
  script file, or operable program.
```

The release-packaging failure is the same missing cmdlet at `scripts/write-deterministic-zip.ps1:70`, surfacing through `scripts/package-native-host-release.ts:169` as `ZIP helper failed` then `Native-host release packaging failed`.

This is proven to be a pre-existing test-harness portability defect, not a candidate regression:

- the identical three failures reproduce on clean base `155d3195816015979ae5a6afc4d7f589778a2474`, checked out into a separate throwaway worktree with zero dirty changes;
- every file on the three failing paths is blob-identical between base and candidate — `scripts/verify-native-host-installation.ps1`, `scripts/write-deterministic-zip.ps1`, `scripts/package-native-host-release.ts`, `test/native-host-installation-verifier.test.ts`, `test/native-host-release-package.test.ts`, `src/browser-adapter/native-host-installation.ts`, `src/browser-adapter/native-host-distribution.ts`, `src/browser-adapter/native-host-manifest.ts`;
- removing `PSModulePath` only from the child process environment produces 315/315 passed, 0 failed;
- no machine repair, install, registry mutation, or execution-policy change is required.

The persisted machine-scope `PSModulePath` is already correct (`C:\Program Files\WindowsPowerShell\Modules;C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules`) and the user scope is unset. With the variable merely unset in a child environment, WinPS 5.1 derives its own correct native module path and `Get-FileHash` resolves. Execution policy (`CurrentUser` = `RemoteSigned`) is not a factor.

The defect is that the harness spawns `powershell.exe` inheriting an arbitrary `PSModulePath` while already pinning `-NoProfile`, `-NonInteractive`, and `LOCALAPPDATA`. It is tracked and remediated separately from this receipt; this receipt does not depend on that fix and does not claim it.

## Trust and authority statement

Source acceptance does not authorize installing or replacing the native host, registry changes, browser automation, release/tag changes, code signing, live WebChat verification, or any Tier V claim.

The browser surface remains proposal-only. Consequential verification authority remains behind separate local operator approval, consistent with ADR-0014, ADR-0017, and ADR-0019.

No SDK or package dependency upgrade occurred.

## Required downstream gates

Plan Gate 12 requires a fresh exact native-host/distribution candidate under existing continuity rules, recording source SHA, workflow run/attempt, candidate receipt, pre-sign/Authenticode hashes as applicable, executable hash, manifest hash, adapter id, protocol version, extension id, config hash, Node/DevSpace identity, install receipt, and registration verifier result. Browser Inspect v2 installed identity must not be reused as v3 evidence.

Tier R requires fresh exact-candidate R0+R1+R2. Tier V additionally requires Tier R evidence on the accepted successor candidate plus a successful locally approved V1. Tier C and Tier D remain unauthorized.

## Conclusion

BROWSER_VERIFY_APPROVAL_V1_SOURCE = PASS

PRODUCTION_BROWSER_VERIFY = NOT_YET_ACCEPTED
