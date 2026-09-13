# Native Host Installation v1 — Design

Date: 2026-09-14
Status: Proposed for written review
Decision authority: ADR-0013, ADR-0014
Depends on: `NATIVE_HOST_DISTRIBUTION = PASS`
Research basis: `docs/research/2026-09-14-native-host-installation.md`

## Goal

Separate Windows native-host installation from supported-browser acceptance so each gate has one authority boundary and one failure domain.

The intended sequence becomes:

`NATIVE_HOST_DISTRIBUTION -> NATIVE_HOST_INSTALLATION -> SUPPORTED_BROWSER_HOST -> BROWSER_MUTATION_ENABLEMENT`

Installation consumes one already-verified native-host artifact, places deterministic per-user files, prepares one exact Chromium Native Messaging registration, and records enough identity for safe verification and cleanup.

Supported-host acceptance then exercises only already-installed state. It no longer writes HKCU as part of the browser test.

## Authority boundary

This design does not itself authorize live registry mutation. Preparing installation files, tests, and dry-run evidence is implementation work; changing HKCU remains a separate explicit operational action.

A live registration may occur only through a sanctioned human action or a separately reviewed structured registry capability. Shell, PowerShell/.NET, helper executables, or other mechanisms MUST NOT be introduced merely to route around a local command-safety block.

The milestone does not authorize browser mutation, terminal/Git widening, administrator elevation, browser enterprise policy, or changes to default/Business WAG surfaces.

## Accepted artifact input

V1 installation accepts only the artifact already recorded by the distribution gate unless a later reviewed distribution receipt supersedes it:

- source SHA: `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d`;
- executable SHA-256: `0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf`;
- artifact name: `wag-native-host-windows-x64-fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d-attempt-1`;
- native application: `com.openai.web_agent_gateway`;
- extension id: `nnhhhppkpogkedpjnijeagcbfjaoogec`.

Before preparing installation state, the existing distribution verifier MUST re-check repository identity, source SHA, build receipt, payload shape, executable checksum, application name, and extension id. No local rebuild may substitute for a failed verification.

## Per-user installation layout

V1 targets Windows x64 and uses a versioned per-user root outside repositories:

`%LOCALAPPDATA%\WebAgentGateway\native-host\<source-sha>\`

The directory contains only:

- `wag-native-host.exe`;
- `com.openai.web_agent_gateway.json`;
- `install-receipt.json`;
- an optional human-importable registration artifact generated from the exact manifest path.

The executable is copied from the verified distribution artifact and hashed again after placement. The source artifact archive is not treated as the installed executable location.

Side-by-side source-SHA directories are allowed so an upgrade does not overwrite an older verified payload before registration is deliberately changed.

## Manifest and registration contract

The machine-specific manifest is generated with the existing `createNativeHostManifest` contract. It MUST contain:

- `name = com.openai.web_agent_gateway`;
- `path` equal to the absolute installed `wag-native-host.exe` path;
- `type = stdio`;
- exactly one `allowed_origins` entry: `chrome-extension://nnhhhppkpogkedpjnijeagcbfjaoogec/`.

Wildcards, multiple extension origins, repository-relative paths, and temporary artifact paths are rejected.

The only v1 registry target is the 64-bit per-user Windows view of:

`HKCU\SOFTWARE\Chromium\NativeMessagingHosts\com.openai.web_agent_gateway`

Its default string value is the absolute installed manifest path. V1 MUST NOT also write Edge, Chrome, HKLM, browser-policy, or WOW6432Node registrations.

The registration artifact, if generated for human import, is data only. Repository tooling MUST NOT automatically import it as part of build, test, preparation, or supported-host acceptance.

## Installation receipt

`install-receipt.json` is non-secret local metadata. It binds the prepared installation to:

- schema version;
- repository and distribution source SHA;
- workflow run id and run attempt from the accepted build receipt;
- executable SHA-256;
- native application name and extension id;
- installed executable and manifest paths;
- manifest SHA-256;
- registry hive, view, subkey, and expected default value;
- preparation timestamp.

The receipt does not contain browser credentials, WAG bearer tokens, operator-review credentials, repository contents, or mutable authority flags.

Preparation is idempotent only when every existing owned file matches the receipt and expected hashes. A mismatched executable, manifest, receipt, or unexpected extra executable fails closed instead of being overwritten silently.

## Registration and verification checkpoint

After preparation, the gate status is `NATIVE_HOST_INSTALLATION = PREPARED_AWAITING_REGISTRATION` until a separately authorized operational action creates the exact expected HKCU value.

Before registration, the exact key MUST be observed as absent or already equal to the expected manifest path. A different existing value is configuration drift and MUST NOT be overwritten by the v1 flow; the gate stops for explicit reconciliation.

Registration verification is read-only. The repository verifier uses a committed PowerShell check limited to `Get-ItemPropertyValue` against the exact HKCU key plus ordinary manifest/executable file and hash reads. It contains no registry-write cmdlets. If the host safety layer blocks that read-only verifier, the gate remains `AWAITING_REGISTRATION_VERIFICATION`; browser success MUST NOT be used retroactively to claim that the installation gate had already passed.

After registry observation, the verifier MUST also re-read the manifest and installed executable and require their hashes and identities to match the receipt. Only then may the gate record `NATIVE_HOST_INSTALLATION = PASS`.

