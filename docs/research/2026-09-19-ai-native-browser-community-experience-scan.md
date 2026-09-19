# AI-native browser community experience scan

Date: 2026-09-19
Status: RESEARCH RECEIPT — community evidence, not an acceptance benchmark
Repository: `ShenJun93/web-agent-gateway`

## Purpose

Evaluate community experience before spending time on local empirical trials. The user explicitly prefers adopting/retiring existing code when a better external solution exists; sunk-cost preservation is not a requirement.

Primary candidates in this pass:

1. BrowserOS neo
2. open-browser-use
3. Cloudflare Browser Run / Kitesurf

This receipt separates:
- vendor/official claims;
- independent community reports;
- public issue-tracker evidence;
- current evidence gaps.

No local install or benchmark was performed for this pass.

## Executive conclusion

Do **not** start a three-way local benchmark yet.

The public evidence is already strong enough to narrow the field:

- **BrowserOS neo** has the strongest fit for authenticated local agent browsing, but community reports and current issues show a product that is useful yet still rough around MCP compatibility, migration, platform coverage, UI polish, and some security/hardening edges. It is a credible future replacement candidate for browser-bridge functionality, not yet a low-risk wholesale migration.
- **open-browser-use** has attractive architecture and licensing, but the independent user/community evidence base is still too thin. The project is moving quickly and has a small public footprint. Treat it as an early replacement candidate to monitor/code-review, not as proven production infrastructure.
- **Cloudflare Browser Run** is the strongest production infrastructure story for offloading browser execution. **Kitesurf** is especially interesting for stateless/bursty agent tasks, but it is beta, intentionally trades away full-browser fidelity, and is not a substitute for a persistent authenticated desktop browser. Community discussion also flags bot/challenge limitations. Browser Run and Kitesurf should be considered an offload lane, not a direct WAG/BrowserOS replacement.

Current preferred sequence:
1. broaden community/prior-art scan to adjacent projects;
2. identify which local capabilities can be retired without losing required trust/ownership guarantees;
3. only then perform the smallest empirical trial needed to resolve remaining uncertainty.

## 1. BrowserOS neo

### Official/product fit

BrowserOS neo is explicitly positioned as a second browser for AI agents, with local Chromium, persistent login state, MCP integration, multiple agent sessions, and replay/dashboard features.

This matches the user's highest-value local use case better than a generic headless browser:
- authenticated sites;
- existing browser sessions;
- Claude Code / Codex / MCP workflows;
- visible/replayable agent activity.

### Positive community signals

Independent reports found in public community threads include:

- A user in r/browsers reported using BrowserOS daily for work because Claude can act directly on open tabs through MCP/CLI; they described it as easier than the Claude Chrome extension for a Claude Code-centric workflow.
- A Hermes user reported BrowserOS + MCP working well for logged-in Facebook/YouTube access.
- A LocalLLM user reported BrowserOS neo working well in VS Code and Claude Code, particularly for search and credentialed websites.
- Users looking for alternatives to Comet repeatedly mention BrowserOS as one of the few open/local options worth trying.

These reports support a real differentiator: **logged-in local browsing controlled from coding agents**.

### Negative community signals

Community reports are materially mixed:

- r/PerplexityComet: BrowserOS described as still early, with workflows possible but requiring trial-and-error, debugging, and sometimes adding features yourself.
- r/AI_Agents: one user called the experience poor on a multi-step cross-tab task; replies broadly agreed current agentic browsers remain slow/unreliable for long chains.
- r/browsers: one daily user said they avoided agent mode because it was slow and often failed.
- BrowserOS users have also reported local-model/Ollama setup friction and installation friction on Windows.

This is not evidence that BrowserOS is unusable. It is evidence that the product should not yet be assumed to eliminate lifecycle/debugging work.

### Issue-tracker evidence

Recent public BrowserOS neo issues show active movement but also real integration rough edges:

- #2423: MCP `run` side effects execute, but successful results failed schema/structured-content handling.
- #2505: MCP protocol-version/session-model incompatibility broke Antigravity-style clients.
- #2176: users asked for one-click migration from legacy BrowserOS to neo because provider/MCP/history/bookmark/extension/skill migration was manual; the issue also notes Linux neo availability lagging macOS/Windows at the time.
- #2424: Windows MCP-related ports bound to `0.0.0.0` despite local-only intent; request filtering held, but the bind behavior required hardening.
- Current issue inventory also contains live neo bugs/security-hardening items, including localhost-origin access and scheduled-job behavior.

### Interpretation

BrowserOS neo is **not vaporware** and has genuine daily users. It is also **not yet boring infrastructure**.

For this user's workload, the strongest use case is:
- second local browser dedicated to agents;
- authenticated state;
- direct Claude/Codex access;
- reducing reliance on custom browser bridges.

The strongest concern is that it may replace one set of custom lifecycle problems with a still-evolving MCP/browser product.

