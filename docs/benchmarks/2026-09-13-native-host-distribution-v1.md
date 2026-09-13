# Native Host Distribution v1 Gate Receipt

Date: 2026-09-13
Gate: `NATIVE_HOST_DISTRIBUTION = PASS`
Merged main commit: `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d`
Implementation PR: `#7` (`feat: add native host distribution v1`)
Workflow: `Native Host Distribution`
Workflow run id: `34757274244`
Run attempt: `1`
Job id: `103723709276`

## Main-run acceptance

The accepted artifact was produced by the `push` workflow on `main` for the exact merged commit above. The single `distribution` job completed successfully on `windows-2025` and every distribution step passed: checkout, Node setup, dependency install, typecheck, TypeScript build, focused distribution tests, one native-host build, exact publish-candidate artifact test, packaging, verifier, and upload.

The runner receipt records:

- OS/architecture: `Windows` / `X64`
- hosted image OS: `win25-vs2026`
- hosted image version: `20260907.229.1`
- Node: `24.20.0`
- package-lock SHA-256: `f976a6f3b36ffc7c0500446266705902b64417c646be7a830133dabb2ffca663`

## Artifact identity

The workflow exposed exactly one non-expired artifact for this run:

- artifact id: `10318026404`
- name: `wag-native-host-windows-x64-fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d-attempt-1`
- workflow artifact digest: `sha256:fcdef7ba1a12621e380845e40779cd6d53c28ecb9be907d353b943ae125db8f1`
- size: `36049958` bytes

The downloaded artifact payload contained exactly:

- `wag-native-host.exe`
- `wag-native-host.exe.sha256`
- `build-receipt.json`

No additional executable, manifest, browser profile, credential, token, installer, or machine-specific registration state was present.

## Local consumer verification

The exact run artifact was downloaded with GitHub CLI into a disposable task-owned evidence directory and verified without rebuilding the executable.

Verifier invocation bound the artifact to repository `ShenJun93/web-agent-gateway` and merged source SHA `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d`.

Verifier result:

`{"status":"verified","sourceSha":"fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d","sha256":"0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf"}`

The strict receipt independently records the same executable SHA-256, source SHA, run id/attempt, Node version, lockfile hash, native application name `com.openai.web_agent_gateway`, and stable extension id `nnhhhppkpogkedpjnijeagcbfjaoogec`.

## Supply-chain pins

The accepted workflow used the reviewed immutable action commits:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (`v7.0.1`)
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (`v7.0.0`)
- `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (`v7.0.1`)

## Gate result and authority boundary

`NATIVE_HOST_DISTRIBUTION = PASS`

This PASS proves that a reviewed merged-main source commit produced a uniquely identified Windows native-host artifact and that the downloaded artifact passed the repository's local consumer verifier without a local rebuild.

It does not authorize or claim browser installation, extension activation, Native Messaging registration, HKCU mutation, enterprise policy changes, browser mutation, terminal/Git authority widening, or supported-host execution.

Current separate gate state remains:

`SUPPORTED_BROWSER_HOST = BLOCKED_FAIL_CLOSED`

`BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

Task 10 supported-browser/HKCU acceptance remains a separate authorization and must start from this verified artifact rather than rebuilding the native host inside the installation attempt.
