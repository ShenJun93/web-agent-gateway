# P1 — ChatGPT WAG Direct Access Research

**Date:** 2026-09-21  
**Role:** P1 — ChatGPT WAG Direct Access Research Owner  
**Canonical future repository:** `E:\Projects\chatgpt-wag-access`  
**Research artifact:** `P1_CHATGPT_WAG_DIRECT_ACCESS_RESEARCH_2026-09-21.md`  
**WAG authority snapshot used:** `ShenJun93/web-agent-gateway` `main@bd2727a1c3792f60b72f6c470b3034481b294e72` (retrieved 2026-09-21; commit dated 2026-09-20)  
**OpenAI tunnel-client current release checked:** `v0.0.14`, published 2026-09-01  
**Decision posture:** Research only. No WAG mutation. No large implementation.

---

## Evidence-status vocabulary

- **FACT** — directly supported by current primary/upstream evidence.
- **INFERENCE** — conclusion derived from confirmed facts; not directly promised by the platform.
- **RECOMMENDATION** — proposed design/next action.
- **UNVERIFIED ASSUMPTION** — terminology or behavior not yet confirmed in canonical authority.
- **EMPIRICAL TEST NEEDED** — must be proven on the target workstation/product surface before acceptance.

Evidence IDs in the body resolve to the Evidence Ledger in §6. This is intentional: other sessions should be able to cite an evidence ID instead of repeating the research.

---

# 1. Executive summary

## Decision

**RECOMMENDATION — preferred architecture**

Use the current supported OpenAI private-MCP route:

```text
Normal ChatGPT web session (ChatGPT Business custom MCP app)
        |
        | MCP tool calls + OpenAI client metadata
        v
OpenAI-hosted Secure MCP Tunnel endpoint
        |
        | outbound-only tunnel transport
        v
OpenAI tunnel-client on the Windows workstation
        |
        | local stdio MCP
        v
WAG `serve-stdio`
        |
        | WAG-owned admission / policy / ownership / approvals / effects
        v
DevSpace + bounded local repository resources
```

This is a composition of the **supported ChatGPT custom-app path + MCP + Secure MCP Tunnel**, not a new browser bridge. ChatGPT cannot directly call localhost; Secure MCP Tunnel is the official supported bridge for a private developer-machine MCP server and requires no inbound public listener. (OPENAI-MCP-001, OPENAI-TUNNEL-001, OPENAI-TUNNEL-002)

**Do not introduce an extra P1 runtime proxy by default.** WAG already has an accepted private stdio direction specifically designed for ChatGPT Business + Secure MCP Tunnel. `chatgpt-wag-access` should initially own deployment/app metadata, OpenAI-specific correlation/admission integration tests, acceptance harnesses, benchmarks, and runbooks. Add a thin runtime shim only if a live spike proves that WAG cannot receive/normalize the OpenAI `_meta` fields needed for correlation without contaminating WAG with provider-specific logic. (WAG-STDIO-001, WAG-MISSION-001)

## Main findings

1. **FACT:** Full custom MCP with write/modify actions is currently available to ChatGPT Business and Enterprise/Edu on ChatGPT web. Pro is currently limited to read/fetch custom MCP; Plus is not a supported private full-MCP developer-mode route. (OPENAI-MCP-001)
2. **FACT:** ChatGPT cannot directly connect to a local MCP server. Secure MCP Tunnel is the current OpenAI-supported path for private/on-prem/developer-machine MCP servers. (OPENAI-TUNNEL-001)
3. **FACT:** Secure MCP Tunnel is outbound-only from the workstation to OpenAI; it can forward to a local MCP server over stdio or HTTP. No inbound public port is required. (OPENAI-TUNNEL-002)
4. **FACT:** ChatGPT supplies `_meta["openai/session"]` as an anonymized conversation ID for correlating tool calls within one ChatGPT session, plus `_meta["openai/subject"]` and, when available, `_meta["openai/organization"]`. (OPENAI-SESSION-001)
5. **FACT:** WAG ADR-0017 explicitly states provider conversation IDs, MCP transport sessions, request IDs, browser IDs, URLs, and bearer tokens are correlation/transport credentials only; WAG must mint authority-bearing `owner_id`, `session_id`, and `adapter_id`. (WAG-IDENTITY-001)
6. **INFERENCE:** `_meta["openai/session"]` is the cleanest host correlation key for five ChatGPT conversations, but it must never become a Goal Lease or durable WAG authority credential. WAG should domain-separate/hash it as correlation material and mint its own session identity. (OPENAI-SESSION-001, WAG-IDENTITY-001)
7. **FACT:** Current OpenAI `tunnel-client` supports bounded concurrent MCP execution. Its documented default is 10 active MCP requests with a separate default in-flight buffer of 20, so transport-level support for five simultaneous chats is not inherently blocked. (OPENAI-TUNNEL-CONC-001)
8. **EMPIRICAL TEST NEEDED:** Five-session correctness is not yet proven end-to-end for ChatGPT → tunnel → WAG → DevSpace. WAG/DevSpace concurrency, session isolation, tool timeouts, restart/reconnect behavior, and same-repository contention must be measured.
9. **FACT:** Current WAG Business/private MCP exposes exactly five tools: `health`, `workspace.open`, `repo.snapshot`, `file.read`, `verify.run`; mutation and Git write are intentionally not authorized on that surface. (WAG-SURFACE-001)
10. **FACT:** WAG already contains an accepted durable mutation core whose remote choreography is `mutation.preview -> local operator review/execution -> mutation.result`; remote callers cannot approve/apply the mutation. This is the correct authority pattern to reuse when Business mutation is separately authorized. (WAG-MUTATION-001)
11. **FACT:** WAG currently has no authorized Business Git-write surface. Therefore ChatGPT cannot yet replace Claude Code for the requested complete implementation loop. (WAG-SURFACE-001, WAG-MUTATION-001)
12. **RECOMMENDATION:** First prove the existing five-tool WAG surface through ChatGPT Business + Secure MCP Tunnel with one session, then five sessions. Only after that should a separate WAG authority decision project durable mutation and bounded Git semantics.

## Current blocker

The blocker is no longer “how to reach localhost.” OpenAI now has an official solution for that. The blocker is **authority projection and acceptance**: the target ChatGPT surface must gain enough WAG-authorized semantic capabilities for edit + Git while preserving WAG’s local ownership/approval/fencing model.

---

# 2. Exact problem being solved

Provide a supported, structural, low-friction path by which a normal ChatGPT session can perform this bounded workflow without Desktop Commander and without Claude Code mediating calls:

```text
ChatGPT
→ WAG access surface
→ workspace.open
→ inspect/search/read
→ bounded edit
→ test/verify
→ git status/diff/commit
→ structured result
```

The architecture must support **five simultaneous ChatGPT sessions** on one workstation and must preserve these invariants:

- model/chat content is not local authority;
- browser/page content is untrusted;
- WAG remains the authority backend;
- tools are semantic and bounded, not arbitrary shell/process forwarding;
- WAG owns identity, admission, resource ownership, approvals, leases/fencing, execution policy, and audit;
- transport/provider identifiers are correlation only;
- consequential effects remain explicit, auditable, fail-closed, and independently gated;
- CPU, RAM, process count, startup latency, and five-session scaling are acceptance dimensions, not afterthoughts.

---

# 3. Non-goals

This research does **not**:

- mutate `web-agent-gateway`;
- authorize Business mutation or Git write capability;
- add raw shell, PTY, arbitrary process management, arbitrary environment injection, or generic forwarding;
- make ChatGPT/browser text an approval or lease credential;
- auto-click ChatGPT, Windows, browser, or WAG security controls;
- turn Secure MCP Tunnel into a public distribution mechanism;
- make Desktop Work direct-local access the authority backend;
- build a universal public relay merely to preserve ChatGPT Plus;
- create a new browser extension because an extension already exists;
- treat MCP transport session state as durable WAG state;
- assume five-session performance without measurement;
- assume “Goal Lease” semantics that are not yet located in WAG canonical authority.

---

# 4. Current platform facts

## 4.1 ChatGPT custom MCP availability

**FACT — OPENAI-MCP-001:** OpenAI currently documents full MCP support, including modify/write actions, for ChatGPT Business and Enterprise/Edu on ChatGPT web. Business admins/owners can enable developer mode, create/test a custom MCP app, and publish it to the workspace. Pro can connect custom MCPs with read/fetch permissions in developer mode but does not currently get full MCP. The Help Center explicitly says ChatGPT cannot connect directly to a local MCP server and points private/local servers to Secure MCP Tunnel.

