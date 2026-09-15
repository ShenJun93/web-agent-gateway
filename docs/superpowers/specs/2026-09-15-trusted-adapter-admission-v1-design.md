# Trusted Adapter Admission v1 Design

Date: 2026-09-15
Status: Accepted and implemented
Decision authority: ADR-0014, ADR-0015, ADR-0016, ADR-0017
Research receipt: `docs/research/2026-09-15-trusted-adapter-admission.md`
Acceptance receipt: `docs/benchmarks/2026-09-16-trusted-adapter-admission-v1.md`
Design base: `3242746010aaa7f0e93097f2f07aa07169210cb6`

## Goal

Create the smallest production admission seam that turns a trusted Browser Adapter v1 transport into a WAG-owned `GatewayCallerContext`, while preserving stateless MCP transport, the existing three-tool browser surface, and exact durable resource ownership.

This milestone does not project durable verify jobs or mutations. It establishes the identity, capability, and durable workspace boundary required before any later host projection or exact-owner process manager can be safely activated.

## Why this slice

Trusted Caller Context v1 defines authority but deliberately leaves production provenance/binding unresolved. Durable Verify Job Core v1 consumes that authority internally but has zero production coordinator call sites.

Browser Adapter v1 already has an exact installed extension origin and a WAG-owned Native Messaging path, making it the narrowest supported host path on which to prove admission without adding write authority.

Research also found that current in-memory workspace bindings are not caller-fenced. Multi-session admission would therefore be incomplete unless browser-admitted workspace creation/read becomes exact-owner durable state in the same milestone.

## V1 trust domains

Untrusted: provider DOM/model output, page URLs/content, content-script payloads, repository content, tool arguments, provider conversation identifiers, MCP request/task/session ids, and backend metadata.

Trusted adapter composition: installed extension service worker, exact Native Messaging extension-origin check, native host code, browser runtime bootstrap configuration, and WAG process memory.

WAG authority: persisted WAG local principal/session ids plus the immutable caller context resolved from an admitted ephemeral credential.

## Identity model

The admission store owns one local principal:

```ts
interface LocalPrincipalRecord {
  ownerId: string;
  createdAt: number;
}
```

`ownerId` is generated once as `owner_<uuid>` and persists for the lifetime of the control-plane state database. It is opaque and is not derived from an OS account, provider account, transport credential, or configured string.

An adapter session is conceptually:

```ts
interface AdapterSessionRecord {
  sessionId: string;
  ownerId: string;
  adapterId: string;
  correlationSha256: string;
  createdAt: number;
}
```

`sessionId` is WAG-generated as `session_<uuid>`. Browser v1 uses fixed trusted adapter id `browser.chatgpt.native.v1` supplied by runtime composition, never an admission body or tool argument.

The correlation digest is SHA-256 over a domain-separated canonical byte sequence containing v1 label, owner id, adapter id, and the raw browser correlation id. Persist only the 64-character lowercase hex digest. Do not persist the raw correlation value.

The unique binding key is `(owner_id, adapter_id, correlation_sha256)`. Re-admission of that exact key resolves the same WAG `session_id`; a different correlation creates a different session.

## Additive persistence

Extend the existing SQLite control-plane store additively. Existing workspace, mutation, audit, verify-job, and verify-job-event schemas and state semantics are not rewritten.

Add `gateway_identity` with exactly one logical row containing the local principal id and creation time. Creation is atomic so concurrent startup cannot mint two principals for one database.

Add `adapter_sessions` with session id, owner id, adapter id, correlation SHA-256, and creation time. Enforce uniqueness of `(owner_id, adapter_id, correlation_sha256)`.

No bootstrap token, admitted bearer, raw browser correlation, tab id, provider conversation id, MCP session/task id, URL, canonical root duplication, backend workspace id, or native-host pid is added to these tables.

The admission registry exposes narrow operations conceptually equivalent to:

- `getOrCreateLocalPrincipal()`;
- `admitCorrelation(adapterId, rawCorrelation)` returning a validated immutable `GatewayCallerContext`;
- exact read-only inspection helpers required by tests only.

It does not expose ownership transfer, session enumeration to host clients, revocation, lease extension, or cleanup-all behavior.

