# WAG live native PDF extraction

Date: 2026-09-25
Status: PASS

## Objective

Close the remaining document-read gap without falling back to Desktop Commander, OCR, browser
automation, or human shell relay.

The autonomous-local surface now extracts bounded text from local PDFs and also recognizes a PDF
when it is reached through the frozen `file.read` path.

## Source

Feature commit:

```text
86c99e8275ca54581ad4545868993128ad787d1b
feat: add native local PDF text extraction
```

Runtime dependency fix:

```text
5b6ab4aab5ef7d398e97009e3c3d3e9dbefbe920
fix: bind runtime dependencies to build worktree
```

The promotion fix was required because the runtime previously junctioned
`E:/WAG-Runtime/<head>/node_modules` to the main repository's dependency tree. The build worktree
contained `pdfjs-dist`, while the main repository node_modules did not. Runtime promotion now
binds the deployed runtime to the exact node_modules tree used for typecheck/build.

## Production capability

New direct tool:

```text
machine.pdf.extract
```

Bounds:

- maximum input PDF: 16 MiB;
- default pages: 10;
- maximum pages per call: 50;
- default extracted characters: 64 KiB;
- maximum extracted characters: 256 KiB;
- isolated worker timeout: 20 seconds;
- bounded worker output: 512 KiB;
- SHA-256 identity is checked across the worker boundary;
- obvious credential-shaped text is redacted before return;
- line pagination is rejected for PDF input and the caller is directed to PDF page extraction.

The frozen `file.read` path also detects the PDF magic header and returns bounded extracted text,
so an older connector snapshot can still consume PDF content through the existing read tool.

## Source verification

```text
test/local-machine-pdf.test.ts
2/2 PASS

test/local-machine-mcp-surface.test.ts
test/direct-mcp-readiness.test.ts
test/dc-replacement-surface.test.ts
25/25 PASS

typecheck = PASS
build     = PASS
diffcheck = PASS
```

## Promotion

Initial feature runtime:

```text
E:/WAG-Runtime/86c99e8275ca
```

Its first live PDF extraction correctly exposed the dependency-junction defect:

```text
ERR_MODULE_NOT_FOUND: pdfjs-dist
```

After fixing promotion, the accepted runtime is:

```text
E:/WAG-Runtime/5b6ab4aab5ef
sourceHead = 5b6ab4aab5ef7d398e97009e3c3d3e9dbefbe920
activation = SUCCEEDED
receipt = E:/WAG-Acceptance/promotion-logs/activate-5b6ab4aab5ef.json
```

The activation replaced `E:/WAG-Runtime/86c99e8275ca/dist/cli.js` without restarting DevSpace.

## Live extraction proof

Fixture:

```text
E:/WAG-Acceptance/pdf-live-86c99e8275ca/sample.pdf
pages = 2
size  = 892 bytes
sha256 = b69990272a4671af27fd1baffbe5921b4e93d546e34e4cf017081bdb9bfe7c4d
```

Page 1 result:

```text
mime_type       = application/pdf
page_count      = 2
start_page      = 1
extracted_pages = 1
has_more        = true
redacted        = true
content         = Live PDF page one secret=<REDACTED>
```

Page 2 result:

```text
start_page      = 2
extracted_pages = 1
has_more        = false
content         = Live PDF page two needle
```

Frozen `file.read` PDF fallback returned both pages and preserved the same SHA-256 identity.

## Live MCP registration proof

A deployed-runtime in-memory MCP client called the actual registered `machine.pdf.extract` tool,
not the LocalMachineContext method directly.

Observed:

```text
runtimeRoot = E:/WAG-Runtime/5b6ab4aab5ef
machine.pdf.extract present = true
MCP call state = PASS
page_count = 2
extracted_pages = 2
redaction = PASS
```

That isolated live harness registered 32 tools because it deliberately did not attach a DevSpace
executor, so mutation/commit/command contexts were not initialized. The production direct-MCP
readiness projection for the same source/config is:

```text
projected tools = 43
DIRECT_MCP_LOCAL_READINESS = READY
```

The currently cached ChatGPT connector schema may continue to expose an older tool catalog until
connector discovery refreshes. That cache does not alter the deployed WAG runtime or the frozen
`file.read` PDF fallback.

## Result

Native PDF text extraction is live in WAG. PDF reading no longer requires Desktop Commander, OCR,
or manual relay.
