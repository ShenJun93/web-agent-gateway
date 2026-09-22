# AI-native Browser / Agent Identity Research — Pass 10

Date: 2026-09-20
Status: RESEARCH RECEIPT — agent identity + local approval standardization; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start of pass: `ec2ca8f0f32ff7ae8199558f409e0ffd9ea6c286`

## Purpose

Continue the user-requested research program without local installation or benchmarking.

Pass 10 targets the exact next action recorded by Pass 9:

1. current MCP agent/workload identity roadmap;
2. Enterprise Managed Authorization / Cross-App Access boundaries;
3. whether 2026-era MCP auth can retire WAG caller-context code;
4. Windows Hello / WebAuthn exact-proposal approval;
5. local approval brokers outside browser DOM authority;
6. OpenAI Secure MCP Tunnel current threat/data-path/RBAC evidence;
7. transport interchangeability;
8. proof-of-possession only where bearer theft is a real gap;
9. adjacent standards that could replace custom proposal/approval design;
10. no implementation unless a concrete residual gap survives.

No browser launch, MCP tunnel deployment, Windows credential enrollment, registry mutation, process mutation or benchmark was performed.

## Executive conclusion

Pass 10 does **not** find one standard that replaces ADR-0019 end-to-end.

It does find enough mature standards to reduce future custom code by separating the problem into layers:

```text
HUMAN / ENTERPRISE IDENTITY
  OAuth 2.1 + MCP Protected Resource Metadata
  -> Enterprise Managed Authorization where enterprise policy exists

MACHINE / SERVICE IDENTITY
  client_credentials / private_key_jwt now
  -> Workload Identity Federation when platform identity exists

TOKEN-THEFT HARDENING
  DPoP when the authorization server + client path supports it

REMOTE TRANSPORT
  Secure MCP Tunnel | public HTTPS | managed tunnel
  -> replaceable reachability only

FINE-GRAINED AUTH REQUEST VOCABULARY
  OAuth Rich Authorization Requests can describe structured authorization
  -> does not itself prove independent human approval

LOCAL OPERATOR VERIFICATION
  UserConsentVerifier = lightweight user verification
  WebAuthn assertion = cryptographic challenge binding

EXACT EFFECT APPROVAL
  WAG-owned immutable proposal + independent local display
  -> WebAuthn challenge may bind proposal fingerprint
  -> approval remains single-use and atomic with effect dispatch

AGENT INSTANCE / DELEGATION
  still not standardized enough to replace WAG ownership/delegation semantics

EFFECT TRUTH / RECOVERY
  still WAG-owned
```

The main architecture correction is:

**Do not build a custom identity protocol. Do not pretend current MCP identity is already a complete agent-delegation standard. Compose the mature pieces and keep only the missing ownership/approval/effect semantics in WAG.**

---

## 1. MCP 2026 authorization now covers more identity classes, but not complete agent identity

### Core HTTP authorization

The 2026-07-28 MCP authorization model is a standard OAuth resource-server flow:

- OAuth 2.1;
- Protected Resource Metadata (RFC 9728);
- resource audience binding;
- Authorization Server / OIDC discovery;
- Client ID Metadata Documents as the preferred registration direction;
- DCR retained for compatibility;
- issuer/mix-up hardening in the current spec/SDK.

This should remain the remote WAG entry layer.

### Important per-request identity rule

The 2026 protocol is intentionally per-request/stateless.

An open transport is **not** a conversation or durable identity. The current TypeScript SDK also documents that `clientInfo` / `serverInfo` are self-reported display/debug metadata and must not drive security decisions.

Therefore WAG must not replace its exact caller/workspace/proposal ownership with:

- TCP connection identity;
- Streamable HTTP connection lifetime;
- self-reported client name/version;
- an MCP request stream;
- a tunnel ID.

### Current agent-identity gap remains real

MCP community discussions in 2026 still explicitly identify first-class verifiable agent identity and delegation as an unresolved/future area.

