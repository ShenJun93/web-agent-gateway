# AI-native Browser Community Experience Scan — Pass 2

Date: 2026-09-19
Status: research receipt; no local benchmark performed
Canonical scope: community/prior-art evidence before empirical testing

## Purpose

Continue the community-first scan started in `2026-09-19-ai-native-browser-community-experience-scan.md`.

This pass covers:

- Vercel `agent-browser`
- Browser Use / Browser Harness / BrowserCode
- Steel
- Browserbase / Stagehand
- Kernel
- Hyperbrowser / HyperAgent
- Opera `opera-browser-cli` / `opera-devtools-mcp`
- Puma Browser / Puma OS
- Open Interpreter
- additional local real-profile bridges: Panerelay, Browser Bridge, Real Browser MCP, Chrome Bridge MCP

No install or local benchmark was run. Remote GitHub `main` for WAG was verified at
`2abb644c85134b8ef2a8482ad7d2757a04bfa6fd` before this pass. The local Windows connector was offline, so the local worktree/HEAD was not independently verified.

## Architectural guardrail

ADR-0018 and ADR-0019 remain controlling.

A browser project may replace browser transport, session management, browser lifecycle, authenticated-profile plumbing, or cloud browser infrastructure. It does **not** automatically replace WAG admission, ownership, capability policy, approval boundaries, durable effect ownership, or the separation between browser proposal authority and consequential execution authority.

Therefore a project can be excellent browser infrastructure and still be an incomplete WAG replacement.

## Executive result

Community evidence is now sufficient to stop broad candidate expansion and move to a small shortlist.

### Local real-profile lane

1. **Browser Use Browser Harness — primary empirical candidate**
   - Best combination of adoption, active maintenance, real-browser support, thin tool surface, and direct relevance to Claude Code/Codex.
   - Important current blockers remain on Windows and lifecycle handling, so it must not be treated as production-boring yet.

2. **Panerelay — code-review + bounded empirical candidate**
   - Very relevant architecture: explicit authorization of existing Chrome/Edge tabs, existing login state, provider integration for agent-browser and Browser Use, background tab control, MIT.
   - Public community footprint is still small; evidence is mostly maintainer compatibility work rather than sustained independent reports.

3. **Opera browser CLI / DevTools MCP — bounded empirical candidate if adopting Opera is acceptable**
   - Official vendor-supported Windows path, persistent profile, headed logged-in browser, compact agent-oriented CLI, explicit bridge lifecycle.
   - Public independent issue/community history is extremely small. It also uses a persistent local bridge and CDP/remote-debugging patterns whose authority is broad.

4. **Vercel agent-browser — keep as action engine/reference, not lifecycle authority**
   - Very active project, strong AI-oriented CLI, profile/session features and high community visibility.
   - Recent Windows and wedged-session reports directly overlap the user's orphan-process/cleanup bottleneck.
   - Recent releases added an idle timeout, Rust daemon and Windows Job Object cleanup, so earlier leak reports are partially mitigated; however current Windows hangs and command-wedge reports remain unresolved enough that SessionCommander/Cleanup Sidecar cannot be retired on public evidence alone.

### Cloud/offload lane

1. **Browserbase** — strongest maturity/community/observability signal among managed providers in this pass.
2. **Kernel** — strongest managed-auth/session-lifecycle story and attractive usage model; independent community evidence is thinner than Browserbase.
3. **Steel** — strongest self-host/open-source escape hatch; useful if lock-in avoidance matters more than managed maturity.
4. **Hyperbrowser** — credible managed option but currently weaker public community signal for this specific use case than Browserbase/Kernel.

These cloud products can remove local browser fleet/process management for offloaded tasks. They do not replace a local everyday authenticated-profile bridge.

### Drop from empirical shortlist for current WAG mission

- **BrowserCode**: higher-level coding agent; Browser Harness is the more relevant substrate.
- **Open Interpreter core**: general coding/desktop agent layer; current web QA can delegate to agent-browser, so it does not independently solve browser lifecycle.
- **Puma Browser / Puma OS**: interesting privacy research/product direction, but Puma Browser is currently mobile-first and Puma OS is not a Windows desktop coding-agent browser bridge.
- **small real-profile bridges** (Browser Bridge, Real Browser MCP, Chrome Bridge MCP): architecture is relevant, but public adoption/issue history is too sparse to justify benchmark time before code review.

