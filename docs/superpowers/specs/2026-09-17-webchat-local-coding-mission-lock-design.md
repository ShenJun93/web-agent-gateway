# WebChat-to-Local Coding Mission Lock — Design

Date: 2026-09-17
Status: APPROVED product/architecture mission contract
Decision authority: ADR-0018
Research: `docs/research/2026-09-17-wag-webchat-local-coding-mission-lock.md`

## Purpose

Prevent roadmap drift after rapid changes in AI coding agents, remote MCP, browser integration, and provider-native local tooling.

WAG is not a generic agent platform. It exists to give WebChat AI hosts bounded local development capability through a provider-neutral trust/control plane.

## Normative goals

1. **Replace Remote Desktop Commander on selected WebChat -> local development workflows.** Replacement is workflow-scoped and evidence-based; Desktop Commander feature parity is not required.
2. **Give WebChat agents local development outcomes comparable to Claude Code/Codex through WAG-granted capabilities.** Parity is measured by outcomes, not by reproducing raw shell, unrestricted filesystem, agent loops, subagents, IDE behavior, or model orchestration.

ChatGPT Web is the reference provider and first direct Desktop Commander replacement target. Provider-neutral core semantics are mandatory for later WebChat providers.
## Architecture boundary

WebChat/model reasoning stays outside the local trust boundary. WAG owns caller/admission context, resource ownership, capability/risk policy, local review boundaries, secret isolation, durable effect ownership where required, audit, telemetry, and backend/provider conformance.

Provider adapters remain thin and replaceable. Prefer provider-native remote/private MCP or another stable standard path before a WAG browser/native adapter. Provider-specific execution, policy, approvals, or durable state are forbidden in core.

Execution backends may expose broader internal primitives. Those primitives do not become WebChat authority until WAG defines and accepts a capability-specific port.

## Outcome model

The target local-development outcome families are:

- inspect/search/read repository context and Git state;
- run named verify/build/test/task profiles;
- propose and apply reviewable code changes;
- inspect resulting changes and artifacts;
- add bounded Git/process/device/app effects only when a measured workflow proves they are required.

Arbitrary shell, generic PTY/process control, unrestricted filesystem, raw backend MCP forwarding, and network publication are not implied by coding-outcome parity.
## Acceptance model

Desktop Commander replacement advances by evidence tiers: read/inspect; verify/build/test; reviewed code change; combined practical local-development workflow; then optional higher-risk capability-specific tiers.

A provider reaches core WebChat coding-outcome parity when it can use the same WAG contracts to open an admitted workspace, inspect and locate code, read bounded context, perform an accepted reviewed change, run accepted verification, and inspect final repository/change evidence while preserving caller/resource ownership and audit correlation.

Architectural provider neutrality requires no provider-specific execution logic in core. Empirical neutrality requires at least two materially different WebChat providers to pass the same accepted workflow without changing core authority semantics.

## Trust gate

ADR-0017 remains binding. The current Windows Browser Adapter bootstrap is accepted only for its read-only profile. This mission spec does not authorize `verify.run`, mutation, Git, process, browser mutation, or other consequential Browser Adapter authority.

Any consequential browser projection first requires a stronger admission/isolation gate appropriate to that authority.

## Anti-drift rule

Every proposed production milestone must identify which normative goal it advances, the concrete blocked WebChat workflow, the smallest semantic capability needed, why an existing/native/upstream path is insufficient, and the acceptance evidence that will prove the gap closed.

`NEXT_IMPLEMENTATION_GATE = NONE_AUTOMATIC`

`NEXT_EVIDENCE_TASK = DESIGN_CURRENT_DC_REPLACEMENT_WORKFLOW_BENCHMARK_SUITE`
