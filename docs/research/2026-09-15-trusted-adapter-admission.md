# Trusted Adapter Admission v1 Research

Date: 2026-09-15
Status: researched architecture input
Design base: `3242746010aaa7f0e93097f2f07aa07169210cb6`

## Question

What is the smallest transport/admission contract that can supply production `GatewayCallerContext` to WAG without turning MCP transport sessions, browser tab/session ids, provider metadata, or local bearer files into durable authority?

The answer must preserve ADR-0014 through ADR-0016, Browser Adapter v1's three-tool read-only surface, and the accepted durable verify core while creating the prerequisite for later exact-owner process management.

## Live repository facts

- `GatewayCallerContext` already defines immutable `ownerId`, `sessionId`, and `adapterId` authority.
- durable workspaces, mutations, and verify jobs already persist the exact authority tuple.
- production HTTP is loopback-only and stateless at MCP transport level, but currently uses one runtime bearer and has no Host/Origin guard.
- Browser Adapter v1 currently filters to `health`, `workspace.open`, and `file.read` in extension/native/link layers only.
- browser protocol `sessionId` is generated in trusted extension code but is explicitly correlation, not WAG authority.
- extension `sessionsByTab` is currently service-worker global memory.
- browser runtime discovery currently contains `{mcpUrl,bearerToken}` and writes with `mode: 0o600`.
- admitted durable verify has no production call sites.

The exact design worktree baseline passed `npm ci` and the full repository suite: 190 passed, 0 failed, with HEAD unchanged at the design base.

## MCP protocol and SDK findings

The current MCP specification revision is `2026-07-28`. Its core is intentionally stateless and removes protocol-level sessions. The MCP maintainers explicitly recommend application-owned handles for state that must survive calls rather than hidden transport session state.

Tasks are now the `io.modelcontextprotocol/tasks` extension. SEP-2663 requires authentication/authorization checks on every task request and explains that cross-caller task scoping cannot be safely inferred from protocol sessions. This directly supports WAG keeping durable identity outside MCP task/session machinery.

The TypeScript SDK v2 line is stable as of 2026-07-27 and implements the 2026-07-28 spec. The v1 line remains maintained; 1.30.0 is current while this repository is exact-pinned to 1.29.0. An SDK migration is not required to solve WAG admission and would mix a dependency/protocol migration into a trust-boundary milestone, so this design does not upgrade it.

Installed v1.29.0 source confirms WAG's current `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` is stateless: no MCP session id is issued or validated. Client `requestInit` headers are merged into every request, so an adapter-specific authorization header can be carried without enabling MCP sessions.

MCP's Streamable HTTP security rules require validating a present `Origin` and returning HTTP 403 when invalid, binding local servers to loopback, and authenticating connections. Current WAG already binds loopback and authenticates, but does not validate Origin or Host.

Relevant primary/upstream sources:

- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://tasks.extensions.modelcontextprotocol.io/seps/2663-tasks-extension
- https://tasks.extensions.modelcontextprotocol.io/
- https://github.com/modelcontextprotocol/typescript-sdk/releases
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md

## Chrome Native Messaging and MV3 findings

Chrome Native Messaging gives WAG a useful adapter provenance signal, but not a complete durable identity. The native-host manifest `allowed_origins` list does not permit wildcards, and Chrome passes the caller extension origin as the native host's first argument. The current native host already validates one exact stable extension origin.

MV3 service workers are ephemeral. Chrome explicitly warns that global variables are lost when a service worker is terminated and recommends extension storage for state. Therefore the current `sessionsByTab` global map cannot be treated as a reliable reconnect identity source.

`chrome.storage.session` is appropriate for a browser-session correlation identifier: it survives service-worker termination while the extension/browser session remains loaded, is cleared on extension disable/reload/update or browser restart, and is not exposed to content scripts by default. This intentionally makes browser restart a new WAG session in v1 rather than silently transferring authority.

Content scripts are less trusted than the extension service worker. Provider DOM/model text and content-script messages therefore remain untrusted inputs. The WAG session credential must never be delivered to page/content-script code.

Relevant primary sources:

- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/reference/api/storage

## Windows local-token limitation

Node's filesystem documentation states that Windows does not implement POSIX owner/group/other permission distinctions and only the write bit is meaningfully changeable through mode APIs. Therefore `writeFile(..., { mode: 0o600 })` does not establish a Unix-like confidentiality boundary on Windows.

The current browser discovery bearer must consequently be treated as a bootstrap secret within the same-user local trust domain, not as proof against arbitrary code already executing as that Windows user. This is acceptable only while the admitted browser profile remains read-only and server-side capability-limited. A stronger bootstrap/OS-isolation gate is required before this path can gain process, terminal, Git, browser-mutation, or equivalent consequential authority.

Primary source:

- https://nodejs.org/api/fs.html

## Multi-session workspace gap found in live code

