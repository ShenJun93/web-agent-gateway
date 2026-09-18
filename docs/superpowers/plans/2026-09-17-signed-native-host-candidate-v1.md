# Signed Native Host Candidate v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral, fail-closed candidate-provenance and Authenticode verification gate that can qualify one exact signed `wag-native-host.exe` for Browser Inspect v2 Task 6 without changing Windows trust policy or production release identity.

**Architecture:** Keep `scripts/build-native-host.ts` as the only SEA builder. Record the exact unsigned build identity and system Authenticode SHA-256 first, allow signing only as an explicit external checkpoint, then independently verify Windows Authenticode/RSA trust, unchanged Authenticode-covered content, source/build-input continuity, post-sign flat hash, and process-start acceptance before writing a bounded signed-candidate receipt. Existing distribution/install workflows remain unchanged until a real signer is selected and separately authorized.

**Tech Stack:** TypeScript 6.0.3, Node 24.20.0 for native-host receipts, Zod 4.5.4, Windows PowerShell 5.1 `Get-AuthenticodeSignature`, Git read-only diff checks, Node `child_process` for bounded probes.

**Spec:** `docs/superpowers/specs/2026-09-17-signed-native-host-candidate-v1-design.md`

## Global Constraints

- Final byte order is exactly `postject -> system Authenticode SHA-256 -> sign -> verify same Authenticode SHA-256 -> flat SHA-256 -> execution/acceptance`.
- Accepted signer key algorithm is RSA; Authenticode signing digest is SHA-256.
- No self-signed/local-root trust, SAC/App Control changes, reputation fallback, source execution fallback, or historical-v1 substitution.
- No signing credential, PIN, PFX, private key, API key, or Azure client secret may enter Git, receipts, logs, WAG runtime, or Browser tools.
- Existing Browser Inspect v2 adapter id/protocol/five-tool authority is unchanged.
- Candidate evidence never mutates accepted distribution/install constants or historical receipts.
- `.github/workflows/native-host-distribution.yml` is not changed in this milestone before signer/provider selection.
- Every command that inspects Git is read-only and uses fixed native-host build-input pathspecs.
- Candidate receipts are bounded JSON and contain no local usernames, secrets, or machine-specific paths.
- Task 6 remains blocked unless the exact signed candidate passes this gate.

---

## File map

- Create `src/browser-adapter/native-host-candidate.ts`: strict unsigned/signed receipt schemas, normalized signature facts, native-host build-input classifier, receipt construction/verification.
- Create `scripts/inspect-native-host-signature.ps1`: read-only Windows Authenticode/RSA/EKU inspector with exact JSON output.
- Create `scripts/record-native-host-unsigned-candidate.ts`: bind clean source SHA + lock hash + pre-sign executable hash before external signing.
- Create `scripts/verify-signed-native-host-candidate.ts`: verify signed bytes, source continuity, post-sign hash, and bounded process-start probe; write final candidate receipt.
- Create `test/native-host-candidate.test.ts`: schema, path classifier, receipt strictness, tamper negatives.
- Create `test/native-host-signature.test.ts`: PowerShell AST allowlist, unsigned rejection, trusted Windows binary positive inspection.
- Create `test/native-host-candidate-cli.test.ts`: hermetic Git/source continuity and CLI fail-closed behavior.
- Modify `package.json`: add only convenience scripts for the two candidate CLIs; no new dependency.

### Task 1: Candidate receipt core and build-input continuity

**Files:**
- Create: `src/browser-adapter/native-host-candidate.ts`
- Create: `test/native-host-candidate.test.ts`

**Interfaces:**
- Produces `NATIVE_HOST_CANDIDATE_SCHEMA_VERSION = 1`.
- Produces `NativeHostUnsignedCandidateReceipt`, `NativeHostSignedCandidateReceipt`, `NativeHostSignatureFacts`, and discriminated `NativeHostSignatureInspection`.
- Produces `parseNativeHostUnsignedCandidateReceipt(value)`, `parseNativeHostSignedCandidateReceipt(value)`, and `parseNativeHostSignatureInspection(value)`; both receipts carry the system Authenticode SHA-256 continuity hash.
- Produces `isNativeHostBuildInput(path)` and `assertNoNativeHostBuildInputChanges(paths)`.
- Reuses `NATIVE_HOST_FILENAME` and `sha256File` from `native-host-distribution.ts`.

