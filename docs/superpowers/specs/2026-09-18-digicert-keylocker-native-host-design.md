# DigiCert KeyLocker Native Host Signer Design

**Status:** Design-only authorized on 2026-09-18. No DigiCert account/order, validation, KeyLocker credential, client certificate, purchase, or signing action is authorized by this document.

**Parent gate:** `SIGNED_NATIVE_HOST_CANDIDATE_V1` Task 5.

## Goal

Define the smallest DigiCert Code Signing + KeyLocker path that can sign one exact postject `wag-native-host.exe` while preserving WAG's existing provenance and verification boundaries.

## Non-goals

- no DigiCert/CertCentral/KeyLocker account mutation;
- no order or payment;
- no identity/organization validation submission;
- no API key or client-authentication certificate creation;
- no KSP/SMCTL install or credential persistence;
- no GitHub workflow or repository-secret change;
- no certificate-store/trust-store/SAC/App Control/install/register/Browser mutation;
- no signing action.

## Product and eligibility gate

The baseline design targets DigiCert **Code Signing + KeyLocker** rather than EV because WAG signs a user-mode native host, not a kernel-mode driver. The actual legal publisher and DigiCert validation eligibility must be confirmed before ordering.For WAG, require **RSA-3072 or stronger**. DigiCert currently states that new code-signing issuance uses RSA 3072-bit or larger keys; private keys must satisfy the current hardware/HSM storage requirements.

## Trust and key custody

- publicly trusted DigiCert code-signing certificate with code-signing EKU;
- RSA-3072 or stronger end-entity key;
- private key held non-exportably in DigiCert KeyLocker cloud key storage;
- Microsoft Authenticode compatibility through SignTool/KSP;
- Authenticode file digest: SHA-256;
- RFC 3161 timestamp digest: SHA-256;
- timestamp endpoint: DigiCert's documented TSA;
- no PFX/private key copied into WAG, GitHub, receipts, Browser tools, or logs.

## First-candidate architecture

1. Start from a clean committed WAG SHA containing the accepted Tasks 1–4 implementation.
2. Build the SEA and create the unsigned candidate receipt before any signing operation.
3. Provision one approved RSA KeyLocker key pair/certificate only after separate purchasing and validation authorization.
4. Use a dedicated Windows signing host with DigiCert's KSP/KeyLocker client tooling.
5. Keep provider API key and client-authentication certificate/password outside the repository and WAG runtime; for a manual first candidate, prefer protected local credential storage over CI secrets.
6. Sign exactly `$candidateRoot\wag-native-host.exe` using the approved key alias/certificate and no other artifact.
7. Immediately run WAG's signed-candidate verifier; any trust/RSA/EKU/hash/start failure rejects the candidate.## Future signing invocation shape

When separately authorized and provisioned, use DigiCert's documented SignTool/KSP path with the approved KeyLocker key alias/certificate. The invocation must declare `/fd SHA256`, RFC 3161 `/tr http://timestamp.digicert.com`, and `/td SHA256`.

DigiCert's signing clients authenticate with provider credentials that can include an API key plus client-authentication certificate/password. These values are external signer credentials, not WAG configuration. They must never be printed into candidate logs or persisted in repository files.

For the first local candidate, Windows Credential Manager or an equivalent OS-protected store is preferable to plain environment variables, subject to a later credential-handling authorization.

## Future CI phase — separate authorization required

DigiCert's published KeyLocker CI patterns use long-lived authentication material. CI signing therefore requires a dedicated threat-model/design before implementation.

A later CI design must:

- use a dedicated service/signing identity rather than a personal account;
- scope the API key/client certificate to the least provider permissions available;
- store secrets only in a protected environment/secret manager;
- require manual/environment approval for release signing;
- prevent PR/fork/arbitrary-branch access to signing credentials;
- rotate API key and client-authentication certificate independently where possible;
- prevent `smctl`, KSP, or SignTool verbose output from leaking credentials;
- keep the unsigned receipt immutable before the signer becomes available.

No GitHub workflow work is authorized by this design.## Failure and recovery

- validation/order failure: stop; do not substitute test/private trust;
- any non-RSA issued key/certificate: reject for WAG and correct the product/key before signing;
- credential failure before signature mutation: preserve unsigned evidence and diagnose;
- partial/uncertain signing mutation: discard executable and rebuild from the clean source SHA;
- WAG verifier failure: reject the candidate and do not install or hand it to Browser Inspect;
- credential compromise: revoke/disable the API key/client certificate, rotate access, review KeyLocker audit evidence, and rebuild/re-sign;
- signing-key compromise/revocation: revoke/reissue through DigiCert and treat all affected candidates as invalid.

## Cost snapshot

DigiCert's current comparison page displays Code Signing + KeyLocker at USD 65/month/certificate, 1,000 signings/year, and FIPS 140-2 cloud key storage. The same page also displays a USD 996 12-month subscription amount, which does not arithmetically match 12 × USD 65. Treat pricing as **quote-required** and obtain an authoritative checkout/contract estimate before any purchase authorization.

## Acceptance criteria before purchase/provisioning authorization

A later request must identify:

- legal publisher and validation eligibility;
- exact Code Signing + KeyLocker SKU and authoritative quote;
- RSA-3072-or-stronger key configuration;
- KeyLocker region/data-residency choice if applicable;
- signing-volume requirement;
- dedicated local signer host/operator;
- API-key/client-certificate credential storage and rotation owner;
- timestamp/signing command shape;
- revocation/reissue/recovery procedure;
- explicit exclusion of CI automation unless separately authorized.## Sources reviewed 2026-09-18

- https://www.digicert.com/signing/compare-code-signing-certificates
- https://www.digicert.com/signing/code-signing-certificates
- https://dev.digicert.com/certcentral-apis/services-api/orders/order-code-signing-certificate.html
- https://docs.digicert.com/en/digicert-keylocker/client-tools/command-line-interface/third-party-signing-tool-integrations/signtool.html
- https://docs.digicert.com/en/digicert-keylocker/code-signing/sign-with-third-party-signing-tools/windows-applications/sign-authenticode-files-with-signtool-using-ksp-library.html
- https://docs.digicert.com/en/digicert-keylocker/smctl-command-manual/manage-signatures.html
- https://docs.digicert.com/en/platform-overview/manage-your-accounts/digicert-account/users/client-authentication-certificates/create-client-authentication-certificate.html

**Current state:** design complete; ordering, validation, credential creation, client-tool installation, and signing authority remain closed.