# WAG M11 — Semantic Browser Downloads v1

Date: 2026-10-02
Branch: feat/wag-m11-browser-downloads-v1

## Objective

Add a bounded semantic browser download operation for WAG-controlled existing/AI-owned Edge tabs without opening generic CDP access or granting the extension Chrome downloads permission.

## Public tool

`browser.download`

Input:
- `browser_session_id`
- semantic element `ref`
- optional bounded `timeout_ms` (1s..120s)

Output:
- caller-owned `artifact_id`
- sanitized filename
- byte size
- SHA-256

The tool intentionally does not expose the internal capture directory or arbitrary filesystem paths.

## Semantics

1. Verify the caller-owned session and exact target/claim-epoch fencing.
2. Arm a single-download capture before the triggering click.
3. Apply only:
   `Browser.setDownloadBehavior({ behavior: "allowAndName", downloadPath, eventsEnabled: true })`
   through the bounded existing-browser control protocol.
4. Subscribe only to:
   - `Browser.downloadWillBegin`
   - `Browser.downloadProgress`
5. Trigger one semantic click by opaque snapshot ref.
6. Require exactly one download GUID.
7. Reject canceled downloads, multiple GUIDs, missing/unsafe bytes, and capture timeouts.
8. Read bytes only from WAG's owned capture directory using the GUID filename.
9. Persist bytes through ArtifactPort under the caller authority.
10. Return artifact metadata only.

## Security / authority boundaries

- No `chrome.downloads` permission was added.
- No generic debugger/CDP event subscription became model-facing.
- Download events are pushed only for tabs already attached by WAG.
- Extension sanitizes event payloads and drops all unrelated debugger events.
- WAG protocol independently validates the two event schemas.
- `Browser.setDownloadBehavior` is exact-shape and exact-value bounded.
- Target ID + claim epoch are rechecked at the click dispatch boundary.
- The model never supplies a download filesystem path.
- Internal capture paths are not returned by MCP.
- `browser.download` is declared non-idempotent. The current effect ledger stores only result digests, not structured artifact results, so M11 does not claim false exact-once replay semantics.
- If the session backend cannot stream bounded download events, the operation fails before the download-triggering click.

## v1 scope

- Supported path: attached existing Edge tabs and AI_TAB_GROUP sessions backed by the existing-browser control bridge.
- WAG headless/owned backends without that bounded event bridge fail closed before click.
- MIME inference is not claimed in v1; output contains filename, size and SHA-256 plus the artifact handle.

## Acceptance

- Existing-browser protocol/control + WebSocket + CDP driver + runtime/artifact + MCP surface + product doctor suite: 45/45 PASS.
- Runtime integration proves real temporary bytes are moved into an authority-owned ArtifactPort object and hash matches.
- Missing event bridge regression proves zero click dispatch.
- Product suite: 64/64 PASS.
- TypeScript typecheck: PASS.
- Build: PASS.
- `git diff --check`: PASS.

No public push, merge, or live promotion is claimed yet.
