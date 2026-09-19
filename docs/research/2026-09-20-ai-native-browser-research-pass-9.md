# AI-native Browser Research — Pass 9

Date: 2026-09-20
Status: RESEARCH RECEIPT — remote WebChat -> local browser authority/reachability; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start of pass: `5f9f3ff4ad02a6f65677cfdc789b5e94a840906f`

## Purpose

Continue user-requested research without local installation or empirical browser benchmarking.

Pass 9 asks a narrower question:

> If a hosted WebChat/agent must reach a private/local browser or WAG server, which parts should be standard MCP/OAuth, which parts should be an outbound tunnel, and which authority must remain local?

Compared models:

1. MCP 2026-07-28 authorization and current SDK direction.
2. OpenAI Secure MCP Tunnel.
3. browserControl remote OAuth/device model.
4. Vibe Browser outbound relay.
5. Cloudflare Tunnel + Access/MCP authorization.
6. Tailscale Serve/Funnel and identity/OAuth patterns.
7. MCP URL-mode elicitation for out-of-band interactions.
8. Windows Hello / WebAuthn as local operator-verification donors.

No local server, tunnel, browser profile, process, extension or account configuration was changed.

## Executive conclusion

Pass 9 creates stronger pressure to **stop inventing a WAG-specific remote relay/auth protocol**.

The preferred decomposition is now:

```text
REMOTE MCP CLIENT / WEBCHAT
  -> standard MCP Streamable HTTP
  -> standard MCP OAuth / protected-resource metadata
  -> replaceable reachability transport if origin is private
  -> WAG semantic capability / policy boundary
  -> local browser/action substrate
```

The tunnel is transport, not authority.

The strongest current transport fit for OpenAI-hosted clients is OpenAI Secure MCP Tunnel because it is explicitly designed for private/on-prem/developer-machine MCP servers and uses an outbound-only local tunnel client.

For a provider-neutral deployment, Cloudflare Tunnel + standards-based MCP OAuth/Access is the strongest mature generic pattern found in this pass. Tailscale is excellent for private operator/service networks, but Tailscale Serve alone does not make a service reachable from a hosted WebChat outside the tailnet; Funnel makes it public and therefore requires a real application authorization layer.

browserControl is the strongest open-source donor for **device-scoped remote browser identity + OAuth + local control arbitration**. Vibe is the strongest donor for **minimal outbound reachability UX**, but its browser-wide URL/UUID bearer model is materially weaker than standard OAuth/resource scoping.

MCP URL-mode elicitation is now accepted prior art for moving sensitive external interactions out of the MCP client. It is useful for WAG approval/credential flows, but a URL opened inside the same agent-controlled browser is not an independent operator boundary.

For high-risk local approval on Windows, Windows Hello/WebAuthn is stronger prior art than a page button. A WebAuthn assertion can be cryptographically tied to transaction client data; this is closer to WAG's immutable proposal fingerprint requirement than a generic "Approve" click.

## 1. MCP 2026-07-28 — remote WAG should converge, not fork

The final MCP 2026-07-28 specification materially changes the correct remote architecture.

### Stateless request core

The protocol no longer depends on the old initialize/session model for the modern path.

Each request carries its own protocol/client metadata and standard HTTP headers such as:

- MCP-Protocol-Version;
- Mcp-Method;
- Mcp-Name.

This makes ordinary gateways, WAFs, rate limiters and load balancers more useful because they can route/meter without parsing opaque JSON bodies.

For WAG this means a custom sticky WebSocket/session relay becomes harder to justify for the remote MCP layer.

### Authorization hardening

Current MCP authorization direction includes:

- RFC 9207 authorization-server issuer validation;
- credentials bound to the authorization server that issued them;
- RFC 8707 resource binding;
- Protected Resource Metadata;
- incremental scope step-up;
- TLS requirements for non-loopback token endpoints;
- Client ID Metadata Documents (CIMD) replacing Dynamic Client Registration as the preferred registration path.

Dynamic Client Registration remains for compatibility but is deprecated in 2026-07-28.

WAG implication:

```text
CUSTOM_REMOTE_REGISTRATION_PROTOCOL = AVOID
CUSTOM_BROWSER_WIDE_BEARER = AVOID
MCP_RESOURCE_BINDING = PREFER
MCP_OAUTH_ISSUER_BINDING = PREFER
CIMD = TARGET_DIRECTION
```

### Client metadata is not authority

The current TypeScript SDK explicitly treats clientInfo/serverInfo as self-reported display/debug metadata, not security identity.

Therefore WAG must continue deriving authority from the authenticated principal/token/capability context, not from MCP client name/version strings.

