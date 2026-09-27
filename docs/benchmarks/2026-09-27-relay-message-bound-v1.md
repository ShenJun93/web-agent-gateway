# Relay message bound v1 — oversized-result inventory

Date: 2026-09-27
Status: Task 3 implementation evidence
Limit: every serialized MCP relay message must be smaller than 256 KiB.

## Transport rule

`src/relay-result-chunks.ts` defines a 256 KiB relay ceiling, a 192 KiB direct-result
budget, and 56 KiB raw result chunks. Results above the direct budget are serialized once,
kept only in bounded in-memory storage, and represented by an opaque `result_id`. The
`result.chunk` reader returns individual base64 JSON chunks and never replays the original
tool.

The limit is applied after a tool handler returns, because `toolResult()` duplicates a
structured value into both JSON text and `structuredContent` (`src/server.ts:1438-1440`
in this change). Escaping that text can make a valid 64 KiB tool payload materially larger
than 256 KiB on the wire.

## Live tools that can exceed 256 KiB before relay bounding

| Tool | Existing cap / reason |
| --- | --- |
| `machine.list` | Default 200 entries (`src/local-machine-runtime.ts:839`); MCP accepts up to 1,000 entries and depth 8 (`src/server.ts:611-612`). Entry paths are not governed by a response-byte ceiling. |
| `machine.read` | Text content is bounded to 64 KiB (`src/local-machine-runtime.ts:36,662`), but JSON escaping plus the MCP text/structured duplication can push a valid result above 256 KiB. |
| `machine.read_many` | Up to 20 files (`src/local-machine-runtime.ts:39,917`), each using the bounded text-read path, so aggregate output can exceed the relay ceiling. |
| `machine.image.read` | Image input/result is allowed up to 4 MiB (`src/local-machine-runtime.ts:40,691`) and is returned as native MCP image content. |
| `machine.pdf.extract` | Extraction accepts up to 256 KiB of text and 50 pages (`src/local-machine-runtime.ts:43-45,576-579`); page text plus aggregate content can exceed the relay ceiling. |
| `machine.search` | Up to 50 matches, default 20 (`src/local-machine-runtime.ts:54,739`), over source files up to the 64 KiB text-read boundary; aggregate evidence can exceed the relay ceiling. |
| `machine.search_continue` | Same bounded search result shape and limits as `machine.search` (`src/local-machine-runtime.ts:54,739`). |
| `machine.command.run` | Output accepts up to 20,000 tokens (`src/local-machine-runtime.ts:52-53`), converted to a byte budget at four bytes/token (`src/local-machine-runtime.ts:1525`), so the configured maximum is 80,000 output bytes before JSON expansion. |
| `machine.process.list` | On Windows the enumerator selects up to 500 processes (`src/local-machine-runtime.ts:1008-1022`) and then adds WAG-owned process metadata without a final serialized-byte ceiling (`src/local-machine-runtime.ts:1038-1073`). |
| `machine.terminal.list` | Persistent enumeration considers up to 200 terminal records (`src/local-machine-runtime.ts:528-546`), then combines them with in-process terminal records (`src/local-machine-runtime.ts:1395-1415`) without a final serialized-byte ceiling. |
| `machine.terminal.output` | The terminal buffer is bounded to 64 KiB (`src/local-machine-runtime.ts:56,1379-1381`); valid control/escape-heavy output can expand beyond 256 KiB when represented in MCP JSON. |
| `browser.snapshot` | Up to 500 nodes (`src/browser-harness/browser-mcp-runtime.ts:82,233`), with each node bounded to role 512 bytes, name 1,024 bytes and value 2,048 bytes (`src/browser-harness/browser-mcp-runtime.ts:119-127`). |
| `browser.screenshot` | Screenshot bytes are allowed up to 8 MiB (`src/browser-harness/browser-mcp-runtime.ts:83,284`). |
| `desktop.snapshot` | The existing DesktopPort backend permits up to 500 UIA nodes (`src/desktop-harness/windows-uia-backend.ts:13,495`) with names up to 4,096 bytes and values up to 64 KiB (`src/desktop-harness/windows-uia-backend.ts:509-516`); the bridge itself permits up to 4 MiB of output (`src/desktop-harness/windows-uia-backend.ts:11,419`). Task 3 only bounds its relay result; it does not add or expand DesktopPort. |
| `desktop.screenshot` | The existing UIA backend accepts PNG base64 strings up to 16 MiB (`src/desktop-harness/windows-uia-backend.ts:552-561`), while the bridge output ceiling is 4 MiB (`src/desktop-harness/windows-uia-backend.ts:11,419`). Task 3 only applies generic relay chunking. |
| `repo.list` | The direct surface can route a local-machine workspace to `machine.list`; therefore its local compatibility path inherits the entry-volume bound above. The repository backend itself has a 64 KiB result ceiling (`src/repository-inspection.ts:24`). |
| `repo.search` | The direct surface can route a local-machine workspace to `machine.search`; therefore its local compatibility path inherits that aggregate result bound. The repository backend itself has a 64 KiB result ceiling (`src/repository-inspection.ts:24`). |
| `file.read` | Repository text may be 64 KiB (`src/admitted-workspace.ts:68,78`); the local compatibility path also supports the 4 MiB image result. Either can exceed 256 KiB once encoded for MCP. |
| `verify.run` | Verify profiles allow up to 10,000 output tokens (`src/verify-profile.ts:45`), while durable verify evidence permits 64 KiB of persisted UTF-8 output (`src/durable-verify-job.ts:10`). Escape-heavy valid output can exceed the relay ceiling after MCP JSON encoding. |
| `command.run` | The MCP schema permits up to 10,000 output tokens (`src/server.ts:1120` in this change). At the configured maximum, JSON expansion can exceed 256 KiB even though ordinary output is much smaller. |
| `git.commit` | Up to 64 exact paths (`src/git-commit.ts:10,458`); the returned durable view repeats bounded path data in path/change/EOL metadata, which can exceed 256 KiB at valid path lengths. |
| `git.commit.result` | Returns the same durable commit view and therefore inherits the valid 64-path upper bound above. |

## Tools excluded from the oversized inventory

Repository-only `repo.snapshot` and `repo.diff` stay behind the shared 64 KiB
*serialized backend-result* ceiling (`src/repository-inspection.ts:24`) and have no
local-machine compatibility route that widens their result. Mutation results, remote-push
results, effect readers, diagnostics, capability/health readers, and lifecycle acknowledgements
return bounded identifiers/status metadata rather than bulk payloads.

`result.chunk` is deliberately not re-chunked. Its fixed 56 KiB raw chunk size leaves room
for base64, MCP JSON text duplication, and envelope metadata while remaining below 256 KiB.
