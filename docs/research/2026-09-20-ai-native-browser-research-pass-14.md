# AI-native Browser / Windows Approval Boundary Research — Pass 14

Date: 2026-09-20
Status: RESEARCH RECEIPT — Win32 WebAuthn + local approval broker boundary; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start: `ed2070e6eeea3af225c1690b0c648a8099b9c952`

## Purpose

Continue research only. No local browser benchmark, Windows credential enrollment, packaging change, process launch, or implementation.

Pass 14 targets:
1. Win32 WebAuthn RP/application/same-user isolation semantics;
2. whether native callers can enumerate/request current-user platform credentials for arbitrary RP IDs;
3. AppContainer / Win32 App Isolation as an approval broker boundary;
4. minimal IPC from a broker to full-trust WAG;
5. whether a simpler non-persistent broker satisfies ADR-0019 without claiming hostile-same-user containment;
6. effect on KeyCredential/WebAuthn choice.

## Executive conclusion

Pass 14 resolves the biggest ambiguity left by Pass 13:

**Native Win32 WebAuthn should not be treated as an application/process identity boundary.**

Current Microsoft API shape shows:
- native caller supplies the RP ID to `WebAuthNAuthenticatorGetAssertion`;
- native caller supplies the RP entity/client data during credential creation;
- `WebAuthNGetPlatformCredentialList` retrieves platform credentials for the current user and accepts caller-supplied RP ID filtering.

This does not prove a practical cross-process credential theft exploit. It does prove that the Win32 API surface itself is not documenting browser-origin-to-executable binding as the security boundary.

Therefore:
- WebAuthn remains a strong challenge/authenticator/user-verification primitive;
- it does not replace WAG caller/admission ownership;
- KeyCredential and WebAuthn are both **factors**, not trusted application identity, for a full-trust local WAG path.

A true AppContainer/Win32 App Isolation broker could create a stronger application principal, but the current Win32 App Isolation product remains preview and has real packaging/COM/IPC roughness.

For the already accepted ADR-0019 threat model — which explicitly does not claim containment against a fully compromised same-user account — the lowest-complexity research direction is now:

```text
WAG creates immutable proposal + nonce
-> WAG spawns a short-lived native approval broker
-> only explicit inherited pipe handles are given to the child
-> broker displays exact effect in native UI
-> optional Windows Hello/WebAuthn user verification
-> broker returns a response bound to proposal + nonce
-> WAG validates pending proposal and atomically consumes approval
-> broker exits
```

This avoids:
- browser DOM approval;
- localhost approval endpoint;
- persistent named service;
- permanent privileged broker;
- premature AppContainer dependency.

It does **not** claim hostile-same-user isolation. If that threat becomes in-scope, AppContainer or another stronger principal boundary becomes a separate evidence-driven gate.

## 1. Win32 WebAuthn caller supplies RP ID directly

`WebAuthNAuthenticatorGetAssertion` takes:

```text
HWND
pwszRpId
clientData
options
```

The documented caller is a client application acting on behalf of the RP.

Unlike browser JavaScript WebAuthn, where the user agent derives/checks web origin relationships, the Win32 entry point accepts the RP ID as a caller parameter.

The API documentation reviewed in this pass does not document an executable/package identity check that cryptographically binds `pwszRpId` to the calling native process.

Therefore:

```text
NATIVE_WEBAUTHN_RP_ID = CALLER_INPUT
NATIVE_WEBAUTHN_RP_ID != DOCUMENTED_PROCESS_IDENTITY
```

Source:
- Microsoft `WebAuthNAuthenticatorGetAssertion` documentation.

## 2. Native credential enumeration is current-user scoped, not documented app-scoped

`WebAuthNGetPlatformCredentialList` retrieves platform credentials stored for the **current user**.

Its options contain:
- `pwszRpId`: optional RP ID filter;
- browser private-mode flag.