Use these exact build-input roots/patterns:

```ts
export const NATIVE_HOST_BUILD_INPUTS = [
  'src/',
  'browser/native-host/',
  'scripts/build-native-host.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
] as const;
```

The path classifier treats `/` and `\\` as separators, rejects absolute paths and `..`, and matches a directory entry only when the normalized relative path starts with that exact prefix.

- [ ] **Step 1: Write strict receipt/parser RED tests**

Add tests proving the unsigned receipt accepts only: schema version, repository, source SHA, Node `24.20.0`, package-lock SHA-256, builder script literal, executable filename literal, pre-sign flat SHA-256, and system Authenticode SHA-256. Add signed-receipt tests requiring post-sign SHA-256, exact signature facts, `signingDigest.algorithm = 'SHA256'`, `signingDigest.evidence = 'SIGNER_INVOCATION'`, process probe `STARTED`, and canonical ISO verification time.
Representative RED assertions:

```ts
assert.throws(() => parseNativeHostUnsignedCandidateReceipt({ ...validUnsigned(), extra: true }));
assert.throws(() => parseNativeHostSignedCandidateReceipt({ ...validSigned(), signature: { ...validSigned().signature, publicKeyAlgorithmOid: '1.2.840.10045.2.1' } }));
assert.throws(() => parseNativeHostSignedCandidateReceipt({ ...validSigned(), signingDigest: { algorithm: 'SHA1', evidence: 'SIGNER_INVOCATION' } }));
assert.throws(() => parseNativeHostSignedCandidateReceipt({ ...validSigned(), artifact: { filename: 'other.exe', sha256: hashB } }));
```

- [ ] **Step 2: Run the new core test and verify RED**

Run:

```powershell
.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 test/native-host-candidate.test.ts
```

Expected: FAIL because `native-host-candidate.ts` and its exported parsers do not exist.

- [ ] **Step 3: Implement the strict schemas and path classifier**

Use Zod strict objects and bounded text. Normalize candidate paths with `path.replaceAll('\\', '/')`; reject leading `/`, drive prefixes, empty path, NUL/CR/LF, and any segment equal to `..`.

Signature inspection is exactly:

```ts
type NativeHostSignatureInspection =
  | { status: 'NotSigned'; authenticodeSha256: string }
  | ({ authenticodeSha256: string } & NativeHostSignatureFacts);
```

Signature facts must include:

```ts
{
  status: 'Valid';
  signerSubject: string;
  signerThumbprint: string; // lowercase 40 hex
  publicKeyAlgorithmOid: '1.2.840.113549.1.1.1';
  codeSigningEkuOid: '1.3.6.1.5.5.7.3.3';
  certificateSignatureAlgorithmOid: string;
  timestamp: null | { signerSubject: string; signerThumbprint: string };
}
```
The signed receipt extends unsigned provenance with:

```ts
artifact: { filename: 'wag-native-host.exe'; sha256: string };
authenticodeSha256: string; // same lowercase 64 hex as the unsigned receipt
signature: NativeHostSignatureFacts;
signingDigest: { algorithm: 'SHA256'; evidence: 'SIGNER_INVOCATION' };
executionProbe: 'STARTED';
verifiedAt: string;
```

Require `artifact.sha256 !== unsigned.preSignSha256` and `authenticodeSha256 === unsigned.authenticodeSha256`; signing must change the flat bytes without changing the Authenticode-covered executable content.

- [ ] **Step 4: Add build-input continuity tests**

Cover positives for `src/a.ts`, `browser/native-host/sea-config.json`, `scripts/build-native-host.ts`, and exact package/tsconfig files. Cover negatives for `test/a.test.ts`, `docs/x.md`, `scripts/build-native-host.ts.bak`, absolute paths, and traversal paths. `assertNoNativeHostBuildInputChanges()` must throw with a bounded generic error, not echo arbitrary file contents.

- [ ] **Step 5: Run GREEN + typecheck**

```powershell
.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 test/native-host-candidate.test.ts
npm run typecheck
git diff --check
```

