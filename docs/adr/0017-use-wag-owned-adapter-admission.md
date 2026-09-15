# ADR-0017: Use WAG-Owned Trusted Adapter Admission

Date: 2026-09-15
Status: Accepted
Depends on: ADR-0014, ADR-0015, ADR-0016, `TRUSTED_CALLER_CONTEXT_V1 = PASS`, `DURABLE_VERIFY_JOB_CORE_V1 = PASS`
Research: `docs/research/2026-09-15-trusted-adapter-admission.md`
Acceptance receipt: `docs/benchmarks/2026-09-16-trusted-adapter-admission-v1.md`

## Decision

WAG will own adapter admission and mint the authority-bearing `owner_id`, `session_id`, and `adapter_id` used to construct `GatewayCallerContext` for production host adapters.

MCP transport sessions, browser protocol session ids, tab ids, provider conversation ids, URLs, request ids, bearer tokens, native-host process identity, and backend handles remain correlation or transport credentials only. None may become durable WAG authority.

Admission is an application/control-plane contract above the transport. MCP HTTP remains stateless. Every admitted request is authenticated independently and resolves to an immutable WAG caller context before semantic tool dispatch.

## WAG-owned identity

A local WAG state database contains one opaque WAG-generated local principal id. It is stable across WAG restart for that state database and is not derived from Windows username/SID, provider identity, browser profile, transport token, or model-controlled input.

Each admitted adapter interaction context has a WAG-generated `session_id`. The trusted runtime profile supplies `adapter_id`; request/model arguments cannot choose or override it.

Browser/native correlation may allow trusted composition to recover an existing WAG session, but only through the admission registry. The raw correlation value is not persisted as authority and is never returned to model/page code as an authority credential.

A browser restart starts a new v1 WAG session. Rebinding an old session across a browser restart or transferring child resources requires a separate future contract.

## Credential classes

The browser/native path uses two different credential classes with deliberately different authority.

A bootstrap credential exists only to authenticate the installed local adapter to one strict admission endpoint. It cannot call `/mcp`, cannot select an adapter profile, and cannot directly authorize semantic tools.

Successful admission issues a fresh high-entropy ephemeral session bearer. That bearer is held only in runtime/native-host memory and maps server-side to one exact admitted caller context and capability profile. It is not persisted, not logged, not put into browser protocol messages, and not exposed to page/content-script code.

WAG restart invalidates ephemeral session bearers. Re-admission may recover the same persisted WAG `session_id` only if the exact trusted adapter profile and stored correlation digest match. Re-admission rotates the ephemeral bearer; stale bearers fail closed.

The current Windows discovery file is not a strong boundary against arbitrary same-user code because POSIX `0o600` semantics are not available on Windows. V1 therefore permits its bootstrap credential only for a server-enforced read-only browser profile. Consequential capability enablement requires a separately accepted stronger bootstrap/isolation design.

## Browser correlation lifecycle

The extension service worker stores its per-tab/browser-session correlation identifiers in `chrome.storage.session`, not JavaScript globals. This survives service-worker termination but intentionally does not survive browser restart, extension reload/update, or disablement.

Provider DOM, page text, content-script data, and conversation identifiers never determine WAG ownership. The extension/native path may record bounded provider metadata only as non-authoritative correlation.

Native Messaging's exact installed extension origin is admission provenance evidence. It is necessary for the browser profile, but possession of an extension-origin transport alone is not sufficient to access WAG resources without successful admission.

## Server-side capability profile

Capability authorization is enforced by WAG after admission. Adapter-local filtering is defense in depth, not the authorization source.

Trusted Adapter Admission v1 defines exactly one production admitted profile: Browser Adapter v1. Its MCP surface is exactly `health`, `workspace.open`, and `file.read`.

An admitted browser credential cannot discover or invoke `repo.snapshot`, `verify.run`, mutation tools, durable job APIs, process/terminal operations, Git writes, browser mutation, or generic forwarding, even if those capabilities exist elsewhere in the same process or codebase.

Default and Business stdio surfaces retain their current five-tool behavior and are not silently converted to browser admission semantics.

## Owned workspace boundary

Admission is not considered complete unless resources created through the admitted profile are fenced by the admitted caller context.

Browser-admitted `workspace.open` persists a WAG workspace record with the exact owner/session/adapter tuple. Browser-admitted `file.read` requires that exact tuple before returning data. Unknown workspace ids and valid ids owned by another tuple use the same bounded denial.

