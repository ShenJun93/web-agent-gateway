# Native Host Installation v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare and verify a deterministic per-user Windows Native Messaging installation from the accepted WAG native-host artifact, while keeping live machine registration outside repository automation and making supported-browser acceptance depend on installation PASS.

**Architecture:** Reuse the existing distribution verifier and native-host manifest generator. Add a strict installation receipt plus preparation/verification helpers that create only receipt-owned files and registration data; live registration remains a separate sanctioned operator action. Then revise operational policy and Task 10 so browser acceptance consumes already-installed state.

**Tech Stack:** Node.js 22.19–26, TypeScript 6, Zod 4, Windows per-user filesystem layout, Chromium Native Messaging, PowerShell read-only verification.

**Spec:** `docs/superpowers/specs/2026-09-14-native-host-installation-v1-design.md`

## Global Constraints

- `NATIVE_HOST_DISTRIBUTION = PASS` is a hard prerequisite.
- Accepted source SHA: `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d`.
- Accepted executable SHA-256: `0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf`.
- Accepted workflow run id / attempt: `34757274244` / `1`.
- Native app: `com.openai.web_agent_gateway`; extension id: `nnhhhppkpogkedpjnijeagcbfjaoogec`.
- V1 root: `%LOCALAPPDATA%\WebAgentGateway\native-host\<source-sha>\`.
- Repository implementation/tests never apply live registry changes.
- Only the per-user Chromium registration is in scope; no broader browser/machine policy or mutation authority.
- Existing differing registration values fail closed.
- `BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED`.

---
### Task 1: Installation Contract and Deterministic Layout

**Files:**
- Create: `src/browser-adapter/native-host-installation.ts`
- Create: `test/native-host-installation.test.ts`

**Interfaces:**
- Reuse `verifyNativeHostDistributionDirectory`, `sha256File`, distribution identity constants, and `createNativeHostManifest`.
- Produce `NATIVE_HOST_INSTALLATION_SCHEMA_VERSION = 1` and fixed accepted source/hash/run constants.
- Produce `buildNativeHostInstallPaths(localAppData, sourceSha)` returning absolute root/executable/manifest/receipt/registration-artifact paths.
- Produce strict `NativeHostInstallReceipt`, `parseNativeHostInstallReceipt(value)`, and `createNativeHostRegistrationDescriptor(manifestPath)`.

- [ ] **Step 1: Write failing layout/receipt tests.** Assert source-SHA layout, exact filenames, workflow run identity, app/extension identity, executable/manifest hashes, and one exact registration descriptor. Reject extra keys, relative paths, wrong identities, alternate browser target, wrong hive/view, or alternate extension id.
- [ ] **Step 2: Run `npx tsx --test test/native-host-installation.test.ts`; require RED because the module does not exist.**
- [ ] **Step 3: Implement path building with Windows path semantics and strict Zod schemas.** Registration descriptor is data only and fixes the exact per-user Chromium target plus the absolute manifest path.
- [ ] **Step 4: Require the accepted source SHA, executable hash, workflow run id, and run attempt as constants, not environment-derived values.**
- [ ] **Step 5: Run the task test and `npm run typecheck`; require GREEN.**
- [ ] **Step 6: Commit `feat: define native host installation contract`.**

---
### Task 2: Fail-Closed Installation Preparation

**Files:**
- Modify: `src/browser-adapter/native-host-installation.ts`
- Create: `scripts/prepare-native-host-installation.ts`
- Create: `test/native-host-installation-cli.test.ts`

**Interfaces:**
- Produce `NativeHostInstallationDependencies` with only `verifyDistribution` and `sha256File` seams.
- Produce `prepareNativeHostInstallation(input, dependencies = defaultNativeHostInstallationDependencies)` returning the parsed receipt.
- Production defaults use the existing real distribution verifier and streaming SHA-256; tests may inject deterministic fakes but cannot change accepted identity constants.

- [ ] **Step 1: Write failing preparation tests using a synthetic distribution directory plus injected verifier/hash seams that return the exact accepted identities.** Assert only the executable, generated manifest, install receipt, and data-only registration artifact are prepared, and post-copy hashing is invoked.
- [ ] **Step 2: Add negative identity tests.** Wrong source/hash/run/app/extension identity must fail before target creation even when test dependencies are injected.
- [ ] **Step 3: Add drift/idempotency tests.** Byte-identical receipt-owned state is accepted; executable, manifest, receipt, unexpected executable, or incompatible extra payload drift fails without overwrite.
- [ ] **Step 4: Run Task 1-2 tests; require RED.**
- [ ] **Step 5: Implement atomic preparation in a sibling temp directory, then rename only after manifest/receipt/hash validation succeeds.**
- [ ] **Step 6: Implement CLI arguments `--distribution`, `--local-app-data`, and `--repository`; stdout exposes bounded status/source/hash only and reports `prepared`, never registration-applied state.**
- [ ] **Step 7: Run focused tests and `npm run typecheck`; require GREEN.**
- [ ] **Step 8: Commit `feat: prepare native host installation`.**

---
### Task 3: Read-Only Verification and Cleanup Decisions

**Files:**
- Modify: `src/browser-adapter/native-host-installation.ts`
- Create: `scripts/verify-native-host-installation.ps1`
- Create: `test/native-host-installation-verifier.test.ts`

**Interfaces:**
- Produce `classifyNativeHostRegistration(observedValue, receipt): 'ABSENT' | 'MATCH' | 'DRIFT'`.
- Produce `decideNativeHostOwnedCleanup(...)` returning `BLOCK_DRIFT`, `FILES_ONLY`, or `REGISTRATION_THEN_FILES`; it performs no mutation.
- Read-only verifier accepts `-ReceiptPath <absolute path>` and emits bounded JSON with source/hash/registration classification.

- [ ] **Step 1: Write failing pure decision tests.** Exact expected value is `MATCH`, missing is `ABSENT`, any other value is `DRIFT`; cleanup is allowed only when fresh receipt-owned paths/hashes and observation still agree.
- [ ] **Step 2: Add verifier source-contract tests using a positive capability allowlist.** The script may only read the exact registration value, read/parse receipt-owned files, resolve paths, check 64-bit process context, and compute SHA-256.
- [ ] **Step 3: Run verifier tests; require RED.**
- [ ] **Step 4: Implement pure classification/cleanup decisions without enumerating neighboring registrations, installations, or browser profiles.**
- [ ] **Step 5: Implement the read-only verifier.** Require a 64-bit PowerShell process, read only the receipt-specified per-user target, re-hash executable + manifest, and return `MATCH`, `ABSENT`, or `DRIFT` without changing machine state.
- [ ] **Step 6: Add a Windows execution test for prepared-but-unregistered state; require bounded `ABSENT` output and matching file hashes.**
- [ ] **Step 7: Run verifier tests plus `npm run typecheck`; require GREEN.**
- [ ] **Step 8: Commit `feat: verify native host installation state`.**

---
### Task 4: Repository Regression Gate and Preparation Receipt

**Files:**
- Record execution evidence in the ignored SDD ledger only. The benchmark receipt remains deferred to Task 6 after live operational acceptance.

- [ ] **Step 1: Run focused installation tests:** `npx tsx --test --test-concurrency=1 test/native-host-installation.test.ts test/native-host-installation-cli.test.ts test/native-host-installation-verifier.test.ts`.
- [ ] **Step 2: Re-run distribution/manifest regressions:** `npx tsx --test --test-concurrency=1 test/native-host-distribution.test.ts test/native-host-distribution-cli.test.ts test/native-host-manifest.test.ts`.
- [ ] **Step 3: Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:business`; require exit 0.**
- [ ] **Step 4: Run `git diff --check` and inspect status.** Generated executable/install state, registration data, browser profiles, and credentials stay uncommitted.
- [ ] **Step 5: Record repository regression evidence only.** Do not advance `NATIVE_HOST_INSTALLATION`; `PREPARED_AWAITING_REGISTRATION` begins only after Task 6 performs actual machine preparation.
- [ ] **Step 6: Leave repository state unchanged when the regression gate is clean; no benchmark commit is created in Task 4.**