**Implementation consequence:** The requested full vertical slice cannot currently be treated as a supported private-Plus design. P1’s full acceptance environment is Business (or Enterprise/Edu), not Plus.

**Current cost fact, technically relevant only:** OpenAI’s current Business FAQ/billing docs require at least two paid seats. Standard seats are currently USD 25/user/month monthly or USD 20/user/month on annual billing. This makes the minimum self-serve Standard commitment USD 50/month monthly or USD 40/month equivalent annually before tax/currency effects. (OPENAI-BUSINESS-001)

## 4.2 Secure MCP Tunnel replaces the localhost/public-ingress dilemma

**FACT — OPENAI-TUNNEL-001 / 002:** Secure MCP Tunnel is an outbound-only connection from a host inside the private network to an OpenAI-hosted MCP endpoint. The local server does not need a public listener. `tunnel-client` needs outbound HTTPS to OpenAI and local reachability to the MCP server. The local MCP target can be a stdio command or an HTTP server.

Official topology:

```text
OpenAI product
→ OpenAI-hosted tunnel endpoint
→ queued MCP JSON-RPC
→ outbound long-polling tunnel-client
→ local stdio/HTTP MCP server
→ response through same tunnel
```

The tunnel is reachability/transport, **not WAG authority**. OpenAI explicitly separates tunnel transport logging from normal app-level logging. (OPENAI-TUNNEL-LOG-001)

## 4.3 Streaming and tool-result semantics

**FACT:** Secure MCP Tunnel can forward intermediate server-sent events when a connector requests streaming. OpenAI’s plugin reference supports `structuredContent` for model-visible structured results and recommends declaring output schemas. `_meta` on tool results is not model-visible and should not be used as an authorization mechanism. (OPENAI-TUNNEL-STREAM-001, OPENAI-TOOLS-001)

**RECOMMENDATION:** P1 should keep tool results small, structured, stable-ID based, and bounded. Long verification output should return a compact result/evidence handle rather than dump unbounded logs into the conversation.

## 4.4 Stable ChatGPT session correlation exists

**FACT — OPENAI-SESSION-001:** ChatGPT currently supplies MCP tool handlers:

- `_meta["openai/subject"]` — anonymized user ID, documented for rate limiting/user identification;
- `_meta["openai/session"]` — anonymized conversation ID for correlating tool calls in the same ChatGPT session;
- `_meta["openai/organization"]` — anonymized current organization ID when available.

OpenAI explicitly says `userAgent` and `userLocation` are advisory and must not be used for authorization.

**INFERENCE:** For five simultaneous chats, `openai/session` is the right correlation input. It is not a lease token, not a permission, and not a durable local authority ID.

**EMPIRICAL TEST NEEDED:** OpenAI does not document the exact lifecycle of `openai/session` across chat reopen, browser restart, workspace switch, app relink, account migration, or restored archived chats. Acceptance must test the lifecycle cases that matter to P1.

## 4.5 Authentication is distinct from WAG authority

**FACT — OPENAI-AUTH-001:** OpenAI’s plugin authentication guidance says customer-specific data and write actions should authenticate users. The supported custom path is OAuth 2.1/MCP authorization, with Authorization Code + PKCE, protected-resource metadata, tool-level security schemes, and server-side validation of issuer/audience/expiry/scopes on every request.

**FACT:** Secure MCP Tunnel can carry OAuth discovery metadata, but the authorization server itself is not automatically tunneled. (OPENAI-TUNNEL-OAUTH-001)

**RECOMMENDATION:** Do not build a public OAuth service merely to solve local authority for the first single-operator spike. Use the private workspace/tunnel as transport admission and let WAG’s local authority/approval model remain decisive. Before enabling write for a multi-user or distributed deployment, add standards-compliant end-user authentication or document a reviewed single-operator exception; never promote `_meta` correlation IDs into authentication tokens.

## 4.6 App selection has UX friction

**FACT — OPENAI-APP-UX-001:** In current ChatGPT custom-app behavior, app selection applies to the message where the app is used. A follow-up that needs fresh data or another action may require selecting or `@mention`ing the app again.

**Implementation consequence:** A single selected message can still trigger multiple tool calls, but P1 acceptance must measure the real follow-up ergonomics. “Direct access” does not currently imply a permanently attached app for every future message in a conversation.

## 4.7 ChatGPT Desktop and Work do not supersede this architecture

**FACT — OPENAI-WORK-001:** ChatGPT Work in the desktop app can work with local files/folders when granted access; Work on web/mobile cannot directly access files on the user’s computer. Codex Local can access local folders/repos/terminals but remains a separate product surface.

**FACT — OPENAI-WEBMCP-001:** ChatGPT desktop’s built-in browser supports website-provided WebMCP “site tools,” but the tools are only available while the providing page is open and currently exist in the built-in desktop browser, not ordinary Chrome.

**Decision consequence:** Work Local and WebMCP are useful capabilities but are not clean substitutes for WAG-backed authority in a normal ChatGPT web session. Work Local would bypass WAG; WebMCP adds a page/tab/browser dependency and makes the web page part of the delivery path.

## 4.8 Current MCP upstream favors per-request identity, not transport authority

**FACT — MCP-2026-001:** The current MCP TypeScript SDK v2 supports MCP `2026-07-28`. For modern HTTP, the revision is per request and does not use `Mcp-Session-Id`; request state round-tripped through the client is explicitly untrusted and should be integrity-protected. For stdio, a server factory is pinned per connection. (Upstream modelcontextprotocol TypeScript SDK)

**FACT — WAG-MCP-001:** WAG migrated to exact-pinned MCP SDK v2 packages but deliberately did **not** opt its production surface into MCP `2026-07-28` as part of that migration.

**Implementation consequence:** P1 must not tie authority to MCP protocol-session mechanics. WAG’s own caller context remains the correct durable identity abstraction.

## 4.9 Tunnel concurrency is compatible with five calls at the transport layer

**FACT — OPENAI-TUNNEL-CONC-001:** Current upstream `openai/tunnel-client` documents:

- default `mcp.max-concurrent-requests = 10`;
- default `control-plane.max-inflight = 20`;
- these limits are independent;
- commands may complete out of order and are correlated per command;
- increasing concurrency is safe only if the local MCP server can safely handle it.

**INFERENCE:** Five simultaneous ChatGPT sessions are within the tunnel’s default active-request limit.

**EMPIRICAL TEST NEEDED:** This does not prove WAG, DevSpace, the ChatGPT product, or same-repository effect contention can safely sustain five simultaneous sessions.

## 4.10 Current tunnel release has modern/sessionless hardening

**FACT — OPENAI-TUNNEL-REL-001:** `openai/tunnel-client` `v0.0.14` was published 2026-09-01. Its release notes describe the MCP `2026-07-28` sessionless rollout target and a fix for shared stdio recovery when a later logical session reuses a JSON-RPC request ID after an earlier timeout.

**Implementation consequence:** Pin the tested tunnel version in acceptance evidence. Do not assume an arbitrary older binary has the same multi-session behavior.

## 4.11 WAG already chose Business + Secure MCP Tunnel + stdio

**FACT — WAG-STDIO-001:** WAG’s 2026-09-10 Business Secure MCP Stdio design chose:

```text
ChatGPT Business custom app
→ OpenAI Secure MCP Tunnel
→ tunnel-client
→ WAG stdio process
→ localhost DevSpace
→ approved workspaces
```

The design explicitly preferred stdio over an extra local HTTP listener for the private Business route.

**FACT:** WAG’s local pre-upgrade acceptance passed for the built stdio path and exact-pinned DevSpace; `CHATGPT_BUSINESS_END_TO_END` remained `NOT_YET_TESTED`. (WAG-STDIO-ACCEPT-001)

## 4.12 Current WAG tool surfaces are intentionally narrower than the desired slice

**FACT — WAG-SURFACE-001:** As of the current WAG authority snapshot:

- Business/default MCP: `health`, `workspace.open`, `repo.snapshot`, `file.read`, `verify.run`.
- Browser Inspect v2: `health`, `workspace.open`, `repo.search`, `repo.snapshot`, `file.read`.
- Browser profile does not expose `verify.run`, mutation, Git writes, process/PTY, or generic forwarding.
- Business/default MCP does not expose mutation or Git writes.

