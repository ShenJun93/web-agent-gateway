# Browser Verify Approval v1 — Threat Model

Date: 2026-09-19
Status: DRAFT THREAT MODEL — design evidence only
Companion design: `docs/superpowers/specs/2026-09-19-browser-verify-approval-v1-design.md`

## Security objective

Allow a WebChat/browser caller to propose one bounded named verification while ensuring that no command execution can occur until a separate local operator explicitly approves the exact immutable request.

ADR-0019 resolves the ADR-0017 successor question by accepting bounded, rate-limited, caller-owned proposal/control-plane writes under the current same-user Browser admission while preserving zero direct consequential browser authority.

The design still assumes the current Windows browser/native bootstrap is useful provenance but not a strong same-user isolation boundary. Therefore the browser path never receives an execution primitive, and stronger isolation remains required for any future direct browser process/Git/mutation/browser authority that is not mediated by an independently accepted local authority transition.

## Assets

Protect:
- local repository/workspace contents;
- trusted verify profile configuration;
- local credentials and environment secrets;
- WAG caller/workspace ownership;
- durable verify request/job state;
- operator approval authority;
- verification output;
- native-host/browser protocol integrity;
- release/signing trust boundaries.

## Trust domains

### Untrusted

- provider page/DOM and model output;
- repository text, including prompt-injection content;
- content-script input;
- browser tool arguments;
- provider conversation/tab/request ids;
- arbitrary remote text returned by the model;
- backend error strings;
- unrelated same-user applications.

### Trusted but not sufficient alone for execution

- exact extension id / Native Messaging `allowed_origins`;
- caller origin argument supplied to the native host;
- v3 browser/native protocol validation;
- WAG bootstrap/session bearer;
- WAG admission caller tuple.

These establish provenance and bounded proposal ownership. They do not independently authorize execution.

### Consequential authority

Only:
- trusted local verify-profile configuration; plus
- an exact live local operator approval; plus
- WAG's durable ownership/profile revalidation immediately before internal job creation/dispatch.

## Official platform constraints

Chrome Native Messaging:
- limits native-host access to listed extension origins;
- passes caller origin to the native host;
- uses stdin/stdout to a separately launched host process;
- requires service-worker validation/sanitization because content scripts share renderer context with untrusted pages.

Source:
https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

Windows:
- process/thread security context is represented by access tokens;
- named-pipe access checks use the client's token and object DACL;
- same logged-on user processes generally share user identity unless another isolation boundary is introduced.

Sources:
- https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens
- https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works

Security conclusion: neither Chrome origin nor same-user IPC is promoted into a claim of strong caller attestation.

## Threats and required controls

### T1 — Model/page attempts direct command execution

Attack:
- request `verify.run`;
- inject argv/env;
- call backend-native process tools;
- smuggle shell syntax in profile names.

Controls:
- v3 browser surface omits `verify.run`;
- only `verify.preview(workspace_id, profile)` and `verify.result(request_id)`;
- strict profile-name schema;
- server resolves argv/env only from trusted local config;
- no generic forwarding.

Acceptance:
- tool discovery excludes direct execution;
- explicit calls return tool-not-found/denial;
- shell metacharacters in profile input are data and cannot become command syntax.

### T2 — Weak browser provenance is mistaken for execution authority

Attack:
- another same-user process obtains or imitates local bootstrap material;
- forged page/provider identifiers are supplied;
- process/window/PID identity is treated as a trust proof.

Controls:
- browser admission grants proposal authority only;
- execution still requires local operator approval;
- provider/page ids remain correlation only;
- no PID/window/native-process identity can replace local approval.

Residual risk:
- WAG does not claim protection from a fully compromised local user account capable of controlling both WAG and the operator's browser/session.

### T3 — Prompt injection causes hidden verification

Attack:
repository text instructs the model to execute tests/build commands.

Controls:
- repository text cannot supply argv/env;
- model can only select a trusted profile explicitly named in the local `browserVerifyProfiles` allowlist;
- selection creates a pending request only;
- local review states the exact profile/workspace before execution.

Acceptance:
- malicious fixture content may create at most a pending request;
- no execution occurs without explicit local approval.

