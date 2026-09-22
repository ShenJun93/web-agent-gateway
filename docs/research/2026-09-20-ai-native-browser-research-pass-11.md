# AI-native Browser / Delegation & Native Approval Research — Pass 11

Date: 2026-09-20
Status: RESEARCH RECEIPT — delegation, fine-grained authorization, native approval broker; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start of pass: `b4e676afc96cf8e6f71ad1246309f7d550daee10`

## Purpose

Continue the user-requested research program without local installation or benchmarking.

Pass 11 targets:
1. MCP delegated/agentic access and fine-grained authorization direction;
2. whether standards can replace WAG parent/child capability lineage;
3. Biscuit/Macaroons as proven capability-token prior art;
4. Windows Hello KeyCredential vs WebAuthn for local exact-proposal signing;
5. credential enrollment/revocation/recovery;
6. DPoP composition with OpenAI Secure MCP Tunnel;
7. whether current standards reduce WAG ownership/approval code further.

No browser launch, local MCP server deployment, credential enrollment, process mutation or benchmark was performed.

## Executive conclusion

Pass 11 strengthens the "compose standards, keep minimal WAG semantics" direction.

Key conclusions:

- MCP 2026 is explicitly per-request/stateless. Connection/process/session identity must not be used as application ownership.
- MCP Auth WG is actively working on delegated/agentic access, per-tool scopes and Rich Authorization Requests. WAG should avoid building a large proprietary delegation framework while this standardization is moving.
- Current MCP still lacks a stable, universal delegation lineage format for parent-agent -> child-agent -> tool effect ownership.
- Biscuit is the strongest capability-token donor found for offline attenuation/strictly narrower child grants, but adopting it now would add a second authorization language/token system before MCP direction stabilizes.
- Macaroons remain useful conceptual prior art for caveat-based attenuation, but are bearer credentials and less attractive than Biscuit for a new WAG design.
- Windows Hello `KeyCredential` is a serious lighter alternative to full WebAuthn for a **local-only Windows approval broker**: app-scoped key, non-exportable private key, Windows Hello user verification, arbitrary challenge signing, explicit deletion.
- WebAuthn remains preferable if WAG needs standards interoperability, external FIDO authenticators, RP semantics or future cross-platform approval.
- DPoP + Secure MCP Tunnel is **not proven end-to-end compatible**. DPoP binds the proof to the request target URI (`htu`), while Tunnel rewrites connector-facing resource URLs to tunnel URLs and forwards to a different private MCP origin. No DPoP-specific tunnel handling was found in the current public tunnel-client source. Do not enable DPoP on this lane without explicit provider/protocol validation.
- None of these standards eliminate WAG's exact proposal ownership, independent local approval transition, atomic single-use dispatch or effect truth/reconciliation.

## 1. MCP 2026 makes explicit ownership handles more important, not less

The 2026-07-28 MCP core removed protocol-level sessions and the `Mcp-Session-Id` header.

Every request is independent. The core specification explicitly says an open connection or STDIO process is not a conversation/session and should not be used as continuity identity.

Tool catalogs may vary by authorization presented on the request, but not as hidden connection state.

For WAG:

```text
TRANSPORT_CONNECTION != OWNER
MCP_PROCESS != OWNER
CLIENTINFO != OWNER
TUNNEL_ID != OWNER

WAG_EXPLICIT_OWNER_ID = REQUIRED
WAG_WORKSPACE/PROPOSAL_HANDLE = REQUIRED
```

This validates the current direction rather than making WAG ownership redundant.

Sources:
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/index.mdx
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md

## 2. MCP Auth WG is now working directly on the gaps WAG cares about

The current Auth Interest Group lists active work around:

- delegated and agentic access;
- on-behalf-of token exchange;
- downstream resource access;
- audience restriction;
- consent through chains of agents/tools;
- per-tool scope advertisement;
- step-up authorization;
- fine-grained authorization beyond scope strings;
- Rich Authorization Requests and structured denials/remediation.

The Enterprise IG separately identifies:
- spawned/delegated-agent identity lineage;
- least privilege for child agents;
- descendant revocation;
- multi-agent auditability.

This is important strategically:

```text
BUILD_LARGE_WAG_DELEGATION_STANDARD = NO
KEEP_MINIMAL_INTERNAL_LINEAGE = YES
WATCH_MCP_AUTH_WG = YES
```

The internal WAG model should remain easy to map to emerging standards:
- issuer/subject;
- parent authority;
- resource;
- action;
- constraints;
- expiry;
- single-use/max-use;
- revocation lineage;
- immutable proposal/effect correlation.

Source:
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/community/interest-groups/auth.mdx
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/community/interest-groups/enterprise.mdx

## 3. Fine-grained authorization is active but not settled