**Implementation consequence:** Direct ChatGPT access can be proven now for read/snapshot/verify, but the complete implementation-owner loop is not yet authorized.

## 4.13 WAG already has the right durable mutation authority pattern

**FACT — WAG-MUTATION-001:** WAG’s accepted durable mutation core uses:

```text
mutation.preview
→ persisted immutable plan
→ local operator review
→ local execution of the stored plan
→ mutation.result
```

The remote surface cannot approve or apply the mutation. The operator credential is not projected through MCP. Exact ownership tuple fencing, stale-target rejection, post-write hashing, restart reconciliation, and unknown-outcome handling were accepted locally.

**Decision consequence:** When/if Business mutation is authorized, P1 should project this existing semantic protocol rather than revive raw `file.patch`, remote apply, or browser security-control automation.

## 4.14 WAG identity rules already solve most of the session-authority problem

**FACT — WAG-IDENTITY-001:** WAG ADR-0017 requires WAG to mint authority-bearing `owner_id`, `session_id`, `adapter_id`. Provider/transport identifiers remain correlation only. Repeated trusted admission can use a digest of correlation material to recover a WAG session while rotating ephemeral transport credentials. Durable workspace ownership is fenced by exact owner/session/adapter identity.

**Decision consequence:** P1 does not need a second identity database. It needs a trustworthy mapping from OpenAI host metadata into WAG’s existing admission seam.

---

# 5. Candidate architectures

## A. ChatGPT custom MCP app → public remote MCP endpoint

```text
ChatGPT Business custom app
→ public HTTPS MCP endpoint
→ adapter/backend
→ WAG
```

**FACT:** Supported as a general custom MCP topology. Full write still requires an eligible ChatGPT plan. OAuth is the expected pattern for customer-specific/write functionality. (OPENAI-MCP-001, OPENAI-AUTH-001)

**Pros:** Standard ChatGPT app path; no browser extension; easy remote availability.  
**Cons:** Requires public ingress/domain, TLS, OAuth/public auth, attack surface, deployment lifecycle, and an extra network hop even though the authority backend is local.

**Decision:** Loses to Secure MCP Tunnel for a private single-workstation objective.

## B. ChatGPT custom MCP app → Secure MCP Tunnel → WAG stdio

```text
ChatGPT Business
→ custom MCP app
→ OpenAI Secure MCP Tunnel
→ one workstation tunnel-client
→ WAG serve-stdio
→ DevSpace/resources
```

**FACT:** This is an officially supported current OpenAI private-MCP path and is already WAG’s chosen Business deployment direction. (OPENAI-TUNNEL-001, WAG-STDIO-001)

**Pros:** No inbound public port; no public relay; no browser extension; structural tool calls; direct reuse of existing WAG stdio; bounded concurrency; one local tunnel process; preserves WAG authority.  
**Cons:** Requires Business/Enterprise/Edu for full MCP; OpenAI remains in the transport/data path; ChatGPT app selection has some per-message UX friction; current WAG Business surface is not yet sufficient for full edit/Git loop; end-to-end ChatGPT acceptance is still missing.

**Decision:** **Leading architecture / preferred.**

## C. Secure loopback/native browser bridge

```text
ChatGPT browser page
→ extension/content bridge
→ Native Messaging/native host
→ loopback WAG admission
→ WAG
```

**FACT:** WAG has already accepted a read-only browser-admission profile, but current Windows same-user bootstrap trust is explicitly insufficient for consequential `verify.run`, durable mutation, Git, or process authority. (WAG-BROWSER-001)

**Pros:** Works without Business private MCP for bounded read-only use; can remain local.  
**Cons:** Browser/page coupling; extension/native-host lifecycle; more processes and packaging; weak same-user bootstrap boundary for consequential actions; page content is an untrusted delivery surface; existing WAG ADRs intentionally block write/verify/Git projection here.

**Decision:** Keep as read-only compatibility/fallback evidence, not the target implementation-owner path.

## D. Browser-facing structured adapter / WebMCP page

```text
ChatGPT desktop built-in browser
→ local/site page exposing WebMCP site tools
→ local adapter
→ WAG
```

**FACT:** Site tools are currently tied to the ChatGPT desktop built-in browser and to the page that provides them; tools disappear when the page closes. (OPENAI-WEBMCP-001)

**Pros:** Structured tools rather than raw clicking; no need to parse ChatGPT DOM if the site itself provides tools.  
**Cons:** Requires a page/tab; not a normal ChatGPT web-session path; page lifecycle becomes operational dependency; increases browser friction; still requires a strong WAG admission boundary before consequential capability.

**Decision:** Useful research donor, not leading P1 architecture.

## E. ChatGPT Desktop Work / Codex local access

```text
ChatGPT desktop Work or Codex Local
→ local folder/terminal permissions
→ filesystem/git directly
```

**FACT:** Desktop Work can access local folders with permission; Codex Local has richer repository/terminal access. (OPENAI-WORK-001)

**Pros:** Native local capability; no custom tunnel needed for local files.  
**Cons:** Bypasses WAG as authority backend; changes the product surface; does not prove the target normal-chat structural WAG path; introduces a separate local permission/security model.

**Decision:** Not a P1 solution because it violates the core authority requirement.

## F. Published plugin/public HTTPS relay → outbound local agent → WAG

```text
ChatGPT plugin directory / published app
→ universal public HTTPS MCP relay
→ authenticated device routing
→ outbound local bridge
→ WAG
```

**FACT:** WAG’s prior OpenAI deployment research found the public reviewed-plugin route materially different from private Secure MCP Tunnel: it needs public hosting, publication/review, OAuth, legal/support assets, and user/device routing; Secure MCP Tunnel itself is not the public distribution endpoint. (WAG-PUBLIC-001)

**Pros:** Potential path to broader distribution and potentially non-Business users after review/eligibility.  
**Cons:** Highest engineering/ops/security cost; universal relay becomes internet-facing infrastructure; device routing and OAuth become product features; unnecessary for one private workstation.

**Decision:** **Fallback only if full write from non-Business ChatGPT becomes a hard product requirement.** Do not build it for this short-term objective.

---

# 6. Evidence Ledger

