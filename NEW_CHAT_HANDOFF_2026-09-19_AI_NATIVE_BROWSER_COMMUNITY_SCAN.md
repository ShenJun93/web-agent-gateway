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
   - `docs/research/2026-09-20-ai-native-browser-research-pass-8.md`
   - `docs/research/2026-09-20-ai-native-browser-research-pass-9.md`
   plus Pass 1–7 and replacement-pressure receipts referenced there.
5. Chat history last.

This handoff is not authority when Git disagrees.

## Verified state

Passes 1–9 plus the replacement-pressure audit are complete on the Pass 9 research branch. No local install or browser benchmark was run.

Pass 9 started from canonical remote `main`:
`5f9f3ff4ad02a6f65677cfdc789b5e94a840906f`.

## Current architecture direction

```text
BUILD_NEW_BROWSER = NO

SITE ACTIONS
  native API / WebMCP first
  -> Playwright/browser substrate fallback
  -> generic DOM/screenshot reasoning last

REMOTE WEBCHAT -> WAG
  standard MCP Streamable HTTP
  -> MCP OAuth / protected-resource identity
  -> replaceable reachability transport
  -> WAG capability/policy reduction

OPENAI PRIVATE REACHABILITY
  OpenAI Secure MCP Tunnel
  -> do not build WAG-specific OpenAI relay

PROVIDER-NEUTRAL REACHABILITY
  public HTTPS MCP or managed outbound tunnel
  -> application OAuth remains separate from transport

REMOTE BROWSER DEVICE IDENTITY
  browserControl-style device-scoped credential + OAuth donor
  -> not browser-wide URL bearer

LOCAL APPROVAL
  outside browser DOM authority
  -> URL-mode elicitation for external OOB flows
  -> Windows Hello/WebAuthn worth deeper exact-proposal-binding research

WINDOWS LOCAL SECRET/IPC
  explicit SID/DACL
  -> DPAPI CurrentUser for at-rest hardening
  -> app auth
  -> no hostile-same-user claim

PROCESS OWNERSHIP
  PID + creation identity + executable + WAG-owned record/job

EFFECT TRUTH
  PRECONDITION_CHECKED -> DISPATCHED -> RECONCILING
  -> CONFIRMED | FAILED | UNKNOWN
  -> no blind replay after UNKNOWN

CONSEQUENTIAL AUTHORITY
  WAG ADR-0019 retained

LOCAL LIFECYCLE
  SessionCommander/Cleanup exact-owned supervision retained
```

## Pass 9 material changes

### MCP 2026-era protocol/auth should replace custom remote WAG protocol ideas

The current standard direction favors stateless Streamable HTTP, protected-resource metadata, issuer/resource-bound OAuth and Client ID Metadata Documents (CIMD). Dynamic Client Registration remains compatibility material but is no longer the target design.

MCP client/server self-reported name/version metadata is not authority.

Use standard OAuth identity to enter WAG, then reduce authority again using WAG workspace/capability/proposal policy.

### OpenAI Secure MCP Tunnel is the OpenAI-native private path

Current OpenAI documentation provides an outbound-only tunnel path for private/on-prem/developer-machine MCP servers.

Therefore:

```text
CUSTOM_OPENAI_RELAY = DO_NOT_BUILD
OPENAI_PRIVATE_WAG_REACHABILITY = SECURE_MCP_TUNNEL_WHEN_AVAILABLE
TUNNEL_ID = TRANSPORT_REFERENCE_NOT_CAPABILITY
```

Keep WAG semantics independent from tunnel internals because entitlement/product surfaces can change.

### browserControl is the strongest remote authority donor found

Useful source patterns:

- proof-bound, short-lived device enrollment;
- separate device and MCP connector credentials;
- only credential digests in shared state;
- Protected Resource Metadata / OAuth;
- PKCE S256;
- rotating refresh tokens;
- device-bound grants/revocation;
- outbound authenticated WSS;
- observationId invalidation;
- exclusive interactive lease;
- local Pause/Disconnect wins.

Its current broad `browser:control` authority is still wider than WAG should grant.

Its current DCR client-registration path should evolve with MCP toward CIMD.

### Vibe remains reachability donor, not authority donor

Outbound relay gives excellent no-inbound-port UX.

But remote URL/UUID is itself browser-wide bearer authority. Public history includes a real credential-exposure incident and remote reconnect instability.

