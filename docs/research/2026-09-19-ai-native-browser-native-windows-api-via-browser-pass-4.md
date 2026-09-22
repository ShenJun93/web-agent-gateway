# AI-native Browser Research — Pass 4: Native Paths, Windows Reliability, and API-via-Browser

Date: 2026-09-19
Status: RESEARCH RECEIPT — no local benchmark
Repository: `ShenJun93/web-agent-gateway`

## Purpose

Continue research after Pass 3. This pass focuses on:

1. native provider browser reliability on Windows;
2. first-party Playwright failure semantics;
3. Browser Harness security/privacy/lifecycle findings;
4. real-profile bridge ownership;
5. a newly important category: authenticated API-via-browser tools such as OpenTabs.

No local install or benchmark was performed.

Remote canonical `main` was fresh-verified at:

`c80fc60d2ccceac34e456869c9ad494d8e08727f`

before this branch was created.

The local Windows connector remains unavailable, so local worktree/HEAD is not independently verified.

## Main correction

The ecosystem should no longer be modeled as one list of "browser agents."

There are at least four materially different lanes:

1. **provider-native real browser** — ChatGPT Desktop/Chrome, Claude in Chrome;
2. **provider-neutral browser control substrate** — Playwright, Panerelay, Browser Harness, Playwriter, browser bridges;
3. **authenticated API-via-browser** — OpenTabs-style tools that call a web app's internal API through the user's signed-in browser;
4. **cloud/headless/offload** — Browserbase, Kernel, Browserless, Steel, Notte, Hyperbrowser, Anchor, Browser Run/Kitesurf.

These lanes solve different failure modes and should not be ranked as if they were interchangeable.

## 1. OpenAI native browser — directionally right, Windows bridge still not boring

Official current behavior:

- ChatGPT Desktop has a built-in browser on Windows/macOS with its own browser state.
- OpenAI explicitly recommends the Chrome extension when the task needs the user's existing Chrome profile, signed-in session, open tabs, or installed extensions.
- Browser work is integrated into Work/Codex.
- Site tools use WebMCP in the built-in desktop browser.
- Atlas has been deprecated and browser-agent work moved into ChatGPT/Codex.
- The extension now supports additional Chromium browsers beyond Chrome.

This is the strongest evidence that provider-specific OpenAI browser mechanics should not be duplicated unless ChatGPT Web has a measured gap.

However, current Windows issue evidence remains significant.

A detailed Codex Desktop report shows:

- trivial Chrome use can take almost two minutes;
- both Chrome and in-app-browser setup paths can hang to the outer 120-second timeout;
- native/plugin diagnostics can all report healthy while the shared browser bridge is unusable;
- Windows file-lock/access-denied errors can break plugin update/uninstall;
- IPC EPIPE/disconnect errors appear in the same failure window.

The important inference is not "OpenAI browser is bad." It is:

**native integration reduces product-layer duplication but does not eliminate Windows lifecycle/IPC failure classes.**

Disposition:

**TOP NATIVE COMPARATOR.**
**DO NOT RETIRE LOCAL SUPERVISION ON NATIVE-PROVIDER REPUTATION ALONE.**

Official sources:
- https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app
- https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work
- https://help.openai.com/en/articles/20001423-using-site-tools-in-the-chatgpt-desktop-app

Failure evidence:
- https://github.com/openai/codex/issues/21670

## 2. Claude in Chrome — deterministic ownership bug is more serious than "random tab confusion"

Pass 3 recorded community reports of browser/profile targeting instability.

Pass 4 found a stronger mechanism-level report:

`select_browser` can be account-wide rather than session-scoped. In the reported Windows setup, one Claude session selecting profile B silently moves another session that had selected profile A. The displaced session receives no clear ownership-change signal and can continue browser work in the wrong authenticated account.

This is materially relevant to the user's 10–15 concurrent-session target.

A separate Windows report demonstrates that "Always allow" for site permission can be persisted as a one-shot grant, causing repeated permission blocking during unattended work.

These are not cosmetic UX defects. They reveal two missing primitives:

1. durable session-scoped browser ownership;
2. durable, auditable permission state.

Those two primitives are exactly why WAG/SessionCommander-style owner identity cannot yet be deleted merely because a native extension exists.

Disposition:

**NATIVE COMPARATOR WITH HIGH PRODUCT INTEGRATION VALUE.**
**NOT A MULTI-SESSION OWNERSHIP BASELINE YET.**