## Candidate findings

### 1. Vercel agent-browser

Repository/license:
- Apache-2.0.
- Current package/release observed: 0.38.1.
- Native Rust CLI/daemon is available for Windows x64.

Strengths:
- accessibility snapshot + stable ref workflow designed for agents;
- multiple isolated sessions;
- persistent profile/state options and auth-vault support;
- explicit `--idle-timeout` (default 1h);
- current Windows-launched Chrome is documented as belonging to a Job Object so the tree is terminated with the daemon;
- high issue/PR velocity and frequent signed releases.

Community/failure evidence:
- independent Claude Code users report material token savings and useful real workflows;
- other users report random hangs, slow-page cascades, stale-ref fragility and difficult recovery;
- open issue #1821 reports `open` and `connect` never returning on Windows 10 v0.37.0;
- open issue #1713 reports commands wedging for minutes and detached Chrome trees surviving harness-side timeout on Windows 11 v0.34.0, including 51 residual Chrome processes in one observed incident;
- newer releases added idle cleanup and Windows process containment, so #1713 must not be treated as a timeless description of current cleanup behavior; nevertheless the issue remains open and the current public changelog does not establish full per-command watchdog recovery.

Security:
- existing Chrome/CDP attachment is intentionally broad authority;
- profile/state artifacts can contain bearer-equivalent browser state;
- official docs warn that remote debugging can give local processes full browser control;
- network allowlisting has explicit limitations when attaching to already-running/CDP sessions.

Disposition:
**retain as browser-action engine/reference; do not make it the sole process-lifecycle authority yet.**

Key sources:
- https://github.com/vercel-labs/agent-browser
- https://github.com/vercel-labs/agent-browser/issues/1713
- https://github.com/vercel-labs/agent-browser/issues/1821
- https://github.com/vercel-labs/agent-browser/blob/main/CHANGELOG.md
- https://www.reddit.com/r/ClaudeCode/comments/1rr0pyr/whats_your_reliable_browser_setup_for_claude_code/
- https://www.reddit.com/r/ClaudeAI/comments/1qazrbr/agentbrowser_vercels_new_cli_that_works_with/

### 2. Browser Use / Browser Harness

Browser Harness is more relevant to WAG than BrowserCode because it is the thinner browser-control substrate.

Strengths:
- MIT;
- connects coding agents to the developer's real logged-in Chrome;
- local stdio MCP plus CLI/skill path;
- Browser Use also offers optional cloud sessions for stealth/CAPTCHA/concurrency;
- Browser Use cloud currently advertises $0.02/browser-hour and starts projects at 10 concurrent sessions, with spend-based concurrency growth;
- active releases and large surrounding Browser Use adoption.

Current blockers:
- open issue #813: Windows path skips permission hardening for the auth token and exec'd agent workspace;
- open issue #692: concurrent daemon startup can race and silently orphan one daemon;
- open issue #379: closing the current tab can leave dangling daemon session state;
- current issue list also contains cold-start and screenshot reliability defects.

Bot handling:
- local real-profile mode can benefit from an already-established browser identity but does not make anti-bot challenges disappear;
- Browser Use Cloud adds fingerprints, CAPTCHA solving and residential proxies;
- BrowserCode has an open issue for an agent stuck at an "I am not a robot" challenge.

Disposition:
**primary local empirical candidate, but Windows security/lifecycle defects are explicit acceptance gates.**

Key sources:
- https://github.com/browser-use/browser-harness
- https://github.com/browser-use/browser-harness/issues/813
- https://github.com/browser-use/browser-harness/issues/692
- https://github.com/browser-use/browser-harness/issues/379
- https://browser-use.com/coding-agents
- https://browser-use.com/pricing
- https://browser-use.com/enterprise

### 3. BrowserCode

BrowserCode is a browser-native coding-agent product built above Browser Harness concepts rather than a minimal browser bridge.

Current public issues include:
- in-flight CDP calls remaining pending after session invalidation;
- agent stuck on robot verification.

Its broader agent/runtime surface overlaps areas that ADR-0018 explicitly keeps outside WAG's mission.

Disposition:
**do not benchmark separately for WAG replacement; evaluate Browser Harness instead.**

Sources:
- https://github.com/browser-use/browsercode
- https://github.com/browser-use/browsercode/issues/154

