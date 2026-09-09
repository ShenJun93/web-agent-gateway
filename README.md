# Web Agent Gateway

Provider-neutral local execution gateway for Web AI clients.

## Goal
Use paid Web AI quota (initially ChatGPT Plus Web) as the reasoning surface while keeping repo/files/Git/process execution local, fast, observable, and policy-controlled.

## Canonical authority
1. Git history and tagged evidence.
2. `docs/superpowers/specs/` approved designs.
3. `docs/adr/` architecture decisions.
4. `docs/research/` dated research receipts.
5. `docs/benchmarks/` empirical evidence.
6. Chat history is never canonical project state.

## Current decision
COMPOSE, do not fork wholesale:
- DevSpace: upstream local execution backend/donor.
- LocalAnt: security/policy/approval donor.
- Official MCP SDK: protocol boundary.
- Cloudflare Tunnel: V0 transport candidate.
- Our code: thin gateway, policy, semantic tools, telemetry, compatibility.

## V0 gate
Build only a bounded benchmark spike. Continue only if it materially beats Remote Desktop Commander on latency/reliability while preserving strict security boundaries.