MCP security guidance already recommends progressive least-privilege scopes and targeted step-up authorization.

Issue #1670 proposed RFC 9396 Rich Authorization Requests because static OAuth scopes do not adequately express dynamic:
- exact resources;
- paths/tags;
- temporal constraints;
- role assumptions;
- context-aware policies.

The issue is closed, while the Auth WG still lists fine-grained/RAR work as active. Therefore do not treat RAR as a normative MCP feature yet.

WAG should maintain a typed proposal/capability shape that can later map to RAR, but not depend on it today.

Sources:
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1670
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx

## 4. Scoped execution receipts independently converge on ADR-0019

MCP issue #2852 proposed short-lived, single-use execution receipts bound to:
- tenant;
- agent;
- user;
- tool/action;
- resource;
- job/case/customer;
- approval ID.

The provider then verifies freshness and exact-call binding before performing the business operation.

The proposal is non-normative/closed, but conceptually it converges strongly with WAG's existing model:

```text
proposal_fingerprint
+ exact caller/resource/action
+ approval_id
+ short TTL
+ single use
+ provider/effect verification
```

This is independent evidence that ADR-0019 is not an over-engineered local anomaly; high-risk agent tools are encountering the same need for a second, scoped authorization decision above transport OAuth.

Source:
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2852

## 5. OAuth token exchange helps delegated identity, but does not replace capability lineage

Older MCP issue #214 proposed on-behalf-of token exchange for agent-to-agent communications.

Current Auth WG work is coordinating delegated identity with:
- RFC 8693 token exchange;
- Workload Identity Federation;
- enterprise ID-JAG;
- IETF OAuth/WIMSE.

This can standardize "who is acting on behalf of whom" at OAuth boundaries.

It still does not automatically encode every WAG-specific constraint:
- exact workspace;
- immutable file/change proposal;
- max-use;
- local effect approval;
- restart reconciliation;
- `UNKNOWN` outcome semantics.

Therefore:

```text
RFC8693_OBO = DELEGATED_IDENTITY_DONOR
RFC8693_OBO != COMPLETE_WAG_CAPABILITY_LINEAGE
```

Source:
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/214

## 6. Biscuit is the strongest capability-token donor found

Eclipse Biscuit provides:
- public-key signed authorization tokens;
- decentralized/offline verification;
- offline attenuation;
- child tokens that can only become more restrictive;
- Datalog policies;
- expiration;
- revocation identifiers;
- broad implementation availability;
- Apache-2.0.

This maps well to a future agent delegation model:
- root grant -> child agent;
- child narrows resource/action/expiry;
- downstream verifier does not need to call a central issuer for every action.

### Why not adopt now

Biscuit would introduce:
- a separate token format;
- a Datalog authorization language;
- key management;
- token revocation state;
- an additional audit/debug layer.

WAG already has a smaller internal capability/ownership model, and MCP delegated authorization is actively evolving.

Adopting Biscuit now would be justified only if a real cross-process/cross-host delegation workflow requires portable attenuated capabilities before MCP standardization lands.

Disposition:

```text
BISCUIT = STRONG_CAPABILITY_DELEGATION_DONOR
BISCUIT_ADOPT_NOW = NO
BISCUIT_REVISIT_TRIGGER = PORTABLE_MULTI_HOP_DELEGATION_GAP
```

Sources:
- https://www.biscuitsec.org/
- https://doc.biscuitsec.org/

## 7. Macaroons remain valuable prior art but are not the preferred new dependency

Google's Macaroons paper established:
- decentralized delegation;
- chained MAC credentials;
- contextual caveats;
- attenuation by time/place/principal/purpose.

This remains useful conceptual prior art.

However:
- macaroons are bearer credentials;
- verification/shared-secret topology is less attractive for a new multi-verifier public-key architecture than Biscuit;
- WAG does not currently need another portable capability-token dependency.

Disposition:
**research donor, not adoption candidate.**

Source:
- https://research.google.com/pubs/pub41892.html

## 8. Windows Hello KeyCredential is a lighter local-only approval primitive than WebAuthn

Windows `KeyCredentialManager` can create an application/user-specific RSA key.

Microsoft documents that:
- if appropriate TPM hardware exists, Windows requests the TPM to create/store the key;
- the app cannot directly access the private key;
- the public key can be exported;
- `RequestSignAsync(data)` signs arbitrary data and triggers Windows Hello PIN/biometric verification;
- `DeleteAsync(name)` irreversibly removes the application's current-user credential.

This maps almost exactly to a local WAG approval receipt:

```text
data_to_sign =
  domain_separator
  || proposal_fingerprint
  || nonce
  || expires_at
  || approval_purpose
```

WAG stores the public key and verifies the returned signature before the atomic approval -> durable job transition.

### Advantages over WebAuthn for WAG local-only use

