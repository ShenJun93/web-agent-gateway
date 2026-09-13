# Native Host Distribution v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reviewed Windows `wag-native-host.exe` distribution artifact whose exact source commit and binary hash can be verified before any separately authorized browser installation.

**Architecture:** Keep `scripts/build-native-host.ts` as the only SEA packager. Add a strict receipt/bundle contract, make the existing artifact test able to exercise a prebuilt binary, and add a SHA-pinned Windows GitHub Actions workflow that builds once, tests that exact executable, then publishes only binary + checksum + receipt on `main` pushes.

**Tech Stack:** Node.js 24.20.0, TypeScript 6, Zod 4, Node SEA, esbuild 0.28.2, postject 1.0.0-alpha.6, GitHub Actions Windows Server 2025.

**Spec:** `docs/superpowers/specs/2026-09-13-native-host-distribution-v1-design.md`

## Global Constraints

- Distribution only; no browser install, HKCU mutation, host execution authorization, mutation, terminal, or Git authority widening.
- Windows x64 only in v1; runner label is `windows-2025`, not `windows-latest`.
- Node is exactly `24.20.0`; dependency install is `npm ci`; package-manager cache is disabled.
- Every `uses:` entry is pinned to a reviewed full 40-hex commit SHA.
- `pull_request_target` is forbidden; workflow permissions are explicitly `contents: read`.
- PR runs build/test only; only successful `push` runs on `main` may upload a distributable artifact.
- The publish binary is built once and the artifact integration test MUST exercise that exact executable before packaging.
- The published payload contains exactly `wag-native-host.exe`, `wag-native-host.exe.sha256`, and `build-receipt.json`.
- Artifact Attestations and Authenticode are deferred and are not v1 gates.

---
### Task 1: Strict Build Receipt Contract

**Files:**
- Create: `src/browser-adapter/native-host-distribution.ts`
- Create: `test/native-host-distribution.test.ts`

**Interfaces:**
- Produces `NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION = 1`.
- Produces `NATIVE_HOST_FILENAME = 'wag-native-host.exe'`.
- Produces `NATIVE_HOST_APPLICATION_NAME = 'com.openai.web_agent_gateway'`.
- Produces `BROWSER_ADAPTER_EXTENSION_ID = 'nnhhhppkpogkedpjnijeagcbfjaoogec'`.
- Produces strict `NativeHostBuildReceipt`, `parseNativeHostBuildReceipt(value)`, and `sha256File(path)`.
- Receipt fixes Node version to `24.20.0` and carries source SHA/ref, workflow run identity, runner identity, lockfile hash, executable hash, native-app name, extension id, and required gate names.

- [ ] **Step 1: Write failing receipt tests.** Cover one canonical receipt plus rejection of extra keys, malformed repository names, non-40-hex source SHA, non-64-hex hashes, wrong Node version, wrong extension/native-app identities, invalid run id/attempt, and missing or reordered required gate names.
- [ ] **Step 2: Add a hash test** using a temp file with known bytes and assert `sha256File` matches `createHash('sha256')`.
- [ ] **Step 3: Run `npx tsx --test test/native-host-distribution.test.ts`; verify RED because the module does not exist.**
- [ ] **Step 4: Implement the strict Zod receipt schema and bounded constants.** Use strings for GitHub run ids to avoid numeric precision assumptions; runner image fields may be optional only when the hosted runner does not expose them.
- [ ] **Step 5: Implement streaming SHA-256 file hashing.** Do not load the native-host executable into one unbounded buffer.
- [ ] **Step 6: Run the task test plus `npm run typecheck`; verify GREEN.**
- [ ] **Step 7: Commit `feat: define native host distribution receipt`.**

---
### Task 2: Package and Verify the Three-File Bundle

**Files:**
- Modify: `src/browser-adapter/native-host-distribution.ts`
- Create: `scripts/package-native-host-distribution.ts`
- Create: `scripts/verify-native-host-distribution.ts`
- Create: `test/native-host-distribution-cli.test.ts`

**Interfaces:**
- Produces `writeNativeHostDistributionBundle({ executablePath, packageLockPath, outputDir, metadata })`.
- Produces `verifyNativeHostDistributionDirectory({ directory, expectedRepository, expectedSourceSha })`.
- Packaging output is exactly `wag-native-host.exe`, `wag-native-host.exe.sha256`, and `build-receipt.json`.
- CLI packaging metadata comes only from explicit GitHub runner environment fields plus the exact executable/package-lock paths; it never reads browser or WAG runtime state.

