# ADR-0019: Separate Browser Proposal Authority from Consequential Execution Authority

Date: 2026-09-19
Status: Accepted
Depends on: ADR-0014, ADR-0015, ADR-0016, ADR-0017, ADR-0018
Design: `docs/superpowers/specs/2026-09-19-browser-verify-approval-v1-design.md`
Threat model: `docs/research/2026-09-19-browser-verify-approval-v1-threat-model.md`
Acceptance plan: `docs/superpowers/plans/2026-09-19-browser-verify-approval-v1-acceptance.md`

## Context

ADR-0017 accepted the current Windows Browser Adapter admission path only for a server-enforced read-only capability profile because the discovery/bootstrap secret lives in the same-user local trust domain rather than behind a strong OS application-isolation boundary.

ADR-0018 therefore kept direct browser `verify.run`, durable mutation, Git, process, browser-mutation, and equivalent consequential capabilities blocked pending a stronger admission/isolation design.

Browser Inspect v2 subsequently expanded the read/inspect surface while preserving that direct-effect boundary.

The next measured product gap is named verify/build/test. Browser Verify Approval v1 proposes a narrower decomposition than granting direct verify execution:

```text
browser -> create bounded verify proposal
local operator -> review/approve exact proposal
WAG -> atomically create and dispatch internal durable verify job
browser -> poll bounded result
```

The architectural question is whether the current same-user Browser admission may create a bounded proposal/control-plane record even though it must not directly execute the verification.

## Existing precedent

ADR-0017 already permits `workspace.open` on the accepted Browser profile, and `workspace.open` persists a durable WAG workspace record owned by the exact caller tuple.

Therefore "read-only Browser profile" has never meant "zero writes to WAG's internal control-plane database." It means the admitted browser cannot directly produce consequential repository, process, Git, browser, publication, or equivalent machine effects.

This ADR makes that distinction explicit.

## Decision

WAG defines two different browser authority classes.

### 1. Non-consequential proposal/control-plane authority

The current same-user Browser admission MAY create narrowly bounded WAG-owned control-plane records when all of the following are true:

- the record is owned by the exact validated `owner_id + session_id + adapter_id` caller tuple;
- creation does not execute a process or command;
- creation does not modify repository/workspace contents;
- creation does not produce Git, browser, network-publication, device, credential, or external-service effects;
- the record cannot itself be consumed as an execution credential;
- the record has a fixed bounded lifetime where applicable;
- creation is rate/resource bounded;
- caller/model input cannot select or override WAG authority fields;
- any later consequential transition requires a separate accepted authority source;
- stale, foreign, replayed, or over-limit records fail closed.

Browser Verify Approval v1's immutable `verify.preview` request is an allowed example of this class when it satisfies its reviewed design and acceptance gates.

Existing durable browser workspace ownership records remain allowed under the same distinction.

### 2. Consequential authority

The current same-user Browser admission MUST NOT directly authorize:

- verify/build/test execution;
- shell/process/PTY execution or control;
- file/repository mutation;
- Git writes or publication;
- browser mutation/automation as a production capability;
- network publication or deployment;
- device/system administration;
- credential/signing operations;
- generic backend forwarding that could produce equivalent effects.

For Browser Verify Approval v1, the browser may propose and poll only. It may not approve or dispatch.

A separate local operator approval is the required authority transition before WAG may atomically create and dispatch the internal durable verify job.

## Local operator authority

The local operator channel is independent from the browser proposal channel.

For a browser-originated proposal to cause verification execution:

1. the proposal must still be live and owned by its original exact caller tuple;
2. the current trusted local verify policy must still authorize the named profile;
3. the current profile plan must still match the immutable proposal;
4. a locally authenticated operator session must explicitly approve the exact proposal;
5. approval and internal job creation must be atomic and single-use;
6. execution must pass the existing Durable Verify Job Core validation immediately before claim/dispatch.

The browser/model cannot receive, synthesize, refresh, or replay operator authority.

The request id and proposal fingerprint are correlation/review evidence only. Neither is an approval credential.

## Browser Verify Approval v1 consequence

ADR-0019 satisfies the architecture-decision prerequisite identified by the Browser Verify Approval v1 design.

It authorizes the **architecture class**:

```text
same-user Browser admission
  -> bounded caller-owned proposal creation
  -> independent local operator approval
  -> existing WAG-owned consequential execution core
```

It does not authorize implementation by itself.

Browser Verify Approval v1 implementation still requires a separately authorized implementation milestone and must satisfy its source/security acceptance plan.

Production promotion still requires exact-candidate native-host distribution, installation/registration, supported-host reacceptance, fresh R0/R1/R2 evidence, and locally approved V1 evidence.

## Bootstrap and isolation interpretation

This ADR does not upgrade the current Windows bootstrap into strong caller attestation.

Chrome Native Messaging extension provenance, caller origin, localhost bearers, PID/parent-process identity, Windows user tokens, and ordinary same-user IPC remain insufficient by themselves for direct consequential authority.

The accepted claim is narrower:

```text
CURRENT_BOOTSTRAP = SAME_USER_PROVENANCE_AND_ADMISSION
PROPOSAL_CONTROL_PLANE_WRITES = ALLOWED_WHEN_BOUNDED
DIRECT_CONSEQUENTIAL_EFFECT = FORBIDDEN
```

