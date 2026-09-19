# Browser Verify Approval v1 — Design

Date: 2026-09-19
Status: DRAFT DESIGN — implementation and production promotion are not authorized by this document
Decision authority: ADR-0016, ADR-0017, ADR-0018, ADR-0019
Depends on: Durable Verify Job Core v1, Trusted Adapter Admission v1, Browser Inspect v2 source implementation

## Purpose

Close the measured V1 named verify/build/test gap without granting the browser or model direct command-execution authority.

DC Replacement Workflow Benchmark v1 already established the Remote Desktop Commander V1 reference outcome. WAG already has:
- trusted named verify profiles;
- exact caller/workspace ownership;
- a durable verify-job core with bounded output and conservative restart semantics;
- a loopback-only local operator review service for durable mutation;
- Browser Inspect v2 read-only repository inspection.

The missing capability is a safe browser projection for requesting one configured verification and receiving its bounded result.

Browser Verify Approval v1 introduces a **proposal + local approval** flow. The browser may create an immutable request for one exact owned workspace and one explicitly browser-eligible trusted verify profile. It cannot execute that profile. Only a separate local operator approval may atomically create the internal durable verify job and permit dispatch.

## Measured product gap

This milestone advances:
- ADR-0018 Goal 1: replace Remote Desktop Commander on the selected WebChat -> local verify/build/test workflow;
- ADR-0018 Goal 2: give WebChat a bounded named verification outcome without raw shell/process authority.

Measured benchmark gap:

```text
V1_WAG = BLOCKED_CAPABILITY
CURRENT_REASON = verify.run is not projected through the browser profile
TARGET_OUTCOME = run one trusted named verification and return bounded evidence
RAW_SHELL_REQUIRED = NO
```

This design does not select Tier C mutation work and does not claim Tier R replacement.

## Trust facts

### Chrome Native Messaging

Chrome documents that:
- a native messaging manifest limits extension access through exact `allowed_origins`;
- Chrome starts the native host as a separate process and communicates over stdin/stdout;
- the native host receives the caller extension origin as its first argument;
- on Windows a service-worker caller receives `--parent-window=0`;
- content scripts share a renderer process with untrusted pages, so extension service workers must validate sender origin/URL and sanitize messages before forwarding them to native code.

Official source:
https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

These properties are useful provenance and routing evidence. They are not treated as an OS-level proof that no other same-user process can reach local WAG state.

### Windows local-process boundary

Windows documents that process/thread access is represented by access tokens and that named-pipe access checks compare the client's token with the pipe security descriptor/DACL. Processes launched for the same logged-on user commonly carry the same user security context unless a stronger isolation boundary is deliberately introduced.

Official sources:
- https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens
- https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works

Therefore Browser Verify Approval v1 does **not** claim that extension origin, a localhost bearer, a named-pipe DACL, parent process identity, window handle, PID, or same-user token is sufficient consequential authority.

## ADR-0019 authority decision

ADR-0019 resolves the previously open ADR-0017 successor question.

`verify.preview` creates durable WAG control-plane state, but ADR-0017 already permits `workspace.open` to persist caller-owned workspace records. ADR-0019 therefore makes the boundary explicit: bounded caller-owned proposal/control-plane writes may use the current same-user Browser admission when they have zero direct consequential effect and are resource-bounded.

ADR-0019 does **not** upgrade the Windows bootstrap into strong caller attestation. Direct verify execution, mutation, Git/process, browser mutation, publication, and equivalent consequential effects remain forbidden through the current Browser admission unless an independent accepted authority transition applies.

For Browser Verify Approval v1, that independent transition is exact local operator approval of the immutable proposal.

The architecture prerequisite is therefore satisfied, but this design still grants no implementation or production-promotion authority.

## Core decision

Under ADR-0019, the browser receives **proposal authority only**.

It does not receive direct execution authority.

The browser-visible verify surface is:

```text
verify.preview
verify.result
```

Direct browser `verify.run` remains absent.

The local operator channel is the only authority that can transition an approved request into an executable durable verify job.

## New adapter/profile identity

Browser Inspect v2 remains a distinct historical/read-only profile.

Browser Verify Approval v1 uses a new identity and wire revision:

```text
BROWSER_VERIFY_ADAPTER_ID = browser.chatgpt.native.verify.v3
BROWSER_VERIFY_PROTOCOL_VERSION = 3
```

The v3 browser surface is exactly:

1. `health`
2. `workspace.open`
3. `repo.search`
4. `repo.snapshot`
5. `file.read`
6. `verify.preview`
7. `verify.result`

