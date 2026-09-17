# Azure Artifact Signing Native Host Signer Design

**Status:** Design-only authorized on 2026-09-18. No Azure resource, identity validation, federation, credential, purchase, or signing action is authorized by this document.

**Parent gate:** `SIGNED_NATIVE_HOST_CANDIDATE_V1` Task 5.

## Goal

Define the smallest Azure Artifact Signing Public Trust path that could sign one exact postject `wag-native-host.exe` while preserving the existing candidate-provenance and verification gate.

## Non-goals

- no Azure subscription/resource creation;
- no identity-validation submission;
- no certificate-profile creation;
- no Entra application, managed identity, federated credential, or RBAC mutation;
- no GitHub workflow edit;
- no signing action;
- no change to SAC/App Control, Windows roots, installation, registration, or Browser authority.

## Eligibility gate

Public Trust is usable only after the actual legal certificate owner is identified and current Microsoft eligibility is positively verified. Do not infer this from machine, IP, chat, or coarse location.Current Microsoft quickstart eligibility for Public Trust is organizations in the United States, Canada, European Union, United Kingdom, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, and Israel; individual developers are limited to the United States and Canada. A paid Azure subscription and Microsoft Entra tenant are prerequisites.

## Trust and key requirements

- certificate profile type: **Public Trust**, never Public Trust Test or Private Trust;
- Windows trust must chain through Microsoft's public code-signing trust model;
- final signed candidate must expose the code-signing EKU and an RSA public-key OID accepted by WAG's verifier;
- Authenticode file digest: SHA-256;
- RFC 3161 timestamp digest: SHA-256;
- timestamp endpoint: Microsoft's Artifact Signing TSA;
- signing certificate/private key remains service-managed and is never exported to WAG or GitHub.

The design does not assume RSA from marketing text alone. The first real signature must be inspected by `verify:native-host-candidate`; any non-RSA signer certificate fails closed.

## First-candidate architecture

1. Start from a clean committed WAG SHA that already contains Tasks 1–4.
2. Build the SEA and record `unsigned-candidate-receipt.json` before any signing.
3. Use a dedicated Azure Artifact Signing account and one Public Trust certificate profile belonging to the validated legal identity.
4. Grant signing authority only to a dedicated principal at the narrowest certificate-profile scope supported by Azure RBAC.
5. For the first candidate, prefer an interactive human-authenticated Windows session rather than introducing a client secret or GitHub federation.
6. Sign exactly `$candidateRoot\wag-native-host.exe`; no rebuild, copy replacement, repack, or second file is permitted between receipt and signing.
7. Immediately run WAG's signed-candidate verifier and retain only its bounded non-secret receipt.## Future signing invocation shape

When separately authorized and provisioned, the Windows signing operation should follow Microsoft's supported SignTool + Artifact Signing Dlib path with `/fd SHA256`, RFC 3161 `/tr`, and `/td SHA256`. The metadata file may contain only account endpoint/name and certificate-profile reference; it must not contain a secret.

Signing evidence recorded for WAG is limited to:

- source SHA and unsigned receipt already produced by WAG;
- reviewed invocation declaring SHA-256;
- final verifier receipt with signer subject/thumbprint, RSA OID, timestamp facts, unchanged system Authenticode hash, and changed flat SHA-256.

Do not persist Azure access tokens, browser tokens, client secrets, or raw verbose authentication logs with candidate evidence.

## Future CI phase — separate authorization required

If CI signing is later approved, use Microsoft Entra workload identity federation rather than a long-lived client secret. The federation must bind exactly one WAG repository and one explicit GitHub Environment, branch, or tag subject; wildcard subjects are prohibited.

The CI identity receives only `Artifact Signing Certificate Profile Signer` on the designated profile. GitHub permissions are limited to `contents: read` and `id-token: write` plus only permissions independently required by the build. Signing must be a protected, explicit release/manual job; ordinary pull-request jobs never receive signer authority.

Any workflow/OIDC implementation requires a new design approval because it changes external trust and repository execution authority.

## Failure and recovery

- eligibility failure: stop without creating Public Trust resources;
- identity validation failure: do not substitute Private Trust or Public Trust Test;
- signing/authentication failure: discard the candidate only if its bytes were partially mutated; otherwise preserve unsigned evidence and retry only after root cause is understood;
- verifier failure: candidate is rejected and must not be installed or handed to Browser Inspect Task 6;
- suspected identity compromise: revoke/suspend through Azure, rotate the signing principal/federation, and rebuild/re-sign from a clean reviewed SHA.## Cost snapshot and lifecycle

As of 2026-09-18, Microsoft lists Basic at USD 9.99/month for up to 5,000 signatures and Premium at USD 99.99/month for up to 100,000, with USD 0.005/signature above quota. Prices remain quote/billing-subscription dependent.

Artifact Signing uses short-lived signing certificates and recommends timestamping every signature so validation survives certificate expiry. Certificate lifecycle remains service-managed.

## Acceptance criteria before provisioning authorization

A later authorization request must include:

- legal owner type and eligible jurisdiction confirmed from current Microsoft docs;
- paid Azure subscription + Entra tenant ownership model;
- exact account region and Public Trust certificate-profile naming;
- exact RBAC scope and principal type for first manual signing;
- proof the expected signer is RSA-compatible with WAG's verifier;
- cost acknowledgement;
- revocation/recovery owner;
- explicit statement that no GitHub/OIDC work is included unless separately authorized.

## Sources reviewed 2026-09-18

- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models
- https://learn.microsoft.com/en-us/azure/artifact-signing/concept-resources-roles
- https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management
- https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations
- https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation
- https://azure.microsoft.com/en-us/products/artifact-signing

**Current state:** design complete; provisioning/signing authority remains closed.