# Signed Native Host Candidate v1 — Design

Date: 2026-09-17
Status: APPROVED 2026-09-17; continuity amendment from implementation-plan self-review
Decision authority: ADR-0013, ADR-0014, ADR-0017, ADR-0018
Consumes: Browser Inspect v2 implementation through `50809015877e827569fee73bd8c2c13931753712`

## Goal

Create a deterministic, reviewable trust gate for `wag-native-host.exe` so Browser Inspect v2 local acceptance can execute the exact candidate on Windows systems where Smart App Control blocks new unsigned SEA binaries.

This milestone changes artifact trust/provenance only. It does not widen Browser tools, mutate Browser Admission, install or register a native host, change Smart App Control/App Control policy, expose signing credentials, or promote a candidate into the accepted release identity.

## Trigger and live evidence

Browser Inspect v2 Task 6 reached `11/13` focused acceptance. Both exact-SEA execution tests fail at Windows process creation with `spawn UNKNOWN` / errno `-4094`.

A stable local probe built the SEA successfully with Node `24.20.0`. Windows Code Integrity Event `3033` then reported that the generated `wag-native-host.exe` did not meet Enterprise signing-level requirements. Event `3089` reported `TotalSignatureCount=0`, `ValidatedSigningLevel=0`, and publisher `Unknown`.

The machine reports `VerifiedAndReputablePolicyState = 1`, consistent with Smart App Control enforcement. The previously accepted v1 native-host executables are also `NotSigned`, but the exact accepted v1 hash `62af695a...` still starts without a new Code Integrity denial. This is consistent with Smart App Control reputation/intelligence allowing an older known binary while blocking a new unknown unsigned binary.

Reputation is therefore diagnostic evidence, not an acceptance mechanism. Browser Inspect v2 requires deterministic trust for a new exact binary identity.

## Decision summary

Use a CA-trusted RSA Authenticode signature on the final PE bytes after SEA injection and before any execution, hash, packaging, or acceptance.

The default signing path is an Organization Validated (OV) RSA code-signing identity from a CA in the Microsoft Trusted Root Program, using CA/Browser Forum-compliant protected key storage such as a hardware token or cloud HSM. Azure Artifact Signing Public Trust is an allowed alternative only when the legal individual/organization identity is currently eligible for that service.

Do not use a self-signed certificate, Artifact Signing Private Trust, Public Trust Test, a locally imported root, Smart App Control disablement, App Control allow-list changes, or accumulated file reputation as substitutes for this gate.

The candidate signature proves Windows trust for one exact binary. It does not replace source-SHA provenance, executable SHA-256, workflow/build receipt, installation receipt, Browser Admission identity, or later supported-host acceptance.

## Signing identity constraints

Smart App Control currently accepts RSA-based signatures from trusted providers; ECC signatures are outside this milestone. The Authenticode digest is SHA-256.

The signature SHOULD carry an RFC 3161 SHA-256 timestamp so the signed artifact can remain verifiable after certificate expiry when platform rules permit. Timestamping does not weaken the requirement that the signing certificate and chain were valid at signing time.

The signing private key MUST remain outside the repository and WAG runtime. No PFX, token PIN, signing API key, Azure client secret, certificate private key, or signing-service credential may be committed, copied into build receipts, surfaced to Browser tools, or logged in acceptance output.

For OV signing, protected key custody is delegated to the selected CA/HSM mechanism. For Azure Artifact Signing, authentication uses short-lived workload identity/OIDC where CI is used; long-lived Azure client secrets are not introduced merely for signing.

No signing identity is assumed to exist today. Provisioning, identity validation, payment, key issuance, federated trust creation, and actual signing remain explicit external/security checkpoints.

## Exact-byte sequencing

Signing occurs only after the existing SEA builder has completed all byte-changing operations:

`TypeScript bundle -> SEA blob -> copy node.exe -> postject NODE_SEA_BLOB -> final unsigned PE -> system Authenticode SHA-256 -> Authenticode sign -> signature verify -> same system Authenticode SHA-256 -> flat SHA-256 -> execution/acceptance -> package/receipt`

Signing before `postject` is invalid because SEA injection changes the PE after signature creation. Re-signing or otherwise mutating the binary after the accepted hash is recorded creates a new artifact identity and invalidates downstream evidence.

The signed executable SHA-256 is the authoritative executable hash for every receipt or acceptance result that consumes the signed candidate. The pre-sign hash may be retained only as diagnostic build evidence and MUST NOT be confused with the executable identity used for install or acceptance.

Unsigned-to-signed continuity MUST also use the Windows system-computed Authenticode SHA-256 image hash. Microsoft documents that AppLocker file-hash rules use an Authenticode cryptographic hash and that App Control Authenticode/PE image hashing excludes signature/timestamp certificate data and PE checksum fields. Record this hash before signing and recompute it after signing; the values MUST be identical. This proves the executable content covered by Authenticode is unchanged even though the flat file SHA-256 changes when a signature is embedded.

