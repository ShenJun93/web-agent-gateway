# AI-native Browser / Standards Maturity Research — Pass 12

Date: 2026-09-20
Status: RESEARCH RECEIPT — standards maturity + native approval path; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start: `4be41708ef90d84720d55c9ac25f8e679f64881a`

## Purpose

Continue research without local benchmark or implementation.

Pass 12 focuses on:
- maturity classification of MCP auth/delegation work;
- WIMSE workload/agent identity and delegation roadmap;
- Biscuit security/adoption maturity;
- Windows KeyCredential desktop viability;
- Secure MCP Tunnel + DPoP gap;
- whether any evidence now justifies replacing WAG semantic authority.

## Executive conclusion

No evidence justifies building a new browser, new remote auth protocol, or large WAG-specific agent identity/delegation standard.

The standards landscape is moving toward exactly the problem WAG currently solves internally:

```text
identity ingress
-> workload/agent identity
-> delegated/attenuated authority
-> fine-grained action/resource policy
-> evidence/receipt
-> local or enterprise approval
-> effect verification
```

But most agent-delegation pieces are still Internet-Drafts / active working-group work.

Therefore:
- reuse stable MCP OAuth/EMA now;
- keep WAG internal authority schema small and standards-shaped;
- do not adopt Biscuit as trust core now;
- keep watching WIMSE delegation/evidence work;
- treat Windows KeyCredential as promising native local-approval primitive but not yet an implementation decision;
- do not claim DPoP + Secure MCP Tunnel compatibility.

## 1. MCP maturity split

### Mature/reusable now

Core MCP 2026 authorization provides:
- OAuth 2.1 resource-server model;
- Protected Resource Metadata;
- resource audience binding;
- dynamic scope challenge and step-up authorization;
- per-request authorization semantics.

Enterprise Managed Authorization is explicitly marked **Stable** in `modelcontextprotocol/ext-auth`.

These should be reused rather than wrapped in custom WAG auth protocols.

### Active/evolving

The MCP community still has active work around:
- per-tool scopes;
- granular consent;
- fine-grained authorization / RAR;
- delegated and agentic access;
- identity lineage and descendant revocation.

Therefore do not present tool-level/RAR/delegation semantics as settled MCP wire contracts.

Sources:
- MCP 2026 authorization specification
- MCP Auth WG / Tool Annotations discussions
- ext-auth Enterprise Managed Authorization stable spec

## 2. Dynamic scopes reduce broad-token pressure but do not replace exact effect approval

MCP 2026 explicitly supports server-driven scope challenges based on the current operation and request context.

This is useful for:
- read vs write;
- specific capability families;
- progressive elevation;
- reducing initial token blast radius.

But a token with `files:write` or a tool-specific scope still does not prove:
- the human approved this exact patch;
- the agent may mutate this exact workspace;
- the proposal is still current;
- the approval is single-use;
- the effect completed.

Therefore:

```text
MCP_STEP_UP_SCOPE = AUTHORITY_ENVELOPE
WAG_EXACT_PROPOSAL_APPROVAL = EFFECT_INSTANCE_DECISION
```

Both layers remain useful.

## 3. WIMSE is the stronger future standards watch than Biscuit

The IETF WIMSE WG currently has active documents for:
- architecture;
- workload identifiers;
- workload credentials;
- workload proof tokens;
- HTTP-signature workload authentication;
- mTLS workload authentication.

The WIMSE architecture explicitly discusses delegation/impersonation through token services and OAuth token exchange.

The WG document set now also lists related 2026 drafts for:
- verifiable attenuated delegation for AI-agent chains;
- credential delegation for AI agents across systems;
- cross-organizational delegation;
- signed authorization-evidence records for AI-agent actions;
- condition-bounded credentials with non-exfiltratable keys/presence constraints.

These are not final standards, but they overlap WAG's problem more directly than a proprietary WAG delegation protocol.

Disposition:

```text
WIMSE = PRIMARY_FUTURE_AGENT/WORKLOAD_AUTHORITY_WATCH
WAG_PUBLIC_DELEGATION_STANDARD = DO_NOT_BUILD
WAG_INTERNAL_SCHEMA = KEEP_MAPPABLE_TO_WIMSE/OAUTH
```

## 4. WIMSE itself is still work in progress

