# AI-Native OSS Reuse Audit — 2026-09-21

**Status:** research / architecture decision support only  
**Scope:** WAG + P1/P2/P3 + future personal AI control plane  
**Decision posture:** reuse-first; no implementation authority is widened by this document.

## Executive decision

The program should **not** build an “AI-native OS” as a monolithic new runtime.

Most horizontal primitives already exist in open source or open standards:

- agent/tool transport: MCP;
- agent/client protocol: ACP;
- agent/agent protocol: A2A;
- agent/user event protocol: AG-UI;
- coding-agent workbench/control surface: OpenHands Agent Canvas and goose;
- agent runtime/sandbox: NVIDIA OpenShell;
- cross-platform execution containment: Microsoft MXC;
- deterministic policy/governance: Microsoft Agent Governance Toolkit / Agent Control Specification (ACS);
- MCP server isolation/gateway: ToolHive;
- agent scheduling/context/memory research: AIOS;
- durable orchestration: LangGraph and general durable-workflow systems.

The architectural gap that remains useful for this program is narrower:

> a provider-independent **personal AI control plane** that binds human intent to local, bounded, durable authority and safely projects that authority into exact local effects.

WAG should therefore become **slimmer**, not broader.

Its strongest durable responsibilities are:

1. exact local workspace/repository ownership;
2. bounded semantic effects;
3. immutable effect/action binding;
4. filesystem/Git/base-hash/HEAD CAS and stale-target rejection;
5. local Goal Lease representation;
6. deterministic execution fencing;
7. effect/result evidence and restart reconciliation;
8. provider-neutral local authority.

Generic agent UI, generic scheduling, generic sandboxing, generic MCP gateway, generic policy language, generic agent-to-agent protocol, and generic cross-platform containment should not be reimplemented unless a benchmark proves a concrete upstream gap.

---

# 1. Verdict vocabulary

| Verdict | Meaning |
|---|---|
| **REUSE** | Use the upstream protocol/project as the default implementation or standard. Do not create a competing subsystem. |
| **WRAP** | Keep a thin local adapter because the upstream primitive does not own WAG authority. |
| **KEEP** | WAG/program-specific semantics remain justified. |
| **BENCHMARK** | Strong upstream candidate, but maturity/security/fit must be empirically proven before dependency adoption. |
| **DEFER** | Do not build now. Re-open only when a real requirement appears. |
| **DELETE-DESIGN** | Remove the planned custom subsystem from the roadmap unless upstream falsification later justifies it. |

---

# 2. Reuse matrix