A March 2026 proposal describes the missing questions directly:

- which specific agent instance is acting;
- what authority was delegated;
- who delegated it;
- how a chain reaches a human/root authority.

Core maintainer notes in August 2026 still list enterprise security and first-class verifiable agent identities as active future work distinct from today's human-centric OAuth flows.

Therefore:

```text
MCP_USER_OR_CLIENT_AUTH = MATURE_ENOUGH_TO_REUSE
MCP_UNIVERSAL_AGENT_INSTANCE_IDENTITY = NOT_YET_CANONICAL
MCP_DELEGATION_CHAIN = NOT_YET_CANONICAL
```

Sources:
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2404
- https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3257
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md

---

## 2. Enterprise Managed Authorization / Cross-App Access is identity federation, not consequential approval

Enterprise Managed Authorization is now a **stable** MCP authorization extension.

Its purpose is to let an enterprise IdP become the policy authority for which employee/client/server combinations are allowed.

The flow uses:

- existing OIDC/SAML enterprise identity;
- RFC 8693 token exchange;
- Identity Assertion JWT Authorization Grant;
- resource authorization server token exchange;
- enterprise group/policy enforcement.

The TypeScript SDK exposes this as Cross-App Access helpers/providers.

### What it can replace in WAG

For a Business/Enterprise deployment it can replace custom code for:

- enterprise user SSO normalization;
- per-server interactive re-login;
- some caller identity acquisition;
- centralized employee offboarding/revocation;
- organization-level access policy ingress.

### What it cannot replace

It deliberately avoids a second per-server consent screen after the enterprise user is already authenticated.

That means it is **not** evidence of:

- local physical operator presence;
- approval of a particular verify/build/mutation proposal;
- agent instance ownership;
- approval freshness for one exact effect;
- single-use effect authorization.

Therefore:

```text
EMA_XAA = GOOD_EXTERNAL_IDENTITY_AND_ENTERPRISE_POLICY
EMA_XAA != ADR_0019_EFFECT_APPROVAL
EMA_XAA != AGENT_INSTANCE_IDENTITY
```

Sources:
- https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/machine-auth.md

---

## 3. Machine auth can remove shared-secret plumbing, but identity semantics remain application-defined

The MCP TypeScript SDK now provides machine-auth paths:

- `client_credentials`;
- `private_key_jwt`;
- Cross-App Access;
- generic externally-owned token providers.

`private_key_jwt` is preferable to a static client secret where a machine identity must authenticate to the Authorization Server using a key.

However, this authenticates the OAuth client at token issuance. It does not by itself prove that every resource request comes from the same key holder unless sender-constrained tokens are also used.

Therefore:

```text
PRIVATE_KEY_JWT = AS_CLIENT_AUTH
PRIVATE_KEY_JWT != PER_RESOURCE_REQUEST_PROOF_OF_POSSESSION
```

Source:
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/machine-auth.md

---

## 4. DPoP is the strongest current standards-based answer to bearer theft

SEP-1932 adopts OAuth DPoP (RFC 9449) for MCP sender-constrained tokens.

Current TypeScript SDK source already contains:

- `DpopSession`;
- per-request proof generation;
- token-endpoint DPoP;
- resource-server proof generation;
- AS and RS nonce tracking;
- DPoP challenge handling;
- access-token hash binding.

Current conformance work also covers DPoP client/server/authorization-server behavior.

### What this changes for WAG

If a remote WAG deployment has a material risk that an MCP bearer token can be stolen from:

- browser/device storage;
- a relay/tunnel host;
- logs;
- another process;

then DPoP can materially reduce replay value because possession of the token alone is insufficient.

This is a better direction than inventing WAG-specific HTTP message signing.

### What DPoP does not prove

A DPoP key proves possession of a signing key.

It does not inherently prove:

- which human is at the device;
- which exact Windows process is using the key;
- that the key is hardware-backed;
- that an agent delegated a particular authority chain;
- that the human approved this exact consequential action.

Therefore:

```text
CUSTOM_WAG_HTTP_POP = DO_NOT_BUILD
DPoP = PREFERRED_BEARER_THEFT_HARDENING_WHEN_SUPPORTED
DPoP_KEY = POSSESSION_IDENTITY_NOT_OPERATOR_APPROVAL
```

Current maturity caution:

DPoP is implemented in the TypeScript SDK and conformance work is active, but it should still be treated as an optional auth extension/profile rather than assumed universal MCP interoperability.

Sources:
- https://www.rfc-editor.org/rfc/rfc9449
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/dpop.ts
- https://github.com/modelcontextprotocol/conformance/issues/368
- https://github.com/modelcontextprotocol/conformance/issues/369
- https://github.com/modelcontextprotocol/conformance/issues/370

---

## 5. Workload Identity Federation is promising, but not yet a universal local-agent identity answer

SEP-1933 Workload Identity Federation is aimed at autonomous workloads with platform-issued identity:

- Kubernetes projected service-account JWT;
- SPIFFE JWT-SVID;
- cloud workload identity token.

The workload exchanges its platform identity for an MCP access token through the JWT Bearer grant.

Benefits:

- no long-lived client secret;
- no per-workload DCR;
- trust anchored in a platform issuer;
- natural fit for servers, CI, Kubernetes and cloud agents.

### Current maturity

Conformance scenarios exist.

As of this pass, the TypeScript SDK still carries `auth/wif-jwt-bearer` in its expected-failure baseline and has an implementation tracking issue. Do not describe WIF as uniformly shipped across current MCP SDKs yet.

### WAG relevance

For:

- CI workers;
- cloud-hosted WAG;
- Kubernetes;
- enterprise agent services;

WIF is likely the correct future identity lane.

For a solo Windows desktop browser bridge, standing up workload federation solely to authenticate one local user process would add disproportionate infrastructure.

Therefore:

```text
MCP_WIF = STRONG_FUTURE_REMOTE_WORKLOAD_IDENTITY
MCP_WIF_WINDOWS_SOLO_DESKTOP = DO_NOT_ADOPT_BY_DEFAULT
```

Sources:
- https://github.com/modelcontextprotocol/conformance/issues/223
- https://github.com/modelcontextprotocol/typescript-sdk/issues/2576
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/test/conformance/expected-failures.yaml

---

## 6. SPIFFE/SPIRE is real Windows workload identity prior art, but too heavy for WAG's default desktop path

SPIRE has current Windows binaries and a Windows workload attestor.

The Windows attestor can derive selectors from:

- current user;
- groups/SIDs;
- workload executable path;
- SHA-256 of the workload binary.

This is meaningful prior art for WAG because it proves a standards ecosystem can bind workload identity to Windows process attributes instead of a plaintext bearer token.

### Important limits

The attestor may need `SeDebugPrivilege` to inspect more privileged workloads.

Hashing arbitrary binaries creates DoS/resource concerns, and SPIRE explicitly documents workload-size controls.

SPIRE is also an operational identity control plane, not a tiny desktop library.

For the current single-user local WAG mission:

```text
SPIFFE_SPIRE = ENTERPRISE_WORKLOAD_IDENTITY_DONOR
SPIRE_AGENT_ON_SOLO_DESKTOP = TOO_HEAVY_BY_DEFAULT
WINDOWS_PATH_SHA256_SELECTOR = USEFUL_PRIOR_ART
```

If future requirements change to multi-host enterprise deployment, SPIFFE should be revisited before building proprietary workload identity.

Sources:
- https://spiffe.io/docs/latest/deploying/configuring/
- https://github.com/spiffe/spire/blob/main/doc/plugin_agent_workloadattestor_windows.md
- https://github.com/spiffe/spire/releases

---

## 7. UserConsentVerifier is useful verification UX, but cannot cryptographically bind an exact proposal

Windows `UserConsentVerifier` can require Windows Hello/PIN/fingerprint before an app continues.

