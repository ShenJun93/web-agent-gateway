# DeepSeek Red-Team Review Assessment

Date: 2026-09-09
Status: REVIEWED INPUT — not canonical by itself.

Source: user-provided DeepSeek review. This receipt records what was accepted, changed, rejected, or deferred after verification against current canonical files and primary sources.

## Executive decision
The review does not overturn ADR-0001 (COMPOSE). It improves the validation order and exposes one important product-access constraint: ChatGPT Plus can use published apps with write actions where supported, but private developer-mode full MCP write is not currently a supported Plus path. Therefore the spike must separate `architecture validation` from `immediate ChatGPT Plus private-write availability`.

## Findings

### 1. Compose ambiguity — REJECT as stale against canonical state
Canonical architecture already selects a separate localhost DevSpace process reached through MCP:
`Web AI -> gateway -> localhost DevSpace`.
Do not switch to importing DevSpace as a library without benchmark evidence that localhost IPC is material.

Reason: a direct import increases coupling to fast-moving DevSpace internals and weakens the upgrade/security boundary. The localhost hop is not assumed to be the dominant latency until measured.

### 2. DevSpace implementation maturity — ACCEPT verification requirement
Do not use stars/commit count as quality evidence. Pin an exact upstream revision and run compatibility/conformance tests before relying on it.

Source inspection confirms substantial test surface, modern MCP adapter code, process sessions, Git/worktree modules, and local-agent adapters. Runtime behavior still requires empirical Windows validation.

### 3. DevSpace process-session restart durability — ACCEPT; source resolves the unknown
`ProcessSessionManager` stores sessions in an in-memory `Map`. `shutdown()` terminates running sessions and clears the map. Completed sessions have a default five-minute cleanup TTL.

Therefore:
- transport/tunnel loss can be a V0 durability requirement;
- DevSpace process restart durability is NOT provided by current process sessions;
- do not build a persistent job manager until evidence says restart durability is required for the core value proposition.

### 4. Worktrees as security boundary — ACCEPT clarification
Worktrees isolate Git working state/workflow, not OS authority. V0 security tests must include parent traversal, symlink escape, credential paths, destructive Git, and arbitrary drive-root access.

### 5. Context-aware risk — ACCEPT WITH CHANGE
Risk must consider tool + target + workspace trust + operation semantics, not tool name alone.

Reject hidden permission escalation based on historical repetition (for example, auto-approve after N similar actions). Any broader grant must be explicit, scoped, time/task/workspace bounded, revocable, and auditable.

### 6. Approval atomicity/replay — ACCEPT, post-value gate
When the approval layer is implemented, approvals must be one-time, request-bound, idempotent, atomic to consume, expiry-bounded, and replay-safe. This is not required before the latency/value spike proves the project deserves a full approval subsystem.

### 7. Tool surface — ACCEPT empirical/tiered hypothesis
The spike should stay minimal. Later tool-surface design should be derived from representative coding tasks.

Likely pattern:
- Tier 1: small common surface;
- Tier 2: consequential/specialized operations exposed only when supported/needed.

Do not dynamically mutate tool exposure in V0 unless host behavior requires it.

### 8. Strict policy usability — ACCEPT concern, REJECT behavioral auto-trust
Avoid one approval per file edit. Prefer explicit workspace/task grants and batched consequential approvals later. Never auto-expand authority merely because similar operations succeeded previously.

### 9. Cloudflare transport risk — ACCEPT test, CORRECT specific claims
Cloudflare supports WebSockets but may close idle connections; heartbeat is recommended. The reviewed claim of a fixed 100-second WebSocket idle timeout is not established by current Cloudflare documentation.

More importantly, MCP 2026-07-28 moves the core toward stateless request/response. Long-running Tasks are poll-based (`tasks/get`), and legacy HTTP+SSE is deprecated. V0 should validate Streamable HTTP, reconnect behavior, request sizes actually used by semantic coding tools, and optional streaming if the chosen host requires it. Do not make WebSocket or 100 MB binary transfer a core requirement without evidence.

### 10. Observability — ACCEPT WITH PHASING
Spike metrics must include technical and user-value measures:
- end-to-end wall clock;
- median/p95 per call;
- tool-call count;
- dropped/failed/retried calls;
- reconnect/re-auth events;
- time to first useful action;
- task completion without manual transport recovery.

Approval fatigue and resource-leak soak metrics belong after the value gate when those subsystems exist.

### 11. Acceptance-gate specificity — ACCEPT
All comparative runs must use the same machine, repository fixture, scenario, network window, model/surface where applicable, and failure-accounting rules. Every request needs a correlation ID. Failures are included, never discarded from latency/reliability reporting.

### 12. DevSpace version stability — ACCEPT
Pin exact version or commit. All DevSpace calls go through our adapter boundary. Upgrade only after tool/schema/behavior compatibility tests pass.

### 13. Repository structure expansion — DEFER
Do not add config/errors/testing/CLI packages before the spike needs them. Add units only when a verified responsibility appears.

### 14. ChatGPT Plus private custom-MCP write — ACCEPT as P0 access constraint
Current OpenAI documentation distinguishes two paths:
- published/available apps can expose supported write actions on eligible plans, including Plus depending on app/plan/rollout;
- private developer-mode full MCP write/modify is currently limited to Business and Enterprise/Edu (Pro gets read/fetch in developer mode; Plus is not a supported private full-write developer path).

Implication: a private gateway cannot be assumed to replace Remote Desktop Commander on the user's current Plus account immediately. The architecture can still be validated with another supported host (for example Claude Web) and later reach ChatGPT Plus through an approved/published plugin/app if eligible.

Do not build an unofficial scraping bypass as the production path.

### 15. Direct API comparison — REJECT as primary benchmark
The product objective is Web subscription quota + local execution, not API economics. Primary benchmark remains Remote Desktop Commander vs gateway path under comparable Web-AI workflow conditions. Local executor-only timing may be recorded as a diagnostic lower bound, not as the success comparator.

### 16. Fixed multi-week timeline — REJECT
Use evidence gates, not calendar estimates. Stop as soon as a blocker invalidates the value proposition; continue only when each bounded validation passes.

## Updated validation order

Gate A — Host/access feasibility
1. Record current ChatGPT Plus limitation for private full-write MCP.
2. Identify a supported host for architecture validation without changing the provider-neutral core.
3. Keep ChatGPT published-plugin path as an external future gate, not an assumption.

Gate B — DevSpace executor validation
1. Pin exact revision.
2. Run on Windows.
3. Verify expected tools/schemas.
4. Verify process session semantics and known restart limitation.
5. Verify worktree/path behavior relevant to the spike.

Gate C — Transport validation
1. Streamable HTTP through Cloudflare Tunnel.
2. Reconnect after tunnel interruption.
3. Correlation IDs across both ends.
4. Long local job survives transport loss.
5. Test realistic payload sizes only.

Gate D — Value benchmark
Run the deterministic coding scenario against DC and the gateway path. Continue only if speed/reliability gains are material under the canonical GO criteria.

## Architecture decision after review
UNCHANGED: COMPOSE a small owned policy/telemetry/semantic gateway in front of pinned localhost DevSpace.

NEW clarification: DevSpace is a separate process accessed through a narrow adapter/MCP boundary, not imported as an internal library for V0.
