# Native Host Installation v1 Gate Receipt

Date: 2026-09-14
Gate: `NATIVE_HOST_INSTALLATION = PASS`
Repository: `ShenJun93/web-agent-gateway`
Accepted source SHA: `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d`
Workflow run id: `34757274244`
Run attempt: `1`
Artifact: `wag-native-host-windows-x64-fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d-attempt-1`

## Accepted distribution identity

The installation consumed the already accepted Windows x64 distribution artifact from workflow run `34757274244`, attempt `1`. The artifact was re-downloaded and re-verified before preparation; no local rebuild was accepted as provenance.

Distribution verification returned:

`{"status":"verified","sourceSha":"fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d","sha256":"0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf"}`

Executable SHA-256: `0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf`.

## Prepared installation

Preparation created only the source-SHA-scoped installation directory:

`%LOCALAPPDATA%\WebAgentGateway\native-host\fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d\`

Owned files:

- `wag-native-host.exe`
- `com.openai.web_agent_gateway.json`
- `install-receipt.json`
- `register-native-host.reg`

The local receipt records schema version `1`, native application `com.openai.web_agent_gateway`, extension id `nnhhhppkpogkedpjnijeagcbfjaoogec`, workflow run `34757274244` attempt `1`, and preparation time `2026-09-14T05:22:43.000Z`.

Manifest SHA-256: `706a38b97b51102f886dcbb94de76e62bb7243d664dca65deaae3c8bcd5aa3ca`.

## Registration verification

The receipt binds one exact per-user 64-bit Chromium Native Messaging registration:

- hive: `HKCU`
- view: `64-bit`
- subkey: `SOFTWARE\Chromium\NativeMessagingHosts\com.openai.web_agent_gateway`
- default value: the installed manifest under the source-SHA directory above

Immediately after preparation, the committed read-only verifier returned `registration: "ABSENT"`, so the gate remained `PREPARED_AWAITING_REGISTRATION` and repository automation stopped at the external registration checkpoint.

After the separately performed registration action, the same committed read-only verifier returned:

`{"sourceSha":"fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d","executableSha256":"0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf","manifestSha256":"706a38b97b51102f886dcbb94de76e62bb7243d664dca65deaae3c8bcd5aa3ca","registration":"MATCH"}`

This verification is read-only and re-checks the exact receipt path, directory/file ownership constraints, executable hash, manifest hash and manifest identity before emitting state.

## Repository verification

Fresh repository evidence before operational acceptance:

- installation focused tests: `23/23` passed;
- distribution/manifest regression tests: `11/11` passed;
- full repository suite: `152/152` passed, `0` failed, `0` skipped;
- `npm run typecheck`: passed;
- `npm run build`: passed;
- Business stdio acceptance: `1/1` passed;
- `git diff --check`: clean.

Generated distribution evidence, local installation state, registry state, browser profiles and credentials are not committed to Git.

## Gate result and authority boundary

`NATIVE_HOST_INSTALLATION = PASS`

This PASS proves the exact accepted native-host distribution was prepared into the owned per-user source-SHA directory, the exact expected per-user Chromium registration is present, and the committed read-only verifier revalidated registration plus executable/manifest hashes and identity.

`SUPPORTED_BROWSER_HOST` remains a separate downstream gate. Browser acceptance must consume this installed state without changing registration or native-host installation and must re-run the read-only installation verifier after the browser flow. `BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED` remains unchanged.