Sources:
- https://github.com/anthropics/claude-code/issues/88057
- https://github.com/anthropics/claude-code/issues/77239
- https://github.com/anthropics/claude-code/issues/74715
- https://support.claude.com/

## 3. Playwright remains the strongest provider-neutral baseline, but daily-profile attachment has a fundamental liveness hazard

A current Playwright MCP issue gives a strong reproduction on Windows 11:

- MCP connects to a real Chrome profile through CDP;
- one Chrome Memory Saver-discarded tab can cause `connectOverCDP()` to hang until timeout;
- raw browser-level CDP calls remain healthy in milliseconds;
- the unresponsive page target never responds to runtime/page commands;
- waking the discarded tab restores Playwright connection.

This means long-lived real-profile attachment inherits browser tab lifecycle state that normal test-profile automation does not encounter.

The practical split is now clearer:

### Playwright-owned dedicated profile

Good for:
- deterministic testing;
- bounded lifecycle;
- headless/offscreen work;
- repeatable cleanup;
- concurrent isolated sessions.

### Playwright attached to daily browser

Good for:
- existing authentication;
- real extensions/history/browser identity.

But:
- ownership is external;
- idle timeout only detaches;
- discarded/dead targets can wedge the attach path;
- profile/tab lifecycle is not controlled by Playwright.

Therefore "Playwright is first-party" does not remove the need to distinguish **owned browser** from **attached browser**.

Disposition:

**PRIMARY PROVIDER-NEUTRAL SUBSTRATE.**
Use owned/dedicated profiles by default for unattended automation; use attached daily browser only when existing authenticated identity is actually required.

Sources:
- https://github.com/microsoft/playwright-mcp/issues/1757
- https://github.com/microsoft/playwright-mcp
- https://github.com/microsoft/playwright-cli

## 4. Browser Harness security findings materially lower its current rank

Two current issue reports are especially consequential.

### Windows ACL / executable-workspace issue

On Windows, the harness currently skips POSIX-style permission hardening for directories holding:

- auth records;
- agent workspace files;
- an `agent_helpers.py` path loaded with `exec_module()`;
- an `.env` capable of changing network behavior.

The issue's concern is not that Windows lacks POSIX chmod; it is that an unimplemented Windows ACL hardening step is silently treated as if no hardening were required.

### Telemetry path bypasses the project's own redaction

A separate report identifies that CLI telemetry can include:

- the task script;
- stdout;
- helper arguments;
- error output;

while the project's existing forbidden-key/redaction filter is applied to a different telemetry path.

The report shows values such as password/text/url arguments can reach PostHog when telemetry is enabled by default.

These reports require maintainer resolution before Browser Harness should be placed ahead of first-party Playwright for sensitive authenticated browsing.

### Existing lifecycle issue remains

Concurrent daemon start is still a check-then-act race that can leave an unreachable orphan daemon holding CDP sessions/background tabs.

Disposition:

**DEMOTE FROM "DEFAULT LOCAL #1" TO "HIGH-POTENTIAL, SECURITY/LIFECYCLE FIXES REQUIRED."**

Sources:
- https://github.com/browser-use/browser-harness/issues/813
- https://github.com/browser-use/browser-harness/issues/681
- https://github.com/browser-use/browser-harness/issues/692

## 5. whg517/browser-bridge — architecture is strong, Windows broker ownership is explicitly unproven

The project is directly relevant because it separates:

- thin MCP client server;
- shared broker;
- Chrome native host.

The broker is intended to outlive individual MCP client/server processes so multiple agents can share the browser without losing the bridge.

The project's own Windows verification issue correctly identifies the risk:

if an MCP client places its child server in a Windows Job Object with `KILL_ON_JOB_CLOSE`, the spawn-and-forget broker can inherit that job and die when one client exits. That would break the multi-client promise.

The issue includes a proper real-Windows acceptance matrix but the checklist is still unverified.

A separate Windows issue shows upgrades can fail while the bridge/native-host executable is running and can leave temp artifacts.

This is good engineering transparency, but it means the project is not yet evidence for deleting SessionCommander ownership logic.

Disposition:

**EXCELLENT TRANSPORT/OWNERSHIP DONOR.**
**WINDOWS ACCEPTANCE STILL OPEN.**

