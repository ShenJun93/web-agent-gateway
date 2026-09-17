# AGENTS.md

## Authority rules
- Resolve exact state from Git, approved specs, ADRs, tests, CI, and live evidence.
- Never reconstruct HEAD, task state, blockers, benchmark results, or provider capability from chat memory.
- Prefer current upstream source/docs over remembered behavior.
- Before promoting architecture, trust-boundary, dependency, packaging, or provider-capability decisions, fresh-research current upstream/official sources and record dated evidence.

## Required reading order
1. `README.md`
2. latest approved file in `docs/superpowers/specs/`
3. relevant ADRs in `docs/adr/`
4. latest research receipt in `docs/research/`
5. benchmark evidence in `docs/benchmarks/`

## Mission guardrails
- Advance one or both normative goals in ADR-0018: replace DC on selected WebChat -> local workflows; enable WebChat local coding outcomes comparable to Claude Code/Codex through WAG.
- Measure coding parity by outcomes, not by copying low-level tool catalogs. A competitor feature is never sufficient justification by itself.
- ChatGPT Web is the reference provider; provider-neutral core semantics must remain reusable by later WebChat providers.
- Prefer provider-native remote/private MCP or another stable standard path before building a provider browser adapter.
- Do not promote a capability unless a concrete WebChat workflow gap and an acceptance test are identified first.
- Product mission never overrides ADR-0014/0017 trust gates; consequential Browser Adapter authority remains separately gated.

## Engineering constraints
- Reuse order: NATIVE -> STANDARD -> PROVEN OSS/SERVICE -> COMPOSE -> WRAP -> EXTEND -> BUILD.
- Keep provider adapters thin; no provider-specific execution logic in core.
- Default-deny security; local approvals for consequential actions.
- Do not treat path allowlists as a sandbox.
- Prefer semantic/coarse-grained tools over many low-level remote calls.
- Long-running process lifetime must be independent from request lifetime.
- Instrument latency and failure spans before optimizing.
- Keep changes small, reviewable, reversible, and testable.

## Scope
V0 is a benchmark spike, not a general agent platform. Do not add browser scraping, A2A, ACP orchestration, marketplace, or multi-device broker unless a later approved spec requires them.