The durable workspace record, not an in-memory DevSpace workspace handle, is the authority source. After WAG restart, re-admission of the same WAG session may reopen the stored canonical root through the configured backend and continue using the same opaque workspace id. Backend handles are replaceable runtime evidence only.

Two admitted sessions that open the same canonical root receive distinct workspace ids. V1 does not transfer, share, merge, or re-parent workspace ownership.

## HTTP boundary

The local HTTP server remains loopback-only. Before admission or MCP dispatch, WAG validates the Host as a permitted local listener host and rejects malformed or unexpected hosts.

Browser/native v1 never needs a web page to call local WAG HTTP directly. Therefore any request carrying an `Origin` header is rejected with HTTP 403. Authenticated non-browser clients that omit Origin remain compatible with the internal native link.

The bootstrap bearer is accepted only at the admission endpoint. The ephemeral admitted bearer is accepted only at the admitted MCP path. Credential-class substitution fails closed.

## Persistence and recovery

The admission registry persists only WAG identity/session metadata and a domain-separated digest of correlation material. It does not persist raw correlation identifiers, bootstrap/session bearer values, MCP transport session ids, browser tab ids, provider conversation data, or backend handles as authority.

A repeated admission for the same local principal, adapter profile, and correlation digest returns the same WAG session id while rotating the ephemeral bearer. A different correlation produces a different WAG session.

Transport/native-host disconnect does not revoke or delete durable WAG resources. Session revocation, expiry leases, resource garbage collection, and ownership transfer are outside v1 and require explicit later lifecycle policy.

## MCP and SDK boundary

MCP session/task identifiers remain compatibility handles. WAG admission does not enable MCP protocol sessions and does not make SDK task state authoritative.

The repository remains pinned to `@modelcontextprotocol/sdk` 1.29.0 for this milestone. The existence of SDK v2 and MCP 2026-07-28 is architecture evidence for transport independence, not authority to combine an SDK migration with admission.

## Consequences

WAG gains a production provenance-to-caller-context seam for the read-only browser adapter while keeping identity independent from protocol/provider details. Durable workspace ownership becomes meaningful across concurrent admitted sessions and WAG restart.

The design intentionally accepts that the current Windows discovery/bootstrap token is same-user local trust rather than a strong sandbox boundary. This blocks promotion of the same bootstrap path to consequential authority until a stronger gate is separately designed and accepted.

## Non-goals

This ADR does not authorize durable verify projection, mutation projection, public `job.*`, cancellation, process reattachment, arbitrary commands, PTY, Git writes, browser automation/mutation, provider account identity, cross-machine identity, browser-restart session recovery, SDK migration, or Remote Desktop Commander replacement.

Changing identity provenance, browser capability profile, workspace ownership semantics, credential-class separation, or the Windows bootstrap trust assumption requires a new reviewed decision and acceptance evidence.

## Candidate native-host refresh amendment — 2026-09-16

Full candidate verification exposed a direct dependency that the original design treated as avoidable: bind-time admission changes the native-host executable bytes. Research receipt: `docs/research/2026-09-16-trusted-adapter-admission-native-host-refresh.md`.

The existing `NATIVE_HOST_DISTRIBUTION = PASS` and `NATIVE_HOST_INSTALLATION = PASS` receipts remain historical facts for source `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d`. Admission v1 does not rewrite or silently supersede them.

For an admission candidate whose native-host bundle inputs differ from the last accepted distribution, use `CURRENT_CANDIDATE_NATIVE_HOST_DISTRIBUTION = REACCEPT_REQUIRED`. A local or feature-branch executable hash is evidence only and cannot become accepted distribution identity.

Source implementation may be accepted as `TRUSTED_ADAPTER_ADMISSION_V1 = IMPLEMENTED_AWAITING_NATIVE_HOST_REFRESH` after full source/security verification and independent review. Final `TRUSTED_ADAPTER_ADMISSION_V1 = PASS` additionally requires a successor exact-main distribution receipt, successor installation verification after separately authorized registration, and supported-browser-host reacceptance against that installed binary.

Repository regression tests may test installation-verifier behavior with hermetic synthetic fixtures. They must not modify the committed production verifier or accepted installation constants merely to make current-source builds match historical artifact identity.

This amendment does not authorize registry mutation, host replacement, browser mutation, or any broader capability. Distribution, installation, and supported-host gates remain fail-closed and sequential.