| evidence_id | claim | source | source type / authority | date/version | confidence | applies_to | implementation consequence |
|---|---|---|---|---|---|---|---|
| OPENAI-MCP-001 | Full MCP incl. write/modify is currently Business + Enterprise/Edu on ChatGPT web; Pro read/fetch only; local MCP cannot be connected directly | https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt | Official OpenAI product documentation | page checked 2026-09-21; page says updated 29 days ago | High | P1, COMMON | Full private P1 acceptance requires Business/Ent/Edu; use Secure MCP Tunnel for local WAG |
| OPENAI-TUNNEL-001 | Secure MCP Tunnel connects private/on-prem/dev-machine MCP to ChatGPT/Codex/API without public exposure | https://developers.openai.com/api/docs/guides/secure-mcp-tunnels | Official OpenAI developer docs | checked 2026-09-21 | High | P1, COMMON | Use official tunnel instead of reverse proxy/public localhost exposure |
| OPENAI-TUNNEL-002 | Tunnel is outbound-only; local target may be stdio or HTTP; no inbound internet needed | same as above | Official OpenAI developer docs | checked 2026-09-21 | High | P1, COMMON | Prefer stdio to WAG; firewall needs outbound 443 + local target only |
| OPENAI-TUNNEL-LOG-001 | Tunnel transport logging and app-level ChatGPT logging are separate; normal app invocation/auth lifecycle logging still applies | same as above, Security and networking / Logging boundaries | Official OpenAI developer docs | checked 2026-09-21 | High | COMMON | Do not mistake tunnel audit logs for WAG/app semantic audit |
| OPENAI-TUNNEL-STREAM-001 | Tunnel can forward intermediate SSE when connector requests streamed results | same as above | Official OpenAI developer docs | checked 2026-09-21 | High | COMMON | Streaming is possible but not required for first WAG slice |
| OPENAI-TUNNEL-OAUTH-001 | OAuth discovery can traverse tunnel; authorization server is not automatically tunneled | same as above, OAuth section | Official OpenAI developer docs | checked 2026-09-21 | High | P1, COMMON | Avoid assuming local OAuth magically works through tunnel; keep auth separate from WAG authority |
| OPENAI-SESSION-001 | ChatGPT supplies anonymized `openai/subject`, `openai/session`, and optionally `openai/organization`; session correlates calls in same ChatGPT conversation | https://developers.openai.com/plugins/reference | Official OpenAI developer docs | checked 2026-09-21 | High | P1, COMMON | Use session only as correlation input; derive WAG-owned session through admission |
| OPENAI-TOOLS-001 | MCP app tools can return `structuredContent`; precise schemas are recommended; annotations are hints, not enforcement | https://developers.openai.com/plugins/reference and https://developers.openai.com/plugins/build/mcp-server | Official OpenAI developer docs | checked 2026-09-21 | High | COMMON | Keep semantic schemas narrow; enforce policy server-side in WAG |
| OPENAI-AUTH-001 | Customer-specific data/write actions should authenticate; OAuth 2.1 + PKCE + protected-resource metadata; validate issuer/audience/expiry/scopes every request | https://developers.openai.com/plugins/build/auth | Official OpenAI developer docs | checked 2026-09-21 | High | COMMON | Multi-user/full-write distribution needs real auth; `_meta` is not a token |
| OPENAI-APP-UX-001 | App selection applies to the current message; reselect/@mention when follow-up needs fresh data/action | https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt | Official OpenAI product docs | checked 2026-09-21 | High | P1 | Include real follow-up friction in acceptance, not just API feasibility |
| OPENAI-WORK-001 | Desktop Work can use local files with permission; web/mobile Work cannot directly access the computer; Codex Local remains separate | https://help.openai.com/en/articles/20001275/ | Official OpenAI product docs | checked 2026-09-21 | High | COMMON | Desktop local capability is not a substitute for WAG-backed normal chat |
| OPENAI-WEBMCP-001 | ChatGPT desktop built-in browser supports site tools/WebMCP tied to an open page; not available in ordinary Chrome | https://help.openai.com/en/articles/20001423-using-site-tools-in-the-chatgpt-desktop-app | Official OpenAI product docs | checked 2026-09-21 | High | P1, COMMON | WebMCP page adapter has tab/page lifecycle friction; not leading architecture |
| OPENAI-BUSINESS-001 | Business currently requires 2 paid seats; Standard USD 25 monthly or USD 20/month annual | https://help.openai.com/en/articles/8792536-chatgpt-team-billing | Official OpenAI billing docs | page updated 4 days before 2026-09-21 | High | P1 | Minimum external-acceptance cost is currently 2 Standard seats |
| OPENAI-TUNNEL-CONC-001 | tunnel-client default active MCP concurrency 10; max-inflight buffer 20; completion may be out of order, correlated per command | https://github.com/openai/tunnel-client/blob/master/docs/configuration.md ; `docs/protocol.md`; `docs/troubleshooting.md` | Upstream OpenAI repository | repo pushed 2026-09-20; checked 2026-09-21 | High | P1, COMMON | Five chats fit transport default, but local server concurrency must be validated |
| OPENAI-TUNNEL-REL-001 | tunnel-client v0.0.14 is current checked release; includes MCP 2026-07-28 sessionless rollout notes and stdio recovery fix | https://github.com/openai/tunnel-client/releases/tag/v0.0.14 | Upstream OpenAI release | v0.0.14, 2026-09-01 | High | P1, COMMON | Pin exact tested tunnel version in acceptance evidence |
| MCP-2026-001 | MCP 2026-07-28 modern HTTP is per-request/sessionless; echoed requestState is untrusted and must be integrity protected; stdio factory pins per connection | https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md | Upstream MCP SDK/spec implementation | current SDK v2 / protocol 2026-07-28 | High | COMMON | Durable authority must not depend on MCP transport session/request state |
| WAG-MISSION-001 | WAG owns local authority; provider adapters stay thin; integration preference starts with provider-native private MCP | `ShenJun93/web-agent-gateway` `docs/adr/0018-lock-webchat-local-coding-mission.md` @ `bd2727a...` | Canonical WAG ADR | current main snapshot 2026-09-21 | High | WAG, P1 | Prefer native OpenAI tunnel/MCP over browser automation; no authority in P1 adapter |
| WAG-STDIO-001 | WAG already designed ChatGPT Business + Secure MCP Tunnel + WAG stdio as lowest-engineering private route | `docs/superpowers/specs/2026-09-10-business-secure-mcp-stdio-design.md` @ `bd2727a...` | Canonical WAG design | 2026-09-10 | High | WAG, P1 | Do not invent another local HTTP/proxy layer without evidence |
| WAG-STDIO-ACCEPT-001 | Local Business stdio readiness passed; ChatGPT Business end-to-end remains untested | `docs/benchmarks/2026-09-10-business-stdio-preupgrade.md` @ `bd2727a...` | Canonical WAG acceptance receipt | 2026-09-10 | High | WAG, P1 | Next evidence should be external ChatGPT/tunnel acceptance, not more local architecture speculation |
| WAG-SURFACE-001 | Current Business/default MCP = health/open/snapshot/read/verify; mutation/Git not exposed | `docs/benchmarks/2026-09-16-mcp-sdk-v2-production-migration-v1.md` + README @ `bd2727a...` | Canonical WAG acceptance/current state | 2026-09-16 / current main | High | WAG, P1 | Full implementation-owner loop needs separately authorized capability projection |
| WAG-MCP-001 | WAG uses MCP SDK v2.0.0 packages but did not enable protocol 2026-07-28 in that migration | `docs/benchmarks/2026-09-16-mcp-sdk-v2-production-migration-v1.md` | Canonical WAG acceptance receipt | 2026-09-16 | High | WAG | Avoid relying on modern protocol behavior until WAG explicitly enables/tests it |
| WAG-IDENTITY-001 | WAG mints owner/session/adapter; provider/MCP/browser IDs are correlation only; durable workspaces are fenced by WAG tuple | `docs/adr/0017-use-wag-owned-adapter-admission.md` @ `bd2727a...` | Canonical WAG ADR | accepted 2026-09-15, amended 2026-09-16 | High | WAG, P1, COMMON | Map OpenAI metadata to WAG admission; never use ChatGPT conversation id as authority |
| WAG-MUTATION-001 | Durable local mutation uses preview → local review/execution → result; remote cannot approve/apply; restart reconciliation/fencing accepted | `docs/benchmarks/2026-09-13-durable-mutation-control-plane.md` @ `bd2727a...` | Canonical WAG acceptance receipt | 2026-09-13 | High | WAG, P1 | Reuse this protocol if Business mutation is later authorized; no raw patch/apply |
| WAG-BROWSER-001 | Browser admission is intentionally read-only because current Windows same-user bootstrap is not strong enough for consequential capability | `docs/adr/0017...`, `docs/adr/0018...`, `docs/adr/0019-separate-browser-proposal-from-consequential-authority.md` | Canonical WAG ADRs | 2026-09-15 onward | High | WAG, P1 | Browser/native bridge is not a shortcut to mutation/Git authority |
| WAG-PUBLIC-001 | Public plugin route requires public HTTPS/OAuth/review/distribution and Secure MCP Tunnel is not public distribution | `docs/research/2026-09-10-openai-plugin-deployment-route.md` @ `bd2727a...` | Canonical WAG research, grounded in official OpenAI docs | 2026-09-10 | High | WAG, P1 | Do not build universal relay just to avoid Business |
| LEASE-COMMON-001 | Separate program research models exclusive resource leases with `lease_id`, `resource_key`, holder, generation and fencing; stale generations rejected | `ShenJun93/unified-ai-factory-research` `architecture/domain-contracts-v0.2.md`, `state-machines-v0.2.md` | User canonical cross-project architecture | current repo evidence located 2026-09-21 | Medium-High | COMMON, P1 | If Goal Lease shares this model, bind it server-side to WAG session and generation; do not accept possession alone |

---

# 7. Security implications

## 7.1 Exact trust boundaries

### TB-0 — ChatGPT model + conversation

**Trust:** Untrusted initiator.  
**May do:** Express intent, select tools, supply semantic parameters.  
**Must not do:** Mint authority, approve its own effects, choose WAG `owner_id/session_id/adapter_id`, generate local approval tokens, or convert page content into credentials.

### TB-1 — OpenAI ChatGPT app host + Secure MCP Tunnel

**Trust:** Trusted transport/product context for reaching the registered app and delivering documented host metadata; **not local effect authority**.  
**May do:** Carry MCP JSON-RPC, host `_meta`, app permissions, optional OAuth tokens, streaming results.  
**Must not do:** Become the source of WAG durable ownership or Goal Lease validity.

