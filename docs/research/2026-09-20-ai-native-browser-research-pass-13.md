# AI-native Browser / WIMSE Evidence & Windows Approval Maturity — Pass 13

Date: 2026-09-20
Status: RESEARCH RECEIPT — standards/evidence and Windows native approval; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start: `e17e05f39b7d17888c23fc5dbe0b75de3b7a5675`

## Executive conclusion

Pass 13 produces two high-value corrections.

First, emerging WIMSE work now maps surprisingly closely to WAG's existing authority model:
- attenuated parent/child delegation;
- exact request authorization evidence;
- pre-dispatch commitment;
- post-dispatch closure/effect evidence;
- workload + delegated subject context.

This strongly supports keeping WAG's internal model small and standards-shaped rather than inventing a public WAG protocol.

Second, Windows Hello `KeyCredentialManager` must **not** be treated as an application/process isolation boundary for WAG's current full-trust/unpackaged path. Evidence from 2026 Windows testing shows same-user processes can access the same named KeyCredential in full-trust scenarios. KeyCredential can still be useful as a user-verification/signing factor, but not as sole authority or secret isolation.

No implementation or local benchmark was performed.

## 1. WIMSE Agent Delegation Chain is extremely close to WAG lineage — but remains an individual draft

`draft-asor-wimse-agent-delegation-chain-01` (September 2026) proposes Verifiable Attenuated Delegation for AI Agent Chains.

Its model:
- OAuth 2.0 JWT access tokens;
- Rich Authorization Requests (`authorization_details`) to represent authority;
- parent-child cryptographic byte commitments;
- deterministic offline verification;
- monotonic attenuation;
- bounded delegation depth;
- monotonic expiry;
- DPoP / proof-of-possession reuse;
- status-list machinery;
- no new cryptographic primitive.

This is almost exactly the shape WAG needs for portable multi-hop delegation.

However, the Datatracker classifies it as an **individual Internet-Draft** with no formal standards standing yet.

Implication:

```text
WAG_INTERNAL_PARENT_CHILD_SUBSET_RULE = KEEP
WAG_PUBLIC_TOKEN_FORMAT = DO_NOT_STANDARDIZE
WIMSE_AGENT_DELEGATION_CHAIN = PRIMARY_MAPPING_TARGET
IMPLEMENT_DRAFT_WIRE_FORMAT_NOW = NO
```

If this or a successor gains WG adoption/stability, WAG should prefer mapping/replacing internal portable delegation instead of extending custom format.

## 2. Authorization-Evidence draft independently converges on WAG proposal/effect truth

`draft-munoz-wimse-authorization-evidence-01` defines:
- a signed Permit;
- cryptographic commitment to canonical request bytes **before dispatch**;
- a paired Closure Record bound to the dispatched-request digest;
- agent/workload identity;
- delegated subject context;
- resource/tool/action;
- decision/timestamp/correlation evidence;
- optional OAuth and HTTP Message Signature integration;
- parent/child authority-lineage verification inputs.

This aligns strongly with WAG:

```text
WAG immutable proposal fingerprint
~= Permit canonical authorized-request commitment

WAG approval/effect dispatch correlation
~= Permit -> dispatch binding

WAG durable effect/result truth
~= Closure/evidence lifecycle
```

Important caveat:
the authorization-evidence document is also an **individual Internet-Draft**, not a WIMSE WG document.

Direction:
- do not implement SCITT/Permit machinery now;
- keep WAG record fields easy to map;
- avoid custom public evidence protocol.

## 3. WAG should preserve three separate records

Standards research reinforces a useful separation:

### A. Delegation grant
Who/what may act, with attenuated authority.

### B. Authorization decision / proposal evidence
What exact action/resource/request was authorized before dispatch.

### C. Effect / closure evidence
What was actually dispatched and what outcome was established.

Do not collapse them into one bearer token.

This preserves:
- least privilege;
- approval semantics;
- auditability;
- unknown-outcome recovery.