Expected: all PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/browser-adapter/native-host-candidate.ts test/native-host-candidate.test.ts
git commit -m "feat: define signed native host candidate receipts"
```

### Task 2: Read-only Windows Authenticode inspector

**Files:**
- Create: `browser/native-host/remove-source-signature.ps1`
- Modify: `scripts/build-native-host.ts`
- Create: `scripts/inspect-native-host-signature.ps1`
- Create: `test/native-host-signature.test.ts`

**Interfaces:**
- Script parameter: `-ExecutablePath <absolute Windows path>`.
- Script parameter: `-ExpectedState Unsigned|Valid`.
- Success stdout: one compact JSON object only; stderr empty.
- Failure stderr: exactly `wag-native-host-signature-inspect: failed`; exit code `1`.
- `Unsigned` success JSON contains exactly `status=NotSigned` and normalized lowercase `authenticodeSha256` from `Get-AppLockerFileInformation`.
- `Valid` success JSON uses the exact normalized signature-facts shape from Task 1 plus the same normalized system Authenticode SHA-256 field.

- [ ] **Step 0: Normalize the copied Node PE before postject**

The official Node Windows SEA sequence removes the source executable signature before injection. The current builder copies signed `node.exe` and injects directly; on the current host this leaves stale certificate-table metadata and `Get-AppLockerFileInformation` fails with `BadImageFormatException` on the final unsigned SEA. Add `browser/native-host/remove-source-signature.ps1` using Windows `ImageEnumerateCertificates` + `ImageRemoveCertificate` from `Imagehlp.dll`, and call it after copying `node.exe` but before `postject`. The helper mutates only the copied build-output executable, accepts zero or more certificate entries, verifies no certificate entries remain, and requires no SignTool/SDK install. `browser/native-host/**` is already in `NATIVE_HOST_BUILD_INPUTS`.

Extend the Task 2 behavior test to prove the existing builder now produces a real postject WAG SEA that is `NotSigned` and accepted by `Get-AppLockerFileInformation`. This existing failing behavior test is the RED evidence for the builder correction.
- [ ] **Step 1: Write AST and behavior RED tests**

The test must parse the committed PowerShell AST and require the exact unique command set `Set-StrictMode`, `Resolve-Path`, `Get-Item`, `Get-AuthenticodeSignature`, `Get-AppLockerFileInformation`, and `ConvertTo-Json`. Permit only the member calls `Equals`, `GetFullPath`, and `ToLowerInvariant`, plus `Write` only when its receiver is exactly `[System.Console]::Error` and its argument is the fixed failure sentinel; implement EKU inspection with a normal `foreach` rather than `Where-Object`. Microsoft documents the AppLocker file hash as a system-computed Authenticode cryptographic hash, so this is the continuity primitive rather than a custom PE parser. Any additional command or invoked member fails the AST test.

Add Windows behavior tests:

```ts
const buildDir = join(temp, 'unsigned-wag');
await buildNativeHost(buildDir); // existing builder, no execution
const unsignedFacts = await inspect(join(buildDir, 'wag-native-host.exe'), 'Unsigned');
assert.equal(unsignedFacts.status, 'NotSigned');
assert.match(unsignedFacts.authenticodeSha256, /^[0-9a-f]{64}$/);
await assert.rejects(() => inspect(join(buildDir, 'wag-native-host.exe'), 'Valid'));
const systemExe = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'notepad.exe');
const facts = await inspect(systemExe, 'Valid');
assert.equal(facts.status, 'Valid');
assert.equal(facts.publicKeyAlgorithmOid, '1.2.840.113549.1.1.1');
assert.match(facts.signerThumbprint, /^[0-9a-f]{40}$/);
assert.match(facts.authenticodeSha256, /^[0-9a-f]{64}$/);
```

Also prove `ExpectedState Unsigned` accepts the real unsigned WAG SEA, rejects the trusted signed system executable, and `ExpectedState Valid` rejects the unsigned WAG SEA.

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 test/native-host-signature.test.ts
```

Expected: FAIL because the inspector does not exist.

- [ ] **Step 3: Implement the PowerShell inspector**

Resolve the path once, require a regular non-reparse file, call `Get-AuthenticodeSignature -LiteralPath`, and obtain the system Authenticode hash with `Get-AppLockerFileInformation -Path`. Normalize only an exact `SHA256 0x<64hex>` hash representation; any missing/ambiguous hash fails closed. For `Valid`, require status `Valid`, non-null signer certificate, RSA public-key OID `1.2.840.113549.1.1.1`, and code-signing EKU `1.3.6.1.5.5.7.3.3`. Normalize thumbprints to lowercase and reject control characters or oversized certificate subjects.
The script must not claim to derive the PE digest algorithm from `Get-AuthenticodeSignature`; Task 4 binds SHA-256 to the reviewed signer invocation separately. Timestamp output is `null` when `TimeStamperCertificate` is absent, otherwise bounded subject + lowercase thumbprint.

- [ ] **Step 4: Run GREEN and AST audit**

```powershell
.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 test/native-host-signature.test.ts
npm run typecheck
git diff --check
```

Expected: PASS on the current Windows host; zero mutation commands in the AST result.

- [ ] **Step 5: Commit Task 2**

```powershell
git add browser/native-host/remove-source-signature.ps1 scripts/build-native-host.ts scripts/inspect-native-host-signature.ps1 test/native-host-signature.test.ts
git commit -m "feat: inspect native host Authenticode trust"
```

### Task 3: Record the unsigned candidate before signing

**Files:**
- Create: `scripts/record-native-host-unsigned-candidate.ts`
- Create: `test/native-host-candidate-cli.test.ts`
- Modify: `package.json`

**Interfaces:**
- CLI arguments: `--build-dir`, `--source-sha`, `--repository`, `--output`.
- `--build-dir` and `--output` must be absolute.
- Build directory must contain regular `wag-native-host.exe` and `sea-config.json` files.
- Source SHA must resolve to a commit in the current repository.
- Current tracked build inputs must match the supplied source SHA in index and working tree.
- The executable must currently inspect as `NotSigned`.

- [ ] **Step 1: Add CLI RED tests in a disposable Git repository**

Test source/build-input continuity against a temporary Git repository through exported dependency-injectable orchestration, supplying normalized `NotSigned` signature facts and a fixed Authenticode SHA-256. Separately, on Windows, build one real unsigned WAG SEA with the existing builder in a temp directory and invoke the production CLI from the canonical clean repo to prove the end-to-end unsigned path. Verify receipt source SHA, lock hash, builder literal, filename, pre-sign flat hash, and pre-sign Authenticode SHA-256.
Add fail-closed cases for:

```text
relative build/output path
wrong executable basename or missing sea-config.json
source SHA not present
unstaged build-input change
staged build-input change
HEAD later than source SHA with a src/** change
signed executable presented to the unsigned recorder
pre-existing output receipt
```

A docs/test-only commit after `sourceSha` is allowed because it is outside `NATIVE_HOST_BUILD_INPUTS`.

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 test/native-host-candidate-cli.test.ts --test-name-pattern="unsigned candidate"
```

Expected: FAIL because the recorder does not exist.

- [ ] **Step 3: Implement the recorder with fixed read-only Git commands**

Use `git cat-file -e <sourceSha>^{commit}` only to establish the commit exists. Obtain changed tracked paths using fixed `git diff --name-only` calls for source-to-HEAD, HEAD-to-working-tree, and `--cached`, then pass those names through `assertNoNativeHostBuildInputChanges()`.

Do not invoke a shell. Use `execFile`/`spawn` with argument arrays. Call the PowerShell inspector with `-ExpectedState Unsigned`, compute flat SHA-256 for `package-lock.json` and the executable, capture the inspector Authenticode SHA-256, build `NativeHostUnsignedCandidateReceipt`, and atomically create the output file with exclusive semantics so existing evidence is never silently overwritten.

Success stdout is bounded:

```json
{"status":"recorded","sourceSha":"<40hex>","preSignSha256":"<64hex>"}
```

It must not print paths, environment values, or certificate/store information.
Add to `package.json` only:

```json
"record:native-host-candidate": "tsx scripts/record-native-host-unsigned-candidate.ts"
```

- [ ] **Step 4: Run GREEN + regression checks**

```powershell
.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 test/native-host-candidate.test.ts test/native-host-signature.test.ts test/native-host-candidate-cli.test.ts
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```powershell
git add package.json scripts/record-native-host-unsigned-candidate.ts test/native-host-candidate-cli.test.ts
git commit -m "feat: record unsigned native host candidate"
```

### Task 4: Verify the signed candidate and write final receipt

**Files:**
- Create: `scripts/verify-signed-native-host-candidate.ts`
- Modify: `test/native-host-candidate-cli.test.ts`
- Modify: `package.json`

**Interfaces:**
- CLI arguments: `--build-dir`, `--unsigned-receipt`, `--output`, `--signing-digest SHA256`.
- `--signing-digest` accepts exactly `SHA256`; this field records reviewed signer-invocation evidence and is not falsely presented as a value extracted by PowerShell.
- Re-validate repository/source/build-input continuity from the unsigned receipt before trusting the signed bytes.
- Recompute current package-lock hash and require equality with the unsigned receipt.
- Inspect `wag-native-host.exe` with `-ExpectedState Valid` and parse through Task 1 schema.
- Compute post-sign flat SHA-256 and require it differs from `preSignSha256`.
- Require the post-sign system Authenticode SHA-256 to exactly equal the unsigned receipt `authenticodeSha256`; mismatch proves the signed executable content is not the recorded SEA candidate and fails before execution.
- Probe only process creation: spawn the verified executable with no Native Messaging arguments, require the Node `spawn` event, bound the probe to 5 seconds, and accept its later nonzero exit because Task 6 owns protocol behavior. A spawn error such as SAC `UNKNOWN/-4094` fails the gate.
- Write the final receipt only after signature verification and process-start probe both succeed.

- [ ] **Step 1: Add signed-verifier RED tests**

Unit-test the verifier orchestration with injected dependencies so hermetic tests can supply valid signature facts and a successful process-start probe without manufacturing a trusted certificate. Assert that tampered executable hash, Authenticode-hash continuity mismatch, lockfile drift, source/build-input drift, invalid/ECC signature facts, unchanged pre/post flat hash, and failed process start all reject before receipt creation.

Representative test:

```ts
await assert.rejects(() => verifyCandidate({ ...input, dependencies: {
  inspectSignature: async () => ({ ...validSignatureFacts(), publicKeyAlgorithmOid: '1.2.840.10045.2.1' }),
  probeStart: async () => 'STARTED',
}}));
assert.equal(await pathExists(outputReceipt), false);
```

CLI-level Windows test uses a trusted system executable only to prove signature parsing/start orchestration, but must not relabel that system file as `wag-native-host.exe`; the production CLI basename check remains exact. Use dependency-level tests for the positive WAG filename path until an actual signed WAG candidate exists.

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 test/native-host-candidate-cli.test.ts --test-name-pattern="signed candidate"
```

Expected: FAIL because the signed verifier does not exist.

- [ ] **Step 3: Implement signed verification and bounded start probe**

Keep orchestration functions exported and dependency-injectable for tests. Production dependencies call the committed PowerShell inspector and `spawn()` directly with `shell: false`. The start probe must terminate a still-running child at the 5-second bound, but it must never kill an unrelated PID/process tree.
Success stdout is bounded:

```json
{"status":"verified","sourceSha":"<40hex>","sha256":"<64hex>","signature":"Valid","executionProbe":"STARTED"}
```

Add to `package.json`:

```json
"verify:native-host-candidate": "tsx scripts/verify-signed-native-host-candidate.ts"
```

- [ ] **Step 4: Run GREEN + complete focused gate**

```powershell
.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 test/native-host-candidate.test.ts test/native-host-signature.test.ts test/native-host-candidate-cli.test.ts
npm run typecheck
npm run build
git diff --check
```

Expected: all PASS. Confirm no tracked distribution/install constants or workflows changed.

- [ ] **Step 5: Commit Task 4**

```powershell
git add package.json scripts/verify-signed-native-host-candidate.ts test/native-host-candidate-cli.test.ts
git commit -m "feat: verify signed native host candidate"
```

### Task 5: External signing checkpoint — no speculative provider integration

**Files:** none unless a separately authorized provider-specific design is approved later.

**Authority gate:** STOP before provisioning/purchase/identity-validation/key issuance/OIDC trust creation/signing until the user explicitly authorizes the exact signer/provider path. Do not edit `.github/workflows/native-host-distribution.yml` merely to prepare for a hypothetical signer.

- [ ] **Step 1: Verify repository implementation independently before external signing**

Run the complete Task 1–4 focused suite, `npm run typecheck`, `npm run build`, and `git diff --check`. Independent review must report Critical=0 and Important=0 before any signing credential is used.

- [ ] **Step 2: Select and authorize one real RSA trusted signer**

Require concrete evidence for Windows-trusted CA chain, RSA code-signing key, protected key custody, SHA-256 Authenticode support, RFC3161 SHA-256 timestamp support, revocation lifecycle, legal-identity eligibility, automation model, and cost. Prefer OV RSA when Azure Public Trust eligibility is not positively established.
If provider selection requires repository workflow/OIDC changes, stop and write a provider-specific bounded design first; do not improvise credentials or signing permissions inside this plan.

- [ ] **Step 3: Build and bind the unsigned candidate from a clean committed SHA**

After Tasks 1–4 are committed and reviewed:

```powershell
$sourceSha = (git rev-parse HEAD).Trim()
$candidateRoot = Join-Path $env:TEMP "wag-native-host-candidate-$sourceSha"
npm run build:native-host -- --output $candidateRoot
npm run record:native-host-candidate -- --build-dir $candidateRoot --source-sha $sourceSha --repository ShenJun93/web-agent-gateway --output (Join-Path $candidateRoot 'unsigned-candidate-receipt.json')
```

Require clean tracked state before recording. The unsigned receipt becomes the immutable pre-sign provenance input.

- [ ] **Step 4: STOP for the separately authorized external signer**

The signer must operate on exactly `$candidateRoot\wag-native-host.exe` after `postject`, use RSA Authenticode with SHA-256, and preferably RFC3161/SHA-256 timestamping. No command is specified here because the actual provider/token/HSM interface does not exist yet and must not be guessed.

Record only non-secret evidence needed to prove the signer invocation used SHA-256. Do not copy private credentials or token/PIN material into the repository or task logs.

- [ ] **Step 5: Verify the signed bytes and create final candidate receipt**

After the authorized signing action succeeds:

```powershell
npm run verify:native-host-candidate -- --build-dir $candidateRoot --unsigned-receipt (Join-Path $candidateRoot 'unsigned-candidate-receipt.json') --output (Join-Path $candidateRoot 'signed-candidate-receipt.json') --signing-digest SHA256
```

Expected: one bounded `status=verified` JSON line, `Get-AuthenticodeSignature`-backed RSA trust facts, an identical pre/post system Authenticode SHA-256, a post-sign flat hash different from the pre-sign flat hash, and `executionProbe=STARTED` without a new Code Integrity denial.

If no signer is authorized/available, stop truthfully with:

```text
SIGNED_NATIVE_HOST_CANDIDATE_V1 = BLOCKED_SIGNING_IDENTITY
BROWSER_INSPECT_V2_TASK6 = BLOCKED_APPLICATION_CONTROL
```

### Task 6: Handoff the exact signed candidate back to Browser Inspect v2 Task 6

**Files:** no Signed Native Host production files change in this task. Browser Inspect v2 Task 6 owns its existing acceptance-test migrations.

**Consumes:** `$candidateRoot` containing `wag-native-host.exe`, `sea-config.json`, `unsigned-candidate-receipt.json`, and `signed-candidate-receipt.json`, with final receipt status verified.

- [ ] **Step 1: Re-verify candidate identity immediately before handoff**

Re-run `verify:native-host-candidate` against the same directory and receipt inputs. Require the same post-sign flat SHA-256, the same recorded Authenticode SHA-256, and clean native-host build inputs. If any `src/**`, `browser/native-host/**`, builder/package/lock/tsconfig input changed since source SHA, rebuild/re-sign instead of reusing the candidate.

- [ ] **Step 2: Resume the existing Browser Inspect v2 Task 6 plan**

Fresh-read `docs/superpowers/plans/2026-09-17-browser-inspect-v2.md` Task 6 and its current Git state. Set only:

```powershell
$env:WAG_NATIVE_HOST_BUILD_DIR = $candidateRoot
```

Then execute Task 6's v2 acceptance migration and exact SEA tests. Do not rebuild inside those acceptance tests and do not substitute source execution.

- [ ] **Step 3: Keep release provenance separate**

A Task 6 PASS records the candidate source SHA + final signed SHA-256 as local acceptance evidence only. Do not update `NATIVE_HOST_ACCEPTED_*`, installation pins, historical receipts, or registration state. The eventual main/release signed artifact remains a separate distribution/reacceptance gate.

## Plan verification before execution

Before dispatching Task 1, verify:

```powershell
git status --short
git rev-parse HEAD
```

Expected base: the approved spec/plan commits only, with no unrelated tracked changes. Every implementation task gets strict RED -> GREEN evidence, independent review, and a small commit before the next task starts.

The implementation phase must not add signing Actions, OIDC permissions, provider secrets, certificate-store writes, registry writes, Smart App Control changes, native-host installation, or Browser authority widening.