Sources:
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2
- https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html

## 2. MCP authorization granularity — useful transport identity, not complete WAG capability policy

Current MCP application authorization supports both server-wide and protected-tool models.

Protected resources advertise OAuth metadata. A protected call returns HTTP 401/WWW-Authenticate and the client discovers the authorization server. Tokens must be issued for the target resource; current SDKs expose token scopes and resource identity.

This is useful for WAG because the external transport can prove:

- which authenticated principal authorized access;
- which MCP resource the token targets;
- which scopes were granted;
- which issuer minted the credentials.

However OAuth scopes should not become the only WAG authority model.

WAG still needs exact local policy objects such as:

- workspace ownership;
- immutable proposal fingerprint;
- exact verify profile;
- bounded file/resource targets;
- generation/precondition;
- local approval state;
- durable effect ownership.

Use OAuth to enter the WAG trust boundary, then reduce authority again through WAG semantic capabilities.

## 3. OpenAI Secure MCP Tunnel — strongest direct fit for ChatGPT/Codex private WAG

OpenAI's current documentation states that ChatGPT does not connect directly to a local MCP server.

For private/on-prem/developer-machine servers, Secure MCP Tunnel provides an outbound-only path:

```text
OpenAI product
  -> OpenAI-hosted tunnel endpoint
  -> queued/long-polled tunnel commands
  -> customer-hosted tunnel-client
  -> private stdio or HTTP MCP server
```

The local server does not need to be exposed to the public Internet.

Current documentation supports:

- private network/on-prem/developer-machine origins;
- outbound HTTPS from tunnel-client to OpenAI;
- downstream stdio or HTTP MCP;
- associations between Platform organizations / ChatGPT workspaces and a tunnel;
- separate Tunnels Read/Manage/Use permissions;
- ChatGPT connection through a tunnel selection;
- Responses API using `tunnel_id`, not a fabricated tunnel `server_url`.

This is strategically important for WAG:

```text
CHATGPT_WEB_PRIVATE_REACHABILITY = SOLVED_UPSTREAM_FOR_SUPPORTED_PLANS
WAG_PUBLIC_LISTENER_REQUIRED = NO
WAG_CUSTOM_OPENAI_RELAY = DO_NOT_BUILD
```

### Current operational maturity caveat

Community/support evidence from 2026 shows real early-friction cases:

- workspace/org association failures;
- tunnel entitlement/RBAC confusion;
- 424 errors when users supplied the hosted tunnel endpoint as `server_url` instead of `tunnel_id`;
- ChatGPT Work vs normal Chat connector behavior differences in at least one recent report.

Several association incidents were later confirmed resolved.

Interpretation:

Secure MCP Tunnel is strong architectural prior art and the correct OpenAI-native lane, but not evidence that every current product surface is operationally boring.

Do not make WAG semantics depend on OpenAI tunnel internals. Keep a replaceable remote transport adapter.

Sources:
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://community.openai.com/tag/secure-tunnel/1159

## 4. OpenAI product constraint matters to WAG roadmap

Current OpenAI Help Center documentation says:

- full custom MCP including write/modify actions is rolling out for Business, Enterprise and Edu;
- Pro can connect custom MCPs with read/fetch permissions in developer mode;
- Agent mode does not use custom apps;
- Deep research can use custom apps for read/fetch only.

Therefore a local browser control system that depends on write-capable ChatGPT custom MCP cannot assume universal plan availability.

Architectural implication:

- keep WAG provider-neutral;
- keep Browser Inspect/read paths independently useful;
- do not redesign the core around a current ChatGPT entitlement;
- use provider adapters to surface the best capability each host currently supports.

Source:
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

## 5. browserControl — strongest open-source remote authority/reachability donor

Pass 8 identified browserControl as interesting. Pass 9 source review strengthens that conclusion.

### Device enrollment

The extension:

1. generates a 256-bit nonce locally;
2. sends only the SHA-256 nonce digest to enrollment start;
3. receives a random 60-second enrollment ticket;
4. claims it with the original nonce;
5. atomically consumes the single-use ticket;
6. receives independent device-scoped credentials.

This is materially better than a static URL bearer copied between clients.

### Split credentials

browserControl separates:

- deviceToken for extension WSS identity;
- mcpToken anchoring connector/OAuth authorization;
- admin token for operator device management;
- relay-cluster credential for internal replica forwarding;
- OAuth access/refresh tokens for remote MCP clients.

Shared relay state stores credential digests rather than plaintext device credentials.

### OAuth

