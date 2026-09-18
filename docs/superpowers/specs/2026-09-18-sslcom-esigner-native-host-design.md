# SSL.com eSigner Native Host Signer Design

**Status:** Design-only authorized on 2026-09-18. No order, validation, credential, eSigner enrollment, purchase, or signing action is authorized by this document.

**Parent gate:** `SIGNED_NATIVE_HOST_CANDIDATE_V1` Task 5.

## Goal

Define the smallest traditional-CA/cloud-HSM path for signing one exact postject `wag-native-host.exe` using an SSL.com publicly trusted RSA code-signing certificate and eSigner, without widening WAG or Browser authority.

## Non-goals

- no SSL.com account/order creation;
- no identity or organization validation submission;
- no payment;
- no eSigner credential creation or enrollment;
- no GitHub workflow or repository-secret mutation;
- no certificate-store, trust-store, SAC/App Control, install, registration, or Browser mutation;
- no signing action.

## Product/identity gate

The exact certificate product depends on the legal publisher: IV for an eligible individual publisher, or OV for a registered organization. The legal owner type must be supplied explicitly before any order.For WAG, request/issue **RSA-3072 or stronger**, never ECC, because Smart App Control requires RSA-compatible trusted signing. SSL.com currently documents RSA code-signing support and a 3072-bit minimum for modern code-signing issuance.

## Trust and key custody

- publicly trusted SSL.com IV or OV code-signing certificate;
- code-signing EKU and Microsoft Authenticode compatibility;
- RSA-3072 or stronger end-entity key;
- private key held non-exportably in SSL.com eSigner cloud HSM;
- Authenticode file digest: SHA-256;
- RFC 3161 timestamp digest: SHA-256;
- no PFX/private key copied to disk, Git, WAG runtime, Browser tools, receipts, or logs.

The normal SSL.com timestamp endpoint may use ECDSA timestamp certificates. That does not change the requirement that the **code-signing certificate** used by WAG must be RSA. Use the provider's normal RFC 3161 endpoint first; the documented RSA legacy TSA is a compatibility fallback only if an actual verifier requires it.

## First-candidate architecture

1. Start from a clean committed WAG SHA containing the accepted Tasks 1–4 implementation.
2. Build the SEA and create `unsigned-candidate-receipt.json` before any provider operation touches the executable.
3. Validate the correct IV/OV publisher identity and explicitly request an RSA-3072-or-stronger signing key in eSigner.
4. Enroll the certificate/key in eSigner's cloud HSM; the key remains provider-held and non-exportable.
5. Use a dedicated local Windows signing session for the first candidate rather than introducing CI credentials.
6. Sign exactly `$candidateRoot\wag-native-host.exe`, once, after postject and after the unsigned receipt is fixed.
7. Immediately run WAG's verifier; any RSA/EKU/trust/hash/start failure rejects the candidate.## Future signing invocation shape

When separately authorized and provisioned, the local Windows signing path should use SSL.com's eSigner CKA/KSP integration with SignTool. The reviewed command must declare `/fd sha256`, RFC 3161 `/tr`, and `/td sha256`; certificate selection must resolve to the approved eSigner RSA certificate only.

Provider account password, API/CSC credential, OTP/TOTP material, certificate PIN, or session token must be entered/held only by the external signer tooling. WAG records no credential value and no verbose provider-authentication log.

## Future CI phase — separate authorization required

SSL.com's published CI/CD examples use persistent account/credential material. Therefore CI signing is not part of the first-candidate design.

If CI is later approved:

- create a dedicated least-privilege signing credential, never a personal daily-use credential;
- store secrets only in an approved GitHub Environment or equivalent secret store;
- require environment protection/manual approval for the signing job;
- expose signer credentials only to that job and only after the unsigned candidate receipt exists;
- prohibit pull-request and arbitrary-branch signing;
- rotate/revoke the credential independently of the certificate where supported;
- redact provider tooling output before retaining logs.

Any such workflow/secret design requires a separate approval and threat-model review.

## Failure and recovery

- validation failure: stop; do not substitute a self-signed or privately trusted certificate;
- certificate issued as ECC: reject and reissue with RSA before signing WAG;
- provider/session failure before signature mutation: preserve unsigned evidence and diagnose;
- partial/uncertain signing mutation: discard executable and rebuild from the recorded clean SHA;
- WAG verifier failure: reject the signed candidate; never install or hand it to Browser Inspect;
- suspected credential/key misuse: revoke or suspend through SSL.com, rotate credentials, and rebuild/re-sign.## Cost and lifecycle snapshot

As of 2026-09-18, SSL.com lists IV and OV code-signing certificates at USD 129/year. eSigner Tier 1 is USD 15/month for 240 signings and one credential. Longer certificate-order terms are marketed at discounts, but publicly trusted code-signing certificates are now subject to the industry 458-day maximum certificate validity, so reissuance can occur within a longer purchased term.

Standard validation is currently described as roughly 3–5 days after complete information/agreements and required callback; actual issuance is not guaranteed by this design.

## Acceptance criteria before purchase/provisioning authorization

A later authorization request must identify:

- legal owner type and IV vs OV product;
- exact RSA-3072-or-stronger key choice;
- eSigner tier and expected signing volume;
- validation evidence/documents and callback owner;
- first-year and renewal/reissue cost acknowledgement;
- exact manual local signer host and operator;
- credential storage/entry method that leaves no secret in repo/logs;
- timestamp endpoint choice;
- revocation/reissue/recovery owner;
- explicit exclusion of CI automation unless separately authorized.

## Sources reviewed 2026-09-18

- https://www.ssl.com/products/software-integrity/code-signing/iv/
- https://www.ssl.com/products/software-integrity/code-signing/ov/
- https://www.ssl.com/products/software-integrity/signing-service/
- https://www.ssl.com/blogs/new-minimum-rsa-key-size-for-code-signing-certificates/
- https://www.ssl.com/how-to/using-your-code-signing-certificate/
- https://www.ssl.com/how-to/how-to-integrate-esigner-cka-with-ci-cd-tools-for-automated-code-signing/
- https://www.ssl.com/how-to/validation-process-for-document-signing-code-signing-and-ev-code-signing-certificates/

**Current state:** design complete; ordering, validation, credentials, enrollment, and signing authority remain closed.