The verification path itself MUST NOT start ChatGPT, invoke a WAG tool, or require the browser adapter. Those belong to the next gate.

## Cleanup and uninstall ownership

Cleanup is exact-installation scoped. An uninstall may remove the registry key only when its current default value exactly equals the manifest path in the matching installation receipt.

If the registry value points elsewhere, uninstall fails closed and leaves both registry state and installation files untouched for manual reconciliation.

If the key is absent, owned files may be removed only after their current paths and hashes still match the receipt. If the key points to the owned manifest, removal order is registry value/key first, then the receipt-owned source-SHA directory.

No cleanup operation may scan for or remove other native-host registrations, browser profiles, WAG runtimes, or source-SHA installation directories.

## Playwright ownership-policy correction

Before the next supported-host attempt, the canonical browser operating policy must change its mandatory inventory command from workspace-scoped `playwright-cli list` to:

`playwright-cli list --all --json`

The policy must state that current Playwright CLI probes session sockets and may delete an unreachable stale `.session` descriptor while listing. This limited CLI registry cleanup is not browser-profile cleanup and does not authorize deletion or reuse of any `userDataDir`.

A new acceptance worker still requires a unique session name and a brand-new profile path. Existing workers from any workspace are left untouched. If the global inventory command is blocked by a browser-control safety boundary, supported-host acceptance stops fail-closed.

The policy correction is operational documentation, not a new WAG browser capability. It must be reviewed before Task 10 resumes.

## Relationship to supported-host acceptance

`SUPPORTED_BROWSER_HOST` may start only after `NATIVE_HOST_INSTALLATION = PASS`.

Task 10 then performs no registry write. It uses Playwright-bundled Chromium with a persistent owned profile, loads only the committed WAG extension, verifies the runtime extension id, and exercises the real path:

`ChatGPT Web -> provider adapter -> MV3 service worker -> Native Messaging -> installed wag-native-host.exe -> WAG`

Acceptance still requires `workspace.open`, `file.read`, adapter reconnect, and reading the same durable workspace again. Direct MCP/HTTP/native shortcuts and Playwright-only local calls remain invalid substitutes.

The exact installed executable and manifest must remain unchanged throughout the supported-host run. Installation drift invalidates the run.

## Relationship to browser mutation

This milestone does not change `BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED`.

Only after read-only supported-host acceptance passes may a separate reviewed milestone project `mutation.preview` and `mutation.result` through the browser adapter. Local operator review and execution remain exclusively inside the durable WAG control plane; the extension, native host, provider page, and Playwright never gain approval or direct-apply authority.

## Verification strategy

Implementation tests must cover at least:

- strict acceptance of the recorded distribution receipt and executable hash;
- deterministic source-SHA installation layout;
- post-copy executable hash verification;
- exact manifest identity and single allowed origin;
- exact Chromium HKCU registration descriptor generation without applying it;
- receipt schema and path/hash binding;
- idempotent preparation when all owned bytes match;
- fail-closed preparation on drift or unexpected executable payloads;
- ownership-safe uninstall decisions for exact match, absent key, and mismatched key;
- no Chrome, Edge, HKLM, policy, browser-profile, or WAG-tool mutation during preparation/tests.

Live operational acceptance additionally requires the separately authorized registration plus sanctioned read-only verification of the exact key/value and installed hashes.

## Acceptance gate

`NATIVE_HOST_INSTALLATION = PASS` requires all of the following:

1. the accepted distribution artifact is re-verified without rebuilding;
2. installation files exist only under the expected per-user source-SHA directory;
3. executable and manifest hashes match the local receipt;
4. the exact per-user Chromium Native Messaging key points to the receipt-owned manifest;
5. no broader browser or machine registration was created;
6. no browser session or WAG tool call is required to establish the installation result.

If the registry mutation is authorized but cannot be verified through a sanctioned read-only path, the gate remains `NATIVE_HOST_INSTALLATION = AWAITING_REGISTRATION_VERIFICATION` rather than inferring success.

## Non-goals

V1 does not add an auto-updater, service, scheduled task, PATH entry, Start Menu integration, administrator installer, browser store publication, enterprise policy, Chrome/Edge registration, machine-wide registration, code signing, or generic Windows configuration authority.

It does not change native-host protocol framing, `LocalAdapterLink`, extension identity, provider parsing, WAG durable ids, filesystem policy, mutation lifecycle, or host-visible tool allowlists.

It does not make the browser adapter a machine-configuration executor. Registry installation remains an explicit operational action outside Web AI/model authority.

## Implementation boundary

Expected repository implementation after this design is approved is limited to:

- a small installation preparation/verification module or script that reuses the existing distribution verifier and manifest generator;
- tests for deterministic layout, receipt binding, registration descriptor generation, drift handling, and uninstall ownership decisions;
- a local installation receipt schema;
- benchmark/gate documentation after live operational acceptance;
- updates to the browser-adapter implementation plan so Task 10 depends on installation PASS instead of performing installation itself.

The external `E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md` policy correction is a separate reviewed operational-document edit performed before the next browser attempt. It is not modified merely by accepting this design document.

No implementation or test may write HKCU automatically. Live HKCU state changes remain outside repository-test authority.

## Consequence

WAG gains a stable boundary between artifact provenance, machine installation, browser transport acceptance, and later mutation projection. A failure in any gate remains local to that gate and cannot be converted into broader fallback authority.
