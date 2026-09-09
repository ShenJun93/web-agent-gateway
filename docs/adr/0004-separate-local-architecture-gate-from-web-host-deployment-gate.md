# ADR-0004: Separate Local Architecture Gate from Web-Host Deployment Gate

Status: Accepted
Date: 2026-09-09

## Context
Task 0 verified the pinned DevSpace executor, Windows runtime, local MCP/OAuth surface, and a public Cloudflare transport prototype. Current ChatGPT Plus product access does not provide a supported private full-write MCP developer path, so an end-to-end ChatGPT Plus write acceptance run cannot be the prerequisite for building the local gateway spike.

## Decision
Split V0 into two independent gates:

1. **Architecture gate** — local gateway -> pinned localhost DevSpace, safety boundaries, telemetry, and transport mechanics can be implemented and benchmarked independently.
2. **Deployment gate** — a supported Web-AI host must later prove the real public write/verify path before any production or user-workspace claim.

A blocked ChatGPT Plus private-MCP deployment does not block Task 2 local implementation. It does block Task 3 public-host acceptance and any claim that the V0 is deployable through the user's current Plus account.

## Consequences
- Task 2 may proceed using localhost integration tests against the exact DevSpace pin.
- Public-host tests stay explicitly BLOCKED until a supported host path exists.
- No provider-specific workaround, browser scraping, or unsupported policy bypass is introduced to clear the deployment gate.