Identity admission alone is insufficient. Current `createGateway()` keeps workspace bindings in an in-memory map and `file.read` checks only possession of `workspace_id`. It does not receive caller context and cannot distinguish two admitted browser sessions.

Once multiple trusted sessions exist, that would make another session's opaque workspace id usable if it leaked or was guessed/observed. The existing durable `workspaces` table already contains exact `owner_id`, `session_id`, `adapter_id`, canonical root, and backend kind, so admission v1 can close this gap without changing workspace schema.

The admitted browser path therefore needs caller-fenced durable workspace open/read behavior:

- `workspace.open` creates a durable workspace record under the admitted caller tuple;
- `file.read` resolves the durable workspace and requires exact owner/session/adapter equality;
- unknown and wrong-owner workspace ids use the same bounded denial;
- after WAG restart, the same re-admitted WAG session may reuse its workspace id by reopening the backend workspace from the stored canonical root;
- backend workspace handles remain ephemeral evidence, never authority;
- separate sessions opening the same root receive separate WAG workspace ids.

Legacy default/Business behavior remains unchanged unless it is explicitly composed with admitted context in a later milestone.

## Options considered

### A. WAG-owned admission registry — selected

WAG generates and persists its own local owner id and adapter-session ids. Trusted adapter provenance plus a high-entropy correlation identifier can rebind to an existing WAG session, but correlation data never becomes the session id itself. Per-request ephemeral credentials resolve to immutable `GatewayCallerContext` before tool dispatch.

This preserves ADR-0014/0015, survives protocol-library changes, enables exact resource fencing, and composes naturally with the existing durable store.

### B. Adapter-signed authority assertions — rejected for v1

An adapter could mint/sign identity assertions and make WAG mostly stateless. This shifts authority minting, key rotation, revocation, and trust-policy complexity into every adapter and weakens WAG's position as the control plane. It may be useful for a future multi-machine deployment, but is unnecessary locally.

### C. Transport/browser ids as authority — rejected

Using `MCP-Session-Id`, the runtime bearer, browser protocol `sessionId`, tab id, URL, conversation id, request id, or provider metadata would violate accepted identity contracts and couple durable ownership to replaceable transport/provider state. MCP 2026's removal of protocol sessions makes this approach especially brittle.

## Recommended v1 contract

Persist one WAG-local principal identity and an adapter-session registry. A browser session record is keyed by a domain-separated SHA-256 digest of trusted browser correlation plus owner and adapter identity. Persist no raw browser correlation value and no bearer credential.

Admission uses a bootstrap-only bearer that is accepted only by a strict local admission endpoint, never by `/mcp`. The browser/native runtime profile fixes adapter identity and capability profile outside request/model arguments. Successful admission returns a fresh in-memory session bearer mapped to the exact `GatewayCallerContext`; re-admitting the same active correlation invalidates/replaces the previous ephemeral bearer while preserving the same WAG session id.

WAG restart invalidates all ephemeral session bearers. The native host re-admits using its bootstrap channel and the same `chrome.storage.session` correlation, which recovers the same persisted WAG session id. Browser restart clears that correlation and creates a new WAG session; no durable ownership is silently transferred.

The browser capability profile is enforced at the MCP server boundary, not only by extension/native/link filtering. Browser sessions expose exactly `health`, `workspace.open`, and `file.read`; `repo.snapshot`, `verify.run`, mutation, job, process, terminal, Git, and browser-mutation capabilities are absent/denied.

The raw HTTP boundary additionally validates the local Host and rejects every request carrying an Origin header in v1. Native/local clients that omit Origin remain supported. These checks run before admission or MCP dispatch.

## Decision limits

This research does not authorize durable verify projection, public job APIs, cancellation, generic process/PTY execution, Git writes, browser mutation, an SDK upgrade, or Remote Desktop Commander replacement.

The Windows bootstrap-token limitation is explicitly accepted only for the read-only browser profile. It is not evidence that the same bootstrap path is safe for future consequential authority.

The next milestone after this admission gate remains the exact-owner process-manager design. Any later projection of durable verify or mutation through a host requires a separate capability-specific review.

## Research judgment

Proceed with WAG-owned adapter admission, stateless MCP transport, per-request ephemeral caller credentials, server-side adapter capability profiles, and exact-owned durable workspace fencing. Reject transport-session authority and do not upgrade MCP SDK as part of this milestone.

## Chrome tab-key follow-up

Fresh official Chrome Tabs API documentation states that `tabs.Tab.id` values are unique within a browser session. Combined with `chrome.storage.session` being scoped to the extension/browser session, this supports using the numeric tab id only as the extension-local lookup key for a stored random correlation value across MV3 service-worker termination.

The tab id itself remains non-authoritative and is never persisted by WAG as ownership. `tabs.onRemoved` should delete the corresponding session-storage entry; browser restart clears the storage domain and intentionally causes a new WAG session.

Primary source:

- https://developer.chrome.com/docs/extensions/reference/api/tabs