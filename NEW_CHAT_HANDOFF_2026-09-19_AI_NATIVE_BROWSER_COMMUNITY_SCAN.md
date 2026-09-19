# New Chat Handoff — AI-native Browser / Agent-browser Research

Date: 2026-09-20
Repository: `ShenJun93/web-agent-gateway`
Canonical branch: `main`

## User directive

Continue research. **Do not run local benchmarks yet.**

Do not preserve WAG/Guardian/SessionCommander browser code because of sunk cost. Prefer native/standard/proven upstream where evidence is stronger, but do not retire authority/lifecycle guarantees without evidence.

## Canonical authority

Fresh-read in order:

1. Git `main` / remote HEAD.
2. `README.md`.
3. ADR-0018 and ADR-0019.
4. Browser research receipts through:
   - `docs/research/2026-09-20-ai-native-browser-research-pass-7.md`
   - `docs/research/2026-09-20-ai-native-browser-research-pass-8.md`
   plus Pass 1–6 and replacement-pressure receipts referenced there.
5. Chat history last.

This handoff is not authority when Git disagrees.

## Verified research state

Passes 1–8 plus the replacement-pressure audit are complete on the Pass 8 branch. No local install or benchmark was run.

Pass 8 started from remote `main`:
`5c5b7c46982481f669b17158967a447ab7076492`.

## Current architecture direction

```text
BUILD_NEW_BROWSER = NO

site-native structured semantics
  -> WebMCP/native API first when available

provider-neutral browser automation
  -> Playwright primary substrate
  -> explicit isolated BrowserContext per owner
  -> Playwright Extension for existing profile, but broad profile authority is explicit

Chrome-specific diagnostics
  -> Chrome DevTools comparator
  -> not lifecycle authority

extension -> local host
  -> prefer Chromium Native Messaging when feasible
  -> avoid custom local listeners unless evidence requires them

Windows persisted bearer
  -> explicit current-user DACL
  -> DPAPI CurrentUser only for at-rest hardening
  -> do not claim hostile-same-user isolation

Windows named pipe
  -> explicit current-user/logon-SID DACL
  -> reject remote clients
  -> app-layer auth
  -> PID is supplementary, never authority

process ownership
  -> PID + creation identity + executable + WAG-owned ownership record/job

effect truth
  -> PRECONDITION_CHECKED -> DISPATCHED -> RECONCILING
  -> CONFIRMED | FAILED | UNKNOWN
  -> no blind replay after UNKNOWN

consequential authority
  -> WAG ADR-0019 retained

runtime/process lifecycle
  -> SessionCommander/Cleanup exact-owned supervision retained
```

## Pass 8 material changes

### Windows ACL concern is now verified

Node `0600` is not owner/group/other ACL proof on Windows. A default/NULL Windows named-pipe security descriptor is also not current-user-only.

Therefore Browser Controller and TaskWindow retain useful application/session designs but are not stronger Windows authority boundaries until explicit DACL/SID protection is shown.

### BrowserTap is the strongest new source donor

`LinVireo/browsertap-mcp` provides the closest prior art found for the missing WAG/SessionCommander mechanics:

- explicit Windows current-user owner + protected owner-only DACL before token write;
- DACL verification/hardening before token read;
- PID + process creation identity + executable checks before bridge termination;
- owner + generation-bound tab ownership;
- operation IDs and non-replayable unknown outcomes;
- late-result retention without converting UNKNOWN into safe retry.

Use it as source donor. Do not copy its broad browser authority/default lab-mode trust model.

### Native Messaging is preferred extension-to-host prior art

Chromium Native Messaging removes the need for an extension-facing custom local listener, uses browser-managed extension origin allowlists and stdio-spawned host processes.

It reduces attack surface but remains same-user local trust and does not replace WAG policy/approval/effect ownership.

### WebMCP now has real upstream pressure

Chrome/Edge origin trials are active and Playwright now exposes page-registered WebMCP tools through MCP. Prefer site-native structured actions before generic DOM automation when available.

WebMCP still has open agent identity/delegation/approval questions. Browser-page approval UI is not independent authority when the same agent can automate the page.

### Remote WebChat -> local browser prior art split

