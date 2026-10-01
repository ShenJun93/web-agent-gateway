# WAG Local M6 — Bounded Document Operations

Date: 2026-09-30
Branch: `feat/wag-local-m6-document-ops-v1`
Base: `a7d665750a55e25d5f70cd2f7c4c1e67a593cdf8`

## Verdict

`M6_DOCUMENT_OPS = PASS`

`M6_DOCUMENT_OPS_LIVE_PROMOTION = NOT_EXECUTED`

This closes the measured M5 document-operation gap at the source/package acceptance level without
granting generic new process, filesystem-root, cloud, or remote-device authority.

## Added MCP surface

Read-only inspection:

```text
machine.docx.inspect
machine.xlsx.inspect
```

Create-new operations:

```text
machine.docx.create
machine.xlsx.create
machine.pdf.create
```

CAS-protected same-path mutation:

```text
machine.docx.replace_text
machine.xlsx.set_cells
machine.pdf.overlay_text
```

All tools remain scoped to an already caller-owned `machine.open` workspace.

## Authority and safety

Document operations reuse existing WAG local-machine authority instead of exposing arbitrary Office
automation or a generic scripting bridge.

Create semantics:

- only relative workspace paths accepted;
- exact extension required: `.docx`, `.xlsx`, or `.pdf`;
- target must not already exist;
- generated files are bounded to 32 MiB;
- write uses a private temp file and same-directory rename;
- kill-switch/effect policy is rechecked before the consequential write/rename.

Edit semantics:

- target must already be a regular non-symlink file inside the workspace;
- caller must provide the exact lower-case SHA-256 observed before the edit;
- target SHA-256 is checked before generation and re-read immediately before replacement;
- stale/raced content is rejected rather than overwritten;
- replacement is performed through a bounded same-directory temp file;
- no external Office/Excel/Word process is started.

Inspection semantics:

- DOCX paragraph text is secret-redacted before MCP return;
- XLSX string cells and formulas are secret-redacted before MCP return;
- oversized inspection results use the existing relay-result chunking boundary.

## Container protections

DOCX/XLSX ZIP processing rejects:

- absolute or traversal entry names;
- duplicate entries;
- encrypted archives;
- ZIP64;
- unsupported compression methods;
- entries above 16 MiB;
- archives above 16 MiB compressed / 64 MiB expanded;
- suspicious compression ratios above the accepted bound.

DOCX:

- bounded paragraphs/text/replacements;
- replacement can cross split Word runs;
- untouched package entries are preserved;
- run properties on the first affected run remain preserved.

XLSX:

- bounded sheets/cells/XML/string sizes;
- native string/number/boolean/null values;
- cell/sheet references validated;
- existing cell style survives a set-cell mutation;
- untouched formulas and package entries remain preserved.

PDF:

- bounded create page/text/font/margin values;
- bounded existing/generated PDF size;
- encrypted/malformed input rejected for mutation;
- overlay coordinates/text bounds validated;
- created and overlaid PDFs remain readable by the accepted native PDF extractor.

## Regression evidence

Library/document tests:

```text
test/document-ops.test.ts
6 / 6 PASS
```

Filesystem authority/CAS/redaction tests:

```text
test/local-machine-document-runtime.test.ts
4 / 4 PASS
```

Product regression:

```text
npm run test:wag-product
44 / 44 PASS
```

Direct MCP surface:

```text
test/direct-mcp-readiness.test.ts
10 / 10 PASS
```

Local-machine MCP routing:

```text
test/local-machine-mcp-surface.test.ts
1 / 1 PASS
```

Relay size boundary:

```text
test/relay-message-bound.test.ts
1 / 1 PASS
```

DC surface compatibility:

```text
test/dc-replacement-surface.test.ts
15 / 15 PASS
```

Production-local DC replacement acceptance:

```text
test/dc-replacement.acceptance.ts
1 / 1 PASS
operatorApprovals = 0
autonomousLocalEffects = true
```

Static/build:

```text
npm run typecheck = PASS
npm run build     = PASS
git diff --check  = PASS
```

Packaging:

```text
npm pack --dry-run = PASS
package size       = 328.8 kB
unpacked size      = 1.5 MB
files              = 150
```

The packed artifact contains:

- `dist/document-docx.js`
- `dist/document-xlsx.js`
- `dist/document-pdf.js`
- `dist/document-zip.js`
- `dist/local-machine-document-runtime.js`

The production runtime lock is byte-synchronized with `package-lock.json`, including the new
`fflate` and `pdf-lib` runtime dependency closure.

## Scope

No live WAG runtime promotion was performed in this batch.

The currently running primary WAG remains the accepted legacy runtime with 53 MCP tools. Promoting
this branch would be a separate lifecycle operation and is not required to establish source/package
acceptance for M6 document ops.

After this batch, the remaining measured M6 candidate families are Product UX and Update Discovery.
