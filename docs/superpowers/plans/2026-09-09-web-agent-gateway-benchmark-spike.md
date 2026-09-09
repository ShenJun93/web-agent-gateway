# Web Agent Gateway Benchmark Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove or reject whether a thin provider-neutral gateway backed by DevSpace materially improves Web-AI local coding execution over Remote Desktop Commander, without assuming private ChatGPT Plus full-write MCP availability.

**Architecture:** A public authenticated MCP transport exposes only the owned gateway. The gateway delegates localhost execution to an exact-pinned DevSpace process through a narrow adapter boundary. Remote Desktop Commander is the primary current baseline.

**Tech Stack:** TypeScript/Node.js, official MCP SDK, pinned DevSpace upstream, OpenTelemetry-compatible structured telemetry, Git, Windows.

**Spec:** `docs/superpowers/specs/2026-09-09-web-agent-gateway-design.md`

## Global Constraints
- Provider-neutral core; no ChatGPT-specific execution logic.
- DevSpace is a separately supervised localhost-only privileged executor, not imported as a library and not treated as a sandbox.
- Pin exact DevSpace version/commit and verify compatibility before benchmark use.
- Public MCP rejects anonymous access.
- Workspace operations are scoped by opaque `workspace_id` mapped to a canonical non-drive-root workspace.
- No arbitrary public raw shell in the initial spike; use configured `verify.run` profiles.
- Default-deny for consequential operations.
- No browser scraping or custom hosted relay in V0.
- Benchmark before broad implementation.
- Failures are evidence; never discard failed runs from latency/reliability reporting.

### Task 0: De-risk host, executor, transport, and safety assumptions
**Files:** Create `docs/benchmarks/v0-prerequisites.md` and `docs/benchmarks/devspace-pin.json`.
- [x] Record the current ChatGPT Plus constraint: private developer-mode full MCP write is not a supported immediate path; published apps may support write depending on plan/app/rollout.
- [x] Record the Web-host deployment status without adding provider-specific core logic: ChatGPT Plus private full-write MCP is BLOCKED; local architecture validation proceeds under ADR-0004 and published-plugin access remains an external future gate.
- [x] Pin one exact DevSpace release or commit. Record repository URL, revision, Node/npm versions, Windows version, and tool/schema fingerprint.
- [x] Run DevSpace locally on Windows and verify the minimum required read/process surface before writing gateway code.
- [x] Verify current process-session semantics: running sessions are in-memory; DevSpace shutdown terminates them. Mark executor-restart durability explicitly out of V0 scope.
- [x] Validate the public transport candidate with the actual Streamable HTTP path, authentication, correlation IDs, reconnect after interruption, and realistic payload sizes.
- [x] Define the hostile Windows path fixture set: traversal, symlink/junction/reparse, UNC/device-path and credential/system-path cases where supported by the test environment.
- [x] Record the split gate: transport/executor architecture prerequisites PASS; ChatGPT Plus public write deployment is BLOCKED. Per ADR-0004, Task 2 local work may proceed while Task 3 public-host acceptance remains blocked.

### Task 1: Capture Remote Desktop Commander baseline
**Files:** Create `docs/benchmarks/dc-baseline.json` and `docs/benchmarks/scenario.md`.
- [x] Define one deterministic disposable-repo scenario: snapshot-equivalent inspection, five reads, symbol search, one behavior-preserving semantic patch, two test runs, diff, and final status.
- [x] Fix comparison conditions: same machine, same repository fixture, same network window where practical, same task text, and same failure-accounting rules.
- [x] Run the scenario through Remote Desktop Commander with timing enabled and correlation IDs where exposed.
- [x] Record per-call wall-clock latency, total wall-clock task time, remote tool-call count, time to first useful action, errors, retries, reconnects, and re-auth events.
- [x] Repeat enough times to report median and p95 without silently discarding failures; record run count and sampling window in the receipt.
- [x] Commit canonical baseline evidence to the benchmark branch; raw failures remain included.