The following remain absent:
- `verify.run`;
- public `job.*`;
- arbitrary argv/env;
- shell/process/PTY;
- Git writes;
- file mutation;
- browser mutation;
- generic backend forwarding.

Existing v1/v2 sessions and workspaces do not acquire v3 authority by upgrade side effect. A v3 workspace is owned by the v3 caller tuple.

## Verify-profile eligibility

Not every configured verify profile becomes browser-requestable.

Preserve the existing `VerifyProfile` schema and `planSha256` algorithm so previously persisted durable verify jobs do not drift merely because Browser Verify Approval exists.

Instead, v3 runtime configuration supplies a separate trusted allowlist conceptually equivalent to:

```ts
browserVerifyProfiles: readonly string[]; // default []
```

This is local trusted policy, never a browser/model argument. A browser request is accepted only when:
- the profile exists;
- its name is present in `browserVerifyProfiles`;
- the profile resolves through the existing trusted resolver;
- its effective plan satisfies all existing argv/env/timeout/output bounds;
- `resumeQueuedAfterRestart === false`.

Approval rechecks both current allowlist membership and the existing profile `planSha256`. Removing a profile from the allowlist invalidates a still-pending request even when command bytes did not change.

The final restart condition is deliberate. Browser-approved v1 work must not begin for the first time after a WAG restart. If approval created a queued internal job but WAG restarts before execution is claimed, existing Durable Verify Job Core recovery fails the queued job closed rather than dispatching it later.

The model never supplies argv, env, timeout, working directory, backend kind, restart policy, allowlist membership, or execution flags.

## Remote schemas

### `verify.preview`

Input:

```json
{
  "workspace_id": "opaque WAG workspace id",
  "profile": "trusted configured profile name"
}
```

No extra fields are accepted.

Output:

```json
{
  "status": "approval_required",
  "request_id": "verifyreq_<opaque>",
  "profile": "unit",
  "fingerprint": "<sha256>",
  "expires_at": 0
}
```

The output does not expose:
- owner/session/adapter ids;
- canonical root;
- argv/env;
- internal job id;
- backend workspace/session ids;
- operator bootstrap/session material.

### `verify.result`

Input:

```json
{
  "request_id": "verifyreq_<opaque>"
}
```

Result is fenced by the exact caller tuple that created the request.

Before dispatch, the result contains only request state and bounded public metadata. After local approval creates the internal job, the request view derives execution state from the linked job while keeping the internal job id hidden.

Conceptual result states:

```text
PENDING_APPROVAL
REJECTED
EXPIRED
INVALIDATED
QUEUED
EXECUTING
SUCCEEDED
FAILED
OUTCOME_UNKNOWN
```

For `SUCCEEDED`, return profile, exit code, bounded output, and truncation evidence. A non-zero verification exit code is still a successfully completed verification result, matching Durable Verify Job Core semantics.

Unknown request ids and wrong-owner request ids return the same bounded denial.

## Durable verify-request record

Add a dedicated request record; do not overload the existing verify-job state machine.

Conceptually:

```ts
interface BrowserVerifyRequestRecord extends GatewayAuthority {
  requestId: string;
  workspaceId: string;
  profileName: string;
  planSha256: string;
  fingerprint: string;
  state: 'PENDING_APPROVAL' | 'REJECTED' | 'EXPIRED' | 'INVALIDATED' | 'DISPATCHED';
  createdAt: number;
  reviewDeadline: number;
  approvedAt?: number;
  linkedJobId?: string; // internal only
  completedAt?: number;
  errorClass?: BrowserVerifyRequestErrorClass;
}
```

The request stores no argv, env values, canonical root duplication, provider conversation id, browser tab id, request payload text, backend handle, or operator credential.

Default review TTL is 60 seconds. It is fixed at creation and cannot be extended by polling, reconnect, re-preview, or repeated approval attempts.

## Fingerprint

The fingerprint is a domain-separated SHA-256 over immutable request facts, conceptually:

```text
browser-verify-v1
workspaceId
profileName
planSha256
requestId
```

Authority fields remain stored independently and are not returned to the browser. The fingerprint exists to make the local review visibly bind to one immutable request; it is not a bearer credential.

## Request creation

`verify.preview` performs, in order:

1. resolve the exact admitted v3 caller context;
2. load the durable workspace;
3. require exact owner/session/adapter equality;
4. resolve the named trusted profile;
5. require current trusted `browserVerifyProfiles` membership;
6. require `resumeQueuedAfterRestart === false`;
7. compute/store the effective plan hash;
8. enforce pending-request resource limits;
9. persist the immutable request before returning its id.