Important maturity caveat:
- architecture and workload credentials are Internet-Drafts;
- workload credentials define WIT/WIC and proof-of-possession expectations but are not RFCs;
- AI-agent delegation drafts are individual/related drafts, not necessarily WG-adopted normative standards;
- credential-delegation draft explicitly states it has no formal IETF standing merely by being an I-D.

Therefore:
- watch and map;
- do not implement draft wire formats as canonical WAG public API;
- do not create migration debt by chasing every draft revision.

## 5. Biscuit feature-fit remains strong, trust-core readiness is weaker than feature-fit

Biscuit has attractive properties:
- attenuation;
- offline verification;
- public-key root trust;
- Datalog policy;
- revocation IDs;
- Apache-2.0;
- active Rust implementation and current 6.0.0 release line.

However, the project itself currently says it is looking for a cryptographic design/implementation audit.

It also had a critical historical vulnerability in Biscuit v1:
- signature forgery could create arbitrary-access tokens;
- fixed by Biscuit v2;
- maintainers reported no known active exploitation.

This is not a reason to distrust modern Biscuit categorically. It is a reason not to replace WAG's small internal authority model with a new cryptographic authorization substrate unless a concrete portable-delegation requirement justifies it.

Disposition:
**prior-art / optional future donor, not trust-core dependency now.**

## 6. Windows KeyCredential remains promising, but packaging/support must be treated carefully

Microsoft now exposes window-bound variants:
- `KeyCredentialManager.RequestCreateForWindowAsync(WindowId,...)`;
- `KeyCredential.RequestSignForWindowAsync(WindowId,...)`.

This is materially better for desktop approval UX because the Windows Hello ceremony can be associated with a specific native window.

Microsoft's Windows Hello documentation states:
- key pair is unique per device;
- TPM is used when suitable hardware exists;
- application cannot directly access private key;
- arbitrary challenge can be signed;
- PIN/biometric is requested for signing.

However, official tutorial/sample material still leans heavily toward packaged/WinUI scenarios, and older Win32 community discussions show integration friction.

Therefore:
- KeyCredential is technically credible;
- **unpackaged WAG native-host/Electron suitability remains an evidence gap**;
- do not code it until a minimal source-only integration path is confirmed.

## 7. KeyCredential attestation should be optional, not default complexity

KeyCredential exposes attestation metadata/certificate chains.

For current WAG local-only approval, the security goal is mostly:
- a key WAG enrolled for this local user/app;
- private key remains inaccessible;
- Windows Hello gates signing;
- WAG verifies proposal-bound signature.

Hardware-origin attestation adds value only if WAG must distinguish:
- TPM-backed vs software-backed;
- specific device trust levels;
- enterprise policy requirements.

For a solo local deployment, treating attestation as mandatory would add certificate-chain parsing/renewal and policy complexity without changing ADR-0019's core local-user approval model.

Direction:
```text
KEYCREDENTIAL_SIGNATURE = POTENTIALLY_SUFFICIENT_LOCAL_PROOF
KEYCREDENTIAL_ATTESTATION = OPTIONAL_FUTURE_ENTERPRISE_SIGNAL
```

## 8. WebAuthn remains the portability path

WebAuthn remains preferable when:
- external FIDO2 authenticators matter;
- cross-platform approval is expected;
- passkey/RP ecosystem interoperability matters;
- multiple clients/platforms should verify the same credential model.

Windows KeyCredential remains preferable candidate when:
- Windows-only;
- local app-owned approval;
- minimal protocol machinery;
- exact challenge signing;
- no external authenticator requirement.

Neither removes the need for independent WAG-owned exact-effect display.

## 9. DPoP + Secure MCP Tunnel remains blocked on explicit composition evidence

No DPoP-specific code or `DPoP-Nonce` handling was found in current public `openai/tunnel-client` source during Pass 11/12 research.

Tunnel documentation confirms:
- connector-facing Protected Resource Metadata is rewritten to tunnel-service URLs;
- MCP Authorization is forwarded to private origin;
- some OAuth endpoints may be shimmed/re-written.

RFC 9449 requires DPoP `htu` to match the target URI at the validating resource server.

That creates an unresolved URI-binding problem if:
- client signs for OpenAI tunnel URI;
- private WAG validates at its local/private URI.