Do not copy that authority model.

### Managed transport donors

Cloudflare Tunnel provides mature outbound-only origin connectivity; Access/MCP OAuth can provide external identity. Keep WAG authority separate.

Tailscale Serve is strong for private local operator/admin UI across a tailnet. Funnel makes a service public and therefore still needs application authorization.

### Out-of-band approval

MCP URL-mode elicitation is accepted prior art for moving sensitive flows such as credentials/OAuth outside model context.

WAG-specific rule remains:

```text
AGENT_CAN_CONTROL_APPROVAL_SURFACE => NOT_INDEPENDENT_OPERATOR_AUTHORITY
```

Do not treat an approval URL opened in the same agent-controlled browser as ADR-0019 local approval.

Windows UserConsentVerifier supplies local Windows Hello/PIN/fingerprint verification. Win32 WebAuthn is stronger prior art when approval must be bound to the exact immutable proposal fingerprint.

## Retain / freeze

Freeze:
- custom remote WAG protocol;
- custom client-registration/auth protocol;
- static browser-wide remote bearer URL;
- OpenAI-specific public relay;
- generic browser action/catalog code;
- provider-specific browser transport clones.

Retain:
- authenticated caller normalization;
- opaque workspace/resource ownership;
- semantic capability/risk policy;
- ADR-0019 proposal/effect split;
- independent local approval;
- durable effect truth/reconciliation;
- Guardian continuity;
- SessionCommander exact-owned local lifecycle.

## Pass 10 — research only

Still no local benchmark or implementation.

Research next:

1. current MCP agent-identity/workload-identity roadmap and active proposals;
2. Enterprise Managed Authorization and Cross-App Access boundaries vs user OAuth;
3. whether newer MCP authorization primitives can reduce WAG caller-context custom code;
4. Windows WebAuthn/UserConsentVerifier exact-proposal binding and lighter OSS/native wrappers;
5. existing local approval brokers outside browser DOM authority;
6. OpenAI Secure MCP Tunnel threat/data-path/RBAC evidence as current documentation evolves;
7. whether remote transport can be fully interchangeable between Secure MCP Tunnel, public HTTPS, Cloudflare-style edge and private admin transport without changing WAG semantics;
8. device-bound/proof-of-possession options only if bearer theft remains a material unresolved gap;
9. watch browserControl/Vibe/Playwright/Chrome DevTools only when state changes;
10. no implementation until a concrete uncovered gap survives this research.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_9 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE

MCP_2026_REMOTE_PROTOCOL = PREFERRED_STANDARD
MCP_CIMD = TARGET_CLIENT_REGISTRATION
MCP_DCR = COMPATIBILITY_DEPRECATED
MCP_OAUTH = EXTERNAL_IDENTITY_NOT_COMPLETE_WAG_AUTHORITY

OPENAI_SECURE_MCP_TUNNEL = PRIMARY_OPENAI_PRIVATE_REACHABILITY
CUSTOM_OPENAI_RELAY = DO_NOT_BUILD
TUNNEL_ID = NOT_CAPABILITY

BROWSERCONTROL = PRIMARY_REMOTE_DEVICE_OAUTH_DONOR
VIBE = OUTBOUND_REACHABILITY_DONOR_NOT_AUTHORITY_MODEL
CLOUDFLARE_TUNNEL_ACCESS = PROVIDER_NEUTRAL_MANAGED_DONOR
TAILSCALE_SERVE = PRIVATE_OPERATOR_UI_DONOR

MCP_URL_ELICITATION = PREFERRED_OOB_EXTERNAL_FLOW
BROWSER_DOM_APPROVAL = NOT_INDEPENDENT_AUTHORITY
WINDOWS_USERCONSENTVERIFIER = LOCAL_VERIFICATION_DONOR
WINDOWS_WEBAUTHN = EXACT_TRANSACTION_APPROVAL_DONOR_TO_STUDY

REMOTE_TRANSPORT = REPLACEABLE
WAG_AUTHORITY_CORE = RETAIN
SESSIONCOMMANDER_EXACT_OWNED_LIFECYCLE = RETAIN
GUARDIAN_BROWSER_CONTROL_EXPANSION = NO

NEXT_ACTION = PASS_10_AGENT_IDENTITY_AND_LOCAL_APPROVAL_STANDARDIZATION
```