### 4. Panerelay

Discovered from community discussion about using Codex/Claude Code with an existing logged-in Chrome.

Architecture:
- local-first MIT project;
- explicit existing Chrome/Edge session reuse;
- agent-browser provider integration;
- Browser Use and Playwright attachment;
- user-authorized tabs, background tab control and no browser relaunch for the normal existing-browser path;
- detailed compatibility matrix separates verified, forwarded, partial and unsupported operations.

Important boundary:
Panerelay intentionally cannot provide launch-time policies such as `--allowed-domains`, proxy/browser args or full profile replacement when it attaches to an already-running daily browser. This is a useful fail-closed design signal, but it also means WAG-level policy must remain outside it.

Evidence quality:
- public footprint is small (tens of GitHub stars at scan time);
- no meaningful public issue history was available;
- compatibility evidence is mostly maintainer-authored deterministic/real-browser acceptance, not independent sustained-use evidence.

Disposition:
**keep in shortlist for source/security review and one bounded empirical comparison, not migration by reputation.**

Sources:
- https://github.com/F-loat/panerelay
- https://github.com/F-loat/panerelay/blob/main/docs/compatibility/agent-browser-0.33.0.md
- https://github.com/F-loat/panerelay/blob/main/docs/compatibility/browser-platforms.md

### 5. Opera browser CLI / opera-devtools-mcp

Strengths:
- official Opera open-source projects;
- `opera-browser-cli` MIT; `opera-devtools-mcp` Apache-2.0;
- Windows setup is explicitly documented;
- persistent user-data-dir can keep login state;
- can connect to an already-running browser;
- compact accessibility output is designed to reduce agent token cost;
- explicit bridge `start/stop/logs/doctor`.

Lifecycle concerns:
- architecture is a detached persistent HTTP bridge -> MCP child -> CDP;
- project docs explicitly document stale bridge/update mismatch and manual kill-by-port recovery if PID tracking is missing;
- concurrency uses a shared MCP connection, with known/planned routing work for some parallel streaming cases.

Security:
- opera-devtools-mcp explicitly warns that MCP clients can inspect/debug/modify all data in the connected browser;
- a remote-debugging port gives local applications broad browser control.

Evidence quality:
- official support signal is strong;
- independent adoption/community issue history is tiny (roughly dozens of stars and no open issues at scan time), which is insufficient to infer boring reliability.

Disposition:
**bounded candidate if switching to an Opera/Neon-backed workflow is acceptable; not a trust-boundary replacement.**

Sources:
- https://github.com/operasoftware/opera-browser-cli
- https://github.com/operasoftware/opera-devtools-mcp
- https://blogs.opera.com/news/2026/05/opera-browser-cli/

### 6. Other real-profile bridges

#### Browser Bridge
MIT. Manifest V3 extension + localhost MCP server. Reuses the exact logged-in Chrome profile and avoids a raw debug port. It binds loopback and uses token/origin checks. Public footprint is extremely small and Windows autostart is manual.

#### Real Browser MCP
Targets native existing Chrome/profile, includes Windows/WSL installation paths, and can optionally use agent-browser as a separate backend. Public independent evidence remains sparse.

#### Chrome Bridge MCP
MIT, existing logged-in Chrome via MV3 + local WebSocket, explicit loopback/origin/token controls. Again, public adoption and issue history are too small.

#### Open Interpreter Interpreter Extension
Open Interpreter now maintains a Playwriter-derived Chrome extension/relay for controlling the user's own Chrome with explicit tab consent. It is architecturally relevant, but the repository is new/small enough that it should be treated like the other code-review candidates rather than evidence of sustained reliability.

Disposition:
**code-review/watch set, not empirical shortlist unless the source review reveals a material advantage over Browser Harness/Panerelay.**

Sources:
- https://github.com/vitalysim/browser-bridge
- https://github.com/ton-to-ton/real-browser-mcp
- https://github.com/ShalomObongo/chrome-bridge-mcp
- https://github.com/openinterpreter/interpreter-extension

## Cloud provider findings

### Browserbase / Stagehand

Strengths:
- persistent authenticated contexts, live view, recordings and strong observability;
- managed CAPTCHA/stealth on paid tiers;
- mature public SDK/framework footprint; Stagehand is MIT and highly active;
- SOC 2 Type II claims and isolated sessions;
- current pricing: Free 3 concurrent / 1 browser-hour; Developer $20/month with 25 concurrent and 100 hours; Startup $99/month with 100 concurrent and 500 hours.

