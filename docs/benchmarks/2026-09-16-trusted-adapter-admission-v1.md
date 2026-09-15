# Trusted Adapter Admission v1 Final Acceptance Receipt

Date: 2026-09-16
Repository: `ShenJun93/web-agent-gateway`
Canonical main at final host acceptance: `4533047028e73803e6fe5710ec0e34b5e4c10ba4`
Native application: `com.openai.web_agent_gateway`
Extension id: `nnhhhppkpogkedpjnijeagcbfjaoogec`

## Successor distribution identity

Task 9C produced and independently verified the exact `main` push successor distribution from source SHA `9c7fb2881d3641354104f6a20257284d5629ef1c`.

Observed immutable distribution identity:

- workflow run id: `35027172925`;
- run attempt: `1`;
- artifact id: `10420296202`;
- executable SHA-256: `4f0869078357cf8b8ae00e4d27adbef0b905921bdd5202aca38ca10c1b055ebb`;
- native application: `com.openai.web_agent_gateway`;
- extension id: `nnhhhppkpogkedpjnijeagcbfjaoogec`.

The Task 9D metadata follow-up was integrated through PR #13. Its merge commit is `4533047028e73803e6fe5710ec0e34b5e4c10ba4`. The follow-up changed only successor acceptance metadata, the committed read-only verifier pins, tests, and the successor receipt; native-host bundle inputs and SEA packaging inputs remained unchanged.

`CURRENT_CANDIDATE_NATIVE_HOST_DISTRIBUTION = PASS`

## Successor installation reacceptance

The accepted successor artifact was downloaded again, verified without rebuilding, and prepared into the deterministic per-user source-SHA directory:

`%LOCALAPPDATA%\WebAgentGateway\native-host\9c7fb2881d3641354104f6a20257284d5629ef1c\`

Prepared installation identity:

- executable SHA-256: `4f0869078357cf8b8ae00e4d27adbef0b905921bdd5202aca38ca10c1b055ebb`;
- manifest SHA-256: `0a1f4b5ed3095cf88ff8cf99d6de8e55d05778bbef07ce80fb7c4b0127fc8dd4`;
- workflow run id: `35027172925`;
- run attempt: `1`.

Before registration switch, the existing HKCU value was read-only verified as the previously accepted historical installation and its historical verifier returned `registration = MATCH`. The successor verifier correctly classified that predecessor registration as `DRIFT` because the successor expected a different source-SHA manifest path.

After explicit operational authorization, the exact 64-bit per-user Chromium Native Messaging default value for `com.openai.web_agent_gateway` was switched from the historical manifest path to the prepared successor manifest path. No Chrome/Edge policy, HKLM, WOW6432Node, browser profile, or machine-wide registration was changed.

The committed successor installation verifier immediately returned:

`{"sourceSha":"9c7fb2881d3641354104f6a20257284d5629ef1c","executableSha256":"4f0869078357cf8b8ae00e4d27adbef0b905921bdd5202aca38ca10c1b055ebb","manifestSha256":"0a1f4b5ed3095cf88ff8cf99d6de8e55d05778bbef07ce80fb7c4b0127fc8dd4","registration":"MATCH"}`

`NATIVE_HOST_INSTALLATION = PASS`

## Supported-browser-host reacceptance

Immediately before browser automation, the canonical `E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md` policy was fresh-read. The required first Playwright command was exactly `playwright-cli list --all --json`; the global inventory was parseable and allowed allocation/recovery of only the owned worker `wag-task9d-0916-a11` with persistent profile `E:\AI-BROWSER\profiles\wag-task9d-0916-a11`.

Playwright-bundled Chromium loaded only the committed WAG extension from canonical `main`. The runtime extension page loaded at `chrome-extension://nnhhhppkpogkedpjnijeagcbfjaoogec/sidepanel.html`, proving the runtime extension id matched the committed identity. `COMSPEC` was supplied only to the owned browser launch process; no persistent/global environment mutation was made.

A disposable pinned DevSpace plus admitted WAG browser runtime served a task-owned Git fixture whose `note.txt` contained `alpha`, `beta`, `gamma`. The installed successor native host consumed the canonical `%LOCALAPPDATA%\WebAgentGateway\browser-adapter.json` discovery path.

A real ChatGPT completed assistant turn produced a valid `workspace.open` `wag-tool` block. The committed content observer queued exactly that call, the extension-owned side panel executed it, Chromium Native Messaging launched the installed successor host, admission succeeded, and WAG returned opaque workspace id `ws_cb11f749-d06c-427b-8a80-81e672cc7972`.

A second real ChatGPT completed turn produced `file.read` for that exact workspace id and `note.txt`. Extension-owned `Run` returned exactly:

`alpha\nbeta\ngamma`

No direct MCP, HTTP, or native-host shortcut was used as supported-host evidence.

## Native-host reconnect evidence

The exact running successor host was observed at the accepted source-SHA installation path with PID `9756`. Only that exact host process was stopped while the owned Chromium browser/tab remained alive, preserving the live browser correlation in `chrome.storage.session`. The side panel then reported `Native host disconnected`.

A third real ChatGPT completed turn produced the same `file.read` request for the same opaque workspace id. Extension-owned `Run` created a new Native Messaging host process, observed as PID `21956` at the same accepted successor executable path, changed the side panel back to `Native host connected`, and again returned exactly `alpha\nbeta\ngamma`.

This proves native-host reconnect plus re-admission of the same still-live browser correlation retained the same WAG-owned session and exact-owned durable workspace authority.

## Post-run installation verification and cleanup

After the complete supported-host flow, the committed read-only installation verifier again returned the same successor source SHA, executable SHA-256, manifest SHA-256, and `registration = MATCH`.

Exact-owned cleanup then:

- closed only Playwright worker `wag-task9d-0916-a11`;
- stopped the task-owned WAG runtime and pinned DevSpace child;
- removed the canonical task discovery file created by that runtime;
- confirmed the admission listener and successor native-host process were gone;
- removed only `E:\AI-BROWSER\profiles\wag-task9d-0916-a11` and `E:\AI-BROWSER\output\wag-task9d-0916-a11`;
- left an unrelated observed Playwright worker untouched.

The successor installation directory and accepted HKCU registration remain installed; supported-host cleanup did not uninstall or roll back accepted installation state.

`SUPPORTED_BROWSER_HOST = PASS`

## Final gate result

`CURRENT_CANDIDATE_NATIVE_HOST_DISTRIBUTION = PASS`

`NATIVE_HOST_INSTALLATION = PASS`

`SUPPORTED_BROWSER_HOST = PASS`

`TRUSTED_ADAPTER_ADMISSION_V1 = PASS`

`BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

This final gate authorizes no mutation projection, durable verify projection, public jobs, process/PTY capability, Git writes, browser mutation, SDK migration, or broader model-visible authority. Browser Adapter v1 remains server-side limited to exactly `health`, `workspace.open`, and `file.read`.