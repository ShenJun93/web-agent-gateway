# AGENTS.md

## Authority rules
- Resolve exact state from Git, approved specs, ADRs, tests, CI, and live evidence.
- Never reconstruct HEAD, task state, blockers, benchmark results, or provider capability from chat memory.
- Prefer current upstream source/docs over remembered behavior.

## Required reading order
1. `README.md`
2. latest approved file in `docs/superpowers/specs/`
3. relevant ADRs in `docs/adr/`
4. latest research receipt in `docs/research/`
5. benchmark evidence in `docs/benchmarks/`

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
