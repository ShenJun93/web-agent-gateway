# Native Host Distribution Successor Reacceptance Receipt

Date: 2026-09-16
Gate: `CURRENT_CANDIDATE_NATIVE_HOST_DISTRIBUTION = PASS`
Repository: `ShenJun93/web-agent-gateway`
Source: merged `main` commit `9c7fb2881d3641354104f6a20257284d5629ef1c`
Workflow: `Native Host Distribution`
Workflow run id: `35027172925`
Run attempt: `1`
Job id: `104576856406`

## Main-push provenance

The successor artifact was produced only by the successful `push` workflow on `main` for the exact source SHA above. The `distribution` job completed successfully, including typecheck, TypeScript build, focused distribution tests, one publish-candidate build, exact publish-candidate testing, packaging, distribution verification, and artifact upload.

Artifact identity observed from GitHub Actions:

- artifact id: `10420296202`;
- name: `wag-native-host-windows-x64-9c7fb2881d3641354104f6a20257284d5629ef1c-attempt-1`;
- workflow artifact digest: `sha256:3148d3416acfb168fa38c7fdd75d34aee0836c52232a1431f26c8d960518f0fe`;
- size: `36049502` bytes;
- created: `2026-09-15T21:44:33Z`;
- expiry: `2026-09-29T21:44:28Z`.

The artifact remained non-expired when this receipt was prepared.
## Downloaded artifact verification

The exact immutable artifact above was downloaded into a disposable task-owned directory and verified with the committed distribution verifier without rebuilding the executable.

Verifier result:

`{"status":"verified","sourceSha":"9c7fb2881d3641354104f6a20257284d5629ef1c","sha256":"4f0869078357cf8b8ae00e4d27adbef0b905921bdd5202aca38ca10c1b055ebb"}`

The downloaded executable independently hashed to the same SHA-256. Its strict `build-receipt.json` records workflow run `35027172925`, attempt `1`, native application `com.openai.web_agent_gateway`, extension id `nnhhhppkpogkedpjnijeagcbfjaoogec`, Node `24.20.0`, and package-lock SHA-256 `f976a6f3b36ffc7c0500446266705902b64417c646be7a830133dabb2ffca663`.

## Successor acceptance metadata

The Task 9D follow-up pins only this observed source SHA, workflow run id/attempt, and executable SHA-256 into the installation acceptance constants and committed read-only verifier. It does not change native-host bundle inputs, SEA packaging, workflow packaging logic, extension identity, application identity, or artifact bytes.

Historical distribution and installation receipts for source `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d` remain historical evidence for that exact artifact and are not rewritten.

`CURRENT_CANDIDATE_NATIVE_HOST_DISTRIBUTION = PASS`

`TRUSTED_ADAPTER_ADMISSION_V1 = IMPLEMENTED_AWAITING_NATIVE_HOST_REFRESH`

This receipt does not claim successor installation acceptance or final Trusted Adapter Admission acceptance. Preparing the successor per-user installation is repository-supported, but switching the HKCU Native Messaging registration remains a separately authorized operational checkpoint. Read-only installation verification and supported-browser-host reacceptance must both pass against the successor installed binary before final `TRUSTED_ADAPTER_ADMISSION_V1 = PASS`.

Browser mutation, terminal/Git authority widening, SDK migration, and broader capability enablement remain unauthorized by this receipt.