| Subsystem | Current candidate | Verdict | Program consequence |
|---|---|---|---|
| Model/provider access | provider-native clients/APIs | **WRAP** | Provider is intent/planning, never local authority. |
| ChatGPT local ingress | OpenAI Secure MCP Tunnel | **REUSE** | P1 does not build a public/local transport bridge. |
| Tool protocol | MCP 2026-07-28+ | **REUSE** | Do not invent another general agent↔tool protocol. |
| Long-running MCP operations | MCP Tasks extension | **REUSE where applicable** | Use for tool-call async lifecycle, not as WAG authority or exact-effect state. |
| Coding client↔agent | ACP | **REUSE** | Do not invent a client↔coding-agent protocol. |
| Agent↔agent collaboration | A2A | **DEFER / REUSE when needed** | No custom inter-agent protocol. Add only when independent agents actually collaborate. |
| Agent↔human UI events | AG-UI | **DEFER / REUSE for custom UI** | If a custom UI is later justified, prefer AG-UI-compatible state/events. |
| Native/general AI workbench | goose | **BENCHMARK** | Candidate user-facing client; not authority boundary. |
| Multi-agent engineering control center | OpenHands Agent Canvas | **BENCHMARK** | Candidate primary workbench before custom native UI. |
| Generic agent OS/kernel scheduling | AIOS | **REFERENCE / DEFER** | Do not adopt as security/control plane; do not duplicate scheduler abstractions now. |
| Generic durable orchestration | LangGraph / equivalent | **WRAP / DEFER** | Useful above WAG for long-running coordination, never for effect authorization. |
| Deterministic policy engine | Microsoft AGT / ACS | **BENCHMARK then WRAP** | Avoid growing WAG into a general policy framework. |
| Action-bound approval semantics | ACS ActionBinding / enforced identity | **ADAPT** | Align WAG effect binding with canonicalized action identity where compatible. |
| Human delegation / Goal Lease | WAG local Goal Lease + emerging OAuth agent auth work | **KEEP + ALIGN** | Keep local authority now; design claims so future standards mapping is possible. |
| Agent runtime/sandbox | NVIDIA OpenShell | **BENCHMARK** | Default challenger for P2/P3 runtime; custom runtime becomes fallback. |
| Cross-platform containment | Microsoft MXC | **BENCHMARK** | Do not create another sandbox abstraction first. Current preview is not yet trusted as security boundary. |
| MCP server runtime/gateway | ToolHive | **REUSE selectively** | Use for third-party MCP servers; do not replace WAG’s repo/Git authority semantics. |
| Secrets for sandboxed providers | OpenShell providers / OS stores / ToolHive providers | **REUSE** | No new generic secret store. |
| Filesystem/network sandbox policy | OpenShell / MXC / ToolHive profiles | **REUSE after acceptance** | Delete custom cross-platform policy implementation from near-term roadmap. |
| Process-tree containment | OpenShell backend / native OS primitives / MXC | **REUSE** | No process-name scanning; custom supervisor only if benchmark proves necessary. |
| Browser automation | Playwright + isolated profiles | **REUSE** | Browser is an execution adapter, not authority. |
| Terminal/PTY | OS-native PTY / existing agent surfaces | **REUSE** | Do not build a terminal emulator as an authority subsystem. |
| Repo search/read | WAG semantic tools | **KEEP** | Provider-neutral bounded local semantic surface remains useful. |
| File mutation | WAG durable mutation | **KEEP** | Exact candidate/base/result binding is a differentiator. |
| Verify | WAG verify profiles | **KEEP** | Trusted allowlisted local verification remains program-specific. |
| Git status/diff/commit | future bounded WAG Git semantics | **KEEP** | Strong fit for exact repo authority; never raw generic shell/Git proxy. |
| Push/PR/release/signing/provider actions | separate explicit gates | **KEEP SEPARATE** | Never inherit broad Goal Lease authority by default. |
| Audit | ACS decision + WAG effect + runtime event envelope | **WRAP/KEEP** | Standardize correlation/evidence envelope; do not collapse decision and execution evidence. |
| Multi-session identity | WAG logical IDs | **KEEP** | Transport/provider IDs stay correlation only. |
| Common P2/P3 semantic contract | existing COMMON report | **KEEP, narrow** | Keep semantics; do not create a shared executable portable core yet. |
| New portable core repo (P4) | none | **DEFER** | Still not justified. |

---

# 3. Upstream findings and implications

## 3.1 MCP: transport/session should not carry authority

MCP 2026-07-28 moved to a stateless core. It removed the protocol-level initialize/session requirement and explicitly recommends application state through explicit handles when needed. The Tasks extension provides durable asynchronous tool-call state with get/update/cancel semantics.

**Implication**

- WAG must continue minting its own owner/session/workspace/effect IDs.
- `Mcp-Session-Id`, transport connection identity, provider conversation IDs, and request IDs must never become Goal Lease authority.
- WAG should project semantic tools over MCP, not duplicate MCP.
- MCP Tasks may carry long-running verify/tool execution handles, but WAG still owns exact effect authorization and recovery semantics.

Evidence:
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks

## 3.2 ACP: coding-client integration is already becoming a standard

ACP explicitly standardizes communication between code editors/clients and coding agents. The stable wire protocol is versioned independently of SDK/schema releases.

goose can already run as an ACP agent. OpenHands Agent Canvas can launch Claude Code, Codex, Gemini CLI, or other ACP agents.

**Implication**

A future native workbench should not define another private editor↔agent protocol. If WAG needs a desktop/control-surface integration, either:

1. sit below an ACP agent as authority/effect backend; or
2. expose a thin adapter that lets ACP-compatible clients use WAG-governed agents.

Evidence:
- https://github.com/agentclientprotocol/agent-client-protocol
- https://github.com/aaif-goose/goose
- https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents

## 3.3 A2A: reserve it for real independent-agent collaboration

