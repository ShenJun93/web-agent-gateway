# AI-native Browser / Approval Surface & Process Hardening Research — Pass 15

Date: 2026-09-20
Status: RESEARCH RECEIPT — approval transport decision pressure + process hardening; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start: `5f2e5eb81283d8b95e465dba849725900c89951f`

## Executive conclusion

Pass 15 corrects an over-eager direction from Pass 14.

A short-lived native approval broker is technically feasible and can be hardened well with standard Windows primitives. However, **it should not replace WAG's existing loopback operator server by default**.

Fresh inspection of canonical WAG shows the existing operator surface is already:
- loopback-only;
- one-time bootstrap;
- session cookie is `HttpOnly; SameSite=Strict`;
- exact POST Origin enforcement;
- per-session CSRF;
- restrictive CSP;
- `X-Frame-Options: DENY`;
- `Referrer-Policy: no-referrer`;
- `Cache-Control: no-store`;
- `nosniff`;
- escaped untrusted display values;
- bounded form body;
- bootstrap/operator credentials are not projected through MCP/browser tools;
- already accepted as part of the durable mutation control plane.

Browser Verify Approval v1 was deliberately designed to **reuse** this proven local operator channel rather than create a second approval subsystem.

Under ADR-0019's accepted threat model, which explicitly excludes full hostile-same-user containment, there is currently no measured security or usability gap that justifies adding:
- a new native broker binary;
- a new UI stack;
- new launch/signing/distribution evidence;
- new process lifecycle;
- new approval transport tests.

Therefore the reuse-first decision is:

```text
CURRENT_LOCAL_APPROVAL_TRANSPORT = KEEP_EXISTING_LOOPBACK_OPERATOR_SERVER
SHORT_LIVED_NATIVE_BROKER = FALLBACK_DESIGN_DONOR
NATIVE_BROKER_IMPLEMENT_NOW = NO
```

This is an evidence-driven correction, not sunk-cost preservation.

## 1. Canonical WAG operator server is already narrow and hardened

`src/operator-server.ts` currently enforces:

- bind only `127.0.0.1` or `::1`;
- random 32-byte bootstrap token;
- bootstrap token invalidated after first successful use;
- random session ID and per-session CSRF;
- session cookie `HttpOnly; SameSite=Strict`;
- exact `Origin === operator origin` for mutation POSTs;
- CSRF checked with timing-safe secret compare;
- 8 KiB form-body cap;
- no-store + no-referrer + nosniff;
- CSP `default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
- X-Frame-Options DENY;
- HTML escaping on all rendered review values.

The implementation exposes no general remote-execution route. It only calls the local mutation coordinator's list/review/approve/reject surface.

## 2. Existing tests and acceptance evidence are unusually relevant

`test/operator-server.test.ts` already proves:
- non-loopback bind fails;
- bootstrap is single-use;
- cookie carries HttpOnly/SameSite;
- bootstrap token disappears after redirect;
- hostile display HTML is escaped;
- CSP/XFO/referrer/no-store headers exist;
- no owner/session/adapter authority fields are rendered;
- approval without exact Origin is denied;
- approval without exact CSRF is denied;
- correct local approval succeeds.

The durable mutation control-plane receipt additionally records:
- durable preview before approval;
- exact local review;
- local execution after approval;
- restart/crash reconciliation;
- exact owner/session/adapter fencing;
- single-use approval/claim transitions;
- final repository evidence;
- full source/test gates.

This is stronger project-specific evidence than generic prior art for a brand-new native broker.

## 3. Browser Verify Approval v1 intentionally composes this existing boundary

The canonical Browser Verify Approval v1 design already says:

```text
browser = propose + poll
local operator = approve/reject
WAG = validate + atomically create/dispatch
trusted profile = command authority
```

Its local review section explicitly reuses the current operator server's transport/session security.

The planned verify-specific delta is limited to:
- list/detail review of exact verify request;
- workspace/profile/plan hash/fingerprint/expiry display;
- approve/reject;
- atomic request -> durable verify-job creation.

It does **not** need a new authority model.

Therefore replacing the transport/UI with a native broker would be a design amendment, not an implementation detail.

## 4. Threat model does not justify the new broker yet

The current Browser Verify threat model explicitly says:
- browser/model cannot approve;
- operator bootstrap/session material never crosses remote tools;
- fully compromised same-user local session is out of scope.

A native child broker without AppContainer would still run under that same user and therefore would **not** materially change the hostile-same-user boundary.

It would reduce HTTP/CSRF/browser-local attack surface, but would add:
- executable integrity;
- launch path;
- inherited-handle correctness;
- job ownership;
- native UI spoofing/usability;
- binary signing;
- distribution/install;
- additional acceptance matrix.

Under the project's reuse hierarchy, that trade is negative without a measured gap.

## 5. UIInspect.MCP validates the general approval patterns, not the need to copy its architecture

`ChrisPulman/UIInspect.MCP` is strong Windows prior art.

Its security design includes:
- server-owned trusted Windows dialog;
- bounded prompt timeout;
- exact PID + process creation time + executable identity + Windows session;
- PID alone never authority;
- in-memory grants;
- fail closed on process restart/broker loss;
- separate capability ceilings;
- MCP client metadata not trusted as identity;
- same-user compromise explicitly outside boundary.

Its unattended broker:
- is activated only through local manager command, not MCP tools;
- holds leases in memory only;
- uses `PipeOptions.CurrentUserOnly`;
- scopes object names to current SID + interactive session;
- revalidates exact process identity on each request;
- has no reusable token file.

This independently validates WAG's direction.

But UIInspect needs multi-hour, multi-agent unattended UI automation, so a persistent named-pipe broker is justified for its product. WAG's exact one-shot proposal approval does not share that requirement.

Disposition:
```text
UIINSPECT_SECURITY_PATTERNS = STRONG_DONOR
COPY_UIINSPECT_PERSISTENT_BROKER = NO
```

## 6. If a native broker is ever required, Windows already provides sufficient primitives

A future short-lived broker does not require a custom supervisor framework.

Preferred process creation/containment primitives:

1. launch with exact full executable path through `CreateProcessW`;
2. use `STARTUPINFOEX`;
3. pass only explicit anonymous pipe handles using `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`;
4. associate the process with a Job Object **at creation** using `PROC_THREAD_ATTRIBUTE_JOB_LIST`;
5. Job Object uses `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`;
6. do not permit breakaway;
7. optionally set active process limit to 1 if broker requires no children;
8. use compatible process mitigation policies only where they do not block WAG's own signed broker;
9. verify expected broker artifact provenance/hash and Authenticode under the existing WAG release model.

Do not rely on `PROCESS_CREATION_CHILD_PROCESS_RESTRICTED` as the primary full-trust security control. Microsoft documents that child-process restriction is effective in a sandbox context and can be bypassed when a process can access privileged process handles.

## 7. Job Objects solve cleanup better than another SessionCommander-specific mechanism

For an owned one-shot broker:

```text
WAG owns Job Object handle
-> broker is assigned at creation
-> broker tree is contained
-> WAG closes job on cancel/shutdown/timeout
-> KILL_ON_JOB_CLOSE terminates remaining tree
```

This gives deterministic broker cleanup with native Windows semantics.

SessionCommander may still observe/reconcile process ownership externally, but WAG does not need to delegate routine broker lifecycle to SessionCommander.

This avoids increasing coupling between WAG and SessionCommander.

## 8. UserConsentVerifier remains optional, not required by the current approval design

The existing operator server already represents an independent user action under ADR-0019.

Adding Windows Hello/PIN/biometric would provide re-verification, but it is not currently required by the threat model.

Use `UserConsentVerifier` only if a future measured risk/UX requirement says:
- accidental click needs stronger friction;
- operator identity should be re-verified immediately before high-risk effect;
- unattended/session-sharing behavior requires a fresh local factor.

Do not add biometric/PIN ceremony merely because the API exists.

## 9. Native WebAuthn remains even farther from the default path

WebAuthn is useful when a cryptographic, portable approval receipt is required.

Current WAG verify/mutation safety relies on:
- exact live pending record;
- local approval state transition;
- single-use state;
- atomic durable effect/job creation;
- restart reconciliation.

No current requirement consumes a portable signed approval proof.

Therefore:
```text
WEBAUTHN_APPROVAL_RECEIPT_REQUIREMENT = NOT_MEASURED
WEBAUTHN_ADD_NOW = NO
```

## 10. Recommended approval hierarchy after Pass 15

```text
TIER 0 — CURRENT
Existing WAG loopback operator server
+ exact immutable proposal
+ one-time bootstrap/session
+ Origin/CSRF/CSP
+ atomic durable approval -> effect transition

