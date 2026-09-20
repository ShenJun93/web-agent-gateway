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
4. Browser/identity research receipts through:
   - `docs/research/2026-09-20-ai-native-browser-research-pass-9.md`
   - `docs/research/2026-09-20-ai-native-browser-research-pass-10.md`
   plus earlier receipts referenced there.
5. Chat history last.

This handoff is not authority when Git disagrees.

## Verified state

Passes 1–12 plus the replacement-pressure audit are complete through the Pass 12 research branch. No local install or browser benchmark was run.

Pass 10 started from canonical remote `main`:
`ec2ca8f0f32ff7ae8199558f409e0ffd9ea6c286`.

## Current architecture direction

```text
BUILD_NEW_BROWSER = NO

SITE ACTIONS
  native API / WebMCP first
  -> Playwright/browser substrate fallback
  -> generic DOM/screenshot reasoning last

REMOTE WEBCHAT -> WAG
  MCP Streamable HTTP
  -> standard OAuth / protected-resource identity
  -> optional enterprise/workload/proof-of-possession extensions
  -> replaceable transport
  -> WAG capability/ownership reduction

IDENTITY
  OAuth/EMA for user + enterprise ingress
  client_credentials/private_key_jwt for machine auth
  WIF/SPIFFE for managed workloads when justified
  DPoP for sender-constrained token hardening when supported
  -> none of these alone is exact effect approval

LOCAL APPROVAL
  outside browser DOM authority
  -> UserConsentVerifier for lightweight local re-verification
  -> Win32 WebAuthn for signed challenge binding where justified
  -> WAG-owned local UI must display the exact immutable proposal

OPENAI PRIVATE REACHABILITY
  Secure MCP Tunnel
  -> private network reachability, not strict-local-auth
  -> MCP payloads/results traverse OpenAI
  -> forwarded bearer may traverse OpenAI
  -> tunnel ID is not WAG authority

WINDOWS LOCAL SECRET/IPC
  explicit SID/DACL
  -> DPAPI CurrentUser where persistent secret is unavoidable
  -> application auth
  -> no hostile-same-user claim

PROCESS OWNERSHIP
  PID + creation identity + executable + WAG-owned record/job

EFFECT TRUTH
  PRECONDITION_CHECKED -> DISPATCHED -> RECONCILING
  -> CONFIRMED | FAILED | UNKNOWN
  -> no blind replay after UNKNOWN

CONSEQUENTIAL AUTHORITY
  ADR-0019 retained

LOCAL LIFECYCLE
  SessionCommander/Cleanup exact-owned supervision retained
```

## Pass 10 material changes

### Standard auth can replace more WAG custom code

Do not build custom:
- OAuth discovery;
- client registration;
- machine auth;
- HTTP proof-of-possession;
- OpenAI relay protocol.

Keep only a thin normalization layer from verified external identity into WAG-owned caller/owner/capability state.

### MCP agent identity is still incomplete

Current MCP can authenticate users, clients and some workloads, but first-class agent-instance identity and delegation lineage remain active/future standardization areas.

Self-reported `clientInfo` is explicitly not authority. MCP 2026 transport/connection identity is not conversation/session authority.

### EMA / Cross-App Access

Enterprise Managed Authorization is stable and useful for enterprise user identity/policy.

It is not:
- exact effect approval;
- local physical presence;
- agent-instance ownership;
- single-use consequential authorization.

### DPoP

Use DPoP rather than a proprietary WAG proof-of-possession scheme when bearer theft is a material threat and the auth path supports it.

DPoP proves key possession. It does not prove human approval or exact Windows process identity.

### Workload identity

MCP WIF is promising for cloud/Kubernetes/SPIFFE-style workloads, but SDK adoption is still evolving.

SPIRE has real Windows workload attestation using user/group/path/SHA-256 selectors, but running a SPIRE control plane solely for one solo Windows desktop WAG path is disproportionate.

### Windows local approval

`UserConsentVerifier` gives light native Windows Hello/PIN/biometric re-verification.

Win32 WebAuthn can sign a challenge that binds WAG's proposal fingerprint.

Important limitation:
plain WebAuthn does not standardize trusted display of arbitrary exact-effect text. A WAG-owned local UI still has to render the immutable proposal independently from the agent-controlled browser.

