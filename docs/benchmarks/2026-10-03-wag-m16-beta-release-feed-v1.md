# WAG M16 — Offline Signed Beta Release Feed v1

Date: 2026-10-03
Branch: `feat/wag-m16-beta-release-feed-v1`

## Objective

Close the release-channel packaging gap without deploying hosted infrastructure or inventing a production signing key.

M16 adds maintainer-side tooling that produces the exact signed feed contract already consumed by `product.update.check`.

## Scope

New source tooling:

- `src/product-update-feed.ts`
- `scripts/generate-wag-beta-feed.ts`
- `test/product-update-feed.test.ts`

The generator accepts one already-built WAG beta release manifest and one package artifact.

It outputs:

1. `WAG_LOCAL_UPDATE_ENVELOPE_V1`
   - raw payload bytes encoded as base64;
   - Ed25519 signature over the exact raw payload bytes.
2. `WAG_LOCAL_UPDATE_SOURCE_V1`
   - HTTPS feed URL;
   - public Ed25519 SPKI DER/base64;
   - bounded timeout and metadata-size limits.

## Safety / authority

- beta manifests only;
- stable/development release manifests are rejected;
- package and feed URLs must be HTTPS and may not contain credentials/fragments;
- package must be a regular file between 1 byte and 512 MiB;
- feed TTL is bounded to 1–168 hours;
- publication time may not be after feed generation time;
- signing key must be Ed25519;
- CLI does not accept raw key material;
- CLI accepts only:
  `--signing-key-ref env:WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM`;
- private key material is never written into the envelope or update-source config;
- output files are create-only; existing outputs are not overwritten;
- no network request, deployment, package upload, runtime switch, or update installation is performed.

## Maintainer invocation

Example:

```text
$env:WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM = <loaded-out-of-band>
npx tsx scripts/generate-wag-beta-feed.ts \
  --release-manifest E:\release\RELEASE.json \
  --package E:\release\web-agent-gateway-beta.tgz \
  --package-url https://downloads.example.invalid/wag/web-agent-gateway-beta.tgz \
  --feed-url https://updates.example.invalid/wag/beta.json \
  --output E:\release\beta-feed.json \
  --source-config-output E:\release\update-source.json \
  --signing-key-ref env:WAG_UPDATE_SIGNING_PRIVATE_KEY_PEM
```

The example domains are intentionally non-production placeholders.

## Contract compatibility

The regression test generates an ephemeral Ed25519 keypair, creates a signed beta feed using the M16 generator, then feeds that envelope into the existing `product.update.check` verification path.

Expected result:

- signature verification passes;
- beta channel is selected;
- candidate release/version are returned;
- package SHA-256 and package size match the generated artifact;
- no runtime/update state is mutated.

## Local acceptance

- M16 generator + existing discovery targeted suite: 10/10 PASS.
- Full WAG product suite: 75/75 PASS.
- TypeScript typecheck: PASS.
- Build: PASS.
- `git diff --check`: PASS.

## Explicit non-claims

- Production update feed endpoint: NOT DEPLOYED.
- Production signing key: NOT CREATED / NOT CONFIGURED.
- Package hosting: NOT DEPLOYED.
- Stable release channel: NOT ENABLED.
- Auto-install from discovered feed: NOT ADDED.

M16 is an offline beta release-packaging capability only.