## 4. OAuth Transaction Tokens are useful context-propagation prior art

The OAuth WG's Transaction Tokens work is active and moving toward WG completion.

An agent-focused draft proposes:
- `actor`: agent performing the action;
- `principal`: human/system entity that initiated it.

This is useful for downstream call-graph identity context.

But transaction/context tokens do not by themselves replace:
- attenuated delegation verification;
- local effect approval;
- exact request fingerprint;
- closure/effect truth.

Disposition:
**context propagation donor, not authority core.**

## 5. WIMSE is a roadmap, not a dependency target yet

WIMSE currently contains active WG documents for:
- workload architecture;
- identifiers;
- workload credentials;
- proof tokens;
- HTTP-signature authentication;
- mTLS authentication.

Related drafts cover:
- agent delegation chains;
- credential delegation;
- cross-org delegation;
- authorization evidence;
- condition-bounded credentials.

This makes WIMSE the highest-value standards watch for WAG's future identity/delegation layer.

But current agent-specific pieces are mostly individual drafts.

Rule:

```text
WATCH_WIMSE_AGGRESSIVELY = YES
CHASE_EACH_DRAFT_IMPLEMENTATION = NO
KEEP_INTERNAL_SCHEMA_MAPPABLE = YES
```

## 6. Critical correction: KeyCredentialManager is not a strong app boundary for full-trust WAG

A 2026 Microsoft Q&A / WindowsAppSDK discussion investigated the exact question WAG cares about.

Observed practical test:
- Application A created a KeyCredential;
- Application B was a separate unpackaged Win32 process under the same Windows user;
- B knew the credential name;
- `KeyCredentialManager.OpenAsync` returned success;
- after Windows Hello verification, B successfully used the credential.

A packaged MSIX **full-trust / mediumIL** app also did not automatically gain an AppContainer cryptographic boundary merely because it had package identity.

The follow-up explanation distinguishes:
- real AppContainer process isolation;
- full-trust packaged Win32 identity/file virtualization.

For full-trust processes, effective KeyCredential protection may degrade toward same-user scope.

Therefore:

```text
KEYCREDENTIAL_PRIVATE_KEY_NONEXPORTABLE = USEFUL
KEYCREDENTIAL_HELLO_USER_VERIFICATION = USEFUL

KEYCREDENTIAL_NAME = NOT_SECRET
KEYCREDENTIAL_FULL_TRUST_APP_ISOLATION = NOT_RELIABLE
KEYCREDENTIAL_ALONE = NOT_WAG_APPROVAL_AUTHORITY
```

## 7. Impact on the proposed local approval architecture

Do not use:

```text
browser/native host
-> call KeyCredential by known name
-> Hello prompt
-> signature
-> execute effect
```

as the entire security boundary.

A malicious/same-user process could potentially invoke the same credential and induce a Hello ceremony.

Instead, the trusted decision still needs:
- WAG-owned immutable proposal;
- WAG-owned independent local UI;
- verified proposal fingerprint;
- broker/admission context;
- single-use transition;
- effect-core validation.

KeyCredential may authenticate **user presence/signing**, but it does not establish trusted caller provenance in full-trust Windows.

## 8. This makes the approval broker more important

The security question shifts from:

> Which Windows Hello API signs the proposal?

to:

> Which trusted local component is allowed to ask for/sign/consume approval, and how is that component isolated from an agent-controlled same-user process?

Potential future research lanes:
- true AppContainer broker;
- isolated Win32/AppContainer boundary;
- capability-specific local broker with explicit ACL/IPC;
- WebAuthn RP/credential binding properties;
- Windows service/security-principal broker only if simpler options cannot meet the threat model.

ADR-0019's prior decision to avoid services/elevation/AppContainer **without evidence** still stands. Pass 13 provides evidence that full-trust KeyCredential alone is insufficient, not evidence that a service is automatically required.