- less protocol ceremony;
- no RP ID/origin model;
- signs arbitrary data directly;
- app-scoped credential lifecycle;
- built-in Hello UX;
- explicit delete API;
- potentially TPM-backed;
- Windows-native.

### Limits

- Windows-only;
- `IsSupportedAsync` requires supported user/device configuration and Hello unlock gesture;
- older documentation notes Microsoft-account requirements for provisioning;
- still does not prove the user understood arbitrary effect text unless WAG independently displays the exact proposal;
- same-user compromise outside the protected signing ceremony remains outside containment;
- future portability is worse than WebAuthn.

Disposition:

```text
WINDOWS_KEYCREDENTIAL = PRIMARY_LIGHTWEIGHT_LOCAL_SIGNING_DONOR
WEBAUTHN = PRIMARY_PORTABLE/FIDO_APPROVAL_DONOR
FINAL_CHOICE = DEPENDS_ON_PORTABILITY_REQUIREMENT
```

Sources:
- https://learn.microsoft.com/windows/apps/develop/security/windows-hello
- https://learn.microsoft.com/uwp/api/windows.security.credentials.keycredential.requestsignasync
- https://learn.microsoft.com/uwp/api/windows.security.credentials.keycredentialmanager.deleteasync
- https://learn.microsoft.com/uwp/api/windows.security.credentials.keycredentialmanager.issupportedasync

## 9. WebAuthn has a clearer standards ecosystem for credential enumeration/deletion

The Win32 WebAuthn API includes:
- platform credential listing;
- platform credential deletion;
- authenticator assertion APIs.

That makes explicit local credential recovery/revocation implementable without WAG handling authenticator private keys.

For a single-user WAG desktop tool, a minimal lifecycle can be:

1. enroll a local platform credential;
2. store credential ID + public key + created time + local label;
3. require assertion over exact approval challenge;
4. revoke by deleting WAG registration;
5. optionally delete platform credential via Windows API;
6. if Hello/reset/device loss invalidates credential, fail closed and require fresh enrollment.

No approval credential should be silently regenerated after loss/reset.

Source:
- https://learn.microsoft.com/windows/win32/api/webauthn/
- https://learn.microsoft.com/windows/win32/api/webauthn/nf-webauthn-webauthndeleteplatformcredential

## 10. KeyCredential vs WebAuthn recommendation boundary

For the current **solo Windows desktop** product:

Prefer KeyCredential if all are true:
- Windows-only is acceptable;
- approval stays strictly local;
- one local application owns enrollment;
- external security keys/passkeys are unnecessary;
- minimum implementation complexity matters.

Prefer WebAuthn if any are true:
- cross-platform approval is expected;
- external FIDO2 authenticators are desired;
- RP/credential interoperability matters;
- passkey/enterprise authenticator ecosystem is useful;
- future web/native approval surfaces should share one credential model.

Neither changes the human-display requirement:

```text
CRYPTOGRAPHIC_SIGNATURE != PROOF_OF_SEMANTIC_HUMAN_UNDERSTANDING
WAG_OWNED_EXACT_EFFECT_UI = STILL_REQUIRED
```

## 11. DPoP + Secure MCP Tunnel is currently an unresolved composition gap

RFC 9449 requires DPoP proofs to contain:
- `htm`: HTTP method;
- `htu`: HTTP target URI.

The resource server validating the proof must verify `htu` against the URI of the request it received.

Secure MCP Tunnel currently:
- exposes a connector-facing tunnel-service MCP URL;
- rewrites Protected Resource Metadata `resource` URLs to tunnel-service URLs;
- forwards inbound Authorization to the private MCP server;
- executes the final MCP request against the configured private origin.

The public tunnel-client repository currently contains no DPoP-specific implementation or `DPoP-Nonce` handling found in this pass.

Therefore a naïve flow has a fundamental question:

```text
client signs DPoP for:
  https://<openai-tunnel>/.../mcp

private WAG receives request at:
  http(s)://<private-origin>/mcp

RFC9449 validator expects htu == received target URI
```

If the same proof is simply forwarded, strict `htu` validation can fail.

Possible solutions require explicit design:
- OpenAI preserves/reconstructs an externally visible canonical URI and WAG validates against trusted proxy context;
- the tunnel terminates DPoP and issues a different downstream credential/proof;
- WAG remains Bearer behind Tunnel while DPoP is used only on direct-public HTTPS lane;
- future Tunnel/MCP support defines a standardized proxy binding.

Do **not** invent a workaround or weaken `htu` validation.

Disposition:

```text
DPOP_DIRECT_HTTPS_WAG = VALID_CANDIDATE
DPOP_SECURE_MCP_TUNNEL = UNPROVEN
DPOP_TUNNEL_PRODUCTION = BLOCKED_ON_EXPLICIT_PROVIDER/PROTOCOL_EVIDENCE
```