TIER 1 — ONLY IF MEASURED NEED
Tier 0 + UserConsentVerifier local re-verification

TIER 2 — ONLY IF LOOPBACK/UI GAP IS PROVEN
Short-lived native child broker
+ inherited anonymous handles
+ exact launch path
+ Job Object containment
+ same WAG proposal/effect state machine

TIER 3 — ONLY IF PORTABLE CRYPTO RECEIPT NEEDED
Tier 2 + WebAuthn/FIDO assertion

TIER 4 — ONLY IF HOSTILE-SAME-USER THREAT ENTERS SCOPE
AppContainer/Win32 App Isolation broker
or separately reviewed stronger OS principal boundary
```

This is cheaper, more reversible and better aligned with the existing accepted evidence than immediately building a native broker.

## 11. What should not change

Do not change:
- ADR-0019 proposal/effect split;
- browser proposal-only authority;
- exact caller/workspace ownership;
- verify-profile trusted allowlist;
- immutable request fingerprint;
- fixed review TTL;
- atomic approval -> job creation;
- no restart-resume for browser-approved verify;
- OUTCOME_UNKNOWN/no blind replay;
- SessionCommander exact-owned lifecycle for its existing domain;
- Guardian continuity role.

## 12. What could be retired/frozen

Continue freezing:
- new browser approval UI inside browser DOM;
- remote approval;
- reusable approval bearer;
- custom auth/proof protocol;
- persistent native approval service;
- AppContainer/service/elevation work without threat-model evidence;
- generic broker framework.

## 13. Pass 16 — research only

No local benchmark or implementation.

Research next:
1. current community/security experience with loopback-only local operator UIs in developer tooling;
2. browser localhost/private-network access changes that could materially change loopback threat assumptions;
3. whether Chrome/Edge local network access permission/PNA changes make loopback approval safer or less reliable;
4. CSRF/DNS rebinding/Host header considerations against the exact current WAG operator server;
5. whether WAG should add exact Host checking or browser-independent launch/open behavior before any verify implementation;
6. compare existing mutation operator server with security patterns from Docker Desktop, Git credential helpers, local OAuth callback servers, developer tooling;
7. only if a concrete loopback gap survives, reopen short-lived native broker design;
8. continue WIMSE/MCP standards watch only on material changes;
9. no local browser benchmark;
10. no implementation.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_15 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE

EXISTING_OPERATOR_SERVER = RETAIN
EXISTING_OPERATOR_SERVER_EVIDENCE = STRONG
BROWSER_VERIFY_OPERATOR_TRANSPORT = REUSE_EXISTING_BY_DEFAULT

SHORT_LIVED_NATIVE_BROKER = FALLBACK_DESIGN
NATIVE_BROKER_IMPLEMENT_NOW = NO
UIINSPECT_MCP = STRONG_WINDOWS_APPROVAL_PRIOR_ART

BROKER_JOB_OBJECT = PREFERRED_FUTURE_CONTAINMENT
PROCESS_CHILD_RESTRICTION_FLAG = NOT_PRIMARY_FULLTRUST_CONTROL

USERCONSENTVERIFIER = OPTIONAL_REVERIFICATION
WEBAUTHN = OPTIONAL_PORTABLE_CRYPTO_RECEIPT
APPCONTAINER = FUTURE_HOSTILE_SAME_USER_GATE

ADR_0019 = RETAIN
WAG_DURABLE_APPROVAL_EFFECT_CORE = RETAIN
SESSIONCOMMANDER_COUPLING = DO_NOT_INCREASE
GUARDIAN_BROWSER_CONTROL_EXPANSION = NO

NEXT_ACTION = PASS_16_LOOPBACK_OPERATOR_SECURITY_AND_BROWSER_LOCALHOST_EVOLUTION_RESEARCH
```
