# Web Agent Gateway Benchmark Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove or reject whether a thin provider-neutral gateway backed by DevSpace materially improves ChatGPT Web local coding execution over Remote Desktop Commander.

**Architecture:** Cloudflare Tunnel exposes only the owned MCP gateway. The gateway applies policy/telemetry and delegates localhost execution to pinned DevSpace. Remote Desktop Commander is baseline only.

**Tech Stack:** TypeScript/Node.js, official MCP SDK, DevSpace upstream, OpenTelemetry-compatible structured telemetry, Git, Windows.

**Spec:** `docs/superpowers/specs/2026-09-09-web-agent-gateway-design.md`

## Global Constraints
- Provider-neutral core; no ChatGPT-specific execution logic.
- DevSpace binds localhost only.
- Default-deny for consequential operations.
- No browser scraping or custom hosted relay in V0.
- Benchmark before broad implementation.

### Task 1: Capture Remote Desktop Commander baseline
**Files:** Create `docs/benchmarks/dc-baseline.json` and `docs/benchmarks/scenario.md`.
- [ ] Define one deterministic disposable-repo scenario: snapshot, five reads, symbol search, patch, test, diff, second test, status.
- [ ] Run the scenario through Remote Desktop Commander with timing enabled.
- [ ] Record per-call latency, total time, remote tool-call count, errors, reconnects, and re-auth events.
- [ ] Repeat enough times to report median and p95 without silently discarding failures.
- [ ] Commit evidence with message `bench: capture desktop commander baseline`.

### Task 2: Build the minimum gateway path
**Files:** Create `package.json`, `src/server.ts`, `src/executor/devspace.ts`, `src/telemetry.ts`, `test/health.test.ts`.
- [ ] Write a failing health-path test that requires the gateway to reach a pinned localhost DevSpace instance.
- [ ] Add only `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `command.run` MCP tools.
- [ ] Instrument request ID plus network-in, policy, executor, aggregation, and total latency fields.
- [ ] Verify no public listener exists for DevSpace itself.
- [ ] Run focused tests and commit with message `feat: add benchmark gateway path`.

### Task 3: Security and transport acceptance
**Files:** Create `test/security.test.ts` and `docs/benchmarks/gateway-results.json`.
- [ ] Add failing tests for parent traversal, symlink escape, credential paths, destructive Git, and arbitrary drive-root access.
- [ ] Implement the smallest strict policy needed to make those tests pass.
- [ ] Run the same deterministic scenario through Gateway -> DevSpace.
- [ ] Interrupt and restore the tunnel while a local job is running; verify process lifetime is independent from request lifetime.
- [ ] Record median, p95, total time, failures, reconnects, and tool-call count.

### Task 4: Gate decision
**Files:** Create `docs/benchmarks/2026-09-09-v0-gate.md`; update ADR only if evidence changes the architecture.
- [ ] Compare gateway evidence with the DC baseline without excluding failures.
- [ ] GO only for >=2x end-to-end speedup, or >=30-40% speedup plus clearly better reliability.
- [ ] Require zero silent dropped calls and passing security/reconnect tests.
- [ ] Otherwise mark NO-GO and stop; do not expand scope to Gemini/Claude, ACP/A2A, or plugin submission.
- [ ] Commit the signed-off gate receipt.