No execution port is called.

No internal verify job exists yet.

## Resource-abuse bounds

Proposal authority can still consume local durable state, so v1 must bound it.

At minimum:
- maximum 8 live pending verify requests per exact caller session;
- maximum 32 live pending browser verify requests globally;
- fixed 60-second review deadline;
- expired requests are terminal and sweepable;
- request ids are server-generated;
- one exact `workspace_id + profile + caller` may have at most one live pending request at a time;
- output/result polling cannot extend any deadline.

Exceeding a limit fails before persistence.

These limits protect WAG control-plane storage; they do not convert the browser into execution authority.

## Local operator review

Reuse the existing loopback-only operator server's transport/session security properties:
- bind only `127.0.0.1` / `::1`;
- one-time bootstrap token;
- `HttpOnly; SameSite=Strict` session cookie;
- exact Origin check for POST;
- per-session CSRF token;
- `Cache-Control: no-store`;
- restrictive CSP;
- `X-Frame-Options: DENY`;
- HTML escaping.

Do not create a generic "approve arbitrary capability" framework.

Extend the operator UI with verify-specific list/detail/actions, for example:

```text
/verifications/<request-id>
/verifications/<request-id>/approve
/verifications/<request-id>/reject
```

The local review page shows:
- canonical local workspace root or a local-safe workspace label;
- profile name;
- plan SHA-256;
- request fingerprint;
- created/review-expiry timestamps;
- a clear statement that approval will execute the configured named profile.

It does not render owner/session/adapter ids, raw bearer values, provider conversation data, env values, or browser-supplied HTML.

The operator bootstrap URL/session is never projected through MCP/native protocol/model-visible results.

## Approval and atomic job creation

Approval must not have a crash window that can create duplicate verify jobs.

A store operation conceptually equivalent to:

```text
approveVerifyRequestAndCreateJob(requestId, now, effectiveProfile)
```

must execute under one SQLite `BEGIN IMMEDIATE` transaction and:

1. load the request and require `PENDING_APPROVAL`;
2. require `reviewDeadline > now`;
3. load/validate the exact workspace ownership tuple;
4. require the current profile to exist and still be listed in trusted `browserVerifyProfiles`;
5. require the current plan hash to equal stored `planSha256`;
6. require `resumeQueuedAfterRestart === false`;
7. create exactly one internal `verify_jobs` row using the stored caller/workspace/profile facts;
8. append the existing verify-job `QUEUED` event;
9. set request state to `DISPATCHED`, record `approvedAt`, and link the internal job id;
10. commit once.

A concurrent/replayed approval cannot create a second job.

If workspace/profile/plan eligibility has drifted, no job is created and the request becomes `INVALIDATED` with a bounded error class.

After commit, the local coordinator calls existing `DurableVerifyJobCoordinator.dispatch(jobId)`.

The browser never calls `dispatch`.

## Reject and expiry

Local reject performs one terminal transition:

```text
PENDING_APPROVAL -> REJECTED
```

No job is created.

Expiry performs:

```text
PENDING_APPROVAL -> EXPIRED
```

No job is created.

Repeated reject/approve after a terminal transition returns conflict/false and never changes execution state.

## Crash and restart semantics

### Pending request

A `PENDING_APPROVAL` request may survive WAG restart until its original review deadline. It still requires a newly authenticated local operator session for approval. Restart does not refresh its deadline.

### Approved but not claimed

Approval atomically creates a normal Durable Verify Job Core `QUEUED` job. Browser-eligible profiles require `resumeQueuedAfterRestart=false`. Therefore a restart before claim causes existing verify-job reconciliation to fail the queued job before execution.

### Executing at restart

Existing Durable Verify Job Core behavior remains authoritative:

```text
EXECUTING -> OUTCOME_UNKNOWN
```

No blind replay occurs.

### Completed

Completed verify result remains durable and bounded. Browser retrieval still requires the original exact caller tuple.

Browser restart creates a new WAG session under the current admission contract and therefore does not inherit the old request/result authority.

## Browser/native protocol boundary

Protocol v3 adds only strict variants for:
- `verify.preview`;
- `verify.result`.

Extension-side filtering remains defense in depth. Server-side v3 MCP composition is the authorization source.