A2A 1.0 defines independent agent discovery/collaboration and separates `contextId` from server-generated `taskId`.

**Implication**

Do not invent WAG-specific inter-agent messaging. Also do not add A2A prematurely. A2A becomes relevant only when two independently owned agents need to collaborate as agents, rather than when one orchestrator is simply invoking local tools.

Evidence:
- https://a2a-protocol.org/dev/specification/

## 3.4 AG-UI: useful if a custom user-facing control surface survives benchmarking

AG-UI is an event-based agent↔UI protocol with state snapshots, deltas, messages and human-interaction patterns.

**Implication**

The P2 native UI does not justify a private event protocol. If OpenHands Agent Canvas/goose do not satisfy the UX and a custom UI is still required, its agent-facing boundary should prefer ACP and/or AG-UI rather than a proprietary protocol.

Evidence:
- https://github.com/ag-ui-protocol/ag-ui
- https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/sdk/js/core/events.mdx

---

# 4. Workbench/client audit

## 4.1 goose

goose is a local, provider-agnostic desktop/CLI/API agent client with MCP and ACP support.

However, its Developer extension documentation states that autonomous mode can run system commands with the user's privileges and edit accessible files without per-action approval.

**Verdict: BENCHMARK as workbench/client, never authority boundary.**

Potential fit:
- human UI;
- provider switching;
- ACP client/server interoperability;
- MCP extension UX.

Must remain below/behind WAG/OpenShell/ACS controls for high-consequence local effects.

Evidence:
- https://github.com/aaif-goose/goose
- https://github.com/aaif-goose/goose/blob/main/documentation/docs/mcp/developer-mcp.md

## 4.2 OpenHands Agent Canvas

Agent Canvas is now explicitly a self-hosted developer control center that can run OpenHands, Claude Code, Codex, Gemini and ACP-compatible agents across local, Docker, VM and cloud backends.

It separates browser UI from backend execution/workspace state and already provides conversations, files, terminals, model configuration, backends and automations.

**Verdict: BENCHMARK before any custom P2 human workbench implementation.**

This is currently a closer fit than building a .NET workbench immediately.

Missing/insufficient relative to this program:
- WAG-specific local Goal Lease authority;
- exact repo/Git effect fencing;
- WAG durable effect evidence;
- provider-independent local authority boundary.

Evidence:
- https://github.com/OpenHands/OpenHands
- https://docs.openhands.dev/openhands/usage/agent-canvas/overview
- https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents

---

# 5. Governance audit

## 5.1 Microsoft Agent Governance Toolkit / ACS

ACS defines a stateless deterministic decision runtime. The host provides a complete snapshot; ACS returns a normalized verdict. The engine does not execute the effect itself.

Important properties already overlap strongly with WAG's direction:

- deterministic policy evaluation;
- allow/deny/transform;
- escalation to approval;
- fail-closed behavior when approval cannot be resolved;
- exact enforced action identity;
- host obligation to execute exactly the evaluated target;
- approval identity revalidation;
- policy/version/evidence separation;
- Rego/Cedar/custom dispatch options;
- multi-language SDKs.

The ActionBinding ADR defines a JCS-canonicalized SHA-256 action digest covering agent, represented subject, operation, target, resource, schema version and parameters.

**Verdict: BENCHMARK then WRAP.**

WAG should not copy AGT wholesale and should not make ACS mandatory yet. AGT is public preview and its broad package surface exceeds WAG's needs.

The recommended boundary is:

```text
provider / agent
      ↓
WAG request normalization
      ↓
optional ACS policy decision
      ↓
WAG local authority + lease/fencing
      ↓
exact local effect executor
```

ACS is a policy decision dependency/adaptor, not the authority owner.

### Candidate semantic alignment

WAG should compare:
- `planSha256` / request fingerprint;
- exact operation + arguments;
- actor/subject/session/workspace;
- policy version;
- action/result binding;
- approval identity;
- expiry/revocation;

against ACS `ActionBinding`, `input_identity`, and `enforced_identity`.

The goal is **interoperability and deletion of duplicate generic policy code**, not replacement of WAG-specific CAS/effect semantics.