### Task 2: Build the minimum read/verify gateway path
**Files:** Create `package.json`, `src/server.ts`, `src/executor/devspace.ts`, `src/telemetry.ts`, `test/health.test.ts`, `test/devspace-compat.test.ts`.
- [x] Write a failing compatibility test that reaches the exact pinned localhost DevSpace revision and verifies required tool names/schemas.
- [x] Write a failing health-path test that requires the gateway to reach that pinned localhost DevSpace instance.
- [x] Add only `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run` MCP tools.
- [x] `workspace.open` returns an opaque workspace ID; later tools accept workspace IDs rather than unconstrained raw roots.
- [x] `repo.snapshot` has deterministic pruning and output/token budgets.
- [x] `file.read` has workspace containment, size/binary checks, and sensitive-path deny rules.
- [x] `verify.run` maps only to configured profiles with bounded argv/profile-supplied env/timeout/output; no raw shell string is exposed. Inherited DevSpace process environment remains an explicit Task 3 security risk.
- [x] Instrument correlation/request ID plus gateway ingress, policy, executor, aggregation, and total latency fields.
- [x] Verify no public listener exists for DevSpace itself.
- [x] Run focused tests and commit with message `feat: add benchmark gateway path`.

### Task 3: Safety and transport acceptance
**Files:** Create `test/security.test.ts` and `docs/benchmarks/gateway-results.json`.
- [ ] Add failing tests for parent traversal, symlink/junction escape where supported, credential/system paths, UNC/device-path forms, and arbitrary drive-root access.
- [ ] Add a prompt-injection fixture proving repository/output text cannot alter policy state.
- [ ] Implement the smallest strict/context-aware policy needed to make those tests pass; risk decisions consider operation + target + workspace scope, not tool name alone.
- [ ] Run the same deterministic scenario through Gateway -> DevSpace using the supported validation host from Task 0.
- [ ] Interrupt and restore the public transport while a local verification job is running; verify process lifetime/output capture is independent from transport request lifetime.
- [ ] Record median, p95, end-to-end wall clock, time to first useful action, failures/retries, reconnects, tool-call count, and task completion without manual transport recovery.

### Task 4: Gate decision
**Files:** Create `docs/benchmarks/2026-09-09-v0-gate.md`; update ADR only if evidence changes the architecture.
- [ ] Compare gateway evidence with the DC baseline without excluding failures. Do not use direct API timing as the primary comparator because it changes the product/cost path.
- [ ] GO for >=2x end-to-end speedup, or >=30-40% speedup plus clearly better reliability, or a smaller latency gain only if remote tool-turn reduction and reliability are materially better enough to improve actual task completion.
- [ ] Require zero silent dropped calls, correlation-ID accounting for every request, authenticated public access, and passing containment/reconnect tests.
- [ ] Report remote tool-turn reduction and task-completion rate alongside latency; latency alone cannot override a reliability/security failure.
- [ ] State separately whether the architecture passes and whether ChatGPT Plus has an immediately usable supported deployment path.
- [ ] Otherwise mark NO-GO or BLOCKED with the exact failed gate; do not expand scope to patching, arbitrary shell, Git mutation, persistent job runtime, OS sandboxing, ACP/A2A, or plugin submission without a new decision.
- [ ] Commit the signed-off gate receipt.

### Phase-gated work after a V0 GO
- `file.patch`: dry-run + base hash + canonical path check + changed-target reject + approval policy as required.
- `verify.run`: expand only through configured profiles.
- arbitrary command execution: structured argv, explicit developer mode, allowlist, timeout/output/env bounds, local approval.
- Git mutation: separate semantic tools with explicit local approval; do not disguise blocked host actions as benign shell commands.
- persistent approvals/jobs and stronger OS isolation: only when empirical workflow evidence requires them.