The content-script/page boundary remains untrusted. The service worker must continue validating the trusted ChatGPT page origin and strict request shape before forwarding. Repository/page text can propose a profile name only through the model/tool request; it cannot approve, dispatch, alter local policy, or supply command syntax.

## Result and telemetry bounds

Use existing Durable Verify Job Core result limits:
- persisted output maximum 64 KiB UTF-8;
- explicit `outputTruncated`;
- bounded closed error classes;
- no raw backend errors;
- no canonical root, argv/env, backend ids, bearer values, or unrelated authority tuple in remote results/events.

Add request lifecycle telemetry only with:
- operation name;
- request state transition;
- bounded duration/error class;
- correlation id suitable for diagnostics.

Do not log request fingerprints as credentials; they are non-secret evidence but do not need broad telemetry propagation.

## Production sequencing

This design can be implemented and source-tested independently of code signing, but production promotion remains separate.

A v3 native-host/browser candidate changes Browser Inspect v2 build inputs and therefore requires its own distribution/install/supported-host acceptance under the repository's existing native-host continuity rules.

Browser Inspect v2 Task 6 remains a historical blocked gate; this design does not retroactively mark it PASS.

A future exact v3 supported-host acceptance may re-prove the inherited inspect capabilities and then V1 on the **same exact accepted candidate**:

1. fresh R0;
2. fresh R1;
3. fresh R2;
4. local-approved V1;
5. security companion cases;
6. exact residue/cleanup verification.

Only after R0/R1/R2 complete may that candidate claim Tier R. Only after V1 completes through local approval may it claim Tier V.

## Expected implementation footprint

Design target only; implementation is not authorized here.

Likely additive files:
- `src/browser-verify-request.ts` — request coordinator and public request view;
- focused request/store/operator/browser tests.

Likely modified files:
- `src/durable-store.ts` — additive request table/events and atomic approval+job creation;
- trusted runtime/private-config composition — additive `browserVerifyProfiles` allowlist defaulting to empty, without changing existing verify `planSha256` semantics;
- `src/operator-server.ts` — verify-specific review routes/rendering while preserving mutation routes;
- browser adapter protocol/profile/native-link/runtime/extension allowlist — v3 identity and two proposal/result tools;
- server composition — exact v3 seven-tool surface.

Do not modify:
- DevSpace generic execution semantics;
- durable mutation state machine;
- default/private or Business tool inventory;
- dependency versions;
- raw shell/process APIs;
- release/signing/provider integration as part of this capability implementation.

Any implementation discovery requiring a generic process manager, OS service, elevation, browser automation, remote approval, or raw command input returns to design review.

## Non-goals

Browser Verify Approval v1 does not:
- attest the browser process cryptographically;
- treat Chrome caller origin as sufficient consequential authority;
- protect against an already fully compromised local user session;
- expose direct `verify.run`;
- expose public jobs/cancellation;
- add arbitrary command/env input;
- enable mutation or Git writes;
- enable browser automation/mutation;
- change provider account identity;
- alter SignPath/release state.

## Decision markers

```text
MILESTONE = BROWSER_VERIFY_APPROVAL_V1
GOAL_1_DELTA = CLOSE_V1_VERIFY_BUILD_TEST_GAP
GOAL_2_DELTA = LOCALLY_APPROVED_NAMED_VERIFICATION
ADAPTER_ID = browser.chatgpt.native.verify.v3
WIRE_PROTOCOL = 3
TOOL_COUNT = 7
BROWSER_EXECUTION_AUTHORITY = NONE
BROWSER_PROPOSAL_AUTHORITY = BOUNDED_VERIFY_REQUEST_ONLY
DIRECT_BROWSER_VERIFY_RUN = FORBIDDEN
REMOTE_APPROVAL = FORBIDDEN
LOCAL_OPERATOR_APPROVAL = REQUIRED
TRUSTED_BROWSER_PROFILE_ALLOWLIST = REQUIRED
BROWSER_PROFILE_RESUME_AFTER_RESTART = FORBIDDEN
INTERNAL_JOB_ID_REMOTE_EXPOSURE = FORBIDDEN
SHELL_PROCESS_PTY_GIT_MUTATION = NOT_EXPOSED
ADR_0017_SUCCESSOR_DECISION = SATISFIED_BY_ADR_0019
ADR_0019_PROPOSAL_AUTHORITY = ACCEPTED
IMPLEMENTATION_AUTHORITY = NOT_GRANTED_BY_THIS_DOCUMENT
PRODUCTION_PROMOTION = REQUIRES_SEPARATE_ACCEPTANCE
```