Evidence:
- https://github.com/microsoft/agent-governance-toolkit/blob/main/policy-engine/spec/SPECIFICATION.md
- https://github.com/microsoft/agent-governance-toolkit/blob/main/policy-engine/docs/security-model.md
- https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/adr/0030-action-bound-approval-protocol.md
- https://github.com/microsoft/agent-governance-toolkit

---

# 6. Goal Lease audit

Goal Lease remains justified locally, but its strategic role changes.

It should be the local representation of **bounded human delegation**, not a new universal agent-authorization protocol.

OAuth's charter now explicitly includes complex delegation for automated agents. Current 2026 work includes:
- Agent Operation Authorization;
- AI Agent Authentication and Authorization guidance;
- agent-authorization use-case/gap analysis;
- agent revocation and rich-authorization-request work;
- transaction-token work relevant to delegated/multi-hop execution.

These are still Internet-Drafts/work in progress, not stable contracts to depend on.

**Verdict: KEEP + ALIGN.**

Required design direction:

```text
Goal Lease
├─ principal / represented subject
├─ agent/workload identity
├─ goal/task identity
├─ operations
├─ resources
├─ constraints
├─ expiry
├─ revocation
├─ delegation/fencing generation
└─ evidence/reference
```

Do not:
- turn a ChatGPT/Claude conversation ID into authority;
- expose lease issuance to the model;
- invent a public token protocol now;
- block P0 waiting for standards work.

Do:
- keep the local durable lease;
- make its semantic projection mappable to emerging OAuth agent delegation claims later.

Evidence:
- https://datatracker.ietf.org/doc/charter-ietf-oauth/
- https://datatracker.ietf.org/doc/html/draft-liu-agent-operation-authorization-02
- https://datatracker.ietf.org/doc/html/draft-klrc-aiagent-auth-03
- https://datatracker.ietf.org/doc/html/draft-chen-oauth-agent-authz-use-cases-03
- https://datatracker.ietf.org/wg/oauth/documents/

---

# 7. Runtime / sandbox audit

## 7.1 NVIDIA OpenShell

OpenShell is a multi-agent runtime/control plane with:
- sandbox lifecycle;
- filesystem/network/process policy;
- endpoint-bound credentials;
- Docker/Podman/MicroVM/Kubernetes drivers;
- provider profiles;
- audit/logging;
- policy proposal/advisor path;
- deterministic policy-prover checks before eligible auto-approval.

Its Policy Advisor has a particularly relevant pattern: explicit auto mode only auto-approves when the prover delta is empty and no security notes remain; otherwise the change remains pending for human review.

**Verdict: BENCHMARK as default P2/P3 runtime candidate.**

This can delete large planned areas:
- custom Linux sandbox supervisor;
- custom generic egress broker;
- custom provider credential injection;
- generic sandbox lifecycle;
- much of the cross-platform process/sandbox abstraction.

Caveats:
- project is still pre-1.0/alpha;
- stable Windows support remains limited/experimental;
- native Windows MXC work is new and must be measured;
- OpenShell policy is not the same thing as WAG Goal Lease/effect authorization.

Evidence:
- https://github.com/NVIDIA/OpenShell
- https://docs.nvidia.com/openshell/dev/sandboxes/policy-advisor
- https://github.com/NVIDIA/OpenShell/issues/2050

## 7.2 Microsoft MXC

MXC provides a single policy/config model over platform-specific containment:
- Windows ProcessContainer/AppContainer/BaseContainer;
- Windows Sandbox;
- WSL containers;
- Bubblewrap/LXC on Linux;
- Seatbelt on macOS;
- experimental microVM/Hyperlight/isolation-session paths;
- filesystem/network/UI policy;
- state-aware lifecycle.

This is very close to the cross-platform substrate P2/P3 would otherwise build.

**Verdict: BENCHMARK, not production trust dependency yet.**

Critical limitation: Microsoft explicitly states that current preview policies have known overly-permissive cases and that **no MXC profile should currently be treated as a security boundary**.

Therefore:
- use MXC for comparison and integration spikes;
- do not weaken WAG/OpenShell security assumptions because MXC exists;
- do not delete fallback native OS containment until empirical security acceptance passes;
- do delete plans to invent a new cross-platform sandbox schema before testing MXC.