## Browser correlation contract

The existing browser protocol `sessionId` remains correlation only. Its v1 validation stays 8-128 ASCII-safe characters. The extension continues to generate it with `crypto.randomUUID()` under a `session_` prefix.

The extension moves per-tab correlation state out of service-worker globals and into `chrome.storage.session`. It removes a tab's correlation on a trusted tab-removal lifecycle event where practical. Service-worker termination/restart must not rotate an existing live-tab correlation.

Browser restart, extension reload/update, or disable clears `storage.session`; a later browser interaction therefore creates a new correlation and a new WAG session. V1 does not reconnect old durable child resources across that boundary.

Provider conversation ids/URLs may later become bounded correlation metadata, but they cannot select an existing WAG session and are not needed for this gate.

The extension stores correlation under an extension-local key derived from the numeric tab id. Chrome documents tab ids as unique within one browser session; the stored value is still the random browser correlation id, not the tab id itself. `tabs.onRemoved` removes that entry. Neither tab id nor storage key is sent to WAG as authority.

## Credential and endpoint contract

Browser runtime generates a cryptographically random bootstrap token with at least 256 bits of entropy on each WAG runtime start. Discovery state changes from a generic MCP credential into an explicit bootstrap record containing only the local admission URL and bootstrap token.

The bootstrap token is accepted only by `POST /adapter/admit`. It is rejected at `/mcp` and any other route. The admission request is strict JSON containing only:

```json
{ "correlation_id": "session_<opaque>" }
```

The request cannot carry owner, WAG session, adapter id, provider, tool profile, workspace id, or capability fields. Runtime composition fixes those values.

Successful admission creates or resolves the WAG session and returns only the local MCP URL plus a fresh random session bearer with at least 256 bits of entropy. It does not return owner/session/adapter authority ids to the native host because the native host does not need them.

Session bearer state is memory-only. The server stores only what is needed to map a bearer securely to one immutable caller context and the fixed Browser Adapter v1 capability profile. Raw bearer values are never persisted or logged.

Re-admitting the same correlation rotates its session bearer and invalidates the previous bearer while preserving the same persisted WAG session id. Re-admitting a different correlation cannot invalidate or adopt another session.

A best-effort authenticated release operation may invalidate the currently held session bearer on unbind/normal native-host close. Native-host crash or transport loss does not delete the persisted WAG session or child resources.

## Local HTTP security contract

All browser-admission HTTP remains bound to `127.0.0.1` in v1. The server records its actual listener port and accepts only the exact `Host: 127.0.0.1:<port>` value for this runtime. Missing, malformed, alternate, userinfo-like, or unexpected Host values fail with HTTP 403 before reading capability payloads.

The browser/native path has no direct web-page HTTP caller. Any request carrying an `Origin` header is therefore rejected with HTTP 403 in v1. A missing Origin is allowed only after the applicable bearer check succeeds. This is intentionally stricter than a browser origin allowlist.

`POST /adapter/admit` requires `Authorization: Bearer <bootstrap-token>` and `Content-Type: application/json`. The decoded request body is independently capped at 4 KiB before strict schema validation. Anonymous, wrong-token, wrong-method, oversized, malformed, or extra-field requests fail without creating an adapter session.

`POST /mcp` requires `Authorization: Bearer <session-token>`. The bootstrap token cannot authenticate this path. Caller context and capability profile are resolved before an MCP server/tool surface is instantiated for that request.

`POST /adapter/release` requires the current session bearer and invalidates only that exact in-memory credential. It does not delete the persisted adapter-session row or any durable child resource.

Bearer comparisons use constant-time comparison where equal-length secret material is directly compared; credential lookup must not emit raw bearer content in diagnostics. Remote errors stay bounded and never include authority ids, correlation digests, roots, tokens, or backend handles.

The existing generic/default HTTP test surface remains compatible where it is not composed as Browser Adapter v1. Admission-specific credentials and tool filtering are opt-in runtime composition, not a global reinterpretation of all HTTP MCP clients.

## Server-side Browser Adapter v1 capability profile

The admitted browser profile is an exact allowlist enforced by WAG when it constructs the per-request MCP surface:

- `health`;
- `workspace.open`;
- `file.read`.

No other tool is registered for a browser-admitted request. In particular `repo.snapshot` and `verify.run` remain unavailable even though they exist on the default five-tool surface. Mutation, durable job, cancellation, process/PTY, Git, browser mutation, and generic forwarding are also absent.

`McpLocalAdapterLink` and the browser/native protocol retain their existing three-tool allowlists as independent defense-in-depth. Their checks do not substitute for server-side filtering.

Tool input schemas remain unchanged and strict. No model-visible schema gains owner/session/adapter, correlation, bearer, adapter profile, provider identity, or browser tab fields.

## Exact-owned durable workspace path

Browser-admitted `workspace.open` receives `GatewayCallerContext` from runtime composition, never from tool arguments. It performs the existing canonical/allowed-root admission and backend open, then persists a durable workspace row under the exact caller tuple before returning the opaque WAG `workspaceId`.

Browser-admitted `file.read` loads the durable workspace row and checks exact owner/session/adapter equality before exposing any data. An unknown workspace id and a valid workspace id belonging to another tuple produce exactly the same bounded denial: `Gateway denied workspace`.

The caller cannot select backend kind or canonical root except through the already-reviewed `workspace.open` path argument and allowed-root/canonicalization policy. Persisted workspace rows continue using backend kind `devspace` in this milestone.

A process-local cache may associate `workspaceId` with an ephemeral DevSpace workspace handle. The cache is convenience only and may be empty after restart. It cannot bypass durable ownership or filesystem policy checks.

## Workspace restart behavior

After WAG restart, the prior session bearer is invalid. The native host re-admits the same browser correlation and receives a new bearer that resolves to the same persisted WAG session id.

When that caller uses an existing owned workspace id and no live backend binding exists, WAG revalidates the stored canonical root against the current configured allowed roots and canonicalization policy before reopening it through the configured DevSpace backend.

If the root no longer exists, no longer passes current allowed-root policy, resolves to a different canonical root, has an unsupported backend kind, or the durable tuple does not exactly match the caller, WAG fails before reading file content. Reopen never rewrites the durable workspace owner or canonical root.

Each concrete file read still performs the existing normalized relative-path, sensitive-path, resolved-containment, binary, and output-size checks. Durable workspace admission is not a sandbox and does not replace per-operation policy.

Two different admitted sessions opening the same path create different WAG workspace ids. Neither can read through the other's id. There is no workspace sharing, adoption, transfer, aliasing, or ownership merge in v1.

## Native-host binding changes

The native host no longer establishes an MCP link before it knows the browser correlation. `session.bind` is the point at which it uses the bootstrap discovery channel to admit that correlation and create an authenticated browser-readonly `LocalAdapterLink`.

The native protocol bind response continues to refer only to browser protocol correlation/provider data; it does not expose the internal WAG owner/session/adapter ids or admitted bearer.

`session.unbind` releases/closes only the currently bound local link and its ephemeral bearer. It does not revoke the durable WAG session. Switching browser tabs therefore cannot delete or transfer another tab's durable resources.

Native-host reconnect followed by bind of the same still-live browser correlation recovers the same WAG session through the admission registry. Duplicate request-id and exact-one-bound-browser-session rules remain unchanged.

## Control-plane composition boundary

Admission v1 does not make the generic `GatewayApi` globally caller-aware. The existing default/Business gateway methods keep their current compatibility semantics.

Introduce a browser-admitted composition seam that receives the resolved `GatewayCallerContext`, the exact Browser Adapter v1 capability profile, the durable store, and the DevSpace execution dependency. Conceptually it owns only admitted `workspace.open` and `file.read` behavior.

The per-request browser MCP server registers only the three approved tools. `health` may reuse the existing gateway health operation because it creates no owned durable resource. Browser `workspace.open` and `file.read` route through the admitted workspace seam rather than the legacy in-memory-only methods.

This separation prevents a browser admission refactor from silently changing Business/default workspace semantics and keeps later capability projections explicit.
## Error and failure semantics

Admission failures are fail-closed and never fall back to the legacy runtime bearer or a broader MCP surface. Bootstrap-token failure, session-token failure, Host/Origin failure, malformed correlation, and caller/workspace mismatch all stop before semantic capability execution.

