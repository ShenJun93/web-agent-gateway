# Native Host Installation v1 Research — 2026-09-14

Status: advisory research receipt for design promotion
Scope: Windows per-user WAG native-host installation, Playwright ownership preflight, and supported-host gate separation

## Trigger

`NATIVE_HOST_DISTRIBUTION = PASS`, but repeated Task 10 attempts remained fail-closed before supported-host evidence. Fresh investigation found that the remaining problem is operational composition, not the native-host artifact or browser-adapter protocol.

The research question is whether installation should become a separate gate before supported-host acceptance, while preserving all existing authority boundaries.

## Canonical project facts

- ADR-0013 already requires separate authorization before Windows native-host registration.
- ADR-0014 keeps Browser Adapter v1 read-only and forbids authority widening on adapter failure.
- The accepted distribution artifact source SHA is `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d`.
- The accepted executable SHA-256 is `0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf`.
- Native application name: `com.openai.web_agent_gateway`.
- Stable extension id: `nnhhhppkpogkedpjnijeagcbfjaoogec`.
- Current browser adapter remote-safe tools remain `health`, `workspace.open`, and `file.read`.

## Playwright session-preflight findings

Current Playwright CLI documentation distinguishes workspace-scoped and global inventory:

- `playwright-cli list` lists sessions in the current workspace;
- `playwright-cli list --all` lists sessions across all workspaces and also includes attachable browser/channel state;
- `--json` provides structured output suitable for deterministic ownership checks.

Source: https://playwright.dev/agent-cli/sessions

Local installed `@playwright/cli 0.1.19` source matches that behavior. Its registry loader reads `%LOCALAPPDATA%\ms-playwright\daemon\<workspace-hash>\*.session`, probes each session socket with `canConnect()`, and removes only the stale `.session` descriptor when the daemon cannot be reached. The list operation does not delete the configured `userDataDir` or browser profile.

Therefore the local browser policy's current `playwright-cli list` preflight is insufficient for cross-workspace ownership. The corrected preflight should be `playwright-cli list --all --json`, with the stale-descriptor side effect documented explicitly rather than described as a pure read.

A missing session in this inventory still does not authorize profile reuse or deletion. Profile ownership must also require a unique new session name and a brand-new profile path, or exact prior ownership evidence for cleanup.

## Extension-host findings

Current Playwright extension guidance says unpacked extensions require a Chromium persistent context. Chrome and Edge branded builds no longer support the command-line side-load flags Playwright needs, so the documented automation path uses Playwright-bundled Chromium with `channel: "chromium"`, `--disable-extensions-except`, and `--load-extension`.

Source: https://playwright.dev/docs/next/chrome-extensions

Local CLI source also accepts this configuration: `browserName` defaults to `chromium`, an explicitly supplied `browser.launchOptions.channel` is preserved, and `browser.launchOptions.args` is part of the validated configuration surface.

This means supported-host acceptance can remain inside the canonical Playwright CLI path without attaching to the user's normal Chrome or Edge profile.

## Windows Native Messaging findings

Current Chromium Windows source checks `SOFTWARE\Chromium\NativeMessagingHosts` for Chromium-branded builds before falling back to the Chrome registry location. It checks user-level registration before machine-level registration and requires the registry value to be an absolute manifest path.

Source: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context_win.cc

Microsoft Edge documentation independently confirms Chromium and Chrome registry locations are fallback locations after Edge's own key. No Edge-specific registration is required for the intended Playwright-bundled Chromium acceptance path.

Source: https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging

## Local safety-layer findings

Desktop Commander currently does not block `playwright-cli`, and recent local history contains successful Playwright CLI session-list and browser commands. The intermittent `playwright-cli list` denial therefore occurs outside Desktop Commander's command blocklist and must remain a fail-closed browser-control boundary.

Desktop Commander does explicitly block the `reg` command. This research does not treat PowerShell/.NET registry mutation, a helper executable, or another shell mechanism as an acceptable way to route around that block.

Actual HKCU mutation must therefore remain an explicit operational checkpoint performed through a sanctioned human action or a future structured registry capability whose authority is reviewed separately.

## Recommended gate decomposition

Use four sequential gates:

`NATIVE_HOST_DISTRIBUTION -> NATIVE_HOST_INSTALLATION -> SUPPORTED_BROWSER_HOST -> BROWSER_MUTATION_ENABLEMENT`

`NATIVE_HOST_INSTALLATION` consumes only the exact verified distribution artifact, prepares a deterministic per-user installation, and records its identity. It does not launch ChatGPT, create a browser profile, execute WAG tools, or expose mutation.

`SUPPORTED_BROWSER_HOST` then becomes a read-only transport acceptance against already-installed native-host state. It does not write registry state.

`BROWSER_MUTATION_ENABLEMENT` remains closed until the read-only supported-host gate passes and a later separately reviewed milestone exposes only the durable `mutation.preview` / `mutation.result` contract.

## Research conclusion

Proceed with a dedicated Native Host Installation v1 design. No new ADR is required because the decomposition makes ADR-0013's existing installation boundary explicit and leaves ADR-0014's control-plane contracts unchanged.
