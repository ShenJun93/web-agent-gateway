# Signed Native Host Signer Options — 2026-09-18

## Scope

This note is read-only provider research for `SIGNED_NATIVE_HOST_CANDIDATE_V1` Task 5. It does not select, purchase, provision, validate, federate, or use a signing identity.

Current implementation gate:

- repository HEAD at research start: `dab7f077009ab61bbafa709b2ab5836ea07940c9`
- Task 1–4 implementation and independent review: accepted
- external signing authority: not granted
- Browser Inspect v2 Task 6: still blocked until one exact signed candidate passes the verifier

Do not infer provider eligibility from device location, chat location, IP-derived location, or prior conversation. Eligibility must be established from the legal individual or organization identity that will own the certificate/profile.

## Binding Windows requirements

Microsoft's current Smart App Control guidance states that protected devices accept code signed with RSA-based certificates from trusted providers; ECC signatures are not supported by Smart App Control. A suitable path therefore needs:

- RSA code-signing key and certificate;
- chain to a Windows/Microsoft trusted public root;
- SHA-256 Authenticode signing;
- RFC 3161 SHA-256 timestamp support where available;
- protected/non-exportable key custody;
- a signer invocation whose SHA-256 digest choice can be recorded without exposing credentials.

Sources:

- https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control
- https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview
- https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models
## Option A — Microsoft Artifact Signing Public Trust

Fit: strongest first choice only when the actual legal identity is positively eligible.

Current Microsoft documentation says Public Trust supports Win32 app code signing and Smart App Control. Basic pricing is USD 9.99/month for up to 5,000 signatures; Premium is USD 99.99/month for up to 100,000 signatures, with USD 0.005 per signature above quota.

The current quickstart lists Public Trust eligibility for organizations in the United States, Canada, European Union, United Kingdom, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, and Israel. Individual developers are limited to the United States and Canada. Identity validation requires an Azure subscription and Microsoft Entra tenant; individual validation also depends on the Azure billing identity.

This path is Microsoft-managed and directly targeted at the Windows trust model, but it is not safe to select until the intended legal owner and jurisdiction are explicitly supplied and verified. Any later GitHub automation must use a narrowly bound workload identity; no repository-wide wildcard federation and no long-lived client secret merely for signing.

Sources:

- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models
- https://azure.microsoft.com/en-us/products/artifact-signing
- https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku

## Option B — SSL.com OV/IV RSA + eSigner cloud HSM

Fit: current lowest-friction traditional-CA candidate when Azure Public Trust eligibility is absent or unproven.

SSL.com currently lists IV and OV code-signing certificates at USD 129/year. eSigner cloud signing is a separate HSM-backed service; Tier 1 is listed at USD 15/month for 240 signatures, with annual billing advertised at a discount. The service supports CI/CD and keeps the private key in SSL.com's cloud HSM.

For Windows-native signing, SSL.com's current CKA guidance uses SignTool with `/fd sha256`, RFC 3161 timestamping via `/tr`, and `/td sha256`. The normal timestamp endpoint may use ECDSA timestamp certificates; SSL.com documents a legacy RSA timestamp endpoint for compatibility. The code-signing certificate itself still must be confirmed as RSA before purchase/issuance.
Automation caveat: SSL.com's published GitHub CI examples use stored account/password/TOTP-style secrets for CKA configuration. That is materially different from Azure OIDC and would need its own bounded credential design before repository workflow integration. For the first local candidate, manual/provider-console signing can remain a separate external checkpoint and avoids speculative CI secret work.

Sources:

- https://www.ssl.com/products/software-integrity/code-signing/ov/
- https://www.ssl.com/products/software-integrity/signing-service/
- https://www.ssl.com/how-to/automate-ev-code-signing-with-signtool-or-certutil-esigner/
- https://www.ssl.com/how-to/how-to-integrate-esigner-cka-with-ci-cd-tools-for-automated-code-signing/

## Option C — DigiCert Code Signing + KeyLocker

Fit: high-assurance enterprise fallback where stronger managed lifecycle/support is worth higher cost.

DigiCert currently lists Code Signing + KeyLocker as a cloud-based key-storage/signing option, with the comparison page showing approximately USD 65/month/certificate for that tier. KeyLocker supports SignTool with `/fd SHA256`, `/tr http://timestamp.digicert.com`, and `/td SHA256`.

The published GitHub integration uses an API token plus client-authentication certificate/password secrets. That credential surface is broader than the current WAG preference for short-lived workload identity and therefore requires a separate credential-storage/threat-model design before CI use.

Sources:

- https://www.digicert.com/signing/compare-code-signing-certificates
- https://docs.digicert.com/en/digicert-keylocker/code-signing/sign-with-third-party-signing-tools/windows-applications/sign-authenticode-files-with-signtool-using-ksp-library.html
- https://docs.digicert.com/en/digicert-keylocker/ci-cd-integrations-and-deployment-pipelines/scripts/github/scripts-for-signing-using-pkcs11-library-on-github.html

## Option D — Sectigo traditional code signing

Fit: valid traditional-CA fallback, but not the first candidate for this milestone because the current public offering emphasizes shipped tokens or customer HSM attestation and is materially more expensive/operationally heavier than the two paths above.

Sectigo's current public page lists code signing starting at USD 536.25/year on the five-year option and states post-2023 private keys are delivered on a Sectigo token or installed on a compliant customer HSM with verifiable attestation.

Source:

- https://www.sectigo.com/ssl-certificates-tls/code-signing
## Decision order for WAG

1. Check legal-identity eligibility for Artifact Signing Public Trust without creating resources. If positively eligible, prepare a provider-specific Artifact Signing design; do not provision until explicitly authorized.
2. If Artifact Signing Public Trust is ineligible or uncertain, prefer a traditional CA with cloud-HSM custody. Current research makes SSL.com OV/IV + eSigner the lowest-friction candidate to validate next.
3. Keep DigiCert KeyLocker as the enterprise fallback when audit/support requirements justify its higher cost and secret-based automation surface.
4. Do not use self-signed certificates, private/test trust, locally imported roots, App Control allowlists, SAC disablement, or reputation waiting as substitutes.

This ordering is a research recommendation, not provider selection or purchasing authority.

## Evidence required before explicit provider authorization

For the exact proposed certificate/profile, collect and review all of the following before any purchase or resource creation:

- legal owner type: individual, sole proprietor, or organization;
- provider/jurisdiction eligibility confirmed from authoritative provider documentation;
- exact certificate product/profile and public trust chain;
- RSA key algorithm and supported key size;
- code-signing EKU and Windows Authenticode compatibility;
- private-key custody model and non-exportability/HSM assurance;
- SHA-256 file digest support;
- RFC 3161 SHA-256 timestamp endpoint and timestamp signer compatibility;
- validation steps, expected identity documents, callback requirements, and issuance lead time;
- first-year and renewal cost, signing-volume limits, overage fees, cancellation/refund constraints;
- manual first-candidate signing procedure;
- automation credentials required later and whether short-lived federation exists;
- revocation/reissue/recovery procedure;
- proof that no secret must enter Git, WAG runtime, Browser tools, receipts, or logs.

## Current gate

```text
SIGNED_NATIVE_HOST_CANDIDATE_V1 = BLOCKED_SIGNER_SELECTION_AUTHORITY
BROWSER_INSPECT_V2_TASK6 = BLOCKED_APPLICATION_CONTROL
```

The next state transition requires an explicit user choice/authorization of a concrete signer path. A bare continuation command is not authority to buy, provision, validate identity, create federation, or sign.