The Win32 interop API can bind the system verification dialog to an application HWND and display an application-provided message.

This is the lightest native option for:

- "the local user is present";
- "the user re-verified before a sensitive action";
- cheap local confirmation UX.

But the API returns a verification result. It does not return a cryptographic signature over WAG's immutable proposal fingerprint.

Therefore:

```text
USERCONSENTVERIFIER = USER_PRESENCE_AND_REVERIFICATION
USERCONSENTVERIFIER != CRYPTOGRAPHIC_EXACT_PROPOSAL_BINDING
```

It remains suitable for lower-risk local approval where a signed approval receipt is unnecessary.

Sources:
- https://learn.microsoft.com/windows/uwp/security/fingerprint-biometrics
- https://learn.microsoft.com/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync
- https://github.com/microsoft/dynwinrt/blob/main/samples/js/windows-hello/README.md

---

## 8. WebAuthn can cryptographically bind a proposal fingerprint, but plain WebAuthn does not prove what the human saw

Win32 WebAuthn can use Windows Hello or external FIDO2 authenticators.

A WebAuthn assertion cryptographically covers:

- authenticator data;
- the hash of `clientDataJSON`;
- `clientDataJSON.challenge`;
- RP/origin context in normal WebAuthn validation.

Therefore a WAG proposal fingerprint can be included in or derived into the challenge and verified after the assertion.

### Critical distinction

This proves:

> the authenticator produced an assertion for this challenge after the required user-verification/presence ceremony.

It does **not** automatically prove:

> the human saw and understood the exact repository/path/profile/effect encoded by that challenge.

W3C Secure Payment Confirmation documentation explicitly calls out this limitation of plain WebAuthn: stuffing transaction-specific data into the challenge does not specify a trusted UX showing that transaction information.

The old WebAuthn Level 1 `txAuthSimple` extension attempted authenticator-displayed transaction text, but current deployment/support cannot be treated as a reliable universal Windows path.

Therefore the preferred WAG design remains:

1. WAG creates canonical immutable proposal.
2. Local WAG-owned UI renders human-readable exact effect.
3. UI is not in the browser DOM controlled by the agent.
4. WebAuthn assertion challenge includes proposal fingerprint + nonce + expiry/context.
5. WAG verifies the assertion and exact expected challenge.
6. Approval is single-use.
7. Approval -> durable job creation is atomic.
8. no approval survives restart/replay unless a later reviewed policy explicitly allows it.

This gives strong binding between WAG's immutable proposal and the authenticator signature, while keeping the honest limitation that the local UI is responsible for trustworthy display.

Sources:
- https://learn.microsoft.com/windows/win32/api/webauthn/
- https://learn.microsoft.com/windows/win32/api/webauthn/nf-webauthn-webauthnauthenticatorgetassertion
- https://www.w3.org/TR/webauthn/
- https://www.w3.org/TR/2026/CRD-secure-payment-confirmation-20260604/
- https://www.w3.org/TR/webauthn-1/

---

## 9. Use a thin native wrapper; do not build FIDO/WebAuthn crypto

There is no reason for WAG to implement CTAP/FIDO cryptography.

Available donor paths include:

- direct Windows `webauthn.dll` API;
- Microsoft C++/WinRT / dynwinrt examples for native/Electron integration;
- mature WebAuthn validation libraries such as `passwordless-lib/fido2-net-lib` where a .NET RP layer is appropriate.

WAG only needs a thin adapter around:

- credential enrollment/selection;
- assertion request;
- challenge construction;
- assertion verification;
- cancellation/timeouts;
- local UI ownership.

Prefer the Windows system broker UX over custom biometric/PIN collection.

Sources:
- https://github.com/microsoft/dynwinrt/blob/main/samples/js/windows-hello/README.md
- https://github.com/passwordless-lib/fido2-net-lib

---

## 10. OAuth Rich Authorization Requests is useful vocabulary, not a replacement for ADR-0019

RFC 9396 defines `authorization_details` for structured fine-grained authorization.