This strongly suggests the native API's enumeration boundary is current-user + credential/RP semantics, rather than an application-private credential namespace.

Again, this is not a claim that another process can silently sign without user verification.

It is sufficient evidence to reject:

```text
WEBAUTHN_PLATFORM_CREDENTIAL = TRUSTED_WAG_PROCESS_IDENTITY
```

Sources:
- Microsoft `WebAuthNGetPlatformCredentialList`;
- `WEBAUTHN_GET_CREDENTIALS_OPTIONS`.

## 3. Native WebAuthn client data is also supplied by caller

`WEBAUTHN_CLIENT_DATA` contains the UTF-8 client data JSON and hash algorithm supplied to the authenticator.

That means WAG must verify its own expected:
- challenge;
- purpose/domain separator;
- proposal fingerprint;
- expiry/nonce;
- any origin/RP literals it chooses to use.

Do not infer that a string placed in native clientData is OS-authenticated executable identity.

## 4. Browser WebAuthn origin security should not be copied conceptually into native Win32

Browser WebAuthn has strong web-origin/RP semantics because the browser participates in the ceremony and validates origin relationships.

Microsoft Edge's remote WebAuthn policy even explicitly controls which web origins may claim otherwise-unavailable RP IDs.

That reinforces the distinction:
- browser origin enforcement is a browser policy/security function;
- native Win32 API is a lower-level client surface.

For WAG local approval:
- challenge verification remains valuable;
- app/process isolation must come from another mechanism if required.

## 5. Win32 App Isolation / AppContainer is a real security boundary

Microsoft's current Windows 11 Security Book states:
- Win32 App Isolation is built on AppContainer;
- AppContainer is recognized as a security boundary;
- isolated process runs low integrity;
- it cannot inject into higher-integrity processes;
- resource access is default-deny and added through capabilities/DACLs.

Traditional AppContainer documentation likewise describes:
- unique Package/AppContainer SID;
- capability SIDs;
- dual-principal access check;
- low integrity;
- explicit DACL grants.

Therefore an approval broker in a real AppContainer can have a meaningful OS identity distinct from ordinary same-user full-trust processes.

Sources:
- Microsoft Windows 11 Application Isolation security documentation;
- Microsoft AppContainer implementation documentation.

## 6. Win32 App Isolation is still not boring infrastructure

Current Microsoft documentation still marks Win32 App Isolation as **preview**.

Minimum documented path:
- Windows 11 24H2 build 26100+;
- MSIX/package identity setup;
- manifest capabilities;
- modern Visual Studio/SDK tooling.

Public issues still show integration roughness:
- COM activation from isolated AppContainer to full-trust COM server can fail;
- packaging semantics have changed/caused compatibility questions;
- supported capabilities remain described as work in progress.

There is also active 2026 tooling churn around newer sandbox/process-container APIs.

Therefore:

```text
APPCONTAINER = STRONG_SECURITY_BOUNDARY
WIN32_APP_ISOLATION = NOT_YET_DEFAULT_WAG_DEPENDENCY
```

## 7. AppContainer IPC can be made explicit with package-SID ACLs

Microsoft documentation provides a current pattern for sharing named Windows objects with a packaged/AppContainer app:
- derive the AppContainer SID;
- build an explicit DACL;
- grant only the desired rights to that SID;
- create the named object with that security descriptor.

Current Microsoft test infrastructure work independently uses the same pattern to authorize an AppContainer test host onto a controller named pipe by granting the exact package SID.

This is strong prior art for a future isolated WAG approval broker.

But it adds:
- packaging/SID lifecycle;
- named-object namespace details;
- DACL management;
- low-integrity/mandatory-label compatibility;
- more operational surface than the current threat model requires.

## 8. `CreateProcessInSandbox` is interesting but remains too new

Microsoft has documented a `CreateProcessInSandbox` API that can launch an AppContainer-isolated process with:
- kernel process isolation;
- default-deny network;
- default-deny filesystem except explicit grants.

