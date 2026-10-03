# WAG Private Beta — Windows Tester Guide

This private beta is for the current full Web Agent Gateway product, not the historical 5-tool native-host preview.

## Safety boundary

This bundle is **unsigned private-beta software**. It is not Authenticode-trusted.

Do not disable Microsoft Defender, SmartScreen, Smart App Control, enterprise policy, or other machine security controls to make WAG run. If policy blocks the beta, stop and report the block as a beta result.

The bundle never contains the maintainer's tunnel credentials, API keys, or tunnel-client binary. Use only the tunnel/client credentials associated with your own ChatGPT connector setup.

Beta receipts are optional. WAG must receive explicit `consent=true` before creating one. No receipt is uploaded automatically.

## Supported tester machine

Use a clean Windows x64 user/install state with:

- Windows 10 or 11 x64;
- PowerShell 7+ (`pwsh`);
- Node.js >= 22.19 and < 27, including `npm`;
- WSL working from `wsl.exe`;
- Microsoft Edge;
- the OpenAI tunnel-client already available in WSL from your own connector environment;
- your own tunnel id (`tunnel_<32 lowercase letters/digits>`).

The clean-install acceptance baseline requires no existing WAG Local install, WAG startup shortcut, WAG tunnel profile, or process already occupying WAG's managed ports.

## 1. Verify the bundle before extracting

The beta operator gives you the expected SHA-256 for the ZIP through the same private channel used to invite you.

From PowerShell:

```powershell
(Get-FileHash .\web-agent-gateway-private-beta-*.zip -Algorithm SHA256).Hash.ToLowerInvariant()
```

Continue only if it exactly matches the operator-provided value.

Extract the ZIP to a normal user-writable directory. Do not run it from inside the ZIP viewer.

The extracted root must contain:

- `PRIVATE_BETA_BUNDLE.json`
- `INSTALL-WAG-BETA.ps1`
- `package\*.tgz`
- `browser-extension\`
- this guide.

## 2. Install and start the clean-install run

Resolve your tunnel-client path inside WSL first. A common connector-managed location is similar to:

```text
/home/<you>/tools/openai-tunnel-client/<version>/tunnel-client
```

Run the beta installer from PowerShell 7:

```powershell
pwsh -NoLogo -NoProfile -File .\INSTALL-WAG-BETA.ps1 \
  -TunnelId "tunnel_<your-own-id>" \
  -TunnelClientPath "/home/<you>/tools/openai-tunnel-client/<version>/tunnel-client"
```

Optional: add `-AllowedRoot "C:\path\to\a\dedicated\WAG-Workspace"`.

The installer:

1. verifies the tarball and every bundled browser-extension file;
2. installs the exact beta package into a per-user bootstrap directory;
3. runs the M15 clean-install **Baseline** stage;
4. runs the **Install** stage;
5. copies the exact-source browser extension into `%LOCALAPPDATA%\WAG-Local\browser-extension-v2`;
6. binds the installed runtime marker to the same extension source SHA and extension SHA.

If the runtime API key is not already configured, WAG prompts for it as a secure value and stores it with Windows DPAPI. Do not paste that key into chat, email, screenshots, issue trackers, or beta receipts.

The expected first-install state is usually:

```text
ACTION_REQUIRED_CHATGPT_CONNECTOR
```

That is not an install failure.

## 3. Load the WAG Edge extension

Open:

```text
edge://extensions/
```

Enable Developer mode, choose **Load unpacked**, and select:

```text
%LOCALAPPDATA%\WAG-Local\browser-extension-v2
```

Do this only for the extension folder installed by the verified beta bundle.

## 4. Complete the connector proof

Open:

```text
%LOCALAPPDATA%\WAG-Acceptance\clean-install-install.json
```

Read `connectorChallenge.prompt`. Give that exact prompt to ChatGPT in the connector session you are testing. The prompt instructs ChatGPT to use WAG to read a challenge file and create the matching response inside the configured workspace.

After ChatGPT completes the challenge, from the extracted beta directory run:

```powershell
$bundle = Get-Content .\PRIVATE_BETA_BUNDLE.json -Raw | ConvertFrom-Json
$cli = Join-Path $env:LOCALAPPDATA ("WAG-Private-Beta\" + $bundle.releaseId + "\app\node_modules\web-agent-gateway\dist\cli.js")
node.exe $cli clean-install-acceptance --stage connector-proof
```

The stage must report `PASS`.

## 5. Reboot acceptance

Reboot Windows once.

Then run:

```powershell
$bundle = Get-Content .\PRIVATE_BETA_BUNDLE.json -Raw | ConvertFrom-Json
$cli = Join-Path $env:LOCALAPPDATA ("WAG-Private-Beta\" + $bundle.releaseId + "\app\node_modules\web-agent-gateway\dist\cli.js")
node.exe $cli clean-install-acceptance --stage post-reboot
```

Open `%LOCALAPPDATA%\WAG-Acceptance\clean-install-postreboot.json` and complete its connector challenge through ChatGPT exactly as in step 4.

Then run:

```powershell
node.exe $cli clean-install-acceptance --stage post-reboot-proof
```

The final clean-install stage must report `PASS`.

## 6. Do one real useful workflow

Use WAG for a task you would actually want automated. Examples:

- inspect/edit files inside your allowed workspace;
- use an AI-owned Edge tab without losing your active user tab;
- upload/download a file through the semantic browser tools;
- inspect a media file before publishing it.

Do not create artificial calls just to inflate metrics.

## 7. Optional private beta receipt

Creating a beta receipt is optional and requires explicit consent.

If you choose to participate, tell ChatGPT explicitly that you consent to creating a private-beta receipt and ask it to call `product.beta.receipt` with `consent=true`.

The receipt is local/offline. It is not uploaded automatically. Send the receipt file to the beta operator only through the private channel agreed for this beta.

Do not post a receipt publicly.

## 8. What to report

Report:

- whether baseline/install/connector/post-reboot stages passed;
- whether a useful workflow completed;
- any blocker and the step where it occurred;
- whether you voluntarily created a beta receipt.

Never send API keys, connector runtime keys, tunnel credentials, raw private files, or screenshots containing secrets.

## Uninstall

Use the installed WAG CLI:

```powershell
$bundle = Get-Content .\PRIVATE_BETA_BUNDLE.json -Raw | ConvertFrom-Json
$cli = Join-Path $env:LOCALAPPDATA ("WAG-Private-Beta\" + $bundle.releaseId + "\app\node_modules\web-agent-gateway\dist\cli.js")
node.exe $cli uninstall
```

The bootstrap package under `%LOCALAPPDATA%\WAG-Private-Beta\<release-id>` can be deleted after WAG uninstall completes.

If uninstall is blocked by machine policy or fails, report that as beta evidence rather than manually deleting WAG state.
