# WAG Full Harness v1.4 — Semantic Browser source receipt

Date: 2026-09-24
Branch: feat/full-harness-browserport-v1
Parent: cf8f6e77b55122b409b984529ff2ed4acf6d5ca0
Status: SOURCE-GREEN / NO LIVE BROWSER / NOT MCP-PUBLISHED

## Added semantic surface

- semantic.snapshot
- semantic.navigate
- semantic.click
- semantic.fill
- semantic.press

The source API is internal to Browser Harness. It is not registered in server.ts.

Snapshot behavior:
- reads BrowserPort URL/title metadata;
- reads the CDP accessibility tree;
- includes only non-ignored DOM-backed nodes;
- emits role/name/value plus editable/focusable/disabled properties;
- mints opaque refs bound to the latest snapshot.

Action behavior:
- click accepts only the current WAG ref, never caller x/y;
- ref -> backendDOMNodeId -> scroll -> DOM box model -> pointer input;
- fill accepts only editable refs, focuses exact DOM node and inserts bounded text;
- press uses a bounded key allowlist;
- navigation permits http/https only;
- a new snapshot or navigation invalidates prior refs.

## Measured gates

Browser + Process Harness:
```text
35 pass
0 fail
```

Existing autonomous-local/repository focused regression:
```text
16 pass
0 fail
```

These are two separate measured batches.

Repository source build:
```text
npm run build
PASS
```

## Non-claims

- no live browser/profile was opened;
- no page mutation was performed outside fakes;
- no raw screen coordinates are accepted from the model;
- no vision/pixel fallback exists yet;
- no arbitrary browser JavaScript is public;
- upload/download and durable browser recovery remain future slices;
- Notebook99 live acceptance remains pending browser-authority integration.