## 9. KeyCredential is downgraded from "primary local signer" to "optional user-verification/signing donor"

Updated disposition:

```text
WINDOWS_KEYCREDENTIAL = OPTIONAL_FACTOR
WINDOWS_KEYCREDENTIAL = NOT_PROCESS_IDENTITY
WINDOWS_KEYCREDENTIAL = NOT_APP_ISOLATION_FOR_FULL_TRUST

WEBAUTHN = STILL_RESEARCH
USERCONSENTVERIFIER = USER_PRESENCE_ONLY
LOCAL_BROKER_BOUNDARY = UNRESOLVED
```

This is a material downgrade from Pass 11/12.

## 10. WebAuthn must be evaluated against the same same-user threat, not assumed safer

WebAuthn provides:
- RP binding;
- credential IDs;
- challenge binding;
- authenticator-backed signatures.

But for native local use, WAG must establish whether:
- another same-user process can request an assertion for the same RP/credential;
- RP/origin enforcement is meaningful in Win32 native API context;
- caller application identity is actually part of the OS security decision.

Do not assume browser-origin WebAuthn guarantees transfer automatically to a local Win32 broker.

This becomes a Pass 14 research gate.

## 11. Current minimal WAG mapping target

Keep internal fields that map naturally to emerging standards:

```text
Grant:
  issuer
  subject / actor
  principal?
  parent_grant_id
  resource
  action
  constraints
  expiry
  depth
  revocation state

Proposal:
  proposal_id
  exact canonical request digest
  resource/action
  grant linkage
  created/expires
  approval requirement

Approval:
  independent authority
  proposal digest
  one-time nonce
  timestamp/expiry
  verification evidence

Effect:
  dispatch digest
  job/effect id
  outcome state
  reconciliation evidence
```

Do not expose a new portable WAG token standard.

## 12. Pass 14 — research only

No local benchmark or implementation.

Research next:
1. Win32 WebAuthn same-user/RP/application isolation semantics;
2. whether another local process can request assertions for the same RP/credential;
3. Windows WebAuthn native caller/origin model;
4. AppContainer / Win32 App Isolation as a minimal approval broker boundary;
5. named-pipe/COM/AppService IPC models from isolated broker to full-trust WAG;
6. whether an existing Windows credential/broker architecture can provide independent approval without a custom service;
7. WIMSE agent-delegation-chain revision/adoption watch;
8. Permit/Closure mapping vs current WAG durable-effect ledger;
9. OAuth Transaction Token maturity/context propagation;
10. still no implementation until the local approval trust boundary is resolved.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_13 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE

WIMSE_AGENT_DELEGATION_CHAIN = HIGH_FIT_INDIVIDUAL_DRAFT
WIMSE_AUTHORIZATION_EVIDENCE = HIGH_FIT_INDIVIDUAL_DRAFT
IMPLEMENT_WIMSE_DRAFT_WIRE_FORMAT_NOW = NO

WAG_GRANT_PROPOSAL_EFFECT_SEPARATION = VALIDATED
WAG_INTERNAL_SCHEMA = KEEP_STANDARDS_MAPPABLE
WAG_PUBLIC_DELEGATION_PROTOCOL = DO_NOT_BUILD

KEYCREDENTIAL = DOWNGRADED_TO_OPTIONAL_FACTOR
KEYCREDENTIAL_FULL_TRUST_APP_BOUNDARY = NOT_RELIABLE
KEYCREDENTIAL_ALONE_FOR_APPROVAL = FORBIDDEN

LOCAL_APPROVAL_BROKER_BOUNDARY = UNRESOLVED
WEBAUTHN_SAME_USER_BOUNDARY = RESEARCH_REQUIRED

ADR_0019 = RETAIN
SESSIONCOMMANDER_EXACT_OWNED_LIFECYCLE = RETAIN

NEXT_ACTION = PASS_14_WINDOWS_WEBAUTHN_AND_ISOLATED_APPROVAL_BROKER_RESEARCH
```
