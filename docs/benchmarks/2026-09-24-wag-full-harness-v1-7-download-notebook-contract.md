# WAG Full Harness v1.7 — Artifact download + Notebook99 exact-once acceptance contract

Date: 2026-09-24
Branch at execution: feat/full-harness-browserport-v1
Parent at start: 678be949b10e49dd65d1bb8184c949864a392b6b
Status: SOURCE-FOCUSED GREEN / LIVE BROWSER NOT TOUCHED

## Added

ArtifactPort:
- createBytes(owner, filename, bytes)
- generated/downloaded bytes use the same opaque artifact id, owner tuple, size ceiling, sha256
  manifest and readback integrity checks as imported files
- createBytes never invokes the arbitrary source-path authorization seam

BrowserDownloadController:
- requires an injected BrowserDownloadDriver
- the driver must arm observation before invoking the supplied trigger
- model-facing download output is an owned ArtifactHandle, not a filesystem path
- filename and bytes are validated before artifact persistence
- timeout is bounded to 1s..120s
- driver failure creates no artifact

Notebook99 acceptance contract:
- high-level Notebook99Driver is injected and is not part of BrowserPort core
- exact expected source topology is checked before submit
- topology mismatch returns FAILED_NO_EFFECT and does not submit
- prompt submission is wrapped by HarnessEffectCoordinator
- successful persistence requires exactly one observed prompt tag plus non-empty response
- retry after SUCCEEDED returns the durable effect without a second submit
- observation loss after submit becomes OUTCOME_UNKNOWN and blind retry is blocked
- duplicate persistence becomes OUTCOME_UNKNOWN, never PASS

## Measured focused gates

Artifact/download/Notebook99/effect focused:
```text
15 pass
0 fail
```

Strict TypeScript check over:
- src/artifact-harness/artifact-port.ts
- src/browser-harness/browser-download.ts
- src/browser-harness/notebook99-acceptance.ts

```text
PASS
```

Additional committed Process/Artifact/Effect batch:
```text
21 pass
0 fail
```

## Parallel-lane contamination discovered

During broader regression, WAG workspace routing mapped the successor worktree handle back to
E:/Projects/web-agent-gateway/.worktrees/full-harness-browserport-v1 for command execution and file
mutation. This is a real multi-worktree isolation defect, not a test artifact.

The pre-existing parallel lane currently has uncommitted changes in:
- src/browser-harness/browser-port.ts
- src/browser-harness/cdp-browser-backend.ts
- src/browser-harness/cdp-protocol.ts
- src/browser-harness/node-cdp-transport.ts
- test/browser-harness-semantic.test.ts

Those changes are not included in this slice.

The parallel event-plumbing source currently has its own duplicate-identifier compile error in
node-cdp-transport.ts. Therefore whole-repository build is not used as evidence for this slice.
No attempt is made here to fix or commit those five parallel-lane paths.

## Non-claims

- no browser was opened
- no download was performed against a real website
- no Notebook99 prompt was submitted
- no browser event plumbing is claimed by this slice
- no public MCP tools changed
- no runtime/config was promoted
- no Desktop Commander was used

## Follow-up

Before live Notebook99 acceptance:
1. close the multi-worktree workspace-routing defect;
2. finish and independently gate Browser.* event plumbing;
3. integrate a download driver over Browser.downloadWillBegin/downloadProgress or equivalent;
4. fresh-read E:/AI-BROWSER/PLAYWRIGHT_HANDOFF.md;
5. allocate only a WAG-owned dedicated browser/profile;
6. run one idempotent Notebook99 acceptance transaction.