### TB-2 — P1 OpenAI integration surface (`chatgpt-wag-access`)

**Preferred shape:** deployment/configuration + tests, not a separate authority service.  
**If a runtime shim is proven necessary:** it may normalize OpenAI host metadata and forward it to WAG’s admission contract. It must be stateless or keep only non-authoritative correlation/cache state.  
**Must not own:** policy, approvals, secrets, workspace ownership, leases, mutation execution, Git authority, durable jobs.

### TB-3 — WAG

**Trust:** Local authority backend.  
**Owns:** principal/session/adapter IDs, capability admission, workspace/resource ownership, policy, approvals, mutation state, lease/fencing semantics, verification authority, effect audit, and any future bounded Git publication/commit semantics.

### TB-4 — DevSpace / local executors / Git / filesystem

**Trust:** Effect executors behind WAG.  
**Rule:** Not reachable directly from ChatGPT. No generic forwarding.

### TB-5 — Human/local operator authority

**Trust:** Independent consequential-approval source where WAG policy requires it.  
**Rule:** Credentials/approval secrets must never be delivered to the ChatGPT model, page content, or remote tool arguments.

## 7.2 Session identity model

### Confirmed inputs

From ChatGPT host metadata:

```text
openai_subject       = anonymized user correlation
openai_organization  = anonymized workspace/org correlation when available
openai_session       = anonymized ChatGPT conversation correlation
```

### Recommended WAG mapping

```text
correlation_digest = HMAC-SHA256(
  WAG_local_secret,
  "chatgpt-mcp-v1" || organization? || subject || session
)

WAG admission resolves/mints:
  owner_id    = WAG-owned local principal
  session_id  = WAG-owned session bound to correlation_digest
  adapter_id  = fixed trusted profile, e.g. "chatgpt-mcp-v1"
  workspace_id = WAG-owned per admitted session/workspace open
```

The HMAC is illustrative pseudocode; WAG already has the durable correlation-digest pattern and should remain the implementation authority.

### Five-session isolation

For five concurrent ChatGPT conversations under one user:

```text
subject = same
organization = same (normally)
openai_session = S1, S2, S3, S4, S5

WAG sessions = W1, W2, W3, W4, W5
```

Each must receive distinct WAG `session_id` and distinct WAG-owned workspace identity even when all five open the same canonical root, unless a later explicit shared-workspace contract says otherwise.

## 7.3 Goal Lease propagation

**UNVERIFIED ASSUMPTION:** The exact canonical “Goal Lease” contract was not found in WAG. A related cross-project lease model exists with `lease_id/resource_key/holder/generation` fencing. Therefore P1 must not invent Goal Lease semantics.

**RECOMMENDATION:**

- The ChatGPT model may reference an opaque goal identifier as intent.
- WAG (or the canonical lease authority if distinct) resolves/claims the lease server-side.
- WAG binds the resulting lease record to its admitted `owner_id/session_id/adapter_id/workspace_id` and current fencing generation.
- Protected writes/commit operations check current generation at the effect boundary.
- A raw `goal_lease_id` or `generation` supplied by model/tool arguments is never sufficient authority.
- Browser/page content never determines lease validity.

This preserves `model != authority` even if a model can see an opaque lease handle.

## 7.4 Tool annotations and ChatGPT confirmations are defense in depth

OpenAI may ask for confirmation based on app permissions and action context. MCP annotations such as read-only/destructive hints help hosts present risk, but they are not enforcement. WAG remains the final decision boundary.

**RECOMMENDATION:** Set accurate annotations, but design every tool as if a malicious or confused model can call it with adversarial arguments.

## 7.5 No security-control automation

Acceptance must not rely on browser automation that clicks ChatGPT permission prompts, WAG local approval, Windows security dialogs, or OAuth consent. Manual confirmation is allowed where the product requires it; automation must stop at those boundaries.

---

# 8. Performance implications

## 8.1 Expected persistent process shape

**RECOMMENDATION:** The preferred steady-state path should have one shared local transport stack, not one process tree per ChatGPT conversation:

```text
1 x tunnel-client
1 x WAG stdio child/process
1 x separately supervised DevSpace process
+ existing OS/browser processes
```

No persistent P1 process should be added unless the metadata/admission spike proves it necessary.

**Five-session success criterion:** five chats must not create five WAG/tunnel processes merely to isolate identity. Isolation belongs in WAG caller context/state, not process multiplication.

## 8.2 Concurrency

The tunnel default of 10 active MCP requests is enough for five concurrent calls at the transport layer. For the first five-session acceptance, cap or leave concurrency at a known value and record it explicitly. Do not increase `mcp.max-concurrent-requests` until WAG/DevSpace correctness under concurrency is proven.

## 8.3 CPU/RAM

**EMPIRICAL TEST NEEDED:** No primary source found that gives a meaningful Windows RSS/CPU budget for the exact stack `tunnel-client + WAG Node process + DevSpace` on this workstation.

Therefore do **not** label the path “lightweight” yet.

Record at minimum:

- idle RSS and private bytes per attributable process;
- idle CPU over 60 seconds;
- process count;
- peak RSS during five concurrent reads;
- peak RSS/CPU during five mixed operations;
- handle/thread count before and after 30-minute soak;
- memory/process residue after all five chats stop issuing calls.

## 8.4 Latency

Measure separately:

1. **local server time** — WAG handler to result;
2. **tunnel transport time** — local client receive/return timestamps;
3. **ChatGPT tool-call round trip** — tool start to tool result surfaced;
4. **model turn time** — user-visible total, reported separately because it includes reasoning/model latency.

Do not combine them into one “WAG latency” number.

## 8.5 Relative acceptance targets

Use baseline-relative gates before hard absolute budgets are known:

- persistent process count must remain constant from 1 session to 5 sessions;
- idle 5-session local-stack RSS should not scale approximately 5×;
- five-session p95 read-tool server/tunnel latency should remain within 2× the single-session baseline unless the workload is deliberately serialized;
- zero lost/misattributed results;
- zero cross-session resource access;
- zero duplicate mutation/commit after retry/reconnect;
- no unowned background process remains after acceptance cleanup.

If the first measurements show much lower stable values, tighten these budgets in the next architecture decision record.

---

# 9. Architecture decision matrix

Legend: **Strong**, **Conditional**, **Weak**, **Blocked**. This is a technical fit matrix, not a product popularity score.

| Candidate | Supported current path | Keeps WAG authority | Private localhost without inbound port | Structured tools | Full write potential | 5-session transport fit | Process/browser friction | Engineering/ops burden | P1 decision |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| A. Custom app → public MCP | Yes on eligible plans | Strong if designed correctly | No | Strong | Strong | Conditional | Low browser friction | High | Secondary |
| B. Custom app → Secure MCP Tunnel → WAG stdio | **Yes** | **Strong** | **Yes** | **Strong** | Strong once WAG authorizes tools | **Strong at tunnel layer; E2E test needed** | **Low** | **Lowest** | **Preferred** |
| C. Browser extension/native bridge | Existing read-only WAG evidence | Strong for read-only; consequential path blocked | Yes | Conditional | **Blocked by current WAG trust decision** | Conditional | High | Medium-High | Read-only fallback only |
| D. WebMCP/site-tools page adapter | Desktop built-in browser only | Conditional | Potentially | Strong | Conditional | Unknown | Page/tab dependent | Medium | Not leading |
| E. Desktop Work/Codex local | Yes | **No — bypasses WAG** | N/A | Product-native | Strong | Product-specific | Low/medium | Low | Reject for P1 goal |
| F. Published plugin → public relay → local bridge → WAG | Possible after review/build | Strong if carefully designed | Local WAG stays private but relay is public | Strong | Potentially | Conditional | Low chat friction | **Very high** | Fallback only for non-Business distribution requirement |

---

# 10. Unknowns requiring empirical spikes

1. **ChatGPT Business E2E:** Can the current WAG `serve-stdio` be discovered and called through Secure MCP Tunnel from an actual Business developer-mode app without WAG redesign?  
   **Status:** EMPIRICAL TEST NEEDED. WAG local readiness passed; external ChatGPT test remains missing.

2. **Host metadata visibility through the exact tunnel/stdout stack:** Does WAG’s current tool handler receive `_meta["openai/subject/session/organization"]` exactly as documented when invoked through the Tunnel connection?  
   **Status:** EMPIRICAL TEST NEEDED.