Sources:
- https://github.com/whg517/browser-bridge/issues/192
- https://github.com/whg517/browser-bridge/issues/133

## 6. open-browser-use — relevant but Windows native-host evidence still weak

Current Windows issue evidence shows a case where:

- registry entry exists;
- native-host manifest is correct;
- extension ID matches;
- executable exists;
- host works when launched manually;

but Chrome's `connectNative` still reports "Specified native messaging host not found."

This is precisely the sort of integration defect that is expensive for a solo operator because every component can look individually healthy while the end-to-end path fails.

Another issue shows stale-socket cleanup can remove a still-live socket when a permission failure is misclassified.

Disposition:

**WATCH/CODE REVIEW.**
The architecture is attractive but Windows integration proof is not strong enough to prefer over Playwright/native provider paths.

Sources:
- https://github.com/iFurySt/open-browser-use/issues/20
- https://github.com/iFurySt/open-browser-use/issues/22

## 7. OpenTabs — new high-value lane: semantic authenticated API-via-browser

OpenTabs is not merely another click/type browser controller.

Architecture:

- Chrome extension + localhost MCP server;
- agent operates in the user's already-authenticated browser session;
- plugins call the same internal APIs used by the web app frontend;
- built-in browser tools remain available as fallback;
- full MCP, two-tool gateway MCP, and CLI modes are supported;
- local auth secret protects the server;
- no cloud relay/account is required for the core server;
- plugin/tool permission levels include Off / Ask / Auto;
- plugin permissions reset on update;
- audit logging is part of the security model;
- MIT license.

This is strategically interesting because a stable semantic operation:

`slack_send_message(channel, text)`

is often cheaper and more reliable than:

`snapshot -> find button -> click -> type -> click -> verify`.

It also lowers context/tool-schema cost through gateway/CLI modes.

Public adoption signal is materially stronger than most small real-profile bridges: the public GitHub repository has hundreds of stars/forks and a broad plugin catalog.

### But the failure mode moves upward, not away

OpenTabs depends on internal web-app APIs and injected page adapters.

Current issues demonstrate:
- Outlook URL migration broke adapter readiness;
- Outlook and YouTube Trusted Types policies blocked adapter execution;
- a published package once shipped stale dist code that broke extension WebSocket connection;
- Windows cold daemon startup can flash many child console windows due update checks;
- plugin behavior can break when the target SaaS changes GraphQL shape, DOM/bootstrap state, CSP, or endpoint semantics.

This means OpenTabs trades **UI automation churn** for **internal-API/plugin maintenance churn**.

For stable high-frequency SaaS workflows, that trade can be excellent.
For arbitrary browsing, it cannot replace a general browser controller.

### Replacement potential

OpenTabs can plausibly replace:
- repeated UI automation for supported SaaS;
- some connector-style bespoke integrations;
- some browser action/token overhead;
- some MCP tool-schema overhead through gateway/CLI mode.

It cannot replace:
- WAG authority;
- arbitrary site interaction;
- browser lifecycle ownership;
- local process supervision;
- durable effect approval;
- a standard public API when one exists.

Disposition:

**PROMOTE TO SEPARATE HIGH-VALUE "API-VIA-BROWSER" LANE.**
Do not compare it directly against Playwright as a single winner.

Sources:
- https://opentabs.dev/
- https://opentabs.dev/docs/reference/mcp-server
- https://github.com/opentabs-dev/opentabs

## 8. browser4agent — useful two-way bridge, currently early

browser4agent offers both directions:

- coding agent -> browser via MCP/CLI;
- browser DevTools/side-panel -> coding agent via ACP.

It supports Chrome, Edge, Firefox and can read page content, cookies/storage, errors, screenshots and low-level Chromium CDP.

Its recent release explicitly changed agent-created tabs to quiet/background behavior, which matches the user's no-focus-stealing requirement.

But current public adoption is still small, and its own README warns that prompt injection in the connected agent can expose browser data. Multiple installed browser instances also contend for one local listening port.

Disposition:

**WATCH / UX DONOR.**
The two-way ACP concept is useful, but it is not yet stronger evidence than Playwright/Panerelay/established native paths.

Source:
- https://github.com/mantou132/browser4agent

## 9. Community experience reinforces a two-mode strategy

Recent community reports repeatedly converge on this split:

### Human-visible, authenticated, short/interactive work

Use:
- native browser integration;
- attached real browser;
- extension bridge.