Community/failure evidence:
- anecdotal users report stable large-scale/long-session use, but those reports are not controlled benchmarks;
- Stagehand issue history shows active churn around session/CDP behavior and API evolution;
- creator/consumer ownership semantics mean a connected client closing does not necessarily destroy a managed session; explicit provider lifecycle remains required.

Lock-in:
- Stagehand SDK is MIT, but Browserbase cloud/session infrastructure is a proprietary managed service.

Disposition:
**cloud/offload shortlist. Strongest maturity signal in this pass, but not local-profile replacement.**

Sources:
- https://www.browserbase.com/pricing
- https://www.browserbase.com/browsers
- https://github.com/browserbase/stagehand

### Kernel

Strengths:
- managed auth supports SSO/2FA/1Password without exposing raw credentials to the model;
- explicit session timeout/pool model;
- ephemeral browser sessions with durable profiles;
- official docs say an abandoned browser enters standby and is deleted after timeout;
- SOC 2 Type II and other compliance claims;
- Apache-2.0 browser infrastructure images are public.
- current free tier: 5 concurrent browsers + $5 monthly credits; Hobbyist $30/month/10 concurrent; Startup $200/month/150 concurrent.

Evidence quality:
- vendor technical documentation is strong;
- independent community evidence is thinner than Browserbase.

Disposition:
**cloud/offload shortlist, particularly when managed authentication and cleanup are the deciding factors.**

Sources:
- https://www.kernel.sh/
- https://www.kernel.sh/pricing
- https://www.kernel.sh/security
- https://www.kernel.sh/blog/auth
- https://github.com/onkernel/kernel-images

### Steel

Strengths:
- `steel-browser` is Apache-2.0 and self-hostable;
- cloud + self-host path lowers strategic lock-in;
- persistent profiles, credential injection, live/replay observability, CAPTCHA/proxy support in managed cloud;
- public project remains active.

Risks:
- credential API is still labeled beta;
- public issues include session-release/relaunch races and fingerprint/launch failures;
- upstream open-source deployment and managed cloud do not have identical feature sets;
- self-host path shifts lifecycle, capacity and security operations back to the user.

Disposition:
**retain as self-host/open-source fallback, not first empirical cloud target.**

Sources:
- https://github.com/steel-dev/steel-browser
- https://docs.steel.dev/
- https://docs.steel.dev/overview/credentials-api/overview
- https://docs.steel.dev/overview/profiles-api/overview

### Hyperbrowser

Strengths:
- managed browser sessions, persistent profiles, stealth/CAPTCHA, Playwright/Puppeteer/CDP compatibility;
- MIT SDKs and HyperAgent; cloud API remains proprietary;
- current pricing: Free 1 concurrent/5,000 credits, Startup $30/25 concurrent, Scale $100/100 concurrent;
- SOC 2/ISO claims for enterprise posture.

Risks/evidence quality:
- independent community volume is lower than Browserbase;
- HyperAgent documents its native CDP layer as still evolving/experimental with occasional sharp edges;
- cloud lock-in remains for the managed browser substrate.

Disposition:
**credible alternative, but no need to spend local benchmark time before Browserbase/Kernel unless price or a specific capability becomes decisive.**

Sources:
- https://www.hyperbrowser.ai/pricing
- https://github.com/hyperbrowserai/HyperAgent
- https://github.com/hyperbrowserai/python-sdk

## Puma Browser / Puma OS

Puma Browser currently presents as a privacy-oriented mobile browser for iOS/Android with 1M+ downloads. Puma OS is presented as an experimental/private AI operating-system initiative.

This does not currently map to the Windows WebChat -> local coding/browser-control mission.

Disposition:
**remove from current empirical shortlist. Revisit only if a Windows/desktop agent-control product becomes concrete.**

Source:
- https://puma.tech/

## Open Interpreter

Open Interpreter is now a broader coding/desktop agent runtime with Windows sandboxing, shared skills, MCP/ACP and QA tooling. Its current web QA path can use agent-browser, and its separate Interpreter Chrome Extension is a Playwriter-derived real-browser bridge.

For WAG:
- the core agent runtime is too high-level and overlaps WAG non-goals;
- the browser extension is relevant prior art but still too new/small for community-first promotion.