### T4 — Broad configured profile becomes silently browser-accessible

Attack:
a powerful local verify profile is automatically exposed when v3 is enabled.

Controls:
- trusted `browserVerifyProfiles` allowlist defaults empty;
- allowlist membership is local policy and never model-supplied;
- existing verify `planSha256` semantics remain unchanged;
- approval rechecks current allowlist membership and current plan hash;
- v3 accepts only allowlisted profiles.

Acceptance:
- profiles absent from the trusted allowlist are denied before request persistence.

### T5 — Profile changes after preview

Attack:
profile `unit` is harmless at preview but its argv/env is changed before approval.

Controls:
- request stores `planSha256`;
- approval re-resolves current profile;
- exact hash equality required before job creation;
- existing durable verify dispatch rechecks the same plan hash before execution.

Acceptance:
- any profile/eligibility/restart-policy drift invalidates request or fails job before execution.

### T6 — Workspace substitution / cross-session reuse

Attack:
session B uses session A's workspace or request id.

Controls:
- request stores exact owner/session/adapter tuple;
- workspace must match exact tuple at preview and approval;
- result lookup requires exact tuple;
- wrong-id and wrong-owner denial is indistinguishable remotely.

Acceptance:
- owner, session, and adapter mismatches are tested independently.

### T7 — Approval replay creates duplicate jobs

Attack:
double-click, concurrent POST, network retry, or browser replay creates multiple verify executions.

Controls:
- one durable request id;
- `PENDING_APPROVAL -> DISPATCHED` plus internal job creation occurs in one `BEGIN IMMEDIATE` transaction;
- linked job id is written once;
- terminal/dispatched requests cannot be approved again;
- existing verify job claim is single-winner.

Acceptance:
- concurrent local approvals produce exactly one job and one execution attempt.

### T8 — Crash between approval and job creation

Attack:
approval state commits but job creation does not, or vice versa.

Controls:
- approval transition and job-row creation are one SQLite transaction;
- either both exist or neither does.

Acceptance:
- fault-injection/transaction tests prove no half-approved request.

### T9 — Crash after approval causes delayed unexpected execution

Attack:
approved job remains queued and executes after restart when the operator is no longer expecting it.

Controls:
- browser-eligible profiles require `resumeQueuedAfterRestart=false`;
- existing Durable Verify Job Core marks recovered queued jobs failed before execution when resume is disabled;
- deadlines never refresh.

Acceptance:
- restart after approved/queued but before claim produces no execution.

### T10 — Crash after execution begins causes duplicate replay

Attack:
WAG cannot tell whether process completed, then restarts and repeats it.

Controls:
- existing `EXECUTING -> OUTCOME_UNKNOWN` recovery remains unchanged;
- no blind replay.

Acceptance:
- restart of a claimed job does not invoke execution port again.

### T11 — Browser request flooding fills durable state

Attack:
model/page or same-user caller creates many pending requests.

Controls:
- 8 live pending requests per exact session;
- 32 global live pending requests;
- at most one live request for exact caller/workspace/profile;
- fixed 60-second TTL;
- expiry sweep;
- limit checked before persistence.

Residual:
- bounded nuisance/DB churn remains possible for an admitted caller, but execution remains impossible without approval.

### T12 — Operator UI confused deputy / CSRF / clickjacking

Attack:
remote page causes operator approval or injects review HTML.

Controls reused from existing operator server:
- loopback bind;
- one-time bootstrap;
- HttpOnly SameSite=Strict cookie;
- per-session CSRF;
- exact Origin for POST;
- CSP;
- X-Frame-Options DENY;
- no-store;
- HTML escaping.

Additional:
- verify routes use server-generated ids;
- no approval URL/token returned through browser tools;
- review text clearly labels execution effect.

Acceptance:
- missing/wrong Origin/CSRF/session denied;
- hostile workspace/profile labels are escaped;
- framed operator UI denied.

### T13 — Operator cannot tell what will execute

Attack:
approval page shows ambiguous label while actual profile differs.

Controls:
- local review includes workspace identity, profile name, plan SHA-256, request fingerprint, expiration;
- current plan hash revalidated at approval;
- profile config is trusted local state.

