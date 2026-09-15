# Trusted Adapter Admission v1 — Source-Phase Gate Receipt

Date: 2026-09-16
Gate phase: source implementation acceptance only
Design commit: `6d1a9c993d1f0a2124d126354f6cb75c836a6614`
Release-gate amendment commit: `63d0c06aef5ff36185f8999234e76dea57a5f2ea`
Exact source candidate: `b373eccc02a917a3e8df66302803eb8b473010da`
Task 9A fixture correction: `b373eccc02a917a3e8df66302803eb8b473010da`

## Scope and gate interpretation

This receipt accepts the Trusted Adapter Admission v1 source implementation and security boundary only. It is not a final native-host release, installation, supported-browser-host, or admission PASS receipt.

The source candidate changes native-host bundle inputs, so it cannot reuse the historical accepted executable identity. Historical distribution and installation receipts remain valid for source `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d` and executable SHA-256 `0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf`.

The candidate therefore remains subject to the two-phase refresh amendment. A feature-branch or local executable hash is diagnostic evidence only and is not accepted distribution provenance.

## Task 9A verifier-regression correction

The pre-correction verifier suite reproduced the expected RED state: 9/11 passed and exactly two tests failed because a current-source native-host rebuild no longer matched the historical accepted executable hash.

Task 9A changed only `test/native-host-installation-verifier.test.ts`. The execution fixture now uses deterministic synthetic executable bytes and a temporary verifier copy whose accepted executable-hash pin is replaced exactly once for the fixture.
The committed production installation constants and `scripts/verify-native-host-installation.ps1` were not changed. Static pin assertions and the PowerShell AST safety audit continue to inspect the committed verifier.

Fresh Task 9A verification on the exact commit:

- installation-verifier suite: 12/12 passed, 0 failed, 0 skipped;
- `npm run typecheck`: exit 0;
- `git diff --check`: exit 0;
- ending HEAD: `b373eccc02a917a3e8df66302803eb8b473010da`.

## Focused admission/security gate

The exact re-frozen candidate `b373eccc02a917a3e8df66302803eb8b473010da` ran the focused admission/security gate with:

- 44 tests;
- 44 passed;
- 0 failed;
- 0 skipped/cancelled/todo;
- ending HEAD unchanged.

The focused gate covered admission persistence, credential rotation and class separation, exact-owner workspaces, restart recovery, exact three-tool MCP surface, HTTP Host/Origin enforcement, native-host bind-time admission, extension correlation persistence, runtime restart isolation, Windows native-host reconnect acceptance, and SEA artifact framing.
## Full source verification

The full repository gate ran on the same exact candidate and completed with:

- `npm test`: 221/221 passed, 0 failed, 0 skipped;
- `npm run typecheck`: exit 0;
- `npm run build`: exit 0;
- `npm run test:business`: 1/1 passed, 0 failed, 0 skipped;
- `git diff --check 6d1a9c9...b373ecc`: exit 0;
- ending HEAD: `b373eccc02a917a3e8df66302803eb8b473010da`.

The full suite retained durable mutation and verify recovery, caller-ownership checks, path containment, secret scrub, native messaging framing, installation-verifier behavior, native-host distribution tests, default MCP behavior, and Business stdio acceptance.

The exact candidate diff from the design commit contains 28 files, 2,363 insertions, and 262 deletions. No `package.json`, `package-lock.json`, native-host distribution workflow, production native-host installation constants, or committed installation verifier is changed by the candidate diff.

## Authority and surface audit

Explicit production/schema searches were manually classified. `ownerId` and `adapterId` hits are confined to the WAG-owned admission and exact-owner workspace seams. `correlation_id` occurs only in the strict bootstrap admission request. Bearer hits are confined to internal HTTP/local-link credential handling.

Broader `repo.snapshot`, `verify.run`, and mutation registrations remain in the default server composition. They are absent from the Browser Adapter v1 admitted surface and extension/native allowlist. Browser-admitted MCP remains exactly `health`, `workspace.open`, and `file.read`.
## Independent exact-diff review