Evidence:
- https://github.com/microsoft/mxc
- https://github.com/microsoft/mxc/blob/main/docs/schema.md
- https://github.com/microsoft/mxc/blob/main/docs/sandbox-policy/v1/policy.md

---

# 8. ToolHive audit

ToolHive focuses on MCP server runtime/gateway concerns:
- isolated container per MCP server;
- identity/access policy per request;
- gateway composition;
- auth/authz;
- observability;
- secrets providers;
- minimal/default-deny permission profiles;
- egress proxy;
- Kubernetes/operator path.

**Verdict: REUSE selectively for third-party MCP workloads.**

ToolHive should not replace WAG's repo mutation/verify/Git semantics because those are local effect-authority protocols, not generic MCP-server hosting.

Potential architecture:

```text
AI clients
  ├─ WAG semantic local effects
  └─ ToolHive-managed third-party MCP servers
```

Do not proxy WAG through ToolHive solely for architectural symmetry unless a concrete operational/security benefit is demonstrated.

Evidence:
- https://github.com/stacklok/toolhive
- https://github.com/stacklok/toolhive/blob/main/docs/arch/05-runconfig-and-permissions.md

---

# 9. AIOS audit

AIOS is a real research/implementation project for agent scheduling, context switching, memory, storage and tool management. It has local/remote-kernel concepts and a scheduler with FIFO/RR behavior.

However, its current maturity/security posture is not suitable as this program's authority/control plane:
- its Rust rewrite is explicitly an early scaffold without feature parity;
- a current open issue reports cross-agent memory injection / privilege-escalation risk in shared memory handling;
- its focus is agent-resource management, not deterministic local effect authorization.

**Verdict: REFERENCE / DEFER, not dependency.**

Useful lessons:
- explicit agent process/context abstraction;
- scheduling research;
- separation of kernel/SDK;
- personal-remote-kernel direction.

Do not:
- adopt AIOS as WAG replacement;
- route privileged authority through AIOS memory/context;
- build a competing generic scheduler unless a later workload actually requires one.

Evidence:
- https://github.com/agiresearch/AIOS
- https://docs.aios.foundation/aios-docs/aios-kernel/scheduler
- https://github.com/agiresearch/AIOS/issues/549
- https://github.com/agiresearch/AIOS/blob/main/aios-rs/README.md

---

# 10. Durable orchestration audit

LangGraph provides:
- persistent state/checkpoints;
- retries;
- human interrupts;
- resumable workflows;
- subagents and shared state.

This is valuable for **goal/task orchestration above WAG**.

It does not eliminate the need for WAG effect idempotency/CAS because workflow retry semantics can replay application code around external effects.

**Verdict: WRAP/DEFER.**

Adopt only when the personal control plane actually needs multi-step durable orchestration. Keep execution effects behind WAG so retries can safely encounter exact effect state rather than blindly repeat filesystem/Git actions.

Evidence:
- https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph
- https://docs.langchain.com/oss/javascript/deepagents/overview

---

# 11. Revised program boundaries

## P0 — WAG closure

Keep:
- Goal Lease local authority;
- exact policy/effect binding;
- manual no-lease path;
- `POLICY_APPROVED` vs `HUMAN_APPROVED`;
- immutable plans;
- file base hash/CAS;
- exact workspace/session/adapter binding;
- expiry/revocation/kill switch;
- durable local effect evidence.

Before expanding generic policy code further:
- perform ACS semantic diff;
- identify generic policy code that can eventually be replaced by an ACS adapter;
- preserve WAG-specific effect checks even if ACS is used.

P0 should **not** be reopened merely to replace accepted local code with preview dependencies.

## P1 — provider ingress #1, not product center

Reframe P1 as:

> first supported external-provider acceptance of the provider-independent local authority plane.

ChatGPT Business + Secure MCP Tunnel remains the first acceptance path because it is structurally useful, not because ChatGPT defines the architecture.

Future providers should enter through independent adapters while seeing the same WAG semantic tools and authority.

## P2 — Windows integration benchmark

Replace “build native Windows workbench” with:

1. benchmark OpenHands Agent Canvas;
2. benchmark goose;
3. benchmark OpenShell native Windows/MXC path;
4. benchmark MXC directly where necessary;
5. only then decide whether a custom Windows UI/runtime still has material value.

