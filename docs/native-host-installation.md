# Windows native-host installation and removal

## Status

The native host is currently a development/pre-release component. Do not treat historical GitHub Actions artifacts as supported releases.

A future official release will identify the exact supported native-host artifact and signature state.

## System change

Installing the Windows native host prepares files under:

`%LOCALAPPDATA%\WebAgentGateway\native-host\<source-sha>\`

and registers one per-user Chromium Native Messaging host at:

`HKCU\SOFTWARE\Chromium\NativeMessagingHosts\com.openai.web_agent_gateway`

The registry default value points to the prepared manifest for that exact source SHA.

WAG does not require administrator elevation for this per-user registration.

## Preparation

Repository tooling first verifies the accepted distribution and then prepares the per-user files:

```powershell
npx tsx scripts/prepare-native-host-installation.ts `
  --distribution C:\path\to\verified-distribution `
  --local-app-data $env:LOCALAPPDATA `
  --repository ShenJun93/web-agent-gateway
```

Preparation does not silently overwrite drifted installation state.

It produces `register-native-host.reg` for explicit human review/import. Repository build and test tooling do not automatically write the registry key.

## Verification

After explicit registration, verify the exact receipt and current files:

```powershell
powershell -NoProfile -File scripts/verify-native-host-installation.ps1 `
  -ReceiptPath "$env:LOCALAPPDATA\WebAgentGateway\native-host\<source-sha>\install-receipt.json"
```

A mismatch is configuration drift and must not be repaired by broad overwrite.

## Removal

Removal is exact-installation scoped.

Before deleting anything, inspect the installation receipt and confirm that the current registry default value is either absent or exactly equals that receipt's `registration.defaultValue`.

If the registry value points somewhere else, stop. Do not delete that registration or the installation directory.

If it matches, remove only the WAG registration:

```powershell
reg.exe delete "HKCU\SOFTWARE\Chromium\NativeMessagingHosts\com.openai.web_agent_gateway" /f
```

Then remove only the source-SHA directory identified by the matching receipt, after confirming its executable and manifest still match the receipt hashes.

Do not scan for or remove unrelated native-messaging registrations, browser profiles, other WAG source-SHA installations, or machine-wide keys.