Remote MCP publishes Protected Resource Metadata and Authorization Server Metadata.

The current implementation supports:

- authorization code;
- PKCE S256;
- opaque access tokens;
- rotating refresh tokens;
- exact MCP resource scoping;
- browser:control scope;
- device-bound grant;
- grant invalidation after device revocation or connector credential rotation.

The current docs use DCR for clients such as Claude.ai. MCP 2026-07-28 now deprecates DCR in favor of CIMD, so this is a **migration pressure**, not a reason to reject the architecture.

### Reachability

The extension maintains an outbound authenticated WSS connection. Hosted MCP clients never reach localhost or a Chrome debug port.

Browser payloads are forwarded in memory through the active relay path; Redis stores control-plane state/presence rather than screenshots.

### Browser authority

Mutations require a fresh observationId. Page/user/navigation changes invalidate old observations.

Each MCP connection uses an interactive lease; local interactive control has priority over remote mutation. Pause/Disconnect are local controls.

This is strong browser-side conflict control.

### Remaining mismatch with WAG

The external OAuth scope is still broad: browser:control gives a remote principal the browserControl browser tool surface.

That is not equivalent to WAG least-authority semantic policy.

WAG should copy the **device identity / OAuth / observation / lease decomposition**, not the broad browser authority.

Disposition:

```text
BROWSERCONTROL_REMOTE_TRANSPORT = STRONG_DONOR
BROWSERCONTROL_DEVICE_IDENTITY = STRONG_DONOR
BROWSERCONTROL_OAUTH = STRONG_DONOR
BROWSERCONTROL_OBSERVATION_FENCE = STRONG_DONOR
BROWSERCONTROL_LOCAL_PAUSE = STRONG_DONOR
BROWSERCONTROL_MCP_DCR = MIGRATE_TOWARD_CIMD
BROWSERCONTROL_BROWSER_CONTROL_SCOPE = TOO_BROAD_FOR_WAG_CORE
```

Sources:
- https://github.com/Officially-aditya/browserControl
- https://github.com/Officially-aditya/browserControl/blob/main/docs/CLAUDE_OAUTH.md
- https://github.com/Officially-aditya/browserControl/blob/main/docs/WEB_CONTROL_PIPELINE.md

## 6. Vibe Browser — reachability is elegant; authority model remains weaker

Vibe demonstrates the simplest useful user experience found for hosted WebChat -> real local Chrome:

```text
extension
  -> outbound relay connection

hosted MCP client
  -> https://relay.../mcp/<uuid>
```

No inbound PC port is required.

This proves that browser reachability can be made nearly frictionless.

But the hosted UUID/URL is itself the browser-control bearer. That makes:

- copy/paste leakage;
- logs/history/screenshots;
- accidental publication;
- support bundles;
- browser extensions;
- chat transcripts

all relevant credential exfiltration paths.

The public issue #105 incident, where a live relay identifier was published and used externally, converts this from a theoretical concern into observed operational evidence.

Later hardening substantially improves redaction, WSS requirements and lifecycle health, but does not change the core bearer model.

WAG lesson:

```text
VIBE_OUTBOUND_CONNECTIVITY_PATTERN = REUSE_CONCEPT
VIBE_BROWSER_WIDE_URL_BEARER = DO_NOT_COPY
URL_ID != AUTHORIZATION_POLICY
TUNNEL_ID != CAPABILITY
```

Sources:
- https://github.com/VibeTechnologies/vibe-mcp
- https://github.com/VibeTechnologies/vibe-mcp/issues/105
- https://github.com/VibeTechnologies/vibe-mcp/issues/87

## 7. Cloudflare Tunnel + Access — strongest provider-neutral managed transport donor

Cloudflare Tunnel provides a mature generic outbound-only origin connector.

Current docs state:

- origin has no public IP requirement;
- cloudflared creates outbound-only connections;
- inbound firewall rules can remain closed;
- public/private HTTP and other protocols can be routed through Cloudflare;
- multiple connectors/replicas support availability.

This solves **reachability**, not application authority.

Cloudflare Access now adds Managed OAuth for non-browser clients, including AI agents and MCP use cases. It returns 401/WWW-Authenticate with OAuth discovery rather than forcing an HTML login redirect.

Cloudflare's Agents/MCP stack also supports OAuth-protected remote MCP servers and per-user vs service-token patterns.

This is architecturally clean:

```text
cloudflared = transport
Access / MCP OAuth = external identity
WAG = capability/policy/effect authority
```

Risks/trade-offs:

- vendor control/data-plane dependency;
- public application configuration complexity;
- a generic tunnel can expose more origin surface than intended if routing is broad;
- service tokens represent machine identity, not human delegated approval.

Disposition:
**strong provider-neutral managed transport donor; not browser authority.**

Sources:
- https://developers.cloudflare.com/tunnel/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- https://developers.cloudflare.com/changelog/post/2026-03-20-managed-oauth/
- https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/
- https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/

## 8. Tailscale — excellent private network identity, weaker direct hosted-WebChat fit

Tailscale Serve exposes a local service only within the tailnet and applies tailnet access controls.

That is excellent for:

- operator UI;
- private admin surface;
- same-team machines;
- local approval broker reachable only through the user's private network.

But a hosted WebChat is generally not inside the user's tailnet, so Serve does not by itself solve remote ChatGPT/Claude reachability.

Tailscale Funnel exposes a service to the public Internet. Once Funnel is used, application authorization again becomes mandatory; tailnet membership is no longer the caller identity.

Tailscale's OAuth Apps and tsidp demonstrate strong identity prior art:

- per-user authorization;
- user identity reflected in policy/audit;
- standard OAuth/OIDC integration;
- network identity as an input to application authorization.

Disposition:

```text
TAILSCALE_SERVE = STRONG_PRIVATE_OPERATOR_UI_TRANSPORT
TAILSCALE_FUNNEL = PUBLIC_REACHABILITY_NOT_AUTHORITY
TAILSCALE_IDENTITY = STRONG_DONOR
DIRECT_CHATGPT_REACHABILITY_VIA_SERVE = NO
```

Sources:
- https://tailscale.com/docs/features/tailscale-serve
- https://tailscale.com/docs/features/tailscale-funnel
- https://tailscale.com/docs/features/oauth-apps
- https://tailscale.com/docs/features/tsidp

## 9. URL Mode Elicitation — standard out-of-band interaction lane

SEP-1036 adds URL-mode elicitation for secure out-of-band interactions.

The core purpose is to keep sensitive external interactions out of the MCP client/model context, including:

- OAuth authorization;
- credential collection;
- payment flows.

The MCP client displays an affordance; sensitive inputs go directly to the external/server-controlled flow rather than transiting through the MCP client.

This is strong standard prior art for WAG where an external authorization/approval ceremony is required.

### Security boundary

The MCP security discussion is explicit that URL elicitation can introduce phishing/social-engineering risk.

Clients should visibly show which server requested the URL and should not automatically act on the URL without user consent.

For WAG, one additional rule is required:

> Do not complete the out-of-band approval inside a browser surface that the requesting agent can itself control.

A separate browser/profile, native system UI or other independent operator channel is stronger.

Disposition:

```text
MCP_URL_ELICITATION = PREFER_FOR_EXTERNAL_OOB_FLOW
ELICITATION_URL_AUTO_NAVIGATE_BY_AGENT = FORBIDDEN
ELICITATION_URL_IN_AGENT_CONTROLLED_TAB = NOT_INDEPENDENT_APPROVAL
```

Sources:
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1036
- https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/

## 10. Windows local approval — UserConsentVerifier and WebAuthn are stronger donors than page UI

WAG ADR-0019 requires a local operator authority transition before consequential execution.

Pass 8 proved that browser-DOM approval is not independent when the agent can automate that DOM.

Windows supplies better native primitives.

### UserConsentVerifier

Windows UserConsentVerifier can request verification through Windows Hello/PIN/fingerprint for a sensitive operation.

Microsoft explicitly describes requiring verification before authorizing sensitive actions such as purchases/restricted resources.

This provides a useful local-presence/user-verification gate.

But a plain verified/not-verified result is not by itself a cryptographic binding to the full proposal.

Use it as a lightweight local confirmation donor, not as the final proof object if exact action binding is required.

### Win32 WebAuthn assertion

Windows WebAuthn can produce an assertion representing authenticator confirmation that the user consented to a specific transaction.

The request takes client data that is hashed/sent to the authenticator.

This gives a stronger possible WAG design:

```text
proposal
  -> canonical proposal fingerprint
  -> challenge/clientData
  -> local WebAuthn/Windows Hello UI
  -> signed assertion
  -> verify assertion + exact proposal fingerprint
  -> single-use approval consumption
  -> dispatch
```

This is closer to ADR-0019 than a generic local button because approval can be cryptographically bound to the immutable transaction.

This is research only. It does not authorize implementation or require WAG to build a WebAuthn RP immediately.

Sources:
- https://learn.microsoft.com/windows/security/identity-protection/hello-for-business/webauthn-apis
- https://learn.microsoft.com/en-us/windows/win32/api/webauthn/nf-webauthn-webauthnauthenticatorgetassertion
- https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier.requestverificationasync

