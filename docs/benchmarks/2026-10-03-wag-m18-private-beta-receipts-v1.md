# WAG M18 — Private Beta Receipts & Offline Aggregation v1

Date: 2026-10-03
Branch: feat/wag-m18-private-beta-receipts-v1

## Objective

Turn M17 privacy-safe local beta evidence into explicitly consented per-install receipts that can be aggregated offline across real beta installations without adding hosted telemetry or automatic upload.

## Product surface

New MCP tool:

- `product.beta.receipt`

Contract:

- requires the literal input `{ "consent": true }`;
- creates one random pseudonymous installation id on first consent and reuses it for later receipts;
- returns the current M17 private-beta summary plus the pseudonymous install id;
- performs no network upload;
- collects no user identity or machine fingerprint;
- stores no tool arguments, paths, content, owner/session ids, exception messages, or remote URLs.

The installation identifier is a random `beta_install_<uuid>`, stored locally as `state/private-beta-installation-id`. It is a linkable installation pseudonym, not a user identity.

## Receipt validation

Strict receipt/summary schemas fail closed on:

- unknown fields;
- invalid timestamps;
- incoherent call/success/failure totals;
- tool-family totals that do not reconcile with usage totals;
- useful-workflow or repeat-usage signals without corresponding successful calls;
- invalid activity windows;
- summary timestamps that predate their latest usage event;
- receipt timestamps that predate their summary.

## Offline aggregation

Maintainer command:

```
npm run beta:aggregate -- --input-dir <absolute-directory> --output <absolute-json> [--as-of <ISO-UTC>]
```

Boundaries:

- offline only; no network code;
- input and output paths must be absolute;
- direct `.json` receipts only;
- at most 1,000 files;
- at most 1 MiB per receipt;
- symlink/non-file receipt entries rejected;
- output is create-only (`wx`) with private file mode;
- latest receipt per pseudonymous installation is used;
- same-installation/same-timestamp conflicting receipts fail closed;
- implausible future receipts fail closed.

Installation-level aggregate metrics:

- installed-release observed count/rate;
- connector-confirmed count/activation rate;
- first-useful-workflow count/rate;
- repeat-workflow signal count/rate;
- active installations in the last 7 days and rate;
- aggregate calls/successes/failures/success rate;
- aggregate tool-family totals.

## Explicit non-claims

The aggregate deliberately reports these as `NOT_MEASURED`:

- weekly active users;
- retention rate;
- recovery rate;
- uninstall reasons;
- support incidents.

Interpretation flags state that:

- the aggregation unit is an anonymous installation, not a user;
- active installations over 7 days are not WAU;
- repeat-workflow rate is not retention;
- receipts are self-reported, not attested or fraud-resistant;
- only the latest receipt per installation contributes to installation-level metrics.

## Acceptance

- targeted M18 product/direct/receipt/CLI suite: 23/23 PASS;
- direct MCP consent boundary: PASS;
- WAG product suite: 82/82 PASS;
- TypeScript typecheck: PASS;
- build: PASS;
- git diff --check: PASS.

No public push, merge, or live promotion is claimed by this document yet.