It is relevant prior art for expressing:

- resource;
- action;
- constraints;
- typed authorization details;

without exploding everything into flat OAuth scopes.

RFC 9126 PAR can also move an authorization request off the front channel and protect it from front-channel tampering.

### Why not replace WAG proposals with an OAuth server now

RAR/PAR solve a different layer:

- expressing an OAuth authorization request;
- protecting its transport to an Authorization Server;
- allowing the AS to authorize structured scope.

They do not automatically supply:

- local Windows independent operator UI;
- exact browser-agent separation;
- durable effect/job ownership;
- atomic one-shot execution;
- effect reconciliation after unknown outcome.

For a solo local WAG deployment, introducing a full local OAuth Authorization Server solely to encode `verify.preview` would increase complexity without removing the hard parts.

However, WAG's future proposal schema should remain conceptually compatible with typed rich authorization:

```text
proposal.type
proposal.resource
proposal.action
proposal.constraints
proposal.fingerprint
proposal.expires_at
```

This reduces future translation cost if an enterprise deployment later maps WAG proposals into RAR.

Sources:
- https://www.rfc-editor.org/rfc/rfc9396
- https://www.rfc-editor.org/rfc/rfc9126

---

## 11. OpenAI Secure MCP Tunnel is clearly transport + control plane, not a local-secret boundary

Current public tunnel documentation materially clarifies Pass 9.

### Data path

The private MCP listener stays private, but:

- MCP JSON-RPC requests;
- tool arguments;
- responses;
- stream events;

cross OpenAI's product runtime / tunnel service / control-plane path.

Forwarded HTTP `Authorization` can also cross OpenAI before the tunnel client applies it to the configured MCP origin.

The architecture explicitly states that strict-local-auth is not supported by Tunnel when all bearer/auth artifacts must remain outside OpenAI.

Therefore the correct claim is:

```text
SECURE_MCP_TUNNEL = PRIVATE_NETWORK_REACHABILITY
SECURE_MCP_TUNNEL != STRICT_LOCAL_AUTH
SECURE_MCP_TUNNEL != LOCAL_DATA_PATH
```

### Narrower local-secret patterns

The tunnel docs support:

- static final-hop MCP headers;
- MCP-side mTLS where the client private key stays customer-side;
- control-plane mTLS in addition to runtime API-key auth.

Even with those, MCP payload/result content still traverses OpenAI.

### RBAC

Tunnel permissions are explicitly split:

- Read;
- Use;
- Manage.

Runtime daemon principals should normally receive Read + Use only.

Tunnel manager/admin keys should remain separate from long-lived runtime keys.

This is good least-privilege prior art.

### WAG consequence

Tunnel ID and tunnel RBAC determine reachability/control-plane use.

They are not WAG workspace capability or effect approval.

Sources:
- https://github.com/openai/tunnel-client/blob/master/docs/architecture.md
- https://github.com/openai/tunnel-client/blob/master/docs/permissions.md
- https://github.com/openai/tunnel-client/blob/master/docs/configuration.md
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

---

## 12. Transport interchangeability is achievable only if WAG keeps authority above transport

The research now supports a clean transport-independent contract:

```text
InboundTransportContext
  transport_kind
  external_principal
  oauth_client_id
  scopes
  issuer
  resource
  optional proof_key_id
  transport_evidence

       |
       v

WAG Caller Normalization
  -> local owner_id
  -> workspace ownership
  -> capability profile
  -> proposal ownership
  -> local approval requirement
  -> effect lifecycle
```

Transport may be:

- OpenAI Secure MCP Tunnel;
- direct public HTTPS MCP;
- Cloudflare-style outbound tunnel;
- private/tailnet admin transport;
- local stdio for trusted local clients.

No transport is allowed to mint WAG consequential authority merely because it has network reachability.

This means future provider changes should not require rewriting WAG's capability semantics.

---

## 13. What current MCP can retire from WAG

### Retire/freeze custom work

