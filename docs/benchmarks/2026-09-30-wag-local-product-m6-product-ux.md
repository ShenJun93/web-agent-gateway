# WAG Local M6 — Product UX Candidate

Date: 2026-09-30  
Branch: `feat/wag-local-m6-product-ux-v1`  
Base: `dba8406087a4574f18499b2c7774097b19149ef3` (M6 bounded document operations)

## Verdict

`M6_PRODUCT_UX = PASS`

`M6_PRODUCT_UX_LIVE_PROMOTION = NOT_EXECUTED`

This closes the M5 product config / recent-activity UX gap at the source/package acceptance level
without exposing raw authority configuration or adding filesystem, process, browser, Git, credential,
network or remote-device authority.

## Added product surface

The accepted private product profile adds:

```text
product.config.get
product.config.update
product.activity.recent
product.usage
product.help
```

Together with the accepted M6 search-lifecycle and document-operation candidates, this branch projects
a full private product surface of **68 MCP tools** after a later live promotion. The currently running
primary WAG remains the accepted legacy **53-tool** runtime.

The minimal historical/default stdio profile remains unchanged because the product UX surface is
wired only when the accepted local product diagnostics/runtime context exists.

## Safe configuration UX

`product.config.get` returns:

- safe product preferences;
- a revision token for compare-and-swap updates;
- release-state summary when present;
- boolean/count capability summaries.

It deliberately does **not** return:

- allowed-root paths;
- DevSpace URLs;
- mutation state paths;
- owner/session correlation;
- Git push URLs/refs;
- browser executable/profile paths;
- relay device ids;
- publishable keys;
- secret environment names;
- raw config content.

`product.config.update` can change only:

```text
update_channel       = stable | beta | development
auto_check_updates   = boolean
```

It cannot mutate `wag-local.config.json` and therefore cannot widen roots, execution, repository,
browser, credential, relay or remote-push authority.

Writes use:

1. the caller's exact 64-hex revision;
2. an exclusive sibling lock file so concurrent WAG processes fail closed;
3. a private unique sibling temp file;
4. revalidation immediately before replacement;
5. same-directory atomic rename.

Stale revisions and concurrent writers are refused rather than merged.

The settings file is a strict three-field schema. Unknown fields or malformed settings fail closed
and are not silently rewritten.

## Activity / usage UX

`product.activity.recent` and `product.usage` reuse the existing bounded
`ToolUsageDiagnostics` store rather than creating a second telemetry stream.

The diagnostics contract stores no:

- arguments;
- paths;
- command text;
- file contents;
- tool output;
- credentials;
- owner/session ids.

Recent activity is bounded to the existing 100-event query maximum and persisted retention remains
bounded by the existing diagnostics ring.

## Help / workflow discovery

`product.help` is a static read-only discovery surface for the accepted WAG Local workflow families.
It performs no filesystem, process, browser, Git, network or credential operation.

## Acceptance evidence

### Product UX unit/security tests

```text
test/product-ux.test.ts
5 / 5 PASS
```

Measured:

- safe config summary does not leak root/config paths, relay secrets or remote-push URLs;
- installed release channel is reflected in default product settings;
- valid existing-file updates work on Windows;
- stale revisions are refused;
- cross-process lock contention fails closed;
- malformed/unknown settings fail closed without rewrite;
- authority config remains byte-identical after preference updates;
- product activity/usage reuse sanitized diagnostics;
- product help returns bounded workflow discovery.

### Direct MCP declaration

```text
test/direct-mcp-readiness.test.ts
10 / 10 PASS
```

Measured:

- all five product tools are in the projected private product surface;
- every product tool has all four MCP hints explicitly declared;
- schemas reject unknown arguments;
- no product tool accepts caller-controlled authority identity.

### Product regression

```text
npm run test:wag-product
49 / 49 PASS
```

### DC replacement production-local acceptance

```text
test/dc-replacement.acceptance.ts
1 / 1 PASS
operatorApprovals = 0
autonomousLocalEffects = true
projected tools = 68
```

### Static / package verification

```text
npm run typecheck = PASS
npm run build     = PASS
npm pack --dry-run = PASS
git diff --check  = PASS
```

The dry-run package contains `dist/product-ux.js`.

## Scope

No live WAG runtime promotion was performed in this batch.

After this batch, the remaining measured M6 candidate is **Update Discovery**. Bounded in-memory
execution remains P2 because generic argv/process execution already covers the workflow with a broader
but existing execution surface.

Remote/multi-device management remains behind the M7 architecture gate.