This could eventually make a tiny approval broker substantially easier than repackaging WAG itself.

However, 2026 VS Code/MXC issues show:
- feature/velocity gating;
- fallback path bugs;
- backend/schema churn.

Therefore:
**watch, do not base WAG approval production architecture on it yet.**

## 9. The current ADR-0019 threat model allows a simpler broker

ADR-0019 already says:
- the current system does not claim hostile-same-user sandboxing;
- a fully compromised same-user account remains outside the containment claim;
- independent local operator approval is required because browser/model authority must not itself approve the effect.

This distinction matters.

The approval system does **not** currently need to prove:

> No other process under the user's account can ever invoke Windows Hello/WebAuthn.

It needs to prove:

> The browser/model cannot turn its own proposal channel into effect authority, and WAG only dispatches after an independent local operator transition bound to the exact live proposal.

That makes a short-lived native broker a credible minimal architecture for the current threat model.

## 10. Preferred minimal broker prior art: inherited anonymous handles

Windows anonymous pipes are intended for related parent/child processes.

Microsoft recommends:
- default `bInheritHandles=FALSE`;
- when inheritance is required, use `STARTUPINFOEX` +
  `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` to explicitly list only handles the child needs.

A child can inherit a specific pipe handle and use the same underlying object/access rights.

This is attractive for WAG approval because there is:
- no discoverable TCP listener;
- no localhost endpoint;
- no stable pipe name to attack;
- no long-running service;
- no need to grant all same-user processes a well-known IPC endpoint.

Candidate research architecture:

```text
WAG
  creates pair of anonymous/inherited handles
  creates random approval_nonce
  records pending proposal(proposal_id,fingerprint,nonce,deadline)
  starts exact broker executable
    with only required handles in PROC_THREAD_ATTRIBUTE_HANDLE_LIST
  closes unused parent/child handle copies

BROKER
  reads canonical proposal over inherited handle
  renders exact effect in native HWND
  asks explicit Approve/Reject
  optionally invokes UserConsentVerifier or WebAuthn
  writes approval response:
    proposal_id
    fingerprint
    nonce
    decision
    verification result
  exits

WAG
  accepts only matching live pending proposal
  atomically consumes approval and creates effect job
  treats broker exit/no-response as reject/fail-closed
```

This is an architecture candidate only. No implementation is authorized by this receipt.

## 11. Why this is better than a persistent localhost approval UI

A browser/model can often:
- navigate HTTP URLs;
- interact with DOM;
- potentially hit localhost depending browser/network policy;
- replay URL/bearer artifacts.

A native on-demand child broker with inherited handles:
- is not reachable through browser navigation;
- has no browser DOM;
- is lifecycle-bounded to one approval;
- naturally supports single-use state;
- leaves fewer long-running processes.

This aligns with the user's process-cleanup constraints and SessionCommander ownership model.

## 12. UserConsentVerifier vs WebAuthn under this broker model

### UserConsentVerifier

Strengths:
- native Windows Hello/PIN/biometric system UI;
- window-bound desktop interop;
- simple result;
- can display an application-provided verification message.

Weakness:
- no cryptographic signature over proposal digest.

Good fit when:
- broker IPC + WAG pending-state binding are trusted under current threat model;
- Hello is only a local re-verification factor.

### Native WebAuthn

Strengths:
- signed assertion;
- challenge binding;
- platform/external FIDO authenticators;
- portable verification model.

Weakness:
- native RP/clientData are caller-supplied;
- not a documented process identity boundary;
- more ceremony/storage complexity;
- trusted exact-effect display is still WAG broker responsibility.

Good fit when:
- a cryptographic approval receipt is actually required;
- portability/external authenticator value justifies complexity.

### KeyCredential

Same conclusion as Pass 13:
- useful optional Hello-gated signing factor;
- not app/process identity for current full-trust path.