Benefits:
- real login;
- real identity/fingerprint;
- direct visibility.

Problems:
- focus/tab ownership;
- permission prompts;
- session drift;
- extension/native-host lifecycle.

### Unattended or durable automation

Use:
- dedicated Playwright/browser profile;
- cloud browser/container;
- explicit session ownership and restart semantics.

Benefits:
- deterministic lifetime;
- isolation;
- recoverability;
- scalable concurrency.

Problems:
- separate authentication/profiles;
- cloud cost or local process cost;
- stronger bot detection on some sites.

Community reports also increasingly prefer Playwright CLI/direct scripting over large MCP browser tool catalogs for token efficiency.

This matches the project's desired reuse rule better than trying to force one browser solution across every workflow.

## Revised architecture hypothesis

```text
A. Provider-specific interactive auth work
   -> OpenAI native browser / Claude in Chrome

B. Provider-neutral arbitrary browser control
   -> Playwright-first
   -> Panerelay / vetted real-profile bridge only when daily-profile auth is needed

C. Stable high-frequency SaaS operations
   -> official API/plugin first
   -> OpenTabs-style API-via-browser only when no suitable official connector/API exists

D. Bursty/unattended/parallel web automation
   -> dedicated Playwright profile or managed cloud browser

All consequential local effects
   -> WAG authority / local approval / durable effect ownership

Local runtime residue
   -> bounded SessionCommander/Cleanup Sidecar supervision until the chosen substrate proves containment
```

## Reuse-order implication

The reuse order becomes more precise:

```text
OFFICIAL APP/API/PLUGIN
-> PROVIDER-NATIVE BROWSER
-> STANDARD PLAYWRIGHT / WEBMCP
-> PROVEN SEMANTIC BROWSER TOOL (e.g. OpenTabs)
-> PROVEN REAL-PROFILE BRIDGE
-> MANAGED BROWSER SERVICE
-> THIN COMPOSITION
-> CUSTOM BROWSER MECHANICS ONLY AS LAST RESORT
```

## Current decisions

```text
COMMUNITY_PASS_4 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
RESEARCH_CONTINUES = YES

OPENAI_NATIVE_BROWSER = TOP_PROVIDER_NATIVE_COMPARATOR
CLAUDE_IN_CHROME = TOP_PROVIDER_NATIVE_COMPARATOR_BUT_MULTI_SESSION_OWNERSHIP_RISK
PLAYWRIGHT = PRIMARY_PROVIDER_NEUTRAL_BASELINE
PLAYWRIGHT_DAILY_PROFILE_ATTACH = AUTH_ONLY_SPECIAL_CASE
BROWSER_HARNESS = DEMOTED_PENDING_SECURITY_AND_LIFECYCLE_FIXES
PANERELAY = HIGH_VALUE_THIN_TRANSPORT_DONOR
WHG517_BROWSER_BRIDGE = HIGH_VALUE_OWNERSHIP_DONOR_WINDOWS_GATE_OPEN
OPEN_BROWSER_USE = WATCH_WINDOWS_NATIVE_HOST_RISK

OPENTABS = PROMOTED_NEW_API_VIA_BROWSER_LANE
BROWSER4AGENT = WATCH_UX_DONOR

GENERIC_WAG_BROWSER_ACTION_GROWTH = FREEZE
WAG_AUTHORITY_CORE = RETAIN
ADR_0019_APPROVAL_BOUNDARY = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN_BOUNDED
NEW_CUSTOM_AI_NATIVE_BROWSER = DO_NOT_BUILD

NEXT_ACTION = CONTINUE_RESEARCH_NOT_BENCHMARK
```

## Next research pass

Research should continue on:

1. OpenTabs maintenance velocity, security model, plugin supply-chain/update behavior and SaaS breakage rate.
2. Whether official APIs/plugins can replace OpenTabs categories before using internal APIs.
3. OpenAI/Anthropic issue-fix velocity for Windows browser ownership/lifecycle defects.
4. Playwright dedicated-profile vs extension-attach concurrency and cleanup evidence.
5. Panerelay / whg517 / Playwriter real Windows sustained-use evidence.
6. Browser Harness maintainer response/fix velocity for #681/#692/#813.
7. Aside pricing, closed-source lock-in, host deadline semantics and multi-session isolation.
8. managed cloud session failure evidence where local machine pressure is the dominant problem.
