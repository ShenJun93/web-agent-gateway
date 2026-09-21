# Goal Lease / OSS Reuse Reconciliation — 2026-09-21

Status: architecture reconciliation after P0 canonical closure  
Canonical base: `40d9c33d25c56317d247e2a659fac0ed4f003f2d`  
Decision source: ADR-0028 + accepted P0 implementation/evidence on `main`

## Decision

P0 remains accepted as implemented. Do **not** reopen or retrofit the accepted Goal Lease implementation merely because broader governance/runtime projects exist.

Goal Lease v1 remains WAG's local representation of bounded human delegation. Its job is narrow:

- bind a human-granted goal to exact local workspace/session/adapter/tool/path/budget/time constraints;
- let WAG record deterministic local policy admission as `POLICY_APPROVED`;
- preserve exact local effect fencing, CAS, restart/recovery and durable evidence;
- keep no-lease behavior identical to the manual `HUMAN_APPROVED` path.

Goal Lease is **not** a universal agent-authorization protocol, a provider credential, an MCP session, or an agent runtime policy language.

## Reuse boundary

### Microsoft Agent Governance Toolkit / ACS

ACS is a candidate **policy-decision dependency or adapter**, not WAG's authority owner.

Potentially reusable/aligned concepts:

- canonical action identity / action binding;
- deterministic policy verdicts;
- approval/evidence identity;
- policy versioning and decision evidence;
- fail-closed escalation.

WAG must retain:

- workspace/repository ownership;
- file/base-hash/HEAD CAS;
- immutable local effect plans;
- exact mutation/commit execution;
- local Goal Lease lifecycle and revocation;
- durable effect/result evidence;
- provider-neutral locally minted authority IDs.

No ACS integration is required for P1 read/verify acceptance.

Primary source:
- https://github.com/microsoft/agent-governance-toolkit

### NVIDIA OpenShell / Microsoft MXC

OpenShell/MXC are runtime/containment candidates for later P2/P3 work. They do not replace Goal Lease or WAG's exact repo/Git effect semantics.

No OpenShell/MXC dependency is introduced into P0 or P1 S1.

Primary sources:
- https://github.com/NVIDIA/OpenShell
- https://github.com/microsoft/mxc

### Emerging OAuth agent authorization

Current OAuth work recognizes delegated automated agents and operation-scoped authorization, but the relevant documents are still evolving drafts.

Goal Lease should remain local now while keeping concepts mappable to future standards:

```text
principal / represented subject
agent or workload
goal / task
operations
resources
constraints
not-before / expiry
revocation
delegation/fencing generation
evidence reference
```

Do not wait for a future Internet standard before using the accepted local mechanism.

Primary sources:
- https://datatracker.ietf.org/doc/charter-ietf-oauth/
- https://datatracker.ietf.org/doc/html/draft-liu-agent-operation-authorization-02
- https://datatracker.ietf.org/doc/html/draft-chen-oauth-agent-authz-use-cases-03

## Transport and provider invariant

```text
provider intent != authority
transport identity != authority
conversation/session correlation != authority
```

ChatGPT, Claude, Codex, Gemini, local agents, MCP transports and tunnel IDs may contribute correlation evidence only. WAG mints and owns local session/workspace/effect authority.

A caller must never be able to assert:

- `HUMAN_APPROVED`;
- `POLICY_APPROVED`;
- owner id;
- trusted adapter id;
- Goal Lease issuance or widening.

## Goal Lease issuance

Lease creation remains out-of-band and human-controlled.

No MCP tool may create, widen, renew or replace a lease. The model/provider may use a configured lease but may not issue one.

For P1 S1, **no Goal Lease is configured at all**. The first ChatGPT direct-access acceptance is read/verify only.

## Residual v1 limitations

### One commit per lease

Keep the existing fail-closed HEAD CAS behavior. Do not weaken it.

If a later milestone needs a multi-commit goal, design an explicit trusted local lease-fence advancement:

```text
bound HEAD A
  -> accepted commit produces B
  -> trusted local authority advances fence A -> B
  -> next bounded commit may target B
```

This is a new authority transition and requires its own review and acceptance. It is not part of P1 S1.

### Browser Run remains human

Browser Run is the transition from untrusted page content into a proposal. A lease may remove Approve after that proposal exists, but must not silently turn arbitrary page text into authority.

The private stdio surface is the correct gesture-free surface because the structured caller proposes directly.

## P1 transport staging after plan check

The current operator plan is ChatGPT Plus. As of 2026-09-21, OpenAI's official ChatGPT developer-mode documentation lists apps/full MCP/developer mode for Business and Enterprise/Edu, and separately notes a Pro read/fetch exception. Plus is not listed as an eligible custom-MCP/developer-mode plan.

Therefore P1 is staged instead of assuming an immediate Business upgrade:

```text
P1A = PLUS_BROWSER_VALUE_PROOF
P1B = BUSINESS_SECURE_MCP_DIRECT_CUTOVER
BUSINESS_UPGRADE = CONDITIONAL_ON_P1A_VALUE
```

P1A uses the already-accepted browser/native WAG path to measure whether WAG is useful enough to replace Desktop Commander for supported work. P1B preserves Secure MCP Tunnel + direct stdio as the preferred structured-provider path if the operator later upgrades to Business.

This does not change the P0 Goal Lease design. P1A intentionally measures the remaining browser gestures; P1B is where the already-proven stdio Goal Lease path can eventually remove those transport-specific gestures.

Current primary source:
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

## Reconciliation result

```text
P0_GOAL_LEASE = KEEP
GENERIC_POLICY_ENGINE = DO_NOT_EXPAND
ACS = BENCHMARK/WRAP_LATER
OPENSHELL_MXC = RUNTIME_BENCHMARK_LATER
OAUTH_AGENT_AUTH = ALIGN_SEMANTICS_LATER
P1A_PLUS = BROWSER_NATIVE_VALUE_PROOF
P1B_BUSINESS = SECURE_MCP_STDIO_DIRECT
BUSINESS_UPGRADE = CONDITIONAL_ON_MEASURED_VALUE
P0_REOPEN_REQUIRED = FALSE
```