A fully compromised same-user account remains outside the containment claim. This ADR does not present the current architecture as a hostile-same-user sandbox.

## Stronger isolation remains a future gate

A future design that wants the browser admission itself to directly authorize consequential effects without independent local operator approval requires a separately accepted stronger isolation/admission decision.

Candidate mechanisms may include a stronger OS principal/broker/service boundary, AppContainer-style isolation, another independently authenticated local authority, or a different reviewed mechanism. This ADR does not select among them.

Do not add Windows services, elevation, AppContainer packaging, service SIDs, custom brokers, or new IPC solely because Browser Verify Approval v1 can be safely decomposed into proposal + local approval.

If a future measured workflow cannot be satisfied under that decomposition, stronger isolation may then be justified on evidence.

## Resource and abuse boundary

Non-consequential does not mean unbounded.

Every browser proposal capability must define explicit resource limits appropriate to its state.

For Browser Verify Approval v1, the reviewed design requires at minimum:

- a fixed review TTL;
- a per-session live-pending limit;
- a global live-pending limit;
- at most one live request for the same exact caller/workspace/profile;
- server-generated opaque ids;
- no deadline extension through polling, reconnect, re-preview, or repeated approval;
- terminal expiry/reject/invalidation semantics.

Exceeding the limit fails before persistence.

These limits are part of the authority decision because uncontrolled durable-state creation could otherwise become a local availability problem even without process execution.

## Capability-profile versioning

Adding proposal authority changes the Browser capability profile even though it does not grant direct consequential effects.

Therefore Browser Verify Approval v1 uses its separately reviewed adapter/protocol identity:

```text
browser.chatgpt.native.verify.v3
protocol 3
```

Existing v1/v2 sessions, bearers, workspaces, and adapter identities do not silently acquire v3 proposal authority.

Capability authorization remains server-side. Extension/native filtering remains defense in depth only.

## Failure and recovery requirements

Proposal authority must remain fail-closed across restart and race conditions.

At minimum:

- pending proposal deadlines are not refreshed by restart;
- local approval is single-use;
- approval and internal job creation are one atomic transaction;
- browser-approved verify profiles cannot begin for the first time after restart unless a future reviewed policy explicitly changes that rule;
- a claimed execution whose outcome cannot be proven remains `OUTCOME_UNKNOWN`;
- no browser retry can reuse old local approval authority.

These requirements preserve ADR-0014 and ADR-0016 ownership/recovery contracts.

## Security invariants

```text
BROWSER_PROPOSAL_STATE_WRITE = BOUNDED_AND_CALLER_OWNED
BROWSER_DIRECT_VERIFY_EXECUTION = FORBIDDEN
BROWSER_REMOTE_APPROVAL = FORBIDDEN
LOCAL_OPERATOR_APPROVAL_FOR_VERIFY = REQUIRED
NO_LOCAL_APPROVAL => NO_VERIFY_EXECUTION
DIRECT_BROWSER_PROCESS_GIT_MUTATION_BROWSER_AUTHORITY = FORBIDDEN
CURRENT_BOOTSTRAP_STRONG_ATTESTATION = NOT_CLAIMED
V1_V2_AUTHORITY_UPGRADE_TO_V3 = FORBIDDEN
STRONGER_ISOLATION_FOR_DIRECT_CONSEQUENTIAL_BROWSER_AUTHORITY = REQUIRED
```

## Relationship to prior ADRs

ADR-0019 refines the browser "read-only" wording in ADR-0017 by separating internal bounded proposal/control-plane writes from consequential effects.

It does not weaken ADR-0017's caller-identity, credential-class, workspace-ownership, bootstrap, Host/Origin, persistence, or fail-closed rules.

It does not weaken ADR-0018's consequential Browser Adapter gate. Direct consequential browser authority remains blocked.

For the narrow Browser Verify Approval v1 architecture, ADR-0019 satisfies the previously unresolved successor-decision gate because local operator approval remains the authority source for execution.

## Non-goals

This ADR does not authorize:

- Browser Verify Approval v1 implementation;
- direct browser `verify.run`;
- mutation projection;
- public `job.*`;
- arbitrary argv/env;
- shell/process/PTY;
- Git writes;
- browser automation/mutation;
- provider-specific authority;
- dependency/SDK migration;
- native-host installation or registry mutation;
- release/tag/signing/provider changes;
- Windows service/elevation/AppContainer migration.

## Decision markers

```text
ADR_0019 = ACCEPTED
CURRENT_BROWSER_BOOTSTRAP = SAME_USER_LOCAL_TRUST
BOUNDED_PROPOSAL_AUTHORITY = ACCEPTED
BOUNDED_CONTROL_PLANE_WRITES = ACCEPTED
DIRECT_CONSEQUENTIAL_BROWSER_AUTHORITY = FORBIDDEN
LOCAL_OPERATOR_EFFECT_APPROVAL = REQUIRED
STRONGER_ISOLATION_FOR_DIRECT_EFFECTS = REQUIRED
BROWSER_VERIFY_APPROVAL_V1_ARCHITECTURE_GATE = SATISFIED
BROWSER_VERIFY_APPROVAL_V1_IMPLEMENTATION = NOT_AUTHORIZED_BY_THIS_ADR
```
