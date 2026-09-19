# New Chat Handoff — AI-native Browser Community Scan

Date: 2026-09-19
Repository: `ShenJun93/web-agent-gateway`
Canonical branch: `main`

## User directive

Do not preserve our own code because of sunk cost. If an external project/service is materially better, prefer adopting it and retire/freeze overlapping custom code.

Research **community experience and real failure modes first**. Only benchmark the smallest surviving shortlist.

## Canonical authority

Fresh-read, in order:

1. Git `main` / remote HEAD.
2. `README.md` canonical authority section.
3. Relevant accepted specs/ADRs, especially:
   - `docs/adr/0018-lock-webchat-local-coding-mission.md`
   - `docs/adr/0019-separate-browser-proposal-from-consequential-authority.md`
4. Research receipts:
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan.md`
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-2.md`
5. Chat history last.

Do not use this handoff as authority when Git disagrees.

## Verified state

Two community/prior-art passes are now complete.

### Pass 1

Covered:
1. BrowserOS neo
2. open-browser-use
3. Cloudflare Browser Run / Kitesurf

Main conclusions:
- BrowserOS neo: credible local replacement candidate, but still early/rough.
- open-browser-use: architecture strongly relevant; insufficient independent community proof.
- Browser Run/Kitesurf: strong offload lane, not persistent local-auth replacement.

### Pass 2

Covered:
1. Vercel `agent-browser`
2. Browser Use / Browser Harness / BrowserCode
3. Steel
4. Browserbase / Stagehand
5. Kernel
6. Hyperbrowser / HyperAgent
7. Opera `opera-browser-cli` / `opera-devtools-mcp`
8. Puma Browser / Puma OS
9. Open Interpreter / Interpreter Extension
10. Panerelay, Browser Bridge, Real Browser MCP, Chrome Bridge MCP

No local install/benchmark was performed.

Remote WAG `main` was verified at
`2abb644c85134b8ef2a8482ad7d2757a04bfa6fd`
immediately before the Pass 2 branch was created.

The local Windows Desktop Commander device was offline during this pass, so local worktree/HEAD was **not** independently verified.

## Shortlist after community evidence

### Local real-profile lane

Primary:
1. **Browser Harness**

Secondary:
2. **Panerelay + agent-browser provider**

Optional only if adopting Opera/Neon is acceptable:
3. **Opera browser CLI / DevTools MCP**

Reference/action engine:
4. **agent-browser** — useful and active, but do not make it sole lifecycle authority yet.

### Cloud/offload lane

Primary:
1. **Browserbase**
2. **Kernel**

Fallback where self-host/open-source matters:
3. **Steel**

Watch:
4. **Hyperbrowser**

## Eliminated from first empirical round

Do not benchmark these in the first round:

- BrowserCode — evaluate Browser Harness substrate instead.
- Open Interpreter core — higher-level agent runtime outside WAG mission.
- Puma Browser / Puma OS — wrong current platform/problem.
- every small real-profile bridge — code review first, benchmark only if it reveals a material advantage.
- all cloud providers — only Browserbase vs Kernel if cloud offload becomes an immediate goal.

## Important reliability findings

### Browser Harness

Relevant current public blockers:
- Windows auth-token/workspace permission hardening gap.
- concurrent daemon-start race can orphan a daemon.
- closing current tab can leave dangling session state.
- cold-start/screenshot issues remain active.

Therefore it is the **first empirical candidate**, not an assumed production replacement.

### agent-browser

Positive:
- current releases added a Rust daemon, default idle timeout and Windows Job Object containment.
- strong profile/session/action semantics and frequent release velocity.

Remaining public risk:
- recent Windows `open/connect` hangs.
- recent wedged-session report where harness timeout did not recover the detached daemon/browser tree.
- unresolved command/watchdog behavior means local cleanup cannot be retired from public evidence alone.

Use it as an action engine/reference until failure/recovery evidence is green.

### Panerelay

Strong design fit:
- real existing Chrome/Edge.
- explicit user-authorized tabs.
- agent-browser + Browser Use integration.
- background tab control.
- MIT.
- compatibility matrix distinguishes verified/partial/unsupported behavior and fails closed on some launch-time controls that cannot be guaranteed.

But public community volume is small. Treat it as code-review + bounded empirical candidate, not a migration by reputation.

### Opera browser CLI

Strong official Windows/vendor path and logged-in/persistent browser support.

But:
- detached persistent bridge exists.
- project docs include stale-bridge recovery.
- parallel routing work is still planned for some flows.
- independent community evidence is very small.
- CDP/browser-debug authority is broad.

## Existing custom-code consequences

Do not preserve browser-specific code due sunk cost.

However, current evidence does **not** justify retiring:

- WAG admission/ownership/capability policy.
- ADR-0019 local approval transition.
- durable consequential-effect ownership.
- SessionCommander / Cleanup Sidecar owner-aware failure cleanup.

External projects may replace browser attachment/action/profile/session plumbing if empirical evidence is stronger.

Guardian continuity/context-warning functionality is separate from generic browser control and should be judged independently.

## Next exact action

Community stop condition has been met.

Run the **minimum local empirical comparison**, not a broad benchmark:

1. Browser Harness.
2. Panerelay + agent-browser provider.
3. Opera browser CLI only if an Opera/Neon dependency is acceptable.

Use a dedicated non-sensitive browser/profile first.

Acceptance matrix:

1. Windows setup/attach.
2. authenticated profile survives controlled restart.
3. existing-tab control does not unexpectedly steal focus.
4. two simultaneous agent sessions stay isolated.
5. 10 open/action/close cycles leave zero task-owned residual process.
6. forced kill mid-navigation/snapshot recovers without stale ownership.
7. deliberately slow/wedged target produces bounded failure.
8. local listener/socket/pipe and token permissions are acceptably scoped.
9. untrusted page content cannot gain consequential local authority.
10. Claude Code/Codex integration works without weakening WAG authority.

If local empirical evidence selects an upstream winner, identify exact WAG/Guardian/SessionCommander code that becomes redundant and retire/freeze it in small reversible slices.

## Cloud follow-up only when needed

If offload becomes immediate, compare only:

- Browserbase
- Kernel

on one authenticated workflow with profile reuse, crash/reconnect, explicit cleanup, 3-5 concurrent sessions, live/replay evidence and observed cost.

Do not benchmark Steel/Hyperbrowser unless the first pair fails a concrete requirement.

## Decision discipline

Use:
`NATIVE -> STANDARD -> PROVEN OSS/SERVICE -> COMPOSE -> WRAP -> EXTEND -> BUILD`

ADR-0019 remains controlling:
browser-side proposal authority must not silently become consequential execution authority.

## Decision markers

```text
COMMUNITY_SCAN_STOP_CONDITION = MET
LOCAL_BENCHMARK_RUN = NO
LOCAL_PRIMARY = BROWSER_HARNESS
LOCAL_SECONDARY = PANERELAY_PLUS_AGENT_BROWSER
LOCAL_OPTIONAL_VENDOR = OPERA_BROWSER_CLI
AGENT_BROWSER = ACTION_ENGINE_REFERENCE
CLOUD_PRIMARY = BROWSERBASE,KERNEL
CLOUD_SELF_HOST_FALLBACK = STEEL
RETIRE_WAG_AUTHORITY_BOUNDARY = NO
RETIRE_LOCAL_CLEANUP_YET = NO
NEXT_ACTION = MINIMUM_LOCAL_EMPIRICAL_COMPARISON
```