3. **Five ChatGPT sessions:** Are five distinct `openai/session` values observed, and can WAG map them to five isolated caller contexts without spawning five local stacks?  
   **Status:** EMPIRICAL TEST NEEDED.

4. **Chat reopen/reconnect semantics:** Does `openai/session` remain stable across page reload/reopen of the same conversation? What happens after app relink or tunnel-client restart?  
   **Status:** EMPIRICAL TEST NEEDED.

5. **WAG stdio concurrency:** Can the current WAG MCP server safely service five in-flight read/verify calls over the tunnel-client’s shared stdio connection?  
   **Status:** EMPIRICAL TEST NEEDED.

6. **Long verification timeout behavior:** What timeout/result boundary does ChatGPT impose on a long synchronous `verify.run` through the tunnel?  
   **Status:** EMPIRICAL TEST NEEDED.

7. **App selection friction:** How many explicit user selections/@mentions are needed across a realistic multi-turn coding loop?  
   **Status:** EMPIRICAL TEST NEEDED.

8. **Goal Lease canonical contract:** Where is the authoritative Goal Lease schema/lifecycle in the coordinated program, and is WAG expected to own it or consume a signed/fenced lease from another authority?  
   **Status:** UNVERIFIED ASSUMPTION; must resolve from canonical program artifacts, not chat memory.

9. **Business mutation projection:** Can WAG safely project existing `mutation.preview/result` to the Business adapter while retaining local-only approval and exact caller fencing?  
   **Status:** Requires a new WAG design/acceptance decision; not merely a P1 adapter change.

10. **Git authority:** What minimal semantic Git interface should WAG authorize for status/diff/commit without becoming a generic Git/shell proxy?  
    **Status:** Requires separate WAG authority design. No current authorized surface found.

11. **Resource cost:** Exact Windows CPU/RAM/handle/process impact for one and five sessions.  
    **Status:** EMPIRICAL TEST NEEDED.

---

# 11. Minimal benchmark / spike plan

The plan intentionally front-loads falsification and uses the current five-tool WAG surface before any mutation design.

## Spike S0 — version and environment receipt

Capture:

- ChatGPT plan/workspace role;
- custom-app developer mode state;
- `tunnel-client --version` and release digest;
- WAG exact SHA/build digest;
- DevSpace exact revision;
- Node/npm versions;
- Windows build;
- tunnel configuration **without secrets**;
- WAG config digest **without roots/secrets in shared report**.

**Pass:** exact reproducible version receipt exists.

## Spike S1 — direct read-only Business path

Use current WAG Business stdio tool surface only.

```text
ChatGPT custom app
→ Tunnel
→ tunnel-client
→ WAG serve-stdio
→ health
→ workspace.open
→ repo.snapshot
→ file.read
→ verify.run (small deterministic profile)
```

**Positive controls:** all five tools discoverable and callable.  
**Negative control:** stop `tunnel-client`; calls fail rather than falling back to Desktop Commander/browser automation.  
**Pass:** structured results match WAG local evidence, no public WAG listener, no DC dependency.

## Spike S2 — session-correlation capture

Instrument only enough to record a local domain-separated digest of:

```text
organization? + subject + session
```

Never log raw tokens or browser/page content. If WAG cannot currently observe the metadata cleanly, use a disposable P1 metadata-canary MCP server to verify OpenAI behavior before requesting a WAG adapter change.

**Pass:** calls in one chat correlate to one stable digest; a second fresh chat produces a different session correlation; same user subject is consistent where documented.

## Spike S3 — five-session read/verify isolation

Open five normal ChatGPT conversations, S1–S5. Use the same WAG app and same workstation stack.

For each session:

1. `workspace.open` same canonical disposable repo root;
2. obtain distinct WAG workspace identity;
3. read a session-specific fixture target;
4. run one bounded verify profile;
5. repeat after interleaving calls across sessions.

Record:

- `openai/session` digest;
- WAG session/workspace IDs (opaque IDs only);
- request correlation IDs;
- start/end timestamps;
- per-call outcome;
- CPU/RSS/process count;
- any timeout/retry.

**Pass:** no cross-session data/result confusion; no authority sharing; no extra persistent per-session process; all 5 succeed under bounded concurrency.

## Spike S4 — reconnect/restart matrix

Run four cases:

1. browser page reload with same chat;
2. close/reopen same chat;
3. restart `tunnel-client`;
4. restart WAG stdio child / local stack.

For each, determine whether correlation persists, WAG re-admits, and incomplete calls fail/recover deterministically.

**Pass:** no stale authority; no duplicate effect; read operations either reconnect or fail cleanly. Long verify behavior is explicitly documented.

## Spike S5 — Desktop Commander absence proof

Before test:

- do not select or invoke Desktop Commander;
- disable/stop its local path if present and safe to do in the disposable acceptance environment;
- capture process/listener baseline.

Execute S1/S3 again.

Capture:

- ChatGPT tool/app invocation transcript identifying the WAG custom app;
- `tunnel-client` logs/metrics;
- WAG audit/correlation record;
- process tree/listeners showing the expected tunnel-client → WAG → DevSpace path;
- negative control by stopping tunnel-client.

**Pass:** WAG calls continue with Desktop Commander absent; stopping the tunnel breaks the path; no DC process/tool appears in execution evidence.

## Spike S6 — mutation projection canary (only after separate WAG authorization)

Do **not** implement this in P1 first.

Use existing WAG durable protocol:

```text
mutation.preview
→ local operator review/execute
→ mutation.result
→ file.read/repo.snapshot
```

Run with five sessions targeting:

- five disjoint files;
- two sessions racing the same file/base hash;
- one tunnel interruption after preview;
- one WAG restart during queued/executing state.

**Pass:** stale/conflicting writers fail closed; local approval cannot be supplied remotely; result recovery is deterministic.

## Spike S7 — bounded Git authority canary (future WAG design)

Only after a separate WAG design accepts semantic Git tools. Test:

- read-only repo status/diff;
- exact candidate/diff digest binding;
- commit of only approved candidate state;
- stale base/head failure;
- no push/branch rewrite/raw Git flags;
- duplicate/retry idempotence;
- five-session same-repo fencing.

**Pass:** exactly one valid commit for one authorized candidate; stale session cannot publish/commit over newer ownership.

---

# 12. Recommended architecture / current leading candidate

## Preferred architecture

### Topology

```text
┌─────────────────────────────────────────────────────────────┐
│ ChatGPT Business web session                               │
│ - model = intent/planning                                  │
│ - custom MCP app selected for action                       │
└─────────────────────────────┬───────────────────────────────┘
                              │ MCP + documented OpenAI _meta
                              v
┌─────────────────────────────────────────────────────────────┐
│ OpenAI product/app host + Secure MCP Tunnel endpoint        │
│ - transport/auth context                                   │
│ - NOT local authority                                      │
└─────────────────────────────┬───────────────────────────────┘
                              │ outbound tunnel
                              v
┌─────────────────────────────────────────────────────────────┐
│ tunnel-client v0.0.14+ exact accepted build                │
│ - one shared workstation runtime                           │
│ - bounded concurrency                                      │
└─────────────────────────────┬───────────────────────────────┘
                              │ stdio MCP
                              v
┌─────────────────────────────────────────────────────────────┐
│ WAG serve-stdio                                            │
│ - trusted admission resolves host correlation              │
│ - WAG mints owner/session/adapter/workspace                 │
│ - capability policy + local approvals + fencing            │
│ - semantic effects only                                    │
└─────────────────────────────┬───────────────────────────────┘
                              │ bounded local executor API
                              v
┌─────────────────────────────────────────────────────────────┐
│ DevSpace / repository / Git                                │
│ - no direct ChatGPT access                                 │
└─────────────────────────────────────────────────────────────┘
```

### What `chatgpt-wag-access` should contain

**Initial repository scope:**

- this research report and evidence ledger;
- exact OpenAI product/tunnel setup runbook;
- custom-app tool metadata/description definitions if they are not already sourced directly from WAG;
- tunnel profile templates with secret references only;
- version pin/check script or receipt format;
- metadata-correlation canary/harness;
- single-session acceptance harness;
- five-session acceptance harness;
- performance/cleanup measurement scripts;
- Desktop Commander absence/negative-control checklist;
- result/evidence schema for acceptance receipts.

**Only if proven necessary:** a thin ChatGPT-specific ingress shim that:

- receives OpenAI host metadata;
- canonicalizes/validates presence/shape;
- computes/forwards non-authoritative correlation material;
- invokes WAG’s admission seam;
- never owns policy/effects/durable authority.

### What must stay in WAG

- owner/session/adapter/workspace ID minting;
- capability profiles and admission;
- allowed roots and path policy;
- local secrets;
- Goal Lease/lease binding if WAG is the canonical owner;
- fencing generation checks;
- mutation plan persistence and state machine;
- local approval service;
- verify authority and durable result core;
- future bounded Git status/diff/commit semantics;
- audit/effect evidence;
- restart reconciliation.

## Fallback architecture

### Near-term fallback while full private MCP is unavailable

Keep the existing WAG Browser Inspect v2 path **read-only** and retain Claude Code/Codex as implementation owner for mutations/Git. Do not weaken WAG to make Plus behave like Business.

### Full-write fallback if Business is unacceptable but normal ChatGPT access is mandatory

Build a reviewed public plugin architecture with a universal HTTPS MCP relay, real OAuth, authenticated device routing, and an outbound local WAG bridge. This is a separate product/distribution project, not the next P1 step. It should be greenlit only if non-Business distribution has strategic value beyond this one workstation.

---

# 13. Reasons alternatives lost

## Public remote MCP endpoint lost to Secure MCP Tunnel

It solves a problem OpenAI now solves natively while adding public ingress, hosting, TLS, OAuth, abuse protection, monitoring, and relay operations.

## Existing browser extension/native bridge lost as the target path

WAG’s own accepted security decisions limit the current browser admission to read-only authority. Promoting it would require stronger caller isolation and would still retain browser/extension/native-host complexity that the official tunnel path removes.

## WebMCP/site-tools lost

It is tied to the desktop built-in browser and the providing page, adding page/tab lifecycle and browser-state dependence. P1 needs a normal ChatGPT structural backend path, not a special local website that must stay open.

## Desktop Work/Codex local lost

It may be operationally capable, but it moves local authority outside WAG. That violates the central program constraint rather than solving it.

## Universal public relay/public plugin lost for the short-term objective

It has real strategic value only if broad distribution is a goal. For one workstation it creates a much larger auth, hosting, routing, legal/review, monitoring, and incident-response surface.

## Extra P1 proxy lost by default

WAG already has a direct stdio MCP surface designed for Secure MCP Tunnel. An extra proxy adds a new process and a new place where identity can accidentally become authority. Add it only after a spike proves a concrete interface gap.

---

# 14. Near-term implementation consequences

## Minimal sequence

### Phase 0 — artifact/repo setup only

1. Create `E:\Projects\chatgpt-wag-access` as the P1 research/acceptance repository when the workstation is available.
2. Add this report unchanged as the first canonical evidence artifact.
3. Record WAG dependency as an external authority at exact SHA; do not vendor or mutate it.

### Phase 1 — external read/verify acceptance, no WAG mutation

1. Obtain/use ChatGPT Business developer mode for the external acceptance window.
2. Pin/test `tunnel-client` v0.0.14 or the then-current explicitly reviewed release.
3. Connect the current WAG built `serve-stdio` command through Secure MCP Tunnel.
4. Create a draft developer-mode custom app; do not publish until stable.
5. Run S1 and S5.

**Exit criterion:** `CHATGPT_WAG_DIRECT_READ_VERIFY = PASS` and `DESKTOP_COMMANDER_IN_PATH = FALSE`.

### Phase 2 — correlation + five-session acceptance

1. Prove `_meta` arrival and session correlation with S2.
2. Reuse WAG caller-context semantics; do not create P1 durable identity.
3. Run S3/S4 and record CPU/RAM/process/latency evidence.

**Exit criterion:** `CHATGPT_WAG_FIVE_SESSION_READ_VERIFY = PASS`.

### Phase 3 — WAG authority design request, not P1 implementation

Only after Phase 2 passes, open a WAG design task for the smallest missing semantic projections:

1. expose existing `repo.search` to the Business profile if policy accepts it;
2. expose existing durable `mutation.preview` / `mutation.result` to the Business profile while preserving local-only approval;
3. define bounded read-only repository status/diff semantics;
4. define one bounded commit semantic tied to exact candidate/diff digest, current WAG session/lease/fencing generation, and repository HEAD;
5. explicitly exclude push, branch rewrite, arbitrary Git flags, raw shell, and process execution.

### Phase 4 — implementation-owner acceptance

After WAG separately accepts those capabilities, execute a disposable real repository task entirely through ChatGPT → WAG:

```text
workspace.open
repo.search / repo.snapshot / file.read
mutation.preview
local operator approval
mutation.result
verify.run
repo.status
repo.diff
repo.commit
repo.snapshot / read-back
```

Repeat with five sessions and contention cases.

---

# 15. Reusable findings for other projects

## COMMON-1 — OpenAI private localhost access

Do not build a public reverse proxy merely because a local MCP server cannot be called directly by ChatGPT. Secure MCP Tunnel is now the official outbound-only private bridge. Reuse OPENAI-TUNNEL-001/002.

## COMMON-2 — Host session IDs are correlation, not authority

`openai/session` is useful for conversation correlation and five-session isolation, but durable local authority should be minted locally. Reuse OPENAI-SESSION-001 + WAG-IDENTITY-001.

## COMMON-3 — Avoid protocol-session authority

Modern MCP is moving toward per-request/sessionless semantics. Durable ownership, jobs, leases, and effect state belong above transport. Reuse MCP-2026-001.

## COMMON-4 — One shared transport stack can support multiple sessions

OpenAI tunnel-client has explicit bounded concurrency and independent in-flight buffering. Do not multiply local processes per chat until measurements show isolation requires it. Reuse OPENAI-TUNNEL-CONC-001.

## COMMON-5 — Secure transport is not effect authorization

Tunnel association, OAuth, app permissions, model confirmations, and MCP annotations are layers. The local authority service still must validate every consequential effect. Reuse OPENAI-AUTH-001 + WAG identity/mutation evidence.

## COMMON-6 — Keep proposal and execution separated

WAG’s durable mutation pattern is broadly reusable: remote AI proposes an immutable effect; local authority reviews/executes; remote AI retrieves result. This avoids timing-sensitive “preview then later remote apply” workflows.

## COMMON-7 — Browser automation should be fallback, not substrate

Where provider-native structured tools exist, prefer them to DOM parsing, extension message parsing, or synthetic clicks. This reduces browser friction, prompt-injection surface, and process/lifecycle complexity.

## COMMON-8 — Five-session acceptance must include resource contention, not only five successful reads

A useful concurrency test must prove identity separation, same-resource fencing, restart/retry behavior, and no result misattribution. Throughput alone is insufficient.

---

# 16. Open questions

1. Where is the canonical **Goal Lease** schema/lifecycle for this coordinated program? Is WAG its owner, or does WAG consume a claim from another authority?
2. Does actual ChatGPT Business Tunnel traffic deliver all documented `_meta` fields to WAG’s current stdio tool handler without a shim?3. Does one `openai/session` remain stable when the user reloads/reopens the same ChatGPT conversation?
4. Does ChatGPT invoke multiple tools concurrently inside one selected-app message, and what ordering guarantees, if any, are observable?
5. What is the product-side timeout for a long `verify.run` through a custom app + Secure MCP Tunnel?
6. Should WAG eventually project its durable verify job core as an explicit semantic job/result tool for long tests, or is synchronous verify sufficient for the target workload?
7. What is the smallest bounded Git contract: separate `repo.status/repo.diff/repo.commit`, or a single candidate-oriented commit operation?
8. Should the first private single-operator write path use only workspace/tunnel admission + local WAG approval, or should it add OAuth immediately despite the extra auth-server surface?
9. What exact CPU/RAM/process budget should become the hard gate after the first Windows measurement?
10. Is ChatGPT’s current per-message custom-app selection UX acceptable for sustained implementation ownership, or does it materially slow the workflow versus Claude Code/Codex?

---

# 17. Handoff capsule

## 10 most important confirmed facts

