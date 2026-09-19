# ADR-0020: Make the Private Stdio Surface the DC Replacement Repository-Engineering Surface

Date: 2026-09-19
Status: Accepted
Depends on: ADR-0003, ADR-0008, ADR-0009, ADR-0011, ADR-0014, ADR-0015, ADR-0017, ADR-0018, ADR-0019
Design: `docs/superpowers/specs/2026-09-19-wag-dc-replacement-v1-design.md`
Research: `docs/research/2026-09-19-wag-dc-replacement-v1-surface-selection.md`
Acceptance plan: `docs/superpowers/plans/2026-09-19-wag-dc-replacement-v1-acceptance.md`
Measured gap: `docs/benchmarks/2026-09-17-dc-replacement-live-benchmark-v1-attempt-1.md`

## Context

ADR-0018 commits WAG to replacing Remote Desktop Commander on selected WebChat -> local development workflows.
The DC Replacement Workflow Benchmark v1 measured which workflows those are: R0 bounded read, R1 repository discovery,
R2 repository state, V1 named verification, C1 reviewed existing-file change, D1 integrated coding loop. DC completed
all six. WAG completed none of R1..D1 on the Browser Adapter at that time.

Browser Inspect v2 and Browser Verify Approval v1 closed R1, R2 and V1 for the browser path. ADR-0018 and ADR-0019
deliberately leave Tier C and Tier D unreachable there: direct consequential browser authority stays forbidden until a
stronger isolation/admission decision exists, and ADR-0019 explicitly declines to select one.

That leaves an unresolved question. WAG cannot become the primary repository-engineering operator if the only surface
being extended is the one surface that is architecturally barred from the last two tiers.

The research receipt establishes the answer already exists in the codebase. On the private/Business stdio surface:

- `repo.search` is implemented in `src/repository-inspection.ts` and already accepted on both browser profiles, but is
  not registered on stdio at all;
- `mutation.preview` / `mutation.result` and the whole `DurableMutationCoordinator` + operator review path are
  implemented and accepted, but are assembled only inside a test fixture and are unreachable in production.

## Decision

The **private/Business stdio surface is WAG's DC replacement repository-engineering surface.** The Browser Adapter
remains an inspect-and-propose surface only.

### 1. Surface assignment

```text
Browser Adapter (v2 inspect, v3 verify)  -> inspect, search, snapshot, read, verify proposal + result
Private / Business stdio                 -> the full repository-engineering loop, DC replacement target
```

Tier C and Tier D claims are made on the private stdio surface or not at all. No part of this ADR grants the browser
any authority it does not already hold, and the browser tool lists, adapter ids and protocol revisions are unchanged.

### 2. Extended stdio capability profile

When, and only when, the local private configuration explicitly opts in, the private stdio surface may additionally
expose:

```text
repo.search        (read-only; identical semantics and bounds to the accepted browser projection)
mutation.preview   (consequential; local operator approval required before any write)
mutation.result    (read-only view of a durable mutation record)
```

### 3. Default-deny is preserved literally

Absent configuration, `serve-stdio` exposes exactly the five accepted tools:

```text
health, workspace.open, repo.snapshot, file.read, verify.run
```

The shipped default is unchanged, and the existing Business stdio five-tool acceptance remains true byte-for-byte.
Opt-in is a local file the operator writes; it can never be requested by the model, the provider, the transport, or
repository content.

### 4. Mutation authority is unchanged, only reachable

Projecting `mutation.preview` onto stdio does **not** create a new authority class. Every existing invariant holds
without relaxation:

- a preview persists an immutable durable record and performs no write (ADR-0011);
- a separate, locally authenticated operator session must approve the exact record before any backend call (ADR-0008);
- approval is single-use and TTL-bounded (ADR-0009);
- the caller tuple is WAG-generated and validated, never supplied by the model (ADR-0015);
- the executor boundary and bounded-effect contract are untouched (ADR-0003, ADR-0014).

The MCP caller can propose and can read state. It cannot approve, cannot dispatch, and cannot discover the operator
channel: the operator bootstrap URL, session cookie and CSRF token are never present in any MCP response.

### 5. Caller identity for the stdio path

The stdio caller context is derived locally and is not negotiable by the client:

- `ownerId` comes from local configuration;
- `sessionId` is generated fresh per gateway process and is never reused across restarts;
- `adapterId` is the fixed literal for this surface;
- no field may be read from tool arguments, transport metadata, environment supplied by the client, or repository text.