Acceptance:
- rendered review corresponds exactly to stored request and plan hash.

### T14 — Internal job id becomes remote authority

Attack:
browser obtains job id and attempts direct coordinator/result calls.

Controls:
- browser request id is separate from internal job id;
- job id never appears in browser protocol/MCP result;
- public `job.*` absent.

Acceptance:
- serialized browser responses contain no `job_` identifier.

### T15 — Verification output leaks secrets or local roots

Attack:
test/build process prints environment secrets or backend details.

Controls:
- existing environment scrub remains mandatory;
- secret-like configured env keys denied;
- result max 64 KiB UTF-8;
- raw backend errors not propagated;
- request/job events contain no output, argv/env, roots, bearer values, or backend handles.

Acceptance:
- sentinel parent secrets do not appear in output/events;
- oversize output truncates deterministically.

### T16 — Non-zero test failure is confused with infrastructure failure

Attack:
model retries/re-executes because a failing test is treated as tool failure.

Controls:
- completed process with non-zero exit remains `SUCCEEDED` verify outcome with exit code;
- retries are model decisions requiring a new preview and new local approval.

Acceptance:
- fixture V1 baseline exits 1 and is returned as a completed verification result, not execution error.

### T17 — Browser v2 sessions silently gain v3 proposal authority

Attack:
existing v2 bearer/workspace is reused after upgrade.

Controls:
- new adapter id `browser.chatgpt.native.verify.v3`;
- protocol v3;
- exact adapter id in workspace/request authority tuple;
- v1/v2 discovery/protocol values rejected by v3.

Acceptance:
- v2 caller cannot create or read v3 requests.

### T18 — Browser proposal path mutates repository

Attack:
preview itself causes file/Git/process effects.

Controls:
- preview may read durable workspace metadata and trusted profile config only;
- no execution port call;
- no Git command required;
- no file mutation backend used.

Acceptance:
- fixture hash/status unchanged after preview/reject/expiry.

### T19 — Local operator approval is stolen by remote WebChat

Attack:
model obtains bootstrap URL, CSRF, cookie, or approval endpoint material.

Controls:
- operator bootstrap/session material is never placed in MCP/native result, telemetry, or repository;
- approval endpoint requires local authenticated operator session + Origin + CSRF;
- request fingerprint is not an approval credential.

Acceptance:
- browser-visible traces contain none of the operator secrets.

### T20 — Fully compromised same-user session

Attack:
malware under the user's account reads process memory, drives the local UI, tampers trusted config, or modifies WAG binaries.

Position:
- out of scope for v1 containment claim;
- do not claim this design is a sandbox against arbitrary same-user malware;
- code signing, install verification, least-authority local policy, and ordinary OS security reduce risk but do not establish hostile-same-user isolation.

## Security invariants

```text
NO_LOCAL_APPROVAL => NO_VERIFY_EXECUTION
REMOTE_CALLER_CANNOT_APPROVE = TRUE
DIRECT_BROWSER_VERIFY_RUN = ABSENT
MODEL_SUPPLIED_ARGV_ENV = IMPOSSIBLE
PROFILE_DRIFT_BEFORE_EXECUTION = FAIL_CLOSED
CROSS_CALLER_REQUEST_ACCESS = DENIED
APPROVAL_REPLAY = NO_SECOND_JOB
RESTART_BEFORE_CLAIM = NO_DELAYED_BROWSER_VERIFY
RESTART_AFTER_CLAIM = OUTCOME_UNKNOWN_NO_REPLAY
INTERNAL_JOB_ID_REMOTE = HIDDEN
OPERATOR_SECRET_REMOTE = HIDDEN
V2_TO_V3_AUTHORITY_UPGRADE = FORBIDDEN
ADR_0019_PROPOSAL_AUTHORITY_ONLY = ENFORCED
```

## Threat-model decision

The design is acceptable for implementation review only if the implementation preserves the separation:

```text
browser = propose + poll
local operator = approve/reject
WAG = validate + atomically create/dispatch
trusted profile = command authority
```

Any design change allowing the browser/model to approve, dispatch, supply argv/env, refresh approval, recover an old request under a new caller session, or invoke a generic process primitive requires a new threat-model review.