**browserControl**
- stronger authority donor: OAuth discovery, DCR, Authorization Code + PKCE, rotating tokens, device-bound grants, observation fences and exclusive interactive lease.

**Vibe Browser / Vibe MCP**
- stronger reachability donor: extension dials outbound to hosted relay, so no inbound PC port is required.
- weaker authority: hosted URL/UUID is a browser-wide bearer; page content traverses vendor relay.
- public history includes a live relay credential exposure incident and remote reconnect instability.

Do not adopt either wholesale as WAG authority. Pass 9 should compare the remote authority/reachability patterns systematically.

### Additional donors

- Savage MCP: mutual HMAC + host/path allowlist + deliberately narrow read/scrape capability.
- TaskWindow: useful tab/session UX and no-focus semantics; Windows token ACL proof remains missing.
- Chrome Agent Bridge: fail-closed profile routing and ungroup-before-close cleanup to avoid persistent Chrome saved-group residue.
- Hronaut: capability lineage/revision/effect truth donor; owner-token Windows ACL remains weaker than BrowserTap.
- LAPSrj/browser-mcp: strong Windows lifecycle donor; coordination record remains operational evidence, not authority.

## Freeze / retain

Freeze:
- generic DOM/action catalog in WAG;
- generic CDP wrappers;
- custom browser launcher/profile engine;
- provider-specific ChatGPT/Codex pipe clone;
- browser automation in Guardian;
- browser-semantic expansion in SessionCommander.

Retain:
- WAG caller/admission/opaque ownership;
- capability/risk policy;
- ADR-0019 proposal/effect split;
- independent local approval;
- durable effect/job ownership;
- audit/evidence;
- Guardian context/continuity;
- SessionCommander exact-owned lifecycle;
- Cleanup Sidecar verifier/fallback.

## Pass 9 — research only

Do not benchmark locally.

Focus next on **remote WebChat -> local browser authority/reachability**:

1. compare browserControl OAuth/device-bound model vs Vibe bearer relay;
2. compare current MCP authorization specification and OAuth protected-resource metadata;
3. compare OpenAI/ChatGPT remote/private MCP connection model where public documentation is available;
4. compare Cloudflare Access/Tunnel, Tailscale Serve/Funnel and ngrok-style broker patterns only as transport/identity donors, not as browser products;
5. separate browser content/data path from authority path;
6. compare credential rotation/revocation, device identity, no-inbound-port requirement, relay compromise impact and per-capability scoping;
7. find local operator approval brokers outside browser DOM authority;
8. prefer standard remote MCP/OAuth before custom relay protocol;
9. continue current issue watches only when state moves;
10. do not implement or benchmark.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_8 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE

BROWSERTAP = PRIMARY_WINDOWS_OWNERSHIP_EFFECT_DONOR
BROWSERCONTROL = REMOTE_OAUTH_OBSERVATION_LEASE_DONOR
VIBE = OUTBOUND_REACHABILITY_DONOR_WITH_BROWSER_WIDE_BEARER_RISK
SAVAGE_MCP = NARROW_READ_POLICY_DONOR
TASKWINDOW = TAB_SESSION_UX_DONOR_WITH_WINDOWS_ACL_GAP

WINDOWS_NODE_MODE_0600_OWNER_ONLY = FALSE
WINDOWS_DEFAULT_NAMED_PIPE_OWNER_ONLY = FALSE
PROCESS_PID_ONLY_AUTHORITY = FORBIDDEN

WEBMCP = STRATEGIC_NATIVE_SEMANTIC_LANE
PLAYWRIGHT = PRIMARY_PROVIDER_NEUTRAL_SUBSTRATE
CHROME_DEVTOOLS = DIAGNOSTIC_COMPARATOR_NOT_LIFECYCLE_AUTHORITY

WAG_EFFECT_RESULT = CONFIRMED_FAILED_UNKNOWN
UNKNOWN_BLIND_RETRY = FORBIDDEN
WAG_AUTHORITY_CORE = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN
GENERIC_BROWSER_MECHANICS_BUILD = FREEZE

NEXT_ACTION = PASS_9_REMOTE_WEBCHAT_BRIDGE_AND_AUTHORITY_PRIOR_ART
```
