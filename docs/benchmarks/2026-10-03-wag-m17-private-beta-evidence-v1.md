# WAG M17 — Privacy-Safe Private Beta Evidence v1

Date: 2026-10-03
Branch: feat/wag-m17-private-beta-evidence-v1

## Objective

Close the local evidence gap for WAG private-beta validation without adding hosted telemetry, external uploads, or identity-bearing analytics.

M17 adds one read-only local MCP tool:

- `product.beta.summary`

It converts the existing bounded diagnostics ring plus local product state into aggregate adoption signals suitable for explicit private-beta receipt collection.

## Signals exposed

Per local install only:

- installed release observed;
- ChatGPT connector confirmed;
- first useful workflow completed;
- active UTC days inside the retained diagnostics window;
- repeat-usage signal based on two or more successful calls in an allowed tool family;
- aggregate tool-family call/success/failure counts;
- total calls, successes, failures and bounded success rate.

The repeat signal excludes system, product, diagnostics and unknown/other tool families.

## Explicit non-claims

M17 does **not** claim or calculate cross-user/commercial metrics that require aggregation across real beta users.

The output explicitly marks these as `NOT_COLLECTED`:

- external user count;
- activation rate;
- first useful workflow rate;
- repeat workflow rate;
- weekly active users;
- retention rate;
- recovery rate;
- uninstall reasons;
- support incidents.

It also explicitly states:

- local active UTC days are not WAU;
- a repeat-usage signal is not retention;
- aggregation requires explicit receipt collection.

## Privacy boundary

The summary is derived only from the existing bounded diagnostics ring and safe local product state.

It does not include:

- tool arguments;
- filesystem paths;
- file/content payloads;
- owner IDs;
- session IDs;
- request/effect IDs;
- exception messages;
- raw remote URLs;
- automatic network upload.

The tool is read-only, idempotent, and closed-world.

## Acceptance

- focused diagnostics/product/direct-surface suite: 27/27 PASS;
- full WAG product suite: 76/76 PASS;
- TypeScript typecheck: PASS;
- build: PASS;
- git diff --check: PASS.

## M8 relationship

M17 provides privacy-safe **local evidence inputs** for the M8 private-beta gate. It does not itself prove demand, WAU, retention, recovery rate, or commercial viability. Those require explicit receipts from real beta installations and external aggregation outside the local WAG authority boundary.

No public push, merge, or live promotion is claimed by this document yet.