- [ ] **Step 1: Write failing bundle tests.** Create a temp fake `.exe` and lockfile; assert packaging copies the executable, emits exact lowercase SHA-256 checksum text, writes a strict receipt, and leaves exactly three files in the publish directory.
- [ ] **Step 2: Add negative verifier tests.** Reject an extra fourth file, mismatched executable hash, malformed checksum, receipt/source-SHA mismatch, wrong repository, wrong extension id, and tampered receipt metadata.
- [ ] **Step 3: Add CLI tests** that spawn both scripts with a synthetic GitHub environment and prove stdout contains only bounded status/JSON without local paths, tokens, or environment dumps.
- [ ] **Step 4: Run `npx tsx --test test/native-host-distribution.test.ts test/native-host-distribution-cli.test.ts`; verify RED.**
- [ ] **Step 5: Implement atomic publish-directory assembly.** Build in a sibling temporary directory, verify its exact three-file set, then rename into the final workflow-owned output path; reject a pre-existing non-empty destination.
- [ ] **Step 6: Implement verification in fail-closed order:** exact filenames -> strict receipt -> expected repository/source SHA -> checksum-file syntax -> executable SHA-256 equality.
- [ ] **Step 7: Run task tests and `npm run typecheck`; verify GREEN.**
- [ ] **Step 8: Commit `feat: package native host distribution bundle`.**

---
### Task 3: Reuse the Artifact Test Against the Publish Binary

**Files:**
- Modify: `test/native-host-artifact.test.ts`

**Interfaces:**
- Consumes optional `WAG_NATIVE_HOST_BUILD_DIR` only inside the test harness.
- When unset, the test preserves current behavior and builds its own temp artifact.
- When set, the test MUST use `<build-dir>\wag-native-host.exe` and `<build-dir>\sea-config.json` without invoking `scripts/build-native-host.ts`.

- [ ] **Step 1: Refactor the test with a small `resolveArtifactUnderTest()` helper.** Validate that an override is absolute and contains both the executable and generated SEA config.
- [ ] **Step 2: Add a harness regression test or assertion** proving the override path is selected and the build command is not invoked when `WAG_NATIVE_HOST_BUILD_DIR` is supplied.
- [ ] **Step 3: Run the artifact test without the override and verify existing behavior still passes.**
- [ ] **Step 4: Build one disposable artifact with `npm run build:native-host -- --output <temp-dir>`, then run the same test with `WAG_NATIVE_HOST_BUILD_DIR=<temp-dir>` and verify it passes against that exact executable.**
- [ ] **Step 5: Run `npm run typecheck`; verify GREEN.**
- [ ] **Step 6: Commit `test: verify prebuilt native host artifact`.**

---

### Task 4: SHA-Pinned Windows Distribution Workflow

**Files:**
- Create: `.github/workflows/native-host-distribution.yml`
- Create: `test/native-host-distribution-workflow.test.ts`