Sources:
- https://www.rfc-editor.org/rfc/rfc9449
- https://github.com/openai/tunnel-client/blob/master/docs/configuration.md
- https://github.com/openai/tunnel-client/blob/master/docs/architecture.md

## 12. Current delegation strategy for WAG

Until MCP stabilizes delegated/agentic authorization, keep the smallest internal model that preserves safety:

```text
AuthorityGrant {
  grant_id
  issuer_owner
  parent_grant_id?
  subject
  resource/workspace
  allowed_actions
  argument/proposal constraints
  issued_at
  expires_at
  max_use
  revision
  revoked_at?
}

EffectProposal {
  proposal_id
  owner/grant
  exact resource/action
  immutable fingerprint
  expiry
}

LocalApproval {
  proposal_fingerprint
  one-time nonce
  signed/user-verified proof
  expiry
}
```

Rules:
- child grant must be strict subset of parent;
- no implicit authority from connection;
- no durable authority from clientInfo/tunnel ID;
- proposal cannot itself execute;
- local approval cannot broaden proposal;
- approval single-use;
- dispatch + durable job creation atomic;
- UNKNOWN is not silently retried.

Do not expose this internal model as a new public "WAG auth standard."

## 13. Replacement impact

### Can reduce/freeze
- custom remote auth protocols;
- custom PoP;
- generic browser mechanics;
- large proprietary agent-delegation format;
- connection/session-bound ownership.

### Retain
- exact owner/workspace/proposal state;
- minimal parent/child authority constraints where actually needed;
- ADR-0019 approval split;
- local exact-effect display;
- durable effect truth;
- SessionCommander exact-owned process lifecycle;
- Guardian continuity.

## 14. Pass 12 — research only

Still no local benchmark or implementation.

Research next:

1. current MCP Auth WG issues/SEPs for tool scopes, RAR, OBO/delegation and execution receipts; classify stable/draft/experimental/closed;
2. WIMSE/IETF workload and delegated identity direction that MCP is explicitly coordinating with;
3. Biscuit security audits, production adoption and operational failure modes before keeping it as a serious future donor;
4. Windows KeyCredential behavior for unpackaged Win32/Electron/Node native host paths and current account/Hello prerequisites;
5. whether KeyCredential attestation adds useful trust or unnecessary complexity for local WAG;
6. Secure MCP Tunnel + DPoP: look for OpenAI issue/spec changes or obtain explicit compatibility evidence;
7. trusted-proxy canonical-URI patterns only as standards research — do not weaken RFC 9449 validation;
8. local approval UI isolation options: native HWND, separate broker process, secure desktop only if justified;
9. credential recovery threat model for Hello reset/account migration/device replacement;
10. continue to avoid implementation until research converges.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_11 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE

MCP_2026_CONNECTION = NOT_APPLICATION_OWNERSHIP
MCP_AUTH_WG_DELEGATION = ACTIVE
MCP_TOOL_SCOPES = ACTIVE
MCP_RAR_FINE_GRAINED_AUTH = ACTIVE_NOT_STABLE
MCP_AGENT_LINEAGE_STANDARD = NOT_STABLE_YET

WAG_LARGE_CUSTOM_DELEGATION_STANDARD = DO_NOT_BUILD
WAG_MINIMAL_INTERNAL_LINEAGE = RETAIN

BISCUIT = STRONG_FUTURE_CAPABILITY_DONOR
BISCUIT_ADOPT_NOW = NO
MACAROONS = PRIOR_ART_NOT_PREFERRED_DEPENDENCY

WINDOWS_KEYCREDENTIAL = LIGHTWEIGHT_LOCAL_APPROVAL_SIGNING_DONOR
WINDOWS_WEBAUTHN = PORTABLE_FIDO_APPROVAL_DONOR
LOCAL_EXACT_EFFECT_UI = REQUIRED_REGARDLESS_OF_SIGNING_PRIMITIVE

DPOP_DIRECT_HTTPS = VALID_CANDIDATE
DPOP_SECURE_MCP_TUNNEL = UNPROVEN
DPOP_TUNNEL_HARDENING = DO_NOT_CLAIM_WITHOUT_PROVIDER_EVIDENCE

WAG_EXACT_PROPOSAL_OWNERSHIP = RETAIN
WAG_ATOMIC_APPROVAL_EFFECT_TRANSITION = RETAIN
WAG_EFFECT_TRUTH = RETAIN
SESSIONCOMMANDER_EXACT_OWNED_LIFECYCLE = RETAIN
GUARDIAN_BROWSER_CONTROL_EXPANSION = NO

NEXT_ACTION = PASS_12_STANDARDS_MATURITY_AND_NATIVE_APPROVAL_PATH_RESEARCH
```