---

### Task 5: Operational Policy and Task-10 Prerequisites

**Files:**
- Modify outside repository only after separate review: `E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md`.
- Modify in repository: `docs/superpowers/plans/2026-09-13-wag-browser-adapter-v1.md`.

- [ ] **Step 1: Apply the browser-ownership policy correction exactly as specified by the approved design/research receipt.** Keep inventory global, fail closed when inventory is blocked, and never infer profile ownership from absence.
- [ ] **Step 2: Review the external policy diff independently; it must narrow ambiguity without widening browser-control authority.**
- [ ] **Step 3: Update Task 10 so `NATIVE_HOST_INSTALLATION = PASS` is a prerequisite and installation is no longer performed during supported-host acceptance.**
- [ ] **Step 4: Preserve existing read-only extension/native-host/reconnect acceptance semantics.**
- [ ] **Step 5: Commit the repository planning correction separately from implementation code.**

---
### Task 6: External Registration Checkpoint and Acceptance

**Files:**
- Modify after evidence: `docs/benchmarks/2026-09-14-native-host-installation-v1.md`.

**Boundary:** This plan does not perform the live machine-registration action. That action remains outside repository automation and requires its own sanctioned operator path.

- [ ] **Step 1: Re-verify the accepted distribution artifact and prepare the exact source-SHA installation directory.**
- [ ] **Step 2: Run the committed read-only verifier and record the pre-check classification.** Any drift stops the gate.
- [ ] **Step 3: Stop at the external operational checkpoint.** Continue only after authorized evidence says the exact expected per-user registration has been established.
- [ ] **Step 4: Run the committed read-only verifier again.** Require exact registration match plus executable and manifest hashes equal to the installation receipt.
- [ ] **Step 5: Record provenance, hashes, expected registration descriptor, verifier result, and installation path in the benchmark receipt.** Exclude credentials and WAG secrets.
- [ ] **Step 6: Mark `NATIVE_HOST_INSTALLATION = PASS` only if repository checks and external checkpoint evidence agree.** Otherwise record the bounded pending/drift state.
- [ ] **Step 7: Commit the installation receipt separately.**