A restarted gateway is a new session. It inherits no pending approval authority.

## Why this is not authority widening

The mission guardrails forbid promoting a capability without a measured workflow gap and an acceptance test, and forbid
copying a competitor's tool catalogue.

- The gap is measured, dated and specific: R1 and C1 on the production path, with D1 following from them.
- No new execution primitive is added. `repo.search` and durable mutation already exist, are already reviewed, and are
  already covered by tests.
- No new dependency, transport, listener, elevation, service, or OS boundary is introduced.
- The extension is deliberately *narrower* than DC. WAG still exposes no shell, no process control, no PTY, no
  arbitrary argv, no directory creation, no file move/delete, no Git writes, no runtime configuration mutation, and no
  ambient filesystem reach. DC exposes all of those.

The reuse order is satisfied at the top: this is COMPOSE over existing accepted parts, not BUILD.

## Why the provider prompt is not the boundary

Current OpenAI documentation states that ChatGPT requires manual confirmation before write actions, that read-only
annotations may cause approval to be skipped, and that "it is possible for write actions to occur even if the MCP
server has tagged the action as read only, making it even more important that you trust the custom MCP server."

The provider therefore explicitly places the trust burden on the MCP server. WAG's local operator approval is the only
boundary enforced on this machine, and it remains mandatory regardless of what any provider-side confirmation does.

Upstream Remote Desktop Commander states the converse position for itself: its controls are "safety guardrails that
reduce accidental or unintended actions, not a security sandbox", `allowedDirectories` "only restricts filesystem
operations, not terminal commands", and it "does not protect against a compromised AI account or prompt injection
reaching a trusted client".

WAG's replacement claim rests on that difference and on equal workflow outcomes. It does not rest on breadth.

## Consequences

Accepted:

- WAG may be locally production-accepted as the primary repository-engineering operator on a machine where the extended
  stdio profile is configured and its acceptance evidence has been produced.
- Tier C and Tier D may be claimed from private stdio evidence, recorded as such, and must never be presented as
  Browser Adapter tiers.
- The Business stdio five-tool default and its acceptance test remain authoritative for the unconfigured case.

Not accepted by this ADR:

- any browser authority change, adapter id change, or protocol revision;
- shell, process, PTY, Git write, directory create/move/delete, or configuration-mutation tools on any surface;
- remote or model-driven approval on any surface;
- removing, weakening, or deferring the local operator approval;
- exposing internal job or mutation backend identifiers remotely;
- native-host, registry, release, tag, signing, or provider actions;
- any claim of containment against a fully compromised same-user account.

## Security invariants

```text
DC_REPLACEMENT_SURFACE = PRIVATE_STDIO
BROWSER_TIER_C_D = FORBIDDEN
STDIO_DEFAULT_PROFILE = FIVE_TOOLS_UNCHANGED
EXTENDED_PROFILE = LOCAL_CONFIG_OPT_IN_ONLY
MODEL_SELECTABLE_AUTHORITY = NONE
MUTATION_WITHOUT_LOCAL_APPROVAL = FORBIDDEN
APPROVAL_SINGLE_USE = REQUIRED
CALLER_TUPLE_SOURCE = WAG_LOCAL_ONLY
SESSION_ID_PER_PROCESS = REQUIRED
OPERATOR_CREDENTIALS_IN_MCP_RESPONSE = FORBIDDEN
NEW_EXECUTION_PRIMITIVE = NONE
SHELL_PROCESS_PTY_GIT_WRITE = STILL_FORBIDDEN
HOSTILE_SAME_USER_SANDBOX = NOT_CLAIMED
```

## Decision markers

```text
ADR_0020 = ACCEPTED
MEASURED_GAP_SOURCE = DC_REPLACEMENT_BENCHMARK_V1
CAPABILITY_ORIGIN = EXISTING_ACCEPTED_COMPONENTS
AUTHORITY_WIDENING = NONE_BEYOND_SURFACE_PROJECTION
IMPLEMENTATION_AUTHORIZED_BY_THIS_ADR = NO
ACCEPTANCE_PLAN_REQUIRED = YES
PRODUCTION_LOCAL_EVIDENCE_REQUIRED = YES
SUPPORTED_HOST_WEBCHAT_EVIDENCE = SEPARATE_LATER_GATE
```