### OAuth RAR/PAR

RFC 9396 RAR is useful prior art for structured fine-grained authorization vocabulary. PAR protects authorization requests from front-channel tampering.

Do not introduce a full local OAuth Authorization Server just to replace WAG `verify.preview`. RAR/PAR do not replace local approval, atomic dispatch or effect reconciliation.

### Secure MCP Tunnel boundary

Current OpenAI docs make the data path explicit:

- private MCP listener stays private;
- MCP requests/tool arguments/responses/events traverse OpenAI;
- forwarded `Authorization` may traverse OpenAI;
- strict-local-auth is not provided by Tunnel;
- final-hop MCP mTLS can keep a backend private key local;
- tunnel RBAC separates Read / Use / Manage.

Therefore Tunnel remains transport/reachability, never WAG effect authority.

## Freeze / retain

Freeze:
- custom remote WAG protocol;
- custom auth/client-registration;
- custom HTTP PoP;
- generic browser action/catalog work;
- OpenAI-specific relay;
- provider-specific browser clones;
- authority from MCP clientInfo/connection/tunnel ID.

Retain:
- thin authenticated-caller normalization;
- workspace/resource ownership;
- semantic capability/risk policy;
- exact proposal ownership;
- ADR-0019 proposal/effect split;
- independent local approval;
- durable effect truth/reconciliation;
- Guardian continuity;
- SessionCommander exact-owned lifecycle.

## Pass 11 — completed research findings

Still no local benchmark or implementation.

Research next:

1. MCP agent delegation / fine-grained authorization / tool-scope proposals and maintainer direction;
2. stable vs draft status and interoperability of DPoP, WIF, client-credentials and fine-grained auth extensions;
3. whether a standards-based delegation format can replace WAG parent/child capability lineage;
4. Windows native approval-broker OSS prior art with independent UI + Hello/WebAuthn;
5. WebAuthn enrollment/revocation/recovery for a single-user local desktop tool;
6. Windows Hello KeyCredential / TPM-backed signing vs full WebAuthn for proposal signatures;
7. OAuth RAR/JAR/PAR only where they eliminate real enterprise custom code;
8. Secure MCP Tunnel security/release/issues watch;
9. DPoP + Secure MCP Tunnel end-to-end semantics through an intermediary;
10. no implementation until a concrete uncovered gap survives.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_10 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE

BUILD_CUSTOM_IDENTITY_PROTOCOL = NO
MCP_OAUTH_CORE = REUSE
MCP_EMA_XAA = ENTERPRISE_IDENTITY_POLICY_NOT_EFFECT_APPROVAL
MCP_MACHINE_AUTH = REUSE
MCP_DPOP = PREFERRED_BEARER_THEFT_HARDENING_WHEN_SUPPORTED
CUSTOM_WAG_HTTP_POP = DO_NOT_BUILD
MCP_WIF = FUTURE_REMOTE_WORKLOAD_IDENTITY
SPIFFE_SPIRE = ENTERPRISE_DONOR_NOT_SOLO_DESKTOP_DEFAULT

MCP_AGENT_INSTANCE_IDENTITY = STILL_EVOLVING
MCP_DELEGATION_CHAIN = STILL_EVOLVING
MCP_CLIENTINFO = NOT_AUTHORITY
MCP_CONNECTION = NOT_SESSION_AUTHORITY

WINDOWS_USERCONSENTVERIFIER = LIGHTWEIGHT_LOCAL_REVERIFICATION
WINDOWS_WEBAUTHN = STRONGER_PROPOSAL_CHALLENGE_BINDING
PLAIN_WEBAUTHN = DOES_NOT_PROVE_EXACT_HUMAN_DISPLAY
LOCAL_WAG_OWNED_APPROVAL_UI = REQUIRED_FOR_EXACT_EFFECT_DISPLAY

OAUTH_RAR = STRUCTURED_AUTHORIZATION_VOCABULARY_DONOR
OAUTH_RAR = NOT_ADR_0019_REPLACEMENT