Unknown and wrong-owner workspace ids deliberately use the same caller-facing denial. Adapter-session lookup failures do not reveal whether a correlation digest or WAG session exists.

If durable workspace reopen fails after restart, the stored record remains unchanged; WAG returns a bounded denial/error and does not manufacture a replacement workspace id or broaden allowed-root policy.

Native-host/admission transport errors are bounded at the browser protocol boundary. Raw HTTP errors, SQLite diagnostics, canonical roots, correlation digests, authority ids, bearer values, and backend handles are not propagated to provider/page code.
## Expected implementation footprint

Create, names may be refined only without widening semantics:

- `src/adapter-admission.ts` for principal/session admission, correlation hashing, and in-memory session-bearer issuance/rotation;
- `src/admitted-workspace.ts` for exact-caller durable browser workspace open/read and backend reopen;
- focused unit tests for admission, credential rotation, workspace ownership, and restart behavior.

Modify only as required:

- `src/durable-store.ts` additively for `gateway_identity` and `adapter_sessions` plus exact test helpers;
- `src/http-server.ts` for optional admission/release routes, Host/Origin guards, credential-class routing, and caller-aware browser MCP composition;
- `src/server.ts` only to support an exact three-tool admitted MCP surface without changing default five-tool behavior;
- `src/browser-adapter/local-link.ts`, `native-host.ts`, browser protocol/runtime, and extension service worker for bind-time admission and `chrome.storage.session` correlation persistence;
- corresponding transport/browser/workspace/security tests.
Do not modify durable mutation or durable verify state-machine semantics, operator approval, verify profiles, DevSpace OAuth, native-host installation/distribution identity, package dependencies, SDK version, Business stdio behavior, or browser tool names in this milestone unless a RED test proves a direct unavoidable dependency and the design is reviewed again.

## Verification strategy

Admission-store tests must prove one principal per database, persistence across reopen, deterministic domain-separated correlation hashing, uniqueness of `(owner, adapter, digest)`, same-correlation session reuse, different-correlation isolation, and absence of raw correlation/bearers from SQLite.

Credential tests must prove at least 256-bit bootstrap/session entropy, session bearer rotation on re-admission, stale bearer rejection, credential-class substitution rejection, exact-bearer release only, and WAG restart invalidating all session bearers while preserving the WAG session mapping.

HTTP tests must cover exact Host acceptance, malformed/alternate Host rejection, all present Origin headers returning 403, bootstrap-only admission, session-only MCP, method/content-type/body-size/schema failures, bounded diagnostics, and no bearer/authority leakage.
Browser extension/native-host tests must prove service-worker restart preserves live-tab correlation through `chrome.storage.session`, browser-session reset creates a fresh correlation, page/content-script inputs cannot choose identity, native-host bind admits before MCP connect, reconnect of the same correlation recovers the same WAG session, and one native binding cannot use another correlation's bearer.

Workspace tests must independently reject wrong owner, wrong session, and wrong adapter; make unknown and wrong-owner ids indistinguishable; prove two sessions opening the same root receive different ids; prove restart reopen uses the same owned id; and prove root/policy/backend drift fails before file access without rewriting the record.

Surface tests must prove browser-admitted MCP exposes exactly three tools and cannot invoke `repo.snapshot`, `verify.run`, mutation/job/process/Git/browser-mutation operations even if another server composition exposes them. Default MCP and Business stdio remain exactly five tools.

Security regression must retain current path containment, secret scrub, native-host exact-origin, distribution/installation, browser request-shape, durable mutation, and durable verify tests. Full candidate verification remains `npm test`, `npm run typecheck`, `npm run build`, `npm run test:business`, `git diff --check`, exact-pinned DevSpace acceptance, and independent exact-diff review.
## Trusted runtime state path

The admitted browser runtime requires an absolute trusted `statePath` for the SQLite control-plane database. It is supplied by local runtime composition, not by private repository config, provider content, browser messages, MCP arguments, or environment inherited by repository commands.