1. Full private custom MCP write/modify is currently a ChatGPT Business/Enterprise/Edu web capability; Pro is read/fetch only and Plus is not the private full-MCP route. (OPENAI-MCP-001)
2. ChatGPT cannot directly reach localhost; Secure MCP Tunnel is the official private/dev-machine bridge. (OPENAI-TUNNEL-001)
3. Secure MCP Tunnel is outbound-only and supports a local stdio MCP command, so WAG does not need a public inbound listener. (OPENAI-TUNNEL-002)
4. ChatGPT provides `openai/session` conversation correlation plus anonymized subject/org metadata to MCP tool calls. (OPENAI-SESSION-001)
5. Those provider/session identifiers must remain correlation only; WAG ADR-0017 requires WAG-owned owner/session/adapter authority. (WAG-IDENTITY-001)
6. Current tunnel-client supports bounded concurrency; default active MCP concurrency is 10, so five calls are transport-feasible in principle. (OPENAI-TUNNEL-CONC-001)
7. WAG already chose Business + Secure MCP Tunnel + WAG stdio as its preferred private ChatGPT route. (WAG-STDIO-001)
8. WAG’s local stdio readiness passed, but real ChatGPT Business end-to-end acceptance is still missing. (WAG-STDIO-ACCEPT-001)
9. Current WAG Business MCP exposes read/snapshot/verify only; mutation and Git writes are not authorized. (WAG-SURFACE-001)
10. WAG already has an accepted durable mutation core with remote preview, local approval/execution, and remote result retrieval; reuse it instead of raw remote patch/apply. (WAG-MUTATION-001)

## 5 remaining uncertainties

1. Real ChatGPT Business + Tunnel + WAG end-to-end behavior, including host `_meta` delivery.
2. Five-session WAG/DevSpace isolation/performance and same-repository contention.
3. Reconnect/restart lifetime of ChatGPT session correlation and in-flight verify calls.
4. Canonical Goal Lease owner/schema and how it binds to WAG session/fencing.
5. The exact bounded Git status/diff/commit authority contract WAG should expose.

## Recommended next action

**Do not design another browser bridge.** Run the external **single-session read/verify Secure MCP Tunnel acceptance** against the current WAG `serve-stdio` surface, then immediately run the five-session correlation/isolation benchmark. Those two spikes decide whether any P1 runtime adapter is needed at all.

## Exact artifacts another session should consume

### P1 artifact

- `P1_CHATGPT_WAG_DIRECT_ACCESS_RESEARCH_2026-09-21.md` — this report.

### WAG canonical authority at research time

- `ShenJun93/web-agent-gateway@bd2727a1c3792f60b72f6c470b3034481b294e72`
- `README.md`
- `docs/adr/0017-use-wag-owned-adapter-admission.md`
- `docs/adr/0018-lock-webchat-local-coding-mission.md`
- `docs/adr/0019-separate-browser-proposal-from-consequential-authority.md`
- `docs/superpowers/specs/2026-09-10-business-secure-mcp-stdio-design.md`
- `docs/benchmarks/2026-09-10-business-stdio-preupgrade.md`
- `docs/benchmarks/2026-09-13-durable-mutation-control-plane.md`
- `docs/benchmarks/2026-09-16-mcp-sdk-v2-production-migration-v1.md`
- `docs/research/2026-09-10-openai-plugin-deployment-route.md`

### Current upstream/official sources

- OpenAI Developer mode and MCP apps: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- OpenAI Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- OpenAI plugin reference (`openai/session`, `subject`, `organization`): https://developers.openai.com/plugins/reference
- OpenAI MCP authentication: https://developers.openai.com/plugins/build/auth
- OpenAI tunnel-client upstream: https://github.com/openai/tunnel-client
- OpenAI tunnel-client v0.0.14: https://github.com/openai/tunnel-client/releases/tag/v0.0.14
- MCP TypeScript SDK 2026-07-28 migration: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md

## Research that SHOULD NOT be repeated

Do **not** re-research these questions unless a cited source changes or a live acceptance falsifies them:

- whether ChatGPT can directly connect to localhost — **it cannot; use Secure MCP Tunnel**;
- whether Secure MCP Tunnel supports stdio/private developer-machine MCP — **it does**;
- whether full private MCP write is currently available on Plus/Pro — **Plus no; Pro read/fetch only; full MCP Business/Enterprise/Edu**;
- whether ChatGPT has a conversation-level correlation field for MCP — **`openai/session` exists**;
- whether provider conversation/session IDs should become WAG durable authority — **WAG ADR-0017 says no**;
- whether WAG already selected Business + Tunnel + stdio — **yes**;
- whether current Business WAG surface already supports mutation/Git — **no**;
- whether WAG has a durable mutation core worth reusing — **yes**;
- whether an extra public relay is required for private local WAG — **no**;
- whether five concurrent tunnel requests are categorically impossible — **no; tunnel-client defaults to 10 active MCP requests, but end-to-end five-session acceptance is still required**.

---

# Final recommendation

## Preferred architecture

**ChatGPT Business custom MCP app → OpenAI Secure MCP Tunnel → one local tunnel-client → WAG `serve-stdio` → DevSpace/resources.** Keep P1 runtime-free unless live metadata/admission evidence proves a thin shim is necessary.

## Fallback architecture

- **Near-term/no-Business:** keep WAG Browser Inspect read-only and keep an existing coding owner for effects; do not weaken the security boundary.
- **If full-write on non-Business ChatGPT becomes strategically mandatory:** public reviewed plugin + OAuth + universal HTTPS relay + outbound local WAG bridge, treated as a separate distribution product.

## Exact trust boundaries

ChatGPT/model = intent only → OpenAI app/tunnel = transport/product context → optional P1 shim = correlation translation only → **WAG = authority** → DevSpace/Git/files = effect executors → local human authority where policy requires.

## Exact session identity model

Use `openai/session` + subject/org as non-authoritative correlation. WAG domain-separates/digests correlation, mints its own `owner_id/session_id/adapter_id/workspace_id`, and binds any Goal Lease/lease generation server-side. Five ChatGPT conversations must map to five WAG sessions even for one user and one root.

## Required WAG interface only

### Already available

- `health`
- `workspace.open`
- `repo.snapshot`
- `file.read`
- `verify.run`

### Smallest additional projections required for implementation ownership

- existing `repo.search` on the Business profile;
- existing durable `mutation.preview`;
- existing durable `mutation.result`;
- bounded read-only repository status/diff semantics;
- one bounded commit semantic bound to exact candidate/diff digest + current WAG caller context + current lease/fencing generation + expected repository HEAD.

**Explicitly not required:** raw shell, arbitrary Git command, PTY, arbitrary process execution, remote approval/apply, browser mutation, push, force update, arbitrary environment injection.

## Minimal implementation sequence

1. Single-session Business + Tunnel read/verify acceptance on current WAG — no WAG code change if possible.
2. Prove host metadata and WAG correlation mapping.
3. Five-session read/verify + restart/performance acceptance.
4. Separate WAG design/authorization for Business mutation projection.
5. Separate WAG design/authorization for bounded status/diff/commit semantics.
6. Five-session full implementation-loop acceptance with contention/retry/restart cases.

## Single-session acceptance

Pass only when a fresh normal ChatGPT session, with Desktop Commander absent, structurally invokes the WAG custom app through Secure MCP Tunnel and completes `health → workspace.open → repo.snapshot/file.read → verify.run`, with WAG/local evidence matching the conversation result and the negative control failing when tunnel-client is stopped.

## Five-session acceptance

Pass only when five simultaneous ChatGPT conversations share one local transport stack, receive five isolated WAG sessions/workspaces, complete interleaved operations without cross-session leakage or result misattribution, survive defined reconnect cases fail-closed, leave no owned processes behind, and meet recorded CPU/RAM/latency budgets.

## Conditions under which ChatGPT can replace Claude Code as implementation owner

ChatGPT can replace Claude Code for this bounded workflow only after all of the following are true:

1. supported full-MCP plan/surface is active and stable enough for the workflow;
2. Secure MCP Tunnel single-session and five-session acceptance pass;
3. WAG—not ChatGPT/P1—mints and validates caller/session/workspace authority;
4. Goal Lease/lease/fencing identity is canonical and enforced at every protected effect;
5. Business surface exposes search/read, durable bounded mutation, verification, status/diff, and bounded commit semantics;
6. no generic shell/Git/process escape hatch is needed for the target tasks;
7. mutation and commit are restart/retry safe and never duplicated after ambiguous transport failure;
8. Desktop Commander and Claude Code are absent from the accepted execution path;
9. five-session CPU/RAM/process/latency evidence is acceptable on the target workstation;
10. the user accepts current per-message app-selection/confirmation friction and Business plan cost.

Until those gates pass, the correct status is **DIRECT READ/VERIFY CANDIDATE**, not “Claude Code replacement.”