## 11. Recommended remote architecture after Pass 9

```text
HOSTED WEBCHAT / REMOTE AGENT
        |
        | Standard MCP Streamable HTTP
        | OAuth resource/issuer/scope identity
        v
REMOTE TRANSPORT EDGE
        |
        | OpenAI Secure MCP Tunnel for OpenAI-native path
        | OR provider-neutral managed tunnel/access
        | OR public HTTPS MCP endpoint
        v
LOCAL / PRIVATE WAG
        |
        | authenticated principal
        | provider-neutral adapter
        v
WAG AUTHORITY CORE
        |
        | opaque workspace ownership
        | semantic capability
        | risk class
        | proposal fingerprint
        | generation/precondition
        v
LOCAL APPROVAL BROKER IF REQUIRED
        |
        | native/OOB user verification
        | exact immutable proposal binding
        v
DURABLE EFFECT CORE
        |
        | dispatch
        | reconcile
        | CONFIRMED / FAILED / UNKNOWN
        v
BROWSER / LOCAL EXECUTION SUBSTRATE
```

Tunnel reachability and OAuth identity never directly become local consequential authority.

## 12. Replacement impact on WAG/Guardian/SessionCommander

### WAG code that should continue shrinking/freeze

Do not build:

- custom remote OAuth protocol;
- custom client registration protocol;
- static browser-wide remote bearer URL;
- OpenAI-specific public relay;
- provider-specific tunnel control plane;
- generic browser action semantics already covered upstream.

### WAG code still justified

Retain:

- normalized authenticated caller context;
- local capability reduction;
- exact workspace/resource ownership;
- proposal/effect separation;
- local approval;
- durable effect/reconciliation;
- provider-independent audit.

### Guardian

Remote transport findings do not change Guardian's continuity/context role.

Do not expand Guardian into a browser-control or tunnel manager.

### SessionCommander

Keep exact-owned local process supervision.

Tunnel clients, native hosts, browser daemons and approval brokers are still local processes whose ownership/recovery must be explicit.

Do not kill by name or treat a healthy network tunnel as proof that downstream local state is correct.

## 13. Decision table

| Layer | Preferred direction | Avoid |
|---|---|---|
| Remote protocol | MCP 2026-era standard path | custom WAG RPC |
| Client registration | CIMD target | new DCR-only design |
| Auth | OAuth protected resource + issuer/resource binding | URL/UUID browser-wide bearer |
| OpenAI private reachability | Secure MCP Tunnel | custom WAG public relay |
| Provider-neutral private reachability | standard HTTPS/tunnel + OAuth | coupling authority to tunnel UUID |
| Existing-profile browser device | browserControl-style device identity donor | shared global browser token |
| External sensitive flow | URL-mode elicitation | credential passthrough |
| Local high-risk approval | native user verification; WebAuthn worth deeper study | page-DOM approval |
| Browser action | Playwright/WebMCP/upstream | custom generic action engine |
| Local lifecycle | SessionCommander exact-owned supervision | kill-by-name/PID-only authority |
| Effect truth | CONFIRMED / FAILED / UNKNOWN | blind retry |

## Pass 10 — research only

Continue research; do not benchmark.

Next high-value research:

1. audit MCP 2026 agent-identity roadmap and whether upcoming primitives can reduce WAG caller-context custom code;
2. inspect Enterprise Managed Authorization and Cross-App Access boundaries vs per-user OAuth;
3. inspect current OpenAI Secure MCP Tunnel threat model/data path/RBAC documentation and community failure modes as evidence becomes available;
4. compare Windows WebAuthn/UserConsentVerifier with simpler local approval brokers and determine minimum exact-proposal binding design;
5. search for existing OSS local approval brokers that expose native Windows Hello/WebAuthn without bringing a large desktop runtime;
6. audit browserControl's current OAuth implementation against MCP 2026 CIMD/resource/issuer rules;
7. determine whether WAG can make remote transport completely interchangeable between Secure MCP Tunnel, public HTTPS and Cloudflare/Tailscale-like edges without changing capability semantics;
8. investigate device-bound proof / proof-of-possession options only if bearer-token theft remains material after standard MCP auth;
9. watch Vibe/browserControl/Playwright/Chrome DevTools only for state changes, not repetitive scans;
10. no implementation until research establishes a concrete gap.

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
CLOUDFLARE_TUNNEL_ACCESS = STRONG_PROVIDER_NEUTRAL_MANAGED_DONOR
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
