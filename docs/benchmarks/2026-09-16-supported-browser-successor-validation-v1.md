# Supported Browser Successor Validation v1 Acceptance Receipt

Date: 2026-09-16
Gate: `SUPPORTED_BROWSER_SUCCESSOR_VALIDATION_V1 = PASS`
Repository base: `457a275e348b959872cfac5d138454ca2ba9276b`
Branch: `docs/supported-browser-successor-validation-v1`
Registered native-host source: `4dcabd0a33de9b2a0685512fd3ab982e657edb0e`
Native application: `com.openai.web_agent_gateway`
Extension id: `nnhhhppkpogkedpjnijeagcbfjaoogec`

## Goal

Revalidate the currently registered accepted native-host release through the supported ChatGPT browser path after Native Host Release Reacceptance v1, without changing browser authority, Business authority, protocol defaults, installation state, or repository runtime code.

The accepted path was:

`ChatGPT Web -> extension observer/queue -> side panel Run -> Chromium Native Messaging -> installed accepted native host -> WAG Browser Admission`.

No direct MCP, HTTP, or native-host shortcut was used as supported-browser success evidence.

## Preflight and installed identity

Canonical `main` was fresh-read before browser work and remained `457a275e348b959872cfac5d138454ca2ba9276b`, equal to `origin/main`, with only the pre-existing untracked `.playwright-cli/` directory.

The committed read-only installation verifier returned exact registration `MATCH` before browser automation with:

- source SHA `4dcabd0a33de9b2a0685512fd3ab982e657edb0e`;
- executable SHA-256 `62af695a2d8bd219b940c207b4edb7d18f1bc0c3c3cd7f549f35ace407aaf138`;
- manifest SHA-256 `814a1f5f5129c2883e6797d275e2b75ce9b1c13f0db137384f15a4ed451e246c`.

Immediately before browser automation, `E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md` was fresh-read through Remote Desktop Commander. The first Playwright command was exactly `playwright-cli list --all --json`.

The initial global inventory showed two pre-existing workers. Neither was treated as owned by this gate and neither was targeted for attach, close, or cleanup. A brand-new worker `wag-successor-0916-v1-a1` used its own persistent profile/output paths and an `OWNER.json` binding that exact session and profile to this read-only validation.

`COMSPEC` was supplied only to the owned browser-launch process as required by the local browser policy. The committed extension loaded at `chrome-extension://nnhhhppkpogkedpjnijeagcbfjaoogec/sidepanel.html`, proving the runtime extension identity; native connectivity remained lazy/disconnected before the first execution.

## Supported read-only path evidence

A task-owned Git fixture contained `note.txt` with exactly:

```text
alpha
beta
gamma
```

A real completed ChatGPT response produced one valid `health` `wag-tool` request. The extension queued exactly that request and extension-owned `Run` established Native Messaging through the installed successor host. WAG returned `status: "ok"` with executor `devspace`.

A real completed ChatGPT response then produced `workspace.open` for the task-owned fixture. Extension-owned `Run` returned opaque workspace id `ws_c188d6e8-cd23-4a53-89de-feebed097230`.

A subsequent real completed ChatGPT response produced `file.read` for that exact workspace id and `note.txt`. Extension-owned `Run` returned exactly `alpha\nbeta\ngamma`.

The server-side browser inventory was independently revalidated on the exact repository base: focused `browser-admitted-mcp` tests passed `4/4`, proving exactly `health`, `workspace.open`, and `file.read`, all read-only, with broader default tools and model-visible authority controls unavailable.

## Native-host reconnect evidence

Before interruption, process provenance established one native host at the accepted executable path as PID `32172`, parented through the Chromium Native Messaging launcher belonging to the exact owned Playwright browser/profile.

Only that proven-owned native-host PID was terminated. The browser and original ChatGPT tab remained alive, preserving that tab's `chrome.storage.session` correlation. The side panel then reported `Native host disconnected`.

A new real ChatGPT `file.read` request for the same workspace id was queued and executed. Native Messaging launched a fresh accepted host process, PID `15312`, at the same receipt-bound executable path. The side panel returned to `Native host connected` and the same workspace again returned exactly `alpha\nbeta\ngamma`.

This is live evidence that native-host reconnect plus re-admission of the same still-live browser correlation preserves the WAG-owned session needed to access its exact-owned durable workspace.

## Session isolation evidence

A second ChatGPT tab was opened inside the same owned browser worker, causing the extension to allocate a different per-tab browser correlation. That tab produced a real `file.read` request using the first tab's opaque workspace id.

Extension-owned `Run` failed closed with the bounded browser error `LOCAL_WAG_FAILED` / `Local WAG request failed`. No workspace existence, owner/session/adapter identifier, root, bearer, or backend handle was disclosed.

This confirms the live supported-browser path does not transfer workspace authority merely because another tab knows an opaque workspace id.

## Post-run verification and cleanup

After the browser flow, the committed read-only installation verifier again returned the same source SHA, executable SHA-256, manifest SHA-256, and `registration = MATCH`.

Exact-owned cleanup closed only `wag-successor-0916-v1-a1`, stopped its task-owned WAG runtime and pinned DevSpace child, removed its discovery file, profile, output directory, and temporary fixture, and verified all recorded owned PIDs were absent.

A final global Playwright inventory no longer contained the owned worker. It contained only an unrelated pre-existing worker, which was left untouched. One other worker visible during the initial inventory had disappeared independently; no action from this gate targeted it.

Canonical Git state after the live gate still had `HEAD = origin/main = 457a275e348b959872cfac5d138454ca2ba9276b` and only the pre-existing untracked `.playwright-cli/` directory.

## Repository verification for this receipt

The receipt was recorded in an isolated worktree from the exact repository base above. Before the documentation delta, full `npm test` passed `193/193`, with zero failures and zero skips.

After the receipt was written:

- `git diff --check` - PASS;
- runtime/package/source/test/workflow diff check - PASS, no changes;
- `npm run typecheck` - PASS;
- `npm run build` - PASS;
- `npm run test:business` - PASS, `1/1`.

The documentation change does not modify installed bytes, HKCU registration, browser profiles outside the exact owned disposable worker, runtime configuration, package dependencies, protocol defaults, or any model-visible tool surface.

## Decision

`SUPPORTED_BROWSER_SUCCESSOR_VALIDATION_V1 = PASS`

`SUPPORTED_BROWSER_HOST = PASS`

`CURRENT_REGISTERED_NATIVE_HOST_SOURCE_SHA = 4dcabd0a33de9b2a0685512fd3ab982e657edb0e`

`CURRENT_REGISTERED_NATIVE_HOST_EXECUTABLE_SHA256 = 62af695a2d8bd219b940c207b4edb7d18f1bc0c3c3cd7f549f35ace407aaf138`

`BROWSER_ADMITTED_SURFACE = READ_ONLY_THREE_TOOL`

`BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`BUSINESS_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`PROTOCOL_DEFAULT_CHANGE = NONE`

`INSTALLATION_MUTATION = NONE`

`REGISTRY_MUTATION = NONE`

`AUTHORITY_WIDENING = NONE`

`PRODUCTION_CHANGE_REQUIRED = NO`

`NEXT_GATE = NONE_AUTOMATIC`
