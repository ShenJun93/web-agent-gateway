# ADR-0018: Lock the WebChat-to-Local Coding Mission

Date: 2026-09-17
Status: Accepted — normative product/architecture mission contract
Research: `docs/research/2026-09-17-wag-webchat-local-coding-mission-lock.md`
Depends on: ADR-0001, ADR-0014, ADR-0015, ADR-0017

## Decision

WAG exists primarily for Web AI / WebChat hosts that need bounded access to local development resources without inheriting uncontrolled local machine authority.

Two product goals are normative:

1. **Replace Remote Desktop Commander on selected WebChat -> local workflows.** A workflow is replaced when the target WebChat completes it through WAG with accepted evidence and Remote Desktop Commander is absent from that production path. WAG does not need feature parity with Desktop Commander's general remote-machine tool catalog.
2. **Give WebChat agents local development outcomes comparable to Claude Code/Codex where WAG grants the capability.** Parity is measured by useful outcomes — inspect, locate, read, change, verify/build/test, inspect results, and separately reviewed Git/process effects when required — not by reproducing a raw shell, IDE, agent loop, planner, subagents, or unrestricted filesystem.

ChatGPT Web is the current reference provider and first direct Desktop Commander replacement target. Provider neutrality remains mandatory: core WAG authority, capability, lifecycle, policy, and execution contracts MUST NOT depend on ChatGPT-specific identifiers or behavior.

## Product boundary

WebChat/model reasoning remains outside the local trust boundary. WAG supplies narrowly scoped local capability and owns the authority decision.

WAG owns:

- trusted caller/admission context;
- opaque workspace/resource ownership;
- capability/risk policy;
- consequential-action review boundaries;
- secret isolation;
- durable effect/job ownership where required;
- bounded evidence, audit, and telemetry;
- backend/provider conformance contracts.

WAG does not own:

- model planning/reasoning or provider chat memory;
- model selection/routing;
- generic subagent orchestration;
- a browser engine;
- a generic IDE or remote workstation;
- unrestricted shell/process/filesystem authority;
- provider-specific execution semantics.

Execution backends remain replaceable and may expose broader native primitives internally. Those primitives do not become WebChat authority unless WAG defines and accepts a capability-specific port above them.

## Desktop Commander replacement contract

Desktop Commander is the primary benchmark for the original WebChat-to-local problem, not WAG's feature checklist.

Replacement claims MUST be workflow/tier scoped. At minimum distinguish:

- read/inspect;
- verify/build/test;
- reviewed code change;
- combined practical local-development workflow;
- separately reviewed higher-risk Git/process/network/device effects.

A read-only pass MUST NOT be described as complete Desktop Commander replacement. Conversely, absence of Desktop Commander features unrelated to accepted development workflows MUST NOT be treated as WAG failure.

Where comparison is possible, acceptance should measure the same WebChat workflow through WAG and Remote Desktop Commander, including completion, latency, round trips, failure accounting, leakage/approval safety, recovery, cleanup, setup, and maintenance.

## Coding-outcome parity contract

"Claude Code/Codex-like" means that the WebChat can achieve useful local coding outcomes through WAG. It does not mean that WAG must expose the same low-level tool names or internal agent architecture.

Prefer semantic capability families:

- repository inspect/search/read/history;
- named verify/build/test/task profiles;
- immutable reviewed change sets;
- bounded artifact/result inspection;
- capability-specific Git/process operations only when measured workflows require them.

Raw arbitrary shell, generic MCP passthrough, unrestricted filesystem access, and backend-native command surfaces are not required for parity and remain unauthorized unless a later ADR makes that broad authority the explicit capability under review.

## Provider integration contract

Use the highest-quality provider-native standard path that preserves WAG semantics and trust boundaries:

1. provider-native remote/private MCP when sufficient;
2. another stable standard host adapter when sufficient;
3. a WAG-owned browser/native adapter only when the WebChat lacks an adequate native path;
4. browser automation only for acceptance/diagnostics or a separately justified capability, not as the default production transport.

Provider adapters remain thin. They MAY translate provider request/result shapes and report host capabilities. They MUST NOT own WAG policy, approval, durable state, local secrets, or execution logic.

Architectural provider neutrality means core semantics are provider-independent. Empirical provider neutrality requires at least two materially different WebChat providers to complete the same accepted WAG workflow without changing core authority semantics.

## Consequential Browser Adapter gate

ADR-0017 remains authoritative: the current Windows discovery/bootstrap mechanism is accepted only for the read-only Browser Adapter profile because it provides same-user local trust rather than strong OS caller attestation.

This ADR does not authorize projecting `verify.run`, durable mutation, Git, process, or other consequential capability through that profile. Any such projection first requires a separately accepted stronger admission/isolation design appropriate to the authority being granted.

Product mission does not override trust-boundary gates.

## Capability-growth rule

A proposed production capability MUST satisfy all of the following before implementation promotion:

1. it closes a measured gap in Goal 1 or Goal 2;
2. the same outcome cannot be met adequately by an existing WAG semantic capability;
3. a provider-native/standard/upstream composition has been evaluated before custom build;
4. its authority and lifecycle are narrower than or explicitly justified against a generic machine primitive;
5. ADR-0014 ownership/containment/recovery contracts remain satisfied;
6. negative security and failure-mode tests are part of its acceptance gate;
7. the proposal does not depend on feature parity with a competitor as its sole justification.

## Explicit non-goals

This mission does not authorize:

- turning WAG into Claude Code, Codex, Gemini/Kimi Code, or Desktop Commander;
- provider model orchestration, agent memory, subagents, or autonomous planning;
- generic remote administration or multi-device brokering;
- browser scraping/automation as a substitute for an available native protocol;
- arbitrary shell/process/PTY, Git writes, network publication, browser mutation, or broad filesystem mutation without capability-specific evidence and review;
- adding a provider merely to increase a provider count.

## Consequences

Future roadmap and implementation proposals MUST state which of Goal 1 or Goal 2 they advance, which concrete WebChat workflow is blocked today, and what evidence will prove the gap closed.

Local coding agents such as Claude Code/Codex remain reference experiences and useful MCP conformance clients. They are not the primary product class and their internal tool catalogs do not define WAG scope.

ChatGPT Web remains the reference provider until another accepted decision changes that priority. A second-provider milestone should prefer native remote/private MCP when available rather than cloning the ChatGPT Browser Adapter.

`NEXT_IMPLEMENTATION_GATE = NONE_AUTOMATIC`.

The next evidence task is to design a current repeatable Remote Desktop Commander replacement workflow benchmark suite before selecting any new production capability.