### Current disposition

**Candidate: WATCH / ADOPT-LATER if maturity improves.**

Do not expand WAG browser-specific surface merely to compete with neo. New WAG browser work should require evidence that neo/open alternatives cannot satisfy the trust boundary.

## 2. open-browser-use

### Official/product fit

open-browser-use drives the user's existing Chrome through:
- a Chromium MV3 extension + native messaging backend; or
- CDP for explicit remote-debugging targets.

It exposes CLI/SDK/MCP surfaces and keeps normal browser profile/login state intact. The current repository is MIT licensed.

This is extremely close to the historical WAG browser-bridge problem.

### Community evidence strength

Independent community evidence is currently **weak** compared with BrowserOS.

Public repository signals observed during this pass:
- roughly 284 stars;
- about 29 forks;
- only a small open-issue count;
- active release cadence;
- recent releases contain reliability work around target/profile selection and recovery when active native-host registry state is missing.

A small issue count cannot be treated as proof of quality when adoption is also small.

### Maturity signals

The project is evolving quickly:
- native-host/socket recovery logic has been changing;
- packaging/install flows have changed;
- Chrome Web Store distribution has been in-progress;
- public documentation across snapshots has shifted from macOS/Linux preview language toward broader npm/Windows setup support.

That speed is positive for development, but it makes stable operational assumptions risky.

### Architecture positives

The architecture is unusually aligned with this user's requirements:

- real browser/profile;
- no mandatory remote-debugging port for the extension backend;
- per-session broker;
- capability-gated local socket;
- MCP integration;
- explicit tab claim/navigation/cleanup operations;
- local-first data path;
- MIT license.

If it matures, it could make a meaningful part of WAG browser integration redundant.

### Evidence gap

The key missing evidence is **independent sustained-use experience**:
- long-running multi-agent sessions;
- Windows reliability under heavy concurrent use;
- profile/login preservation after failures;
- orphan-process behavior;
- tab ownership conflicts;
- interaction with Claude Code/Codex under failure and cancellation.

Because community proof is thin, a local benchmark today would risk testing an immature moving target.

### Current disposition

**Candidate: WATCH / CODE-REVIEW FIRST.**

Do not build overlapping features in WAG unless necessary. Do not retire WAG browser functionality solely on the current open-browser-use community record.

## 3. Cloudflare Browser Run / Kitesurf

### Browser Run: infrastructure maturity

Browser Run is a managed Cloudflare browser platform with:
- browser sessions;
- CDP;
- Playwright/Puppeteer integration;
- Live View;
- session recording;
- human-in-the-loop takeover;
- high concurrency on paid tiers.

Official 2026 limits increased materially; paid-plan defaults reached hundreds of concurrent browser sessions.

Community discussion around Browser Run is generally positive about:
- removing local Chrome/VM maintenance;
- scale/concurrency;
- CDP compatibility;
- live debugging and human takeover.

This is infrastructure, not a daily desktop browser.

### Kitesurf: important but different

Kitesurf is Cloudflare's agent-first browser engine running on Workers. Official claims report much lower CPU/RAM than Chromium for common agentic tasks such as screenshots and HTML extraction.

However Kitesurf is intentionally:
- stateless;
- beta;
- not pixel-perfect Chromium;
- missing human-oriented browser features such as normal tabs/extensions;
- designed for scalable agent jobs rather than persistent desktop identity.

### Community concerns

Independent discussion highlights a key limitation: Kitesurf is not intended to bypass real-browser/bot-detection challenges and may fail on sites that require strong Chromium/TLS/browser fingerprints.

That concern matters for the user's authenticated consumer-web workflows.

There is also evidence of product/documentation churn:
- Cloudflare docs issue #32865 reported inconsistent Browser Run vs legacy Browser Rendering endpoint documentation for Kitesurf Quick Actions.
- Cloudflare Agents issue #1398 documented that one-shot browser tool execution originally created a fresh session per call, losing cookies/tab state, motivating reusable-instance support.

### Operational limits

Free Browser Run usage is intentionally constrained. Official docs list:
- limited daily browser minutes;
- low free concurrency;
- browser timeouts/rate limits.

Paid tiers are designed for scale and are a more meaningful comparison for production agent workloads.

### Interpretation

Browser Run / Kitesurf are strong candidates for moving **stateless or weakly stateful browser work off the Windows machine**:
- research;
- screenshots;
- scraping;
- extraction;
- bursty automation;
- parallel low-trust tasks.

They are not direct replacements for:
- the user's visible authenticated Edge/Chrome workflow;
- persistent local browser profiles;
- local trust/capability gateway behavior.

### Current disposition

**Candidate: ADOPT AS OFFLOAD LANE, not primary local browser replacement.**

Kitesurf itself should be treated as beta until independent experience broadens.

## Comparative community-evidence matrix