---

### Task 7: Supported-Host Handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-09-13-wag-browser-adapter-v1.md`.
- Modify only after new evidence: `docs/benchmarks/2026-09-13-browser-adapter-v1.md`.

- [ ] **Step 1: Require installation PASS before supported-host acceptance starts.**
- [ ] **Step 2: Remove machine-installation mutation from the supported-host task; the browser run consumes already-verified installed state.**
- [ ] **Step 3: Preserve real ChatGPT path, committed extension identity, Native Messaging, `workspace.open`, `file.read`, reconnect, and same durable workspace read.**
- [ ] **Step 4: Preserve fail-closed behavior at browser-control boundaries; direct local substitutes do not count as supported-host evidence.**
- [ ] **Step 5: Keep `BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED`.**
- [ ] **Step 6: Commit the Task 10 plan correction before another supported-host run.**

---
## Plan Self-Review

- Spec coverage: accepted artifact identity, deterministic layout, manifest binding, receipt, drift handling, read-only verification, exact-owner cleanup decisions, operational checkpoint, policy prerequisite, Task 10 separation, and mutation non-enablement are mapped to tasks.
- Reuse: implementation consumes existing distribution verification, SHA-256, and manifest generation rather than duplicating them.
- Testability: Task 2 uses narrow injected verifier/hash seams only for synthetic unit tests; production defaults remain the real verifier/hash implementation and accepted constants remain fixed.
- Authority: repository code prepares and verifies installation state but never performs the external registration action.
- Failure semantics: artifact mismatch, file drift, registration drift, or blocked verification fails closed and cannot become supported-host PASS.
- Cleanup semantics: decisions are exact-receipt scoped; neighboring installations, browser profiles, runtimes, and unrelated registrations are not enumerated or removed.
- Gate ordering: `NATIVE_HOST_DISTRIBUTION -> NATIVE_HOST_INSTALLATION -> SUPPORTED_BROWSER_HOST -> BROWSER_MUTATION_ENABLEMENT`.

## Execution Boundary

Tasks 1-4 are repository implementation/preparation work. Task 5 is a separately reviewed operational-policy/planning correction. Task 6 stops at an external operator checkpoint and uses repository tooling only for read-only verification. Task 7 changes supported-host planning/receipt semantics only.

No task authorizes browser mutation, terminal/Git authority widening, administrator elevation, browser enterprise policy, or default/Business mutation enablement.