OPENAI_SECURE_MCP_TUNNEL = REACHABILITY_NOT_LOCAL_AUTH_BOUNDARY
OPENAI_TUNNEL_PAYLOADS = TRANSIT_OPENAI
OPENAI_TUNNEL_FORWARDED_BEARER = MAY_TRANSIT_OPENAI
TUNNEL_ID = NOT_WAG_CAPABILITY

REMOTE_TRANSPORT = INTERCHANGEABLE_IF_AUTHORITY_STAYS_ABOVE_TRANSPORT
WAG_CUSTOM_AUTH_CODE = REDUCE
WAG_SEMANTIC_AUTHORITY = RETAIN
SESSIONCOMMANDER_EXACT_OWNED_LIFECYCLE = RETAIN
GUARDIAN_BROWSER_CONTROL_EXPANSION = NO

NEXT_ACTION = PASS_13_WIMSE_EVIDENCE_AND_WINDOWS_NATIVE_APPROVAL_MATURITY
```


## Pass 11 material additions

- MCP 2026 is per-request/stateless; transport connection/process is not application ownership.
- MCP Auth WG is actively working on delegated/agentic access, tool scopes and fine-grained/RAR authorization; do not create a large WAG-specific delegation standard.
- Biscuit is the strongest portable attenuated-capability donor found, but adoption is deferred while MCP standardization is active.
- Windows Hello KeyCredential is a lighter Windows-only signing primitive than full WebAuthn for local approval; WebAuthn remains stronger when portability/FIDO ecosystem matters.
- Exact-effect display remains WAG-owned regardless of signing primitive.
- DPoP + Secure MCP Tunnel is currently unproven because DPoP binds `htu` while Tunnel rewrites connector-facing resource URLs and forwards to a private origin. Do not claim compatibility without explicit provider/protocol evidence.
- Keep minimal WAG grant lineage, exact proposal ownership, atomic single-use approval->effect transition, effect truth and SessionCommander exact-owned lifecycle.

Detailed receipt:
- `docs/research/2026-09-20-ai-native-browser-research-pass-11.md`

## Pass 12 — research only

Still no local benchmark or implementation.

Research:
1. classify current MCP delegation/tool-scope/RAR/OBO/execution-receipt work by stability;
2. WIMSE/IETF workload/delegation direction;
3. Biscuit audits/adoption/failure modes;
4. KeyCredential support from unpackaged Win32/Electron/native-host paths;
5. KeyCredential attestation value vs complexity;
6. DPoP + Secure MCP Tunnel compatibility evidence;
7. standards-based trusted-proxy canonical-URI patterns;
8. local approval UI isolation/broker patterns;
9. Hello reset/account/device recovery threat model;
10. no implementation until evidence converges.


## Pass 12 material additions

- MCP core OAuth dynamic scope/step-up and Enterprise Managed Authorization are reusable now; RAR/tool-scope/delegation work remains evolving.
- WIMSE is now the primary future standards watch for workload/agent identity, attenuated delegation and authorization evidence.
- Biscuit remains useful prior art but not a WAG trust-core dependency; project still seeks broader cryptographic audit and had a historical v1 critical signature-forgery vulnerability fixed in v2.
- Windows KeyCredential remains a promising lighter Windows-only exact-challenge signing path; unpackaged/native-host viability needs more evidence.
- KeyCredential attestation should be optional rather than default local complexity.
- DPoP over Secure MCP Tunnel remains unproven because of RFC 9449 target-URI binding versus tunnel URL rewriting.

Detailed receipt:
- `docs/research/2026-09-20-ai-native-browser-research-pass-12.md`

## Pass 13 — research only

Still no local benchmark or implementation.

Research:
1. WIMSE agent-delegation/evidence draft maturity/adoption;
2. authorization-evidence record schema vs WAG proposal/approval/effect records;
3. transaction/execution-context-token adjacent standards;
4. KeyCredential unpackaged Win32/native-host viability;
5. CNG/NCrypt alternatives only if KeyCredential path is blocked;
6. security/community evidence for desktop Hello signing;
7. OAuth/IETF DPoP proxy canonical-URI guidance;
8. Secure MCP Tunnel DPoP/sender-constrained-token watch;
9. MCP fine-grained authorization evolution;
10. no implementation until an architecture reduction is justified.