Do not:
- ignore `htu`;
- substitute untrusted Forwarded headers;
- invent custom URI canonicalization.

Use DPoP only on a lane where the validator and signer share a defined canonical target URI, unless OpenAI/MCP publishes explicit compatible proxy semantics.

## 10. WIMSE condition-bounded credentials reinforce non-exfiltratable-key direction

A related WIMSE draft explores:
- non-exfiltratable keys;
- condition/presence-bound validity;
- separating authority from live-instance/condition claims.

This supports WAG's direction of separating:
- external identity;
- key possession/device state;
- capability authority;
- local human approval;
- effect truth.

It does not replace the implementation today because it remains draft work.

## 11. Architecture after Pass 12

```text
STABLE EXTERNAL IDENTITY
  MCP OAuth / EMA

MACHINE IDENTITY
  current machine auth
  -> WIF/WIMSE later where justified

REMOTE TRANSPORT
  replaceable
  -> never authority itself

DELEGATION
  minimal WAG internal subset lineage
  -> map to future MCP/WIMSE
  -> no WAG public delegation standard

FINE-GRAINED POLICY
  MCP dynamic scopes now
  -> RAR / WIMSE if/when stable
  -> WAG exact resource/action constraints remain internal

LOCAL APPROVAL
  independent WAG-owned UI
  -> UserConsentVerifier low tier
  -> KeyCredential candidate for Windows-local signed challenge
  -> WebAuthn candidate for portable/FIDO path

EFFECT AUTHORITY
  ADR-0019
  -> exact proposal
  -> single-use approval
  -> atomic dispatch
  -> effect reconciliation

PROCESS OWNERSHIP
  SessionCommander exact-owned lifecycle
```

## 12. Pass 13 — research only

No local benchmark or implementation.

Research next:
1. exact status/history of WIMSE agent-delegation/evidence drafts and whether any gained WG adoption;
2. authorization-evidence record schema vs WAG proposal/approval/effect record;
3. transaction-token / execution-context-token standards adjacent to WIMSE;
4. Microsoft documentation/source for KeyCredential from unpackaged Win32/native-host processes;
5. alternative Windows CNG/NCrypt Hello/TPM signing only if KeyCredential packaging remains blocked;
6. independent security review/community experience of KeyCredential desktop integration;
7. DPoP proxy/canonical-URI guidance from OAuth/IETF, not vendor guesses;
8. OpenAI tunnel issue/release watch for DPoP or sender-constrained-token support;
9. whether MCP's active fine-grained/tool-scope work reduces WAG semantic policy further;
10. keep research-only until a concrete architecture reduction is justified.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_12 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE

MCP_CORE_OAUTH_STEP_UP = REUSE
MCP_EMA = STABLE_REUSE
MCP_RAR_TOOL_SCOPES_DELEGATION = ACTIVE_EVOLVING

WIMSE = PRIMARY_FUTURE_WORKLOAD_AGENT_AUTHORITY_WATCH
WIMSE_AGENT_DELEGATION = HIGH_RELEVANCE_NOT_STABLE
WAG_PUBLIC_DELEGATION_STANDARD = DO_NOT_BUILD
WAG_INTERNAL_LINEAGE = MINIMAL_AND_MAPPABLE

BISCUIT = PRIOR_ART_WATCH_NOT_TRUST_CORE
BISCUIT_AUDIT_MATURITY = INSUFFICIENT_FOR_WAG_CORE

WINDOWS_KEYCREDENTIAL = PROMISING_LOCAL_SIGNING_PATH
WINDOWS_KEYCREDENTIAL_UNPACKAGED_SUPPORT = NEEDS_MORE_EVIDENCE
KEYCREDENTIAL_ATTESTATION = OPTIONAL_NOT_DEFAULT
WEBAUTHN = PORTABLE_FIDO_PATH

DPOP_TUNNEL = UNPROVEN_BLOCKED
DO_NOT_WEAKEN_DPOP_HTU_VALIDATION = YES

ADR_0019 = RETAIN
SESSIONCOMMANDER_EXACT_OWNED_LIFECYCLE = RETAIN
GUARDIAN_BROWSER_CONTROL_EXPANSION = NO

NEXT_ACTION = PASS_13_WIMSE_EVIDENCE_AND_WINDOWS_NATIVE_APPROVAL_MATURITY
```