The runtime opens that database before serving admission, runs additive schema initialization, and reuses it across WAG restarts. `ownerId`, adapter-session mappings, durable workspaces, mutations, and verify jobs may therefore share one control-plane database without sharing authority semantics.

Changing `statePath` points at a different WAG authority domain and creates a different local principal. V1 does not merge, import, or migrate authority between state databases.

The browser discovery record does not disclose `statePath`.
## Ephemeral bearer handling

Session bearer generation uses a cryptographically secure random source and returns the raw bearer only once to the admitted native/local client. WAG keeps only an in-memory domain-separated SHA-256 digest mapped to the immutable caller context and capability profile.

Incoming `/mcp` and `/adapter/release` bearer values are digested before lookup. Re-admission removes the previous digest for that WAG session before installing the replacement digest, so two simultaneously valid credentials are not created by ordinary rotation.

Bearer digests are runtime credential indexes only. They are not written to SQLite, durable event rows, telemetry, browser protocol responses, or operator UI. Runtime shutdown drops the entire map.
## Acceptance gate

`TRUSTED_ADAPTER_ADMISSION_V1 = PASS` requires all of the following on one exact candidate:

1. WAG atomically owns one persisted local principal per control-plane database and mints adapter-session ids independently from MCP/browser/provider ids;
2. browser re-admission of the same trusted correlation after native-host or WAG restart resolves the same persisted WAG session while issuing a fresh ephemeral bearer; browser restart/new correlation creates a new WAG session;
3. bootstrap and session credentials are cryptographically strong, class-separated, non-persistent where required, rotated/released exactly, and absent from logs, browser protocol, durable rows, and host-visible tool data;
4. the local HTTP boundary remains loopback-only, accepts only the exact runtime Host, rejects every present Origin with 403, and rejects malformed/oversized/unauthenticated admission before session creation;
5. browser-admitted MCP is server-side limited to exactly `health`, `workspace.open`, and `file.read`; bypassing extension/native/link allowlists cannot reveal or invoke broader tools;
6. browser workspaces are persisted under the exact caller tuple, unknown/wrong-owner ids are indistinguishable, and wrong owner/session/adapter independently fail closed;
7. the same owned workspace id can be safely reopened after WAG restart only when current root/backend/policy checks still pass, without rewriting durable ownership or canonical-root identity;
8. two admitted sessions opening the same root receive different workspace ids and cannot read through each other's ids;
9. model/page/content-script inputs cannot choose or override owner/session/adapter/profile/bearer authority, and Browser Adapter v1 still exposes no mutation, verify, job, process, PTY, Git, or browser-mutation authority;
10. default MCP and Business stdio retain their existing five-tool behavior, all prior security/durable/native-host tests remain green, and focused/full verification plus independent exact-diff review have zero Critical/Important findings.
## Approaches rejected

**Promote MCP protocol/session/task identity into WAG authority:** rejected because MCP core is stateless in the current protocol direction and task authorization is per request. It would also violate ADR-0014/0015 and couple resource ownership to replaceable SDK/protocol machinery.

**Promote browser protocol `sessionId` directly into WAG `sessionId`:** rejected even though the extension generates it in trusted code. The browser id is an adapter correlation handle whose lifecycle is controlled by browser state; WAG must own the durable authority id and explicit rebind semantics.

**Use one runtime bearer for admission and MCP:** rejected because compromise or accidental exposure of the discovery credential would immediately collapse bootstrap and semantic capability authority into one secret.

**Rely only on extension/native/link tool filtering:** rejected because a credential presented directly to the local MCP endpoint would bypass adapter-local defense. Capability authorization must exist at the WAG server boundary.
## Migration and compatibility

This milestone changes only Browser Adapter v1 runtime composition. The default MCP server and Business stdio server retain their existing caller-unaware compatibility path and five-tool surface.

Existing browser protocol tool names and semantic arguments remain unchanged. `session.bind` keeps its browser-correlation field, but the native host now uses it to obtain a WAG-owned admitted context instead of treating a preconnected generic MCP link as sufficient.

Existing durable workspace rows remain valid. Browser-admitted workspaces created after this milestone use the same existing workspace schema and exact authority tuple; no workspace-table migration or ownership rewrite is permitted.

There is no SDK or dependency migration in this milestone.
## Non-goals

