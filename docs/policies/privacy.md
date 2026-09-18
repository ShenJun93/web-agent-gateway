# Privacy

Web Agent Gateway is local software. The WAG project does not operate a centralized service that receives repository contents, local file contents, credentials, or WAG audit state.

## Local data

Depending on enabled capabilities, WAG may process locally:

- approved workspace paths and bounded file contents;
- local configuration and policy;
- local credentials supplied through the environment;
- durable ownership, audit, verification, and installation metadata;
- browser-adapter correlation and short-lived local bearer material.

Secrets and bearer credentials are designed to remain local and are not intentionally written to project telemetry.

## Connected providers and backends

WAG can connect to user-selected external products or locally supervised backends. Data intentionally returned through a WebChat/provider capability may therefore be transmitted by that provider according to the provider's own privacy terms.

For example, when a user asks a WebChat client to read an approved local file through WAG, the returned bounded file content can become part of that provider conversation.

WAG does not treat provider/model output as trusted local authority.

## Telemetry

Current WAG telemetry is local structured program telemetry. The project does not currently operate a WAG telemetry-collection endpoint.

Telemetry contracts are designed to exclude secrets and raw local file content. A future network telemetry service would require a separately reviewed change and an update to this policy before deployment.

## Installation metadata

The Windows native-host installation stores non-secret receipts and manifests under the user's local application-data directory and may register one per-user Chromium Native Messaging host under HKCU.

See `docs/native-host-installation.md` for the exact system change and removal procedure.

## Changes to this policy

Material changes to data collection or transmission behavior require corresponding source review and a policy update.