## 13. Recommended complexity order for current threat model

Research preference now becomes:

```text
1. WAG pending proposal + short-lived native broker + exact-effect display
2. + UserConsentVerifier if re-verification is desired
3. + WebAuthn only if cryptographic receipt/FIDO portability is required
4. AppContainer broker only if hostile-same-user/app isolation becomes required
5. Windows service/elevation only if AppContainer/minimal broker cannot satisfy measured need
```

This preserves the project's reuse/complexity rule:
NATIVE -> STANDARD -> PROVEN -> COMPOSE -> BUILD.

## 14. Security boundaries that remain mandatory

Regardless of broker choice:

- browser cannot approve;
- approval is exact-proposal bound;
- approval has fixed TTL;
- approval is single-use;
- stale/replayed/foreign approval fails closed;
- proposal fingerprint cannot change after display;
- effect dispatch revalidates current capability/profile;
- dispatch + durable job creation is atomic;
- UNKNOWN effect outcome is not blindly retried;
- broker child/process ownership is exact and cleaned up.

## 15. Pass 15 — research only

Still no local benchmark or implementation.

Research next:
1. independent/native desktop approval-broker projects using short-lived child + inherited-handle IPC;
2. whether Windows Credential UI/UserConsentVerifier gives enough anti-spoofing/trusted UI for current threat model;
3. process launch hardening for exact broker binary: full path, signature/hash, restricted inherited handles, mitigation policies;
4. Job Object/process containment for broker cleanup;
5. whether anonymous-pipe child pattern survives AppContainer if later upgraded;
6. AppContainer broker launch options without repackaging whole WAG;
7. WebAuthn native platform credential access/community security reports;
8. WIMSE Permit/Closure draft maturity changes only if material;
9. map proposed broker approval receipt into existing Browser Verify Approval v1 data model;
10. no implementation until research shows a clear minimal approval architecture.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_14 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE

WIN32_WEBAUTHN = STRONG_AUTHENTICATOR_FACTOR
WIN32_WEBAUTHN = NOT_DOCUMENTED_PROCESS_IDENTITY
WIN32_WEBAUTHN_RP_ID = CALLER_SUPPLIED
WIN32_PLATFORM_CREDENTIAL_LIST = CURRENT_USER_SCOPED

APPCONTAINER = REAL_SECURITY_BOUNDARY
WIN32_APP_ISOLATION = PREVIEW_NOT_DEFAULT_DEPENDENCY
CREATEPROCESSINSANDBOX = WATCH_NOT_PRODUCTION_BASE

ADR_0019_HOSTILE_SAME_USER = OUT_OF_SCOPE
CURRENT_APPROVAL_GOAL = INDEPENDENT_FROM_BROWSER_MODEL

SHORT_LIVED_NATIVE_APPROVAL_BROKER = PRIMARY_MINIMAL_RESEARCH_DIRECTION
INHERITED_ANONYMOUS_PIPE = PREFERRED_IPC_DONOR
PERSISTENT_LOCALHOST_APPROVAL_UI = AVOID

USERCONSENTVERIFIER = LOW_COMPLEXITY_REVERIFICATION_FACTOR
WEBAUTHN = OPTIONAL_CRYPTOGRAPHIC_RECEIPT_FACTOR
KEYCREDENTIAL = OPTIONAL_FACTOR_NOT_PROCESS_BOUNDARY

APPCONTAINER_BROKER = FUTURE_STRONGER_ISOLATION_GATE
WINDOWS_SERVICE_BROKER = DO_NOT_BUILD_WITHOUT_MEASURED_NEED

ADR_0019 = RETAIN
WAG_EFFECT_TRUTH = RETAIN
SESSIONCOMMANDER_EXACT_OWNED_LIFECYCLE = RETAIN

NEXT_ACTION = PASS_15_SHORT_LIVED_APPROVAL_BROKER_AND_PROCESS_HARDENING_RESEARCH
```