Trusted Adapter Admission v1 does not authorize or implement durable verify projection, mutation projection, public `job.*`, task cancellation, process reattachment, arbitrary command execution, persistent PTY, Git writes, browser automation/mutation, provider-account identity, cross-machine identity, browser-restart session recovery, session sharing/transfer, leases/revocation policy, garbage collection, SDK migration, or Remote Desktop Commander replacement.

It also does not claim that the current Windows discovery/bootstrap token resists arbitrary code already running as the same Windows user. That limitation remains an explicit blocker for promoting this browser bootstrap path to consequential authority.

## Follow-up sequence

After `TRUSTED_ADAPTER_ADMISSION_V1 = PASS`, do not automatically promote a process manager or any consequential capability. The immediate evidence-gathering sequence is architecture/docs reconciliation, then a bounded MCP v2 / protocol `2026-07-28` compatibility spike, then a current-market viability re-benchmark. These steps may measure compatibility and product fit, but they do not widen trust or tool authority.

Evidence from those gates selects the next implementation milestone. **Exact-Owner Process Manager v1** remains one candidate when measured process ownership/recovery needs justify it; durable verify projection and stronger Windows bootstrap/isolation remain separate candidates. Browser Adapter v1 stays read-only until a separately reviewed consequential-authority gate passes.
## Bootstrap trust precision

The HTTP admission endpoint does not claim to cryptographically attest the Chrome extension against arbitrary same-user Windows code. Exact extension-origin validation occurs at the Chrome Native Messaging/native-host boundary; `/adapter/admit` authenticates possession of the runtime bootstrap credential within the accepted same-user local trust domain.

This distinction is why Browser Adapter v1 remains read-only and server-side capability-limited. Future consequential authority must not reuse bootstrap possession as if it were stronger OS-level caller attestation.
## Native-host distribution refresh amendment — 2026-09-16

Full verification of candidate `8bfd17928649e2c3bbaf2b20852342e9c9fd5227` proved that bind-time admission necessarily changes native-host executable bytes. The original expectation that distribution/installation identity would remain unchanged is superseded by this amendment. See `docs/research/2026-09-16-trusted-adapter-admission-native-host-refresh.md`.

Historical distribution and installation receipts remain valid only for their exact accepted source and artifact. They are never rewritten to name a feature-branch or locally rebuilt executable.
When admission changes native-host bundle inputs, acceptance becomes two-phase.

Source phase: focused/full repository verification, authority audit, and independent review may establish `TRUSTED_ADAPTER_ADMISSION_V1 = IMPLEMENTED_AWAITING_NATIVE_HOST_REFRESH`.

Release/host phase: after merge, the exact `main` push must publish and verify a successor native-host distribution. Installation must then be reaccepted after a separately authorized registration switch, and supported-browser-host acceptance must run against that successor installation before final PASS.

Until the release/host phase completes, record `CURRENT_CANDIDATE_NATIVE_HOST_DISTRIBUTION = REACCEPT_REQUIRED` and do not claim `TRUSTED_ADAPTER_ADMISSION_V1 = PASS`.

Repository regression tests must separate verifier logic from release freshness. Installation-verifier execution tests may use a hermetic synthetic fixture and a temporary verifier copy whose expected executable hash is changed only for that fixture. The committed verifier, accepted distribution/install constants, and their static/AST safety checks remain unchanged.

A feature-branch/local executable hash is never sufficient release provenance. Only the existing main-push distribution workflow may produce the successor artifact identity consumed by the later installation gate.

This amendment authorizes no HKCU mutation, installed-host replacement, cleanup, browser mutation, or capability widening. Those remain separate fail-closed checkpoints.

The successor workflow run id, attempt, and executable hash are observed only after the feature source is merged and the `main` push workflow completes. A narrow follow-up reacceptance change may then pin those observed values into installation acceptance constants, the committed read-only verifier, and a successor receipt.

That reacceptance change must not modify `native-host.ts`, `native-host-main.ts`, `local-link.ts`, their bundled dependencies, the SEA builder, or other native-host bundle inputs. If it does, the successor artifact no longer represents the code being accepted and distribution must be reconsidered again.
