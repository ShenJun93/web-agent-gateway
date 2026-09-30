# WAG Local M6 — Signed Update Discovery Candidate

Date: 2026-09-30  
Branch: `feat/wag-local-m6-update-discovery-v1`  
Base: `2f10032cc46d7e366d646f113b81fe9d61f29d0a`

## Verdict

`M6_UPDATE_DISCOVERY_ENGINE = PASS`

`PRODUCTION_UPDATE_FEED = NOT_CONFIGURED`

`LIVE_RUNTIME_PROMOTION = NOT_EXECUTED`

This closes the local **update-discovery client** gap without turning update discovery into an
implicit updater. A production stable/beta feed endpoint and signing key are intentionally not
invented here; those distribution artifacts belong to the later beta/release channel work.

## Product surface

The private product profile adds one read-only open-world tool:

```text
product.update.check
```

The projected M6 private product surface is now **69 tools**. The primary live WAG remains the
accepted legacy 53-tool runtime until a deliberate promotion.

`product.update.check` may perform one bounded HTTPS GET against the configured update feed. It
does not download a release package, stage files, switch runtime, restart WAG, mutate settings, or
change Git/browser/process/filesystem authority.

## Signed feed contract

Local source configuration:

```text
%LOCALAPPDATA%\WAG-Local\config\update-source.json
schema = WAG_LOCAL_UPDATE_SOURCE_V1
```

The source configuration contains only:

- one HTTPS feed URL;
- one Ed25519 public verification key in SPKI DER/base64;
- bounded timeout;
- bounded metadata byte limit.

Feed transport envelope:

```text
WAG_LOCAL_UPDATE_ENVELOPE_V1
payloadBase64
signatureBase64
```

Signed payload:

```text
WAG_LOCAL_UPDATE_FEED_V1
generatedAtUtc
expiresAtUtc
channels.stable[]
channels.beta[]
channels.development[]
```

Each candidate reuses the accepted M4 `WAG_LOCAL_RELEASE_V1` manifest and separately declares:

- HTTPS package URL;
- package SHA-256;
- bounded package size;
- publication time.

The client verifies the signature **before** parsing/selecting release metadata.

## Fail-closed behavior

Discovery returns stable states:

- `UNCONFIGURED`;
- `DISABLED`;
- `OFFLINE`;
- `INVALID_CONFIG`;
- `INVALID_METADATA`;
- `EXPIRED`;
- `NO_COMPATIBLE_RELEASE`;
- `CURRENT_VERSION_UNKNOWN`;
- `CURRENT`;
- `UPDATE_AVAILABLE`.

Safety properties:

- only HTTPS URLs are accepted;
- URLs containing credentials/fragments are rejected;
- feed redirects are rejected;
- request timeout is bounded;
- response size is bounded both by Content-Length and streamed bytes;
- envelope/base64/signature shape is bounded;
- only Ed25519 verification keys are accepted;
- feed timestamps are validated and expiration is enforced;
- candidate publication times cannot be materially in the future;
- existing M4 Node/migration/rollback compatibility validation is reused;
- incompatible signed releases are ignored rather than executed;
- installed legacy versions are never guessed;
- no package bytes are downloaded during discovery;
- no state/runtime mutation occurs during discovery.

## Auto-check semantics

The product preference `auto_check_updates` now has executable meaning:

- doctor uses `respectAutoCheck=true`;
- if disabled, doctor performs **zero update-feed network calls**;
- an explicit `product.update.check` call bypasses that preference because it is a direct user/agent
  request to check now.

The configured channel is taken from the safe product preference and falls back to the installed
release channel.

## Doctor integration

When no update source is configured, doctor retains the existing informational result:

```text
WAG_UPDATE_CHECK_UNCONFIGURED
```

When configured, doctor maps signed-update discovery to stable non-destructive diagnostics such as:

- `WAG_UPDATE_AVAILABLE` — INFO;
- `WAG_UPDATE_FEED_UNREACHABLE` — WARN;
- `WAG_UPDATE_METADATA_INVALID` — WARN;
- `WAG_UPDATE_METADATA_EXPIRED` — WARN;
- `WAG_UPDATE_NO_COMPATIBLE_RELEASE` — INFO.

An available update is not a health failure and is never auto-installed by doctor.

## Acceptance evidence

### Signed discovery tests

```text
test/product-update-discovery.test.ts
7 / 7 PASS
```

Covered:

- newest compatible signed release selection;
- invalid signature refusal;
- expired metadata refusal;
- offline feed;
- disabled auto-check with zero network calls;
- incompatible release filtering;
- current release detection;
- legacy/current-version-unknown handling;
- no runtime-state mutation.

### Doctor mapping

```text
test/wag-local-doctor.test.ts
7 / 7 PASS
```

### Direct MCP declaration

```text
test/direct-mcp-readiness.test.ts
10 / 10 PASS
```

`product.update.check` explicitly declares:

```text
readOnlyHint = true
destructiveHint = false
idempotentHint = true
openWorldHint = true
```

### Product regression

```text
npm run test:wag-product
58 / 58 PASS
```

### DC-replacement production-local acceptance

```text
test/dc-replacement.acceptance.ts
1 / 1 PASS
projected tools = 69
operatorApprovals = 0
autonomousLocalEffects = true
```

### Build / package

```text
npm run typecheck   = PASS
npm run build       = PASS
npm pack --dry-run  = PASS
git diff --check    = PASS
```

The package contains `dist/product-update-discovery.js`.

## Read-only live doctor check

Source doctor was run against the current live WAG stack and wrote:

`docs/benchmarks/2026-09-30-wag-local-product-m6-update-discovery-live.json`

Observed:

- local product status `READY`;
- DevSpace discovery HTTP 200;
- tunnel health/readiness HTTP 200/200;
- local MCP round trip true;
- update source `UNCONFIGURED`;
- no update candidate;
- no repair and no lifecycle mutation.

This is intentionally **not** evidence of a production update feed.

## M6 disposition

Measured M6 candidates now accepted at source/package level:

1. bounded search lifecycle;
2. native DOCX/XLSX/PDF operations;
3. bounded product config/activity/help UX;
4. signed update-discovery client.

Still deferred:

- bounded in-memory execution — P2 because generic command/process execution already exists;
- production stable/beta feed hosting, signing and release publication — later beta/distribution work;
- remote/multi-device product authority — M7 architecture gate.

No public push was performed.