The existing `scripts/build-native-host.ts` remains the single SEA builder. This milestone MUST NOT create a second native-host bundling implementation.

## Candidate provenance receipt

Signing begins from a clean committed source SHA. The candidate receipt records repository identity, source SHA, Node version, package-lock SHA-256, builder identity, pre-sign diagnostic flat SHA-256, system-computed Authenticode SHA-256, post-sign executable flat SHA-256, signer certificate subject/thumbprint, RSA/signature digest facts, timestamp metadata when present, and verification result.

The receipt contains no private-key material, tokens, PINs, access credentials, full certificate private data, local usernames, or machine-specific secrets. Local paths are not artifact identity.

Task 6 may reuse a signed candidate after later test/document-only commits only when a conservative native-host build-input comparison proves no change since the receipt source SHA. At minimum compare `src/**`, `browser/native-host/**`, `scripts/build-native-host.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, and `tsconfig.build.json`. Any change in that set requires rebuild, re-sign, and a new receipt.

The receipt is candidate evidence only. It does not replace or mutate `build-receipt.json`, installation receipts, accepted-source constants, or historical benchmark receipts.

## Candidate verification contract

Before Task 6 may execute a signed candidate, a read-only verification step MUST establish all of the following:

1. the candidate is the expected `wag-native-host.exe` produced from the intended source state;
2. Authenticode status is valid under current Windows trust evaluation;
3. at least one accepted signature uses an RSA code-signing certificate rather than ECC;
4. the certificate chains to a Windows-trusted CA without importing a new local root for the test;
5. the executable flat SHA-256 is computed after signing;
6. the system Authenticode SHA-256 image hash exactly equals the pre-sign Authenticode SHA-256;
7. the signer subject/thumbprint or equivalent bounded certificate identity is recorded without exposing private material;
8. signature verification produces no trust-policy mutation; and
9. the verification result is bound to the exact candidate hash handed to Task 6.

A successful `Get-AuthenticodeSignature` or SignTool verification alone does not authorize installation, registry changes, Browser execution, or release promotion. It only qualifies bytes for the existing read-only local acceptance gate.

## Local Task 6 handoff

Task 6 already supports a prebuilt directory through `WAG_NATIVE_HOST_BUILD_DIR`. The signed-candidate gate SHOULD use that seam rather than weakening tests to execute source or bypass the SEA executable.

The signed prebuilt directory is ephemeral acceptance input, not an installed host. Task 6 consumes it to run the exact native-host process path and must still prove Browser Inspect v2 protocol/profile behavior, reconnect, cross-session denial, R1/R2 evidence, and zero repository mutation.

Task 6 remains blocked when no trusted signed candidate is available. Tests MUST NOT turn Smart App Control failure into a skip, retry loop, source execution fallback, historical-v1 fallback, or policy bypass.

`npm run build:native-host` remains a build-integrity gate even when its local unsigned output cannot execute under Smart App Control. Passing that build command does not substitute for exact signed-candidate execution.

## Candidate versus accepted distribution

A signed feature candidate and an accepted release distribution are separate identities.

A feature candidate may be signed only for local acceptance after explicit signing authorization. Its source SHA, post-sign executable SHA-256, signer identity, and verification evidence are recorded as candidate evidence. It MUST NOT update production installation pins or historical distribution receipts.

The existing project rule remains authoritative for release provenance: an accepted distribution is produced from the reviewed release/main source according to the distribution workflow and then separately installed/registered only after promotion authorization.

If the final release build differs from the locally accepted feature candidate for any reason, including merge commit, signing timestamp, signer certificate rotation, rebuilt SEA bytes, or workflow inputs, the release binary has a different SHA-256 and requires its own artifact verification and downstream installation/supported-host acceptance.

No local candidate hash is promoted into production constants before a release artifact exists.

## CI and OIDC boundary

This design does not grant signing authority to the existing generic `pull_request` distribution job.

If Azure Artifact Signing is later selected, any GitHub OIDC trust MUST bind a narrowly scoped workflow identity. The signing job must use trusted workflow code and must not allow arbitrary PR-controlled workflow changes to request a signing token. Repository-wide or wildcard federated credentials are prohibited.

GitHub required-reviewer environments cannot be assumed for this private repository because GitHub documents plan-dependent limitations for private repositories. The design must remain safe without environment required reviewers.

Acceptable patterns include a separately reviewed signing workflow whose OIDC subject is constrained to a trusted branch/ref, or an equivalent provider control that restricts which repository/workflow identity may invoke signing. If no sufficiently narrow OIDC subject can be enforced for the chosen provider, signing remains a manual external checkpoint rather than widening CI trust.

For a traditional OV CA/cloud-HSM signer, provider-specific CI integration is deferred until the actual signer is selected. The repository MUST NOT add placeholder secrets, generic credential variables, or a speculative signing action before that selection.

Every third-party GitHub Action introduced for signing MUST be pinned to a reviewed full commit SHA. Floating tags such as `@v2`, `@main`, or `@latest` are not accepted supply-chain controls.

## Failure semantics

The gate fails closed on any of the following:

- unsigned or invalid Authenticode state;
- ECC-only signature;
- untrusted or locally injected root dependency;
- ambiguous/multiple candidate executable selection;
- signing after the accepted hash was computed;
- candidate/source identity mismatch;
- missing or unverifiable signer metadata;
- Smart App Control or Code Integrity denial during exact execution;
- signing credential exposure; or
- any attempt to disable/bypass Windows trust policy to obtain GREEN.

## Acceptance gate

`SIGNED_NATIVE_HOST_CANDIDATE_V1 = PASS` requires all of the following:

- exact source state is recorded;
- final SEA bytes are produced by the existing builder and then signed, in that order;
- the final executable carries a valid CA-trusted RSA Authenticode signature;
- the post-sign flat SHA-256 is recorded;
- the pre/post system Authenticode SHA-256 image hash is identical and recorded;
- bounded signer/certificate identity is recorded without private material;
- current Windows trust evaluation accepts the signature without local trust-store or policy mutation;
- exact signed executable starts on the Smart App Control host without Code Integrity denial;
- no installation, NativeMessagingHosts registration, browser profile mutation, or Browser authority promotion occurs in this gate; and
- downstream Task 6 consumes the exact verified signed bytes rather than rebuilding or substituting another executable.

Until those conditions exist:

`SIGNED_NATIVE_HOST_CANDIDATE_V1 = BLOCKED_SIGNING_IDENTITY`
`BROWSER_INSPECT_V2_TASK6 = BLOCKED_APPLICATION_CONTROL`

## External onboarding gate

The preferred operational path is OV RSA when Azure Artifact Signing Public Trust eligibility is not positively established for the legal identity performing validation.

Current Microsoft guidance describes OV code-signing certificates as globally available and requires CA/Browser Forum-compliant protected private-key storage. Azure Artifact Signing Public Trust has geographic eligibility constraints that must be checked against the legal individual/organization identity, not inferred from device location or chat context.

No provider purchase or account selection is part of this spec. Before provisioning, compare at least identity eligibility, RSA support, Windows Trusted Root Program chain, HSM/cloud-HSM custody, automation model, timestamp service, revocation lifecycle, and total cost.

## Non-goals

This milestone does not:

- change Browser Inspect v2 protocol, adapter id, or five-tool inventory;
- authorize verify, mutation, shell/process, Git write, or browser mutation;
- replace historical v1 distribution/install receipts;
- modify Smart App Control/App Control settings or trusted-root stores;
- introduce an installer or auto-registration path;
- make a feature candidate an accepted production native host;
- rely on SmartScreen/Smart App Control reputation as deterministic evidence; or
- require a specific commercial CA before provider selection is separately authorized.

## Research basis refreshed 2026-09-17

Primary sources:

- Microsoft Smart App Control overview: <https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview>
- Microsoft Smart App Control signing guidance: <https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control>
- Microsoft Windows code-signing options: <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options>
- Microsoft Authenticode timestamp guidance: <https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures>
- Microsoft AppLocker Authenticode hash rule: <https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/understanding-the-file-hash-rule-condition-in-applocker>
- Microsoft PE Authenticode image-hash exclusions: <https://learn.microsoft.com/en-us/windows/win32/debug/pe-format>
- Azure Artifact Signing quickstart/eligibility: <https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart>
- Azure Artifact Signing trust models: <https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models>
- GitHub OIDC reference: <https://docs.github.com/en/actions/reference/security/oidc>
- GitHub environments/protection availability: <https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>

## Decision markers

`MILESTONE = SIGNED_NATIVE_HOST_CANDIDATE_V1`
`TRUST_TARGET = WINDOWS_SMART_APP_CONTROL`
`SIGNATURE = AUTHENTICODE_RSA_SHA256_CA_TRUSTED`
`TIMESTAMP = RFC3161_SHA256_PREFERRED`
`SIGN_ORDER = POSTJECT_THEN_AUTHENTICODE_HASH_THEN_SIGN_THEN_VERIFY_SAME_AUTHENTICODE_HASH_THEN_FLAT_HASH`
`DEFAULT_PROVIDER_CLASS = OV_CA_PROTECTED_KEY`
`AZURE_ARTIFACT_SIGNING = CONDITIONAL_ON_LEGAL_IDENTITY_ELIGIBILITY`
`LOCAL_TRUST_POLICY_MUTATION = FORBIDDEN`
`BROWSER_AUTHORITY_DELTA = NONE`
`RELEASE_PROMOTION = SEPARATE_GATE`