Disposition:
**do not benchmark Open Interpreter core as a WAG replacement. Keep Interpreter Extension in the code-review/watch set.**

Sources:
- https://github.com/openinterpreter/openinterpreter
- https://github.com/openinterpreter/interpreter-extension

## Replacement impact on existing custom code

### WAG

External browser projects can plausibly replace:
- browser launch/attachment;
- accessibility snapshot/action transport;
- profile persistence plumbing;
- some session lifecycle/diagnostics;
- cloud browser provisioning.

They do **not** replace:
- WAG admission and ownership;
- capability/risk policy;
- local approval transition;
- durable consequential-job ownership;
- audit/evidence rules;
- ADR-0019 browser-proposal vs effect boundary.

### ChatGPTSessionGuardian

A strong upstream real-profile bridge could eliminate:
- generic tab/browser control helpers;
- some browser connection health/recovery code;
- provider-specific glue if standard MCP/CLI transport is sufficient.

Guardian continuity/context-warning functions remain a separate concern and should not be retired merely because browser control is externalized.

### SessionCommander / Cleanup Sidecar

Cloud providers can eliminate local browser-process ownership for offloaded sessions.

Local tools cannot yet be assumed to eliminate process cleanup:
- Browser Harness has a current daemon-start race;
- agent-browser still has recent public Windows/wedge reports despite newer containment improvements;
- Opera CLI has a detached persistent bridge with documented stale-process recovery.

Therefore:
**do not retire owner-aware local cleanup until empirical evidence proves the selected local lane leaves no task-owned residue under forced failure.**

## Minimum empirical test — now justified

Community evidence has reduced the first local test set to **two primary candidates plus one optional vendor lane**:

1. Browser Harness
2. Panerelay + agent-browser provider
3. optional Opera browser CLI only if adopting Opera/Neon is strategically acceptable

Do not benchmark BrowserCode, Puma, Open Interpreter core, Hyperbrowser, Steel or every small bridge in this first local round.

### Local acceptance matrix

Use a dedicated non-sensitive test browser/profile first.

For each selected local candidate:

1. Windows install/setup and first attach.
2. Authenticated profile survives a controlled restart.
3. Existing-tab targeting does not steal focus unexpectedly.
4. Two simultaneous agent sessions do not cross-control tabs/state.
5. Ten open/action/close cycles leave no task-owned residual daemon/browser process.
6. Forced kill during navigation/snapshot leaves no unrecoverable stale ownership.
7. One deliberately wedged/slow target returns bounded failure.
8. Listener/socket/pipe exposure is loopback/local and access-bearing tokens are protected.
9. Untrusted page content cannot gain consequential local authority.
10. Claude Code/Codex integration works without broadening WAG authority.

### Cloud test, only if offload becomes an immediate goal

Compare **Browserbase vs Kernel** on one authenticated workflow:
- profile/auth reuse;
- crash/reconnect;
- explicit release/timeout cleanup;
- 3-5 concurrent sessions;
- live/replay evidence;
- observed cost.

Do not test every cloud provider yet.

## Decision markers

```text
COMMUNITY_PASS_2 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
LOCAL_PRIMARY = BROWSER_HARNESS
LOCAL_SECONDARY = PANERELAY_PLUS_AGENT_BROWSER
LOCAL_OPTIONAL_VENDOR = OPERA_BROWSER_CLI
AGENT_BROWSER_ROLE = ACTION_ENGINE_REFERENCE_NOT_LIFECYCLE_AUTHORITY
CLOUD_PRIMARY_SET = BROWSERBASE,KERNEL
CLOUD_SELF_HOST_FALLBACK = STEEL
HYPERBROWSER = WATCH
BROWSERCODE = DROP_FOR_WAG_BENCHMARK
OPEN_INTERPRETER_CORE = DROP_FOR_WAG_BENCHMARK
PUMA = DROP_FOR_CURRENT_WINDOWS_MISSION
SMALL_REAL_PROFILE_BRIDGES = CODE_REVIEW_WATCH
RETIRE_WAG_AUTHORITY_BOUNDARY = NO
RETIRE_SESSION_CLEANUP_ON_PUBLIC_EVIDENCE = NO
NEXT_STEP = MINIMUM_EMPIRICAL_LOCAL_TEST
```