The custom .NET/WPF/WebView2 workbench becomes a **fallback/challenger**, not the default build plan.

## P3 — Linux integration benchmark

Replace custom Linux runtime-first work with:

1. OpenShell on Ubuntu;
2. ToolHive where third-party MCP server isolation is useful;
3. direct MXC/bubblewrap or systemd/cgroup baseline only for comparative evidence;
4. Playwright/profile security spike;
5. shared COMMON benchmark.

A custom systemd/cgroup/network-broker stack is now a fallback only if OpenShell fails measured requirements.

## P4 — portable core

Still **NOT YET**.

Upstream convergence reduces the need for our own portable runtime. A portable core should be created only if WAG-specific authority/effect semantics must be duplicated across implementations and that duplication causes measurable defects or maintenance cost.

---

# 12. What should be deleted or deferred from the roadmap

## DELETE-DESIGN unless upstream fails

- new generic agent OS/kernel;
- custom cross-platform sandbox schema;
- custom generic policy engine;
- custom general-purpose MCP gateway;
- custom agent↔agent protocol;
- custom coding client↔agent protocol;
- custom user-agent event protocol;
- custom secret store;
- custom generic process supervisor abstraction spanning all OSes;
- custom scheduler solely because “AI-native OS needs a scheduler”;
- full native UI before Agent Canvas/goose acceptance tests.

## KEEP

- WAG exact local effect authority;
- Goal Lease local bounded delegation;
- workspace/repository ownership;
- semantic file/repo/verify/Git operations;
- exact base/hash/HEAD fencing;
- effect/result durable evidence;
- provider correlation → locally minted authority identity;
- fail-closed restart/recovery semantics.

---

# 13. Target architecture after reuse audit

```text
Human
  │
  ├────────────── workbench/client ──────────────┐
  │      Agent Canvas / goose / future UI        │
  │            ACP / AG-UI where useful          │
  │                                               │
  ▼                                               │
Provider / coding agent                           │
ChatGPT / Claude / Codex / Gemini / local agent  │
  │                                               │
  ├──────── MCP ──────────────┐                   │
  └──────── A2A if needed ────┤                   │
                              ▼                   │
                  Personal AI Control Plane       │
                  - goal/task identity            │
                  - local Goal Lease              │
                  - workspace ownership           │
                  - provider correlation          │
                  - orchestration state           │
                              │                   │
                      optional ACS policy          │
                              │                   │
                              ▼                   │
                           WAG                    │
                  - semantic local effects        │
                  - CAS/fencing                   │
                  - verify/Git authority          │
                  - durable effect evidence       │
                              │                   │
                       OpenShell runtime           │
                              │                   │
                 MXC / OS-native containment      │
                    │          │          │        │
                 Windows      Linux      macOS     │
```

Third-party MCP servers can be run behind ToolHive independently where useful.

---

# 14. The actual remaining product/research gap

The remaining gap is **not** “an AI OS”.

It is this composition:

1. human declares a bounded goal;
2. local control plane creates/mints authority;
3. multiple interchangeable agents/providers can work toward that goal;
4. each agent sees only allowed workspaces/resources;
5. tool/runtime transport does not become authority;
6. policy can deterministically permit safe actions without per-action human clicks;
7. consequential local effects are bound to exact state/digest/CAS;
8. failures/restarts do not silently duplicate or misattribute effects;
9. evidence identifies which goal, lease, session, action and result produced every consequential change;
10. the execution substrate can move between Windows/Linux without changing authority semantics.

Existing OSS covers most individual layers. The program's useful contribution is the **provider-independent local authority composition and exact effect semantics**.

---

# 15. New-repository decision

**Do not create a new repository yet.**

A new `personal-ai-control-plane` repository becomes justified only after these three gates:

1. P0 Goal Lease/effect authority is accepted and its true WAG boundary is known;
2. OpenShell/MXC/ACS/Agent Canvas/goose spikes establish which upstream components are actually adopted;
3. the remaining coordination code cannot naturally live as thin adapters/tests/specs around WAG.

If those gates pass, the repo scope should be narrow:

```text
personal-ai-control-plane
├─ provider/session adapters
├─ goal/task coordination
├─ Goal Lease projection
├─ workspace/resource ownership coordination
├─ WAG effect adapter
├─ ACS/OpenShell integration adapters
├─ acceptance harnesses
└─ cross-provider/multi-session evidence
```

It must **not** contain:
- a new sandbox engine;
- a new agent runtime;
- a new policy language;
- a new MCP gateway;
- a new LLM framework;
- a new agent scheduler by default;
- a new UI protocol.

---

# 16. Immediate next steps after research

1. Freeze this reuse audit as architecture input.
2. Review Claude's completed P0 evidence independently against the existing P0 acceptance checklist.
3. If P0 passes, reconcile Goal Lease against:
   - ACS ActionBinding/enforced identity;
   - emerging OAuth agent-delegation claims.
4. Run a small, non-production dependency spike:
   - Agent Canvas ↔ ACP agent;
   - OpenShell runtime;
   - ACS decision adapter;
   - WAG remains exact-effect authority.
5. Run Windows OpenShell+MXC benchmark and Linux OpenShell baseline.
6. Recompute P2/P3 scope from measured gaps.
7. Only then decide whether `personal-ai-control-plane` deserves its own repository.

---

# Evidence ledger

Primary/upstream references checked 2026-09-21:

- MCP 2026-07-28: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- MCP Tasks extension: https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks
- ACP: https://github.com/agentclientprotocol/agent-client-protocol
- A2A 1.0: https://a2a-protocol.org/dev/specification/
- AG-UI: https://github.com/ag-ui-protocol/ag-ui
- goose: https://github.com/aaif-goose/goose
- goose Developer extension permissions: https://github.com/aaif-goose/goose/blob/main/documentation/docs/mcp/developer-mcp.md
- OpenHands Agent Canvas: https://github.com/OpenHands/OpenHands
- OpenHands Agent Canvas overview: https://docs.openhands.dev/openhands/usage/agent-canvas/overview
- OpenHands ACP agents: https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents
- Microsoft Agent Governance Toolkit: https://github.com/microsoft/agent-governance-toolkit
- ACS specification: https://github.com/microsoft/agent-governance-toolkit/blob/main/policy-engine/spec/SPECIFICATION.md
- ACS security model: https://github.com/microsoft/agent-governance-toolkit/blob/main/policy-engine/docs/security-model.md
- ACS action-bound approval ADR: https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/adr/0030-action-bound-approval-protocol.md
- NVIDIA OpenShell: https://github.com/NVIDIA/OpenShell
- OpenShell Policy Advisor: https://docs.nvidia.com/openshell/dev/sandboxes/policy-advisor
- OpenShell native Windows/MXC RFC: https://github.com/NVIDIA/OpenShell/issues/2050
- Microsoft MXC: https://github.com/microsoft/mxc
- MXC schema: https://github.com/microsoft/mxc/blob/main/docs/schema.md
- MXC sandbox policy: https://github.com/microsoft/mxc/blob/main/docs/sandbox-policy/v1/policy.md
- ToolHive: https://github.com/stacklok/toolhive
- ToolHive permissions/runconfig architecture: https://github.com/stacklok/toolhive/blob/main/docs/arch/05-runconfig-and-permissions.md
- AIOS: https://github.com/agiresearch/AIOS
- AIOS scheduler: https://docs.aios.foundation/aios-docs/aios-kernel/scheduler
- AIOS Rust scaffold: https://github.com/agiresearch/AIOS/blob/main/aios-rs/README.md
- AIOS memory-isolation issue: https://github.com/agiresearch/AIOS/issues/549
- LangGraph durable orchestration: https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph
- LangGraph Deep Agents: https://docs.langchain.com/oss/javascript/deepagents/overview
- OAuth WG charter: https://datatracker.ietf.org/doc/charter-ietf-oauth/
- Agent Operation Authorization draft: https://datatracker.ietf.org/doc/html/draft-liu-agent-operation-authorization-02
- AI Agent Authentication and Authorization draft: https://datatracker.ietf.org/doc/html/draft-klrc-aiagent-auth-03
- Agent Authorization gap analysis: https://datatracker.ietf.org/doc/html/draft-chen-oauth-agent-authz-use-cases-03
- OAuth WG active documents: https://datatracker.ietf.org/wg/oauth/documents/