| Dimension | BrowserOS neo | open-browser-use | Browser Run / Kitesurf |
|---|---|---|---|
| Independent community volume | Medium | Low | Medium for Browser Run; low for Kitesurf |
| Authenticated local browser fit | Strong | Strong | Weak/indirect |
| Coding-agent integration | Strong | Strong on paper | Strong via CDP/API, different model |
| Proven daily local use | Some reports | Not enough evidence | N/A: cloud service |
| Long-running workflow reliability | Mixed/rough | Unknown | Better infrastructure story, but state model differs |
| Windows relevance | Yes | Claimed/current support evolving | Local OS mostly irrelevant |
| Process/offload benefit | Moderate | Moderate | Strong |
| Bot/challenge fidelity | Full Chromium path helps | Real Chrome helps | Kitesurf can be limited |
| Maturity risk | Medium | High | Browser Run lower; Kitesurf high |
| Replacement impact on WAG | Potentially high | Potentially high | Partial/offload only |

## Implication for our existing code

Sunk cost is explicitly non-binding.

Use the project rule:
**NATIVE -> STANDARD -> PROVEN OSS/SERVICE -> COMPOSE -> WRAP -> EXTEND -> BUILD.**

Therefore:

- WAG browser-specific code is not protected from retirement.
- ChatGPTSessionGuardian browser-control ambitions are not protected from retirement.
- SessionCommander browser/process lifecycle logic may be reduced if upstream tools provide reliable ownership/cleanup.
- Cleanup Sidecar remains useful as a safety fallback, not a reason to preserve inferior architecture.

No retirement decision is made in this receipt. The community evidence narrows where deeper research should go.

## Next research pass — no local benchmark yet

Before any practical test, broaden community/prior-art review to:

1. Vercel `agent-browser`
2. Browser Use / BrowserCode / Browser Harness
3. Steel
4. Browserbase
5. Kernel
6. Hyperbrowser
7. Opera Neon CLI
8. Puma Browser / Puma OS
9. Open Interpreter
10. other local real-profile MCP/browser bridges discovered during the scan

For each candidate collect:
- sustained-use community reports;
- Windows-specific reliability;
- authenticated-profile behavior;
- session/process cleanup;
- concurrency behavior;
- bot/challenge behavior;
- security/privacy incidents;
- issue velocity and unresolved blockers;
- pricing/lock-in;
- licensing;
- whether it eliminates an existing WAG/Guardian/SessionCommander component.

Only after this broader scan should we decide whether a small empirical test is still necessary.

## Source set

### BrowserOS neo
- https://github.com/browseros-ai/BrowserOS
- https://github.com/browseros-ai/BrowserOS/issues/2423
- https://github.com/browseros-ai/BrowserOS/issues/2505
- https://github.com/browseros-ai/BrowserOS/issues/2176
- https://github.com/browseros-ai/BrowserOS/issues/2424
- https://github.com/browseros-ai/BrowserOS/issues
- https://www.reddit.com/r/PerplexityComet/comments/1tf2q7h/whats_everyones_take_on_browseros_as_an/
- https://www.reddit.com/r/AI_Agents/comments/1sar593/agentic_browser_test/
- https://www.reddit.com/r/browsers/comments/1owv942/using_browseros_for_agentic_browsing_and_actions/
- https://www.reddit.com/r/browsers/comments/1u75j72/opensource_ai_browser_privacyfirst_alternative/
- https://www.reddit.com/r/hermesagent/comments/1sl59k6/web_browsing_in_hermes/
- https://www.reddit.com/r/LocalLLM/comments/1w190qm/neomcpbridge_browseros_neo_bridge_for_mcp_clients/

### open-browser-use
- https://github.com/iFurySt/open-browser-use
- https://github.com/iFurySt/open-browser-use/releases

### Cloudflare Browser Run / Kitesurf
- https://developers.cloudflare.com/browser-run/
- https://developers.cloudflare.com/browser-run/kitesurf/
- https://developers.cloudflare.com/browser-run/limits/
- https://developers.cloudflare.com/changelog/product/browser-run/
- https://blog.cloudflare.com/browser-run-for-ai-agents/
- https://blog.cloudflare.com/browser-run-containers/
- https://blog.cloudflare.com/kitesurf/
- https://github.com/cloudflare/cloudflare-docs/issues/32865
- https://github.com/cloudflare/agents/issues/1398
- https://www.reddit.com/r/mcp/comments/1smxa45/cloudflare_just_launched_browser_run_headless/
- https://www.reddit.com/r/myclaw/comments/1vj0hrb/cloudflare_launched_an_agent_browser_but_nobody/

## Research rule for the next session

Community anecdotes are directional evidence, not ground truth. Prefer:
1. repeated independent reports;
2. issue tracker evidence with reproduction detail;
3. maintainer responses/fixes;
4. official documentation for capabilities/limits;
5. vendor benchmark claims only when clearly labeled as vendor claims.

Do not use star count or a single Reddit comment as a quality verdict.