An independent Claude Code reviewer received only the exact `6d1a9c9...b373ecc` diff, ADR-0017, the design spec, and the Task 9 acceptance checklist/amendment. The reviewer ran in restricted read-only mode with only Read/Grep capability and did not receive this implementation session history.

Review result:

- Critical findings: 0;
- Important findings: 0;
- Minor findings: 10;
- final assessment: `READY_FOR_SOURCE_ACCEPTANCE`.

Retained Minor findings, none of which weaken a locked invariant:

1. Browser-admission HTTP disables Node's parser-level `requireHostHeader` so WAG can return its own exact 403; application-level exact Host validation remains fail-closed.
2. Per-tab correlation storage minting is not atomic under two simultaneous messages; the resulting race is availability-only and remains ownership-fenced.
3. Extension bind bookkeeping is optimistic even though bind-time admission can fail; failure remains fail-closed and self-heals on reconnect/service-worker lifecycle.
4. Non-limit backend read errors rely on the local-link protocol boundary for final diagnostic redaction; no backend diagnostic reaches page/model code in the reviewed path.
5. Durable adapter-session/workspace and runtime binding growth has no v1 garbage collection; lifecycle/GC is an explicit v1 non-goal.6. Browser runtime retains an unreachable generic internal bearer while admission mode handles all requests; it is not exposed or usable on the browser surface.
7. `/adapter/release` does not require content type or drain a request body; method and exact session bearer still gate the operation.
8. Task 9A intentionally removes current-source-to-historical-release hash coupling from regression tests; successor release freshness is enforced by Task 9C/9D rather than `npm test`.
9. Reviewer noted a pre-existing side-panel sender-validation concern outside the exact diff; it cannot choose WAG authority or widen the reviewed three-tool read-only surface and is not part of this gate.
10. Reviewer noted temporary review artifacts in the working tree. Exact-owned review artifacts created for this review were removed afterward; a pre-existing untracked `.tmp-admission-review.diff` was left untouched because ownership was not established and it is not part of the candidate commit.

The reviewer positively confirmed WAG-owned identity, no model-visible authority fields, bootstrap/session credential separation, exact Host/Origin fail-closed behavior, exact-owner restart recovery, bearer rotation/release isolation, no raw credential/correlation persistence, Task 9A preservation of production release pins, no browser-surface widening, and same-origin admission-response validation.

## Trust and authority statement

The Windows discovery/bootstrap token remains same-user local trust, not strong OS caller attestation. This source phase does not promote that bootstrap path to consequential authority.

Browser Adapter v1 remains read-only and server-side limited to exactly three tools. Durable mutation, durable verify projection, public jobs, process/PTY, Git writes, browser mutation, SDK migration, and Remote Desktop Commander replacement remain unauthorized by this milestone.

No SDK or package dependency upgrade occurred.

## Required downstream gates

This source receipt does not supersede the accepted historical native-host distribution/install receipts and does not authorize replacing the installed host.

The source candidate changes native-host bundle inputs. A successor artifact must therefore be produced by the existing exact-`main` push distribution workflow, downloaded and verified under its immutable source-SHA/run-attempt identity, then pinned by a narrow reacceptance metadata change that does not alter native-host bundle inputs.
After successor artifact verification, installation preparation may consume only that verified artifact. Switching the exact HKCU Native Messaging registration remains a separately authorized operational action. Read-only installation verification and supported-browser-host reacceptance must then pass against the successor installed binary.

Only after those Task 9C/9D gates complete may a final receipt state `TRUSTED_ADAPTER_ADMISSION_V1 = PASS`.

CURRENT_CANDIDATE_NATIVE_HOST_DISTRIBUTION = REACCEPT_REQUIRED

TRUSTED_ADAPTER_ADMISSION_V1 = IMPLEMENTED_AWAITING_NATIVE_HOST_REFRESH