**Pinned actions:**
- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (`v7.0.1`).
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (`v7.0.0`).
- `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (`v7.0.1`).
**Workflow contract:**
- `on: pull_request` and `on: push` scoped to `main`; no `pull_request_target`.
- `permissions: contents: read` at workflow level.
- `runs-on: windows-2025`.
- Checkout uses `persist-credentials: false`.
- Setup Node uses exact `24.20.0` and `package-manager-cache: false`.
- PR and main runs execute install/typecheck/build/distribution tests.
- Publish steps are guarded by `github.event_name == 'push' && github.ref == 'refs/heads/main'`.

- [ ] **Step 1: Write the failing workflow-contract test.** Read the YAML as text and assert exact triggers, permissions, runner, Node version, cache disablement, the three full action SHAs, absence of `${{ secrets.` and `pull_request_target`, and absence of any floating `uses: ...@vN` form.
- [ ] **Step 2: Assert publication gating.** The test must prove the build/package/upload block has the exact main-push condition and the artifact name includes `${{ github.sha }}`.
- [ ] **Step 3: Run `npx tsx --test test/native-host-distribution-workflow.test.ts`; verify RED because the workflow does not exist.**
- [ ] **Step 4: Create the workflow.** Run `npm ci`, `npm run typecheck`, `npm run build`, and the focused browser/native/distribution tests before any publication step.
- [ ] **Step 5: Build the publish candidate exactly once** into `artifacts/native-host-build`, then run `test/native-host-artifact.test.ts` with `WAG_NATIVE_HOST_BUILD_DIR` pointing at that directory.
- [ ] **Step 6: On main-push only, run the packaging CLI** into `artifacts/native-host-distribution`, using GitHub/runner metadata from the workflow environment.
- [ ] **Step 7: Run the verifier CLI against the produced directory** with expected repository `${{ github.repository }}` and expected SHA `${{ github.sha }}` before upload.
- [ ] **Step 8: Upload only `artifacts/native-host-distribution/`** as `wag-native-host-windows-x64-${{ github.sha }}` with `if-no-files-found: error` and a bounded retention period such as 14 days.
- [ ] **Step 9: Run the workflow-contract test plus typecheck locally; verify GREEN.**
- [ ] **Step 10: Commit `ci: build native host distribution artifact`.**

---
### Task 5: Pre-PR Repository Gate

**Files:**
- No new production files; verify the complete branch state.

- [ ] **Step 1: Run focused distribution gates:** `npx tsx --test --test-concurrency=1 test/native-host-distribution.test.ts test/native-host-distribution-cli.test.ts test/native-host-distribution-workflow.test.ts test/native-host-artifact.test.ts`.
- [ ] **Step 2: Run `npm test`; require 0 failures and 0 skipped tests on Windows.**
- [ ] **Step 3: Run `npm run typecheck`, `npm run build`, and `npm run test:business`; require exit 0 for each.**
- [ ] **Step 4: Run `git diff --check` and inspect `git status --short`; generated executable/distribution output stays uncommitted.**
- [ ] **Step 5: Review the workflow diff for trust expansion.** Confirm no secrets, write permissions, `pull_request_target`, caches, browser installation, HKCU commands, release publishing, or mutable action tags exist.
- [ ] **Step 6: Commit any final test/docs corrections as a bounded commit.**
- [ ] **Step 7: Stop for normal push/PR authorization.** A green local branch is not `NATIVE_HOST_DISTRIBUTION = PASS` because no reviewed `main` artifact exists yet.

---
### Task 6: Post-Merge Main Artifact Acceptance

**Files:**
- Create after evidence: `docs/benchmarks/2026-09-13-native-host-distribution-v1.md`

**Operational prerequisite:** The implementation PR has been separately authorized and merged. Do not substitute a feature-branch run for this gate.

- [ ] **Step 1: Identify the exact merged `main` commit SHA** and fetch the `native-host-distribution` workflow run whose source SHA equals that commit.
- [ ] **Step 2: Require the Windows job and every distribution step to pass.** Record run id, run attempt, runner image identity, and source SHA.
- [ ] **Step 3: Fetch exactly one artifact named `wag-native-host-windows-x64-<source-sha>`.** Reject duplicate, expired, ambiguous, or differently named candidates.
- [ ] **Step 4: Download the artifact to a disposable local evidence directory.** This gate verifies distribution integrity only; browser registration remains outside scope.
- [ ] **Step 5: Inspect the extracted payload and require exactly three files:** `wag-native-host.exe`, `wag-native-host.exe.sha256`, `build-receipt.json`.
- [ ] **Step 6: Run `scripts/verify-native-host-distribution.ts`** with the exact repository identity and merged source SHA; require binary/checksum/receipt equality without rebuilding the executable.
- [ ] **Step 7: Record the evidence receipt** with workflow run identity, source SHA, executable SHA-256, Node version, action pins, runner image identity, and verifier result. Exclude credentials and browser/profile state.
- [ ] **Step 8: Mark `NATIVE_HOST_DISTRIBUTION = PASS` only if Steps 1–7 succeed.** Keep `SUPPORTED_BROWSER_HOST = BLOCKED_FAIL_CLOSED` until a later separately authorized Task 10 attempt completes.
- [ ] **Step 9: Commit the receipt on a small follow-up branch/PR.** Integration into `main` remains a separate authorized action.

---
## Plan Self-Review

- Spec coverage: receipt identity, exact hash, build-once/test-same-binary, Windows-only workflow, main-only publication, three-file payload, fail-closed consumer verification, deferred attestation/signing, and Task 10 separation are each mapped to a task.
- Supply chain: all three Actions are pinned to exact researched commit SHAs; no floating tags are permitted.
- Authority: no task installs a browser extension, writes NativeMessagingHosts/enterprise policy, enables browser mutation, or expands terminal/Git/filesystem capabilities.
- Artifact semantics: `NATIVE_HOST_DISTRIBUTION = PASS` is reserved for evidence from a merged `main` workflow artifact downloaded and verified without a local rebuild.
- Failure semantics: ambiguous source/run/artifact/hash identity fails closed; no alternate local build is accepted inside the same gate.
- Placeholder scan: the prohibited-placeholder search returned no matches.

## Execution Boundary

Implementation Tasks 1–5 may proceed in this isolated worktree after plan approval. Task 6 requires the implementation to be reviewed and integrated first, followed by the matching `main` workflow run.