Do not build:

- custom remote MCP framing;
- custom OAuth discovery;
- custom client registration protocol;
- proprietary machine-auth flow;
- proprietary token proof-of-possession;
- WAG-specific OpenAI relay;
- security decisions from MCP `clientInfo`;
- generic "connection == session owner" logic.

### Keep thin normalization

Keep only the adapter that turns verified external auth into internal facts such as:

```text
external_subject
client_id
issuer
resource
scopes
proof_key_id?       # when DPoP is used
enterprise_context? # when EMA is used
workload_subject?   # when WIF is used
```

### Retain WAG-specific authority

Still retain:

- opaque workspace/resource ownership;
- exact caller/session/proposal ownership;
- semantic capability/risk reduction;
- ADR-0019 proposal/effect split;
- independent local operator approval;
- exact immutable proposal fingerprint;
- atomic one-shot approval -> effect transition;
- effect truth/reconciliation;
- no blind replay after `UNKNOWN`.

---

## 14. Current recommended local approval stack

No implementation is authorized by this receipt.

If a future measured workflow still requires consequential local approval, preferred order is:

### Tier A — low-risk local confirmation

```text
WAG native local UI
+ UserConsentVerifier
+ immutable proposal fingerprint logged
+ one-shot approval state
```

Use when user re-verification is enough and a cryptographic approval receipt is not required.

### Tier B — stronger exact-proposal binding

```text
WAG native local UI
+ Windows WebAuthn
+ Windows Hello / FIDO2 authenticator
+ challenge bound to:
    proposal_fingerprint
    random nonce
    expiry
    approval purpose/domain separator
+ verified assertion
+ atomic single-use dispatch
```

Use when replay resistance and cryptographic binding to a particular immutable proposal justify the extra complexity.

### Not acceptable

- approval button in agent-controlled browser page;
- URL bearer that means "approved";
- reusable approval token;
- self-reported MCP client identity as approval;
- tunnel identity as approval;
- DPoP possession as approval;
- enterprise SSO as per-effect approval.

---

## 15. Decision impact

### WAG

More custom identity code can eventually be deleted than Pass 9 assumed.

The target should be:

```text
STANDARD AUTH IN
-> THIN CALLER NORMALIZATION
-> WAG SEMANTIC AUTHORITY
-> STANDARD/NATIVE LOCAL USER VERIFICATION
-> WAG DURABLE EFFECT CORE
```

### Guardian

No new browser-control scope.

Guardian continuity/context-warning remains independent.

### SessionCommander / Cleanup

No change.

Identity standards do not replace exact-owned local process lifecycle or cleanup.

### Browser projects

No reason to reopen "build an AI browser".

Browser transport/action substrate remains replaceable and below WAG authority.

---

## 16. Unresolved gaps after Pass 10

Research should continue before implementation because these gaps remain:

1. **agent delegation lineage:** MCP has active proposals/discussions but no single stable universal model;
2. **DPoP deployment support:** SDK support is ahead of universal provider interoperability;
3. **WIF maturity across SDKs:** conformance exists but TypeScript client implementation is not yet universal;
4. **native WebAuthn approval UX:** exact proposal display is still an application responsibility;
5. **credential lifecycle:** enrollment/revocation/recovery for a local WebAuthn approval credential needs a minimal design;
6. **same-user threat model:** Windows Hello/WebAuthn improves approval but does not magically make the rest of a compromised user session trusted;
7. **enterprise mapping:** RAR/EMA/WIF mappings should be kept optional so the solo desktop path stays small;
8. **transport-specific data governance:** Secure MCP Tunnel, public HTTPS and private transport have different data-path implications even if authority semantics are identical.

---

## Pass 11 — research only

Still no local benchmark or implementation.

Research next:

1. MCP agent delegation / fine-grained authorization / tool-scope proposals and current maintainer direction;
2. stable vs draft status of DPoP, WIF, client-credentials and fine-grained auth extensions;
3. whether an existing standards-based delegation format can replace WAG-specific parent/child capability lineage;
4. Windows native approval-broker OSS prior art with process isolation, secure desktop/Hello/WebAuthn and auditable exact-action display;
5. WebAuthn credential enrollment/revocation/recovery for a single-user local desktop tool;
6. whether Windows Hello KeyCredential / TPM-backed signing offers a materially simpler native exact-proposal signature than full WebAuthn;
7. OAuth RAR/JAR/PAR only where they can concretely eliminate custom enterprise code;
8. Secure MCP Tunnel issue/release watch for identity forwarding, lifecycle, incident/security changes;
9. DPoP + Secure MCP Tunnel interaction: determine what is actually end-to-end sender-constrained when an intermediary forwards auth;
10. no implementation until a remaining gap survives this pass.

---

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_10 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE

BUILD_CUSTOM_IDENTITY_PROTOCOL = NO

MCP_OAUTH_CORE = REUSE
MCP_EMA_XAA = ENTERPRISE_IDENTITY_POLICY_NOT_EFFECT_APPROVAL
MCP_MACHINE_AUTH = REUSE
MCP_PRIVATE_KEY_JWT = AS_CLIENT_AUTH_NOT_REQUEST_POP

MCP_DPOP = PREFERRED_BEARER_THEFT_HARDENING_WHEN_SUPPORTED
CUSTOM_WAG_HTTP_POP = DO_NOT_BUILD

MCP_WIF = FUTURE_REMOTE_WORKLOAD_IDENTITY
MCP_WIF_SOLO_WINDOWS_DEFAULT = NO
SPIFFE_SPIRE = ENTERPRISE_WORKLOAD_IDENTITY_DONOR_NOT_DESKTOP_DEFAULT

MCP_AGENT_INSTANCE_IDENTITY = STILL_EVOLVING
MCP_DELEGATION_CHAIN = STILL_EVOLVING
MCP_CLIENTINFO = NOT_AUTHORITY
MCP_CONNECTION = NOT_SESSION_AUTHORITY

WINDOWS_USERCONSENTVERIFIER = LIGHTWEIGHT_LOCAL_REVERIFICATION
WINDOWS_WEBAUTHN = STRONGER_PROPOSAL_CHALLENGE_BINDING
PLAIN_WEBAUTHN = DOES_NOT_PROVE_EXACT_HUMAN_DISPLAY
LOCAL_WAG_OWNED_APPROVAL_UI = STILL_REQUIRED_FOR_EXACT_EFFECT_DISPLAY

OAUTH_RAR = STRUCTURED_AUTHORIZATION_VOCABULARY_DONOR
OAUTH_RAR = NOT_ADR_0019_REPLACEMENT

OPENAI_SECURE_MCP_TUNNEL = REACHABILITY_NOT_LOCAL_AUTH_BOUNDARY
OPENAI_TUNNEL_PAYLOADS = TRANSIT_OPENAI
OPENAI_TUNNEL_FORWARDED_BEARER = MAY_TRANSIT_OPENAI
OPENAI_TUNNEL_RBAC = GOOD_LEAST_PRIVILEGE_DONOR
TUNNEL_ID = NOT_WAG_CAPABILITY

REMOTE_TRANSPORT = INTERCHANGEABLE_IF_AUTHORITY_STAYS_ABOVE_TRANSPORT

WAG_CUSTOM_AUTH_CODE = REDUCE
WAG_SEMANTIC_AUTHORITY = RETAIN
WAG_EXACT_PROPOSAL_OWNERSHIP = RETAIN
WAG_LOCAL_APPROVAL_SPLIT = RETAIN
WAG_EFFECT_TRUTH = RETAIN
SESSIONCOMMANDER_EXACT_OWNED_LIFECYCLE = RETAIN
GUARDIAN_BROWSER_CONTROL_EXPANSION = NO

NEXT_ACTION = PASS_11_DELEGATION_AND_NATIVE_APPROVAL_BROKER_RESEARCH
```
