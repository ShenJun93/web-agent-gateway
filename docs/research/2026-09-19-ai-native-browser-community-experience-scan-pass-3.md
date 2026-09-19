# AI-native Browser Community Experience Scan — Pass 3

Date: 2026-09-19
Status: RESEARCH RECEIPT — expanded community/prior-art scan; no local benchmark
Repository: `ShenJun93/web-agent-gateway`

## Why this pass exists

Pass 2 had narrowed the local field and proposed a minimum empirical test. The user explicitly rejected stopping there and requested more research.

This pass therefore reopens the community/prior-art scan and corrects the previous shortlist where newer first-party or higher-signal options were missing.

No local install or benchmark was performed.

Remote canonical `main` was fresh-verified at:

`0b39345f39e1725ec41a75ef4a567c9a4b18564f`

before this branch was created.

The Windows Desktop Commander device remained unavailable for local worktree verification. Do not infer local HEAD from this receipt.

## Architectural authority remains unchanged

ADR-0018 and ADR-0019 remain normative.

A browser runtime may replace browser launch/attachment, profile plumbing, interaction transport, debugging, replay, session orchestration, or cloud browser provisioning.

It does not automatically replace:

- trusted caller admission;
- workspace/resource ownership;
- capability/risk policy;
- local approval authority;
- durable consequential-effect ownership;
- audit/evidence contracts;
- browser proposal vs consequential execution separation.

This distinction became more important, not less, during this pass because current Chrome guidance explicitly treats browser-agent prompt injection as an unsolved probabilistic risk.

## Major correction: first-party Playwright must precede Browser Harness in research

Pass 2 ranked Browser Harness first for local empirical testing.

That ordering is no longer justified without first evaluating Microsoft's current Playwright surfaces.

### Microsoft Playwright MCP

Current Playwright MCP supports:

- persistent profiles by default;
- isolated profiles;
- connection to the user's existing Chrome/Edge through the Playwright extension;
- existing login/cookie/extension reuse through extension mode;
- per-workspace profile separation;
- configurable idle timeout;
- shared browser context modes;
- Chrome, Edge, Firefox, and WebKit.

This removes much of the earlier assumption that a third-party harness was needed simply to reuse authenticated browser state.

Important limitations and failure evidence:

- a persistent profile can only be owned by one browser instance at a time; same-workspace concurrent clients conflict unless isolated or given distinct profiles;
- recent Windows/non-default-profile extension issues existed and required fixes;
- current issues include real-profile/Memory-Saver connection hangs and Windows persistent-profile failure paths;
- direct extension/CDP attachment gives broad browser authority and does not solve WAG's consequential-authority boundary.

### Microsoft Playwright CLI

Playwright CLI is now a separate first-party surface explicitly designed for coding agents.

Microsoft currently positions it as more token-efficient than Playwright MCP because the model does not need to load the full MCP tool schema and large browser outputs into context.

Community reports repeatedly prefer CLI/direct Playwright over MCP for coding-agent work due context/token cost.

Important distinction:

`Playwright CLI != Playwright MCP != raw Playwright scripts`.

Future research and benchmarks must treat these as separate modes.

### Playwright browser.bind interoperability

Current Playwright releases also expose a `browser.bind()` interoperability path that allows a launched browser to be attached by CLI, MCP, or additional Playwright clients.

This is strategically important because it may provide a standard upstream session-sharing primitive instead of custom WAG/Guardian browser session plumbing.

Disposition:

**PROMOTE TO TOP RESEARCH TIER.**

Do not benchmark Browser Harness first until first-party Playwright CLI/MCP-extension/browser.bind behavior has been fully compared on lifecycle, profile ownership, concurrency, Windows cleanup, and authority.

Sources:

- https://github.com/microsoft/playwright
- https://github.com/microsoft/playwright-mcp
- https://github.com/microsoft/playwright-cli
- https://playwright.dev/

## Chrome DevTools MCP — first-party diagnostics, not lifecycle authority

Google's Chrome DevTools MCP is highly relevant for:

- console/network/performance visibility;
- live Chrome debugging;
- source/debug information;
- existing Chrome attachment via `--autoConnect`;
- Windows/Edge workflows through documented client configurations.

However, current community/issue evidence is a direct match for the user's machine-pressure concerns:

- an open issue documents a long-lived server keeping an abandoned dynamic page alive at roughly 28–30% CPU for hours until an external lifecycle wrapper parks/recycles it;
- current troubleshooting warns that autoConnect to large real-browser sessions can wake/freeze many tabs and consume large resources;
- current issues include isolated/temp-profile Chrome trees surviving MCP death;
- previous issues document servers not exiting cleanly after stdin EOF and Chrome processes remaining after plugin disable;
- Windows autoConnect timeout reports remain active.

This is excellent first-party DevTools infrastructure, but public evidence argues against making it the sole process/session lifecycle owner.

Disposition:

**KEEP AS FIRST-PARTY DEBUG/OBSERVABILITY SUBSTRATE.**
**DO NOT RETIRE SessionCommander/Cleanup Sidecar based on Chrome DevTools MCP.**

Sources:

- https://github.com/ChromeDevTools/chrome-devtools-mcp
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1921
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2599
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2621

## Chrome's remote-debugging security change weakens raw-CDP-to-daily-profile strategies

Chrome's official security guidance changed the strategic baseline.

Since Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are not honored against the default Chrome user-data directory unless a non-standard `--user-data-dir` is supplied.

Google explicitly made this change because attackers were using remote debugging to steal cookies despite App-Bound Encryption.

Implication:

Any architecture whose core convenience claim is "turn on a raw remote-debugging port against the user's everyday default profile" is now strategically weaker.

Prefer, in order:

1. browser-native/extension consent paths;
2. first-party browser integration;
3. dedicated automation profiles;
4. raw CDP only where authority and lifecycle are explicitly bounded.

Source:

- https://developer.chrome.com/blog/remote-debugging-port

## Browser Harness — still relevant, but no longer unchallenged #1

Browser Harness remains a strong fit for real logged-in Chrome and coding agents.

Positive:

- background tab operation is intentionally preferred;
- current skill guidance distinguishes `switch_tab` from visible activation;
- default daemon reuse is encouraged instead of one daemon per task;
- explicit diagnostics/recovery guidance exists.

But current issue evidence remains material:

- Windows `ensure_private_dir()` permission hardening gap can leave auth token/workspace less protected;
- concurrent daemon startup can orphan one daemon;
- current-tab close can leave dangling session state;
- tab/session lifecycle recovery is still being consolidated;
- multi-agent shared-browser tab ownership is an open problem;
- long-running sessions can accumulate tabs;
- an iframe helper path can leak CDP sessions.

Disposition:

**RETAIN HIGH IN RESEARCH TIER, BUT REQUIRE A DEMONSTRATED ADVANTAGE OVER CURRENT FIRST-PARTY PLAYWRIGHT.**

Sources:

- https://github.com/browser-use/browser-harness
- https://github.com/browser-use/browser-harness/issues/813
- https://github.com/browser-use/browser-harness/issues/692
- https://github.com/browser-use/browser-harness/issues/582
- https://github.com/browser-use/browser-harness/issues/684

## Aside — materially stronger candidate than Pass 2 captured

Aside is now one of the most important candidates for this user's real-profile workflow.

Current public/developer evidence shows:

- Windows and macOS support;
- `aside` CLI;
- `aside mcp` for external agents;
- `aside repl` exposing a Playwright-like programmable browser surface;
- use of the user's actual authenticated browser/profile;
- password/vault design intended to keep credentials out of model context;
- local memory/task history plus optional sync/cloud components;
- approval gates for sensitive actions;
- agent tabs designed not to steal focus;
- an explicit coding-agent-oriented harness.

External adoption signal is now more meaningful:

- independent projects document Codex/Claude integrations;
- Garry Tan's `gstack` switched its browser-driver contract to Aside-first with a bundled-browser fallback;
- community reports describe actual logged-in workflows rather than only launch-day demos.

However, failure semantics matter:

A third-party `aside-skill` project documents live-tested behavior where older non-interactive `aside exec` could hang indefinitely waiting for a prompt; newer builds can deny the permission and continue with exit code 0, meaning a skipped action may only be visible in transcript/evidence unless the host enforces stronger success markers and deadlines.

Privacy/security is also not "all local":

Aside's own privacy policy states hosted model requests can receive model-visible prompts, tool results, selected browser snapshots/screenshots/files, and browser/vault sync is server-backed when those sync features are enabled.

Aside is closed/proprietary software under its Terms, so lock-in and inspectability are materially different from Playwright/Browser Harness/Panerelay.

Disposition:

**PROMOTE TO HIGH RESEARCH TIER FOR REAL-PROFILE WINDOWS WORK.**
**DO NOT TREAT EXIT CODE OR LOCAL-FIRST MARKETING AS SUFFICIENT RELIABILITY/PRIVACY EVIDENCE.**

Sources:

- https://aside.com/
- https://aside.com/policy/privacy
- https://aside.com/policy/terms
- https://aside.com/blog/how-we-built-the-sota-browser-agent-that-outperforms-fable
- https://github.com/lidge-jun/aside-skill
- https://github.com/garrytan/gstack

## Playwriter — strong architecture, smaller proof base

Playwriter remains attractive because it uses a Chrome extension + local relay against the real browser and exposes a compact programmable surface rather than dozens of low-level MCP tools.

Positive:

- existing user browser/profile;
- multiple agent sessions;
- Playwright-like execution;
- low tool-schema surface;
- no need to relaunch the browser with command-line debug flags.

Current concerns:

- public reports/issues include attachment/disconnect problems;
- detached relay/token startup behavior has had security/operational issues;
- Windows detachment has appeared historically;
- community volume is much lower than Microsoft Playwright.

Disposition:

**CODE-REVIEW / SECONDARY RESEARCH CANDIDATE.**

Source:

- https://github.com/remorses/playwriter

## Agent360 Browser MCP — interesting concurrency claim, but current behavior conflicts with user's UX goal

Agent360 Browser MCP directly targets the user's real logged-in Chrome and advertises up to 20 concurrent sessions.

The project is unusually explicit about current limitations and recently corrected inaccurate claims about Playwright MCP.

However, current public documentation says `browser_switch_tab` activates the target and brings its window to the foreground. Background event delivery also has limitations for browser-owned trusted events.

That is a poor fit for a workload where agent browser activity must not continually steal focus.

Disposition:

**WATCH; DO NOT PROMOTE ABOVE Browser Harness/Panerelay/Playwright/Aside yet.**

Source:

- https://github.com/Agent360dk/browser-mcp

## Panerelay remains architecturally important

Panerelay still has a unique design property:

- existing Chrome/Edge;
- explicitly authorized tabs;
- virtual agent-side tab selection;
- background automation intended not to activate/steal focus;
- providers for agent-browser and Browser Use;
- no requirement to relaunch daily Chrome with a raw debugging port.

Its major weakness remains evidence volume, not conceptual fit.

Disposition:

**KEEP HIGH IN CODE-REVIEW TIER.**

Source:

- https://github.com/F-loat/panerelay

## Windows ODR / MCP containment — strategically important but not production-ready

Microsoft's Windows On-device Agent Registry (ODR) is the most important OS-level prior art found in this pass.

Current preview design provides:

- discovery/management of MCP servers at OS level;
- contained execution in a separate Windows session;
- separate agent user account;
- no direct access to the user's files/settings/registry/credentials/apps/windows by default;
- explicit resource grants;
- audit/logging and admin/Intune controls.

This maps directly to the stronger OS isolation class that ADR-0019 leaves open for future consequential authority.

But it is not ready to replace WAG today:

- Microsoft explicitly labels the feature prerelease;
- containment requires packaged identity/MSIX-style registration for the strong path;
- MCP bundles/unpackaged servers do not get the same containment by default;
- current public issue #60 reports `odr.exe` returning feature-disabled on a recent Windows build;
- contained servers cannot directly see/control apps/windows in the user's interactive session;
- current documentation notes user-file permissions are granted to the host/session rather than cleanly isolated per server.

Therefore ODR may eventually replace significant WAG native-host/discovery/isolation plumbing, but it does not directly solve "control my current authenticated browser" and cannot be current production authority.

Disposition:

**STRATEGIC WATCH / ARCHITECTURE CONSTRAINT.**
Avoid building large new Windows discovery/packaging abstractions without re-checking ODR first.

Sources:

- https://learn.microsoft.com/windows/ai/mcp/overview
- https://learn.microsoft.com/windows/ai/mcp/servers/mcp-containment
- https://learn.microsoft.com/windows/ai/mcp/odr-tool
- https://github.com/microsoft/mcp-on-windows-samples/issues/60

## WebMCP strengthens ADR-0019 rather than replacing it

Chrome's September 2026 WebMCP security guidance explicitly states:

- prompt injection cannot be guaranteed safe inside the LLM;
- malicious tool manifests and contaminated tool outputs are relevant attack vectors;
- agents should use deterministic guardrails;
- cross-origin access should be restricted;
- consequential actions should require confirmation;
- untrusted-content/read-only/consequential annotations are useful but are hints, not an authority system.

This closely aligns with WAG's existing separation between browser proposal and consequential execution authority.

WebMCP is therefore a useful semantic/native web tool layer, but not a replacement for WAG's authority boundary.

Sources:

- https://developer.chrome.com/docs/ai/webmcp/secure-tools
- https://developer.chrome.com/docs/agents/security

## Recent browser-agent security research reinforces least authority

Forever Security's September 16, 2026 BragJack report claims ordinary extensions could hijack built-in browser agents across several major agentic-browser products. The report says two CVEs were assigned and multiple vendors paid bounties.

This is third-party security research and should not be generalized beyond its demonstrated cases.

But it reinforces a conservative architectural rule:

**real-profile convenience must not imply consequential machine authority.**

Browser agent transport should remain separable from local code/process/Git/deployment authority.

Source:

- https://forever.security/blog/bragjack-attack-hijacks-every-browser-agent

## Cloud/offload expansion

### Browserless

Browserless is a mature cloud/self-host browser infrastructure option with:

- persisted sessions/replays;
- proxies;
- automatic CAPTCHA solving;
- Chrome extensions;
- multiple browser engines;
- high concurrency on paid plans;
- enterprise self-host/private deployment.

Current public pricing ranges from free 2-concurrent/2-minute sessions through higher paid concurrency and enterprise private deployment.

Important lock-in/license point:

Self-host/commercial use is not simply permissive open source. Browserless uses SSPL/commercial licensing, and enterprise pricing explicitly includes commercial self-host licensing.

Community/issue evidence also includes operational problems such as long-lived connection/session failures and container crashes in some older/current reports.

Disposition:

**PROMOTE TO CLOUD/OFFLOAD SECONDARY; NOT A LOCAL REAL-PROFILE REPLACEMENT.**

Sources:

- https://www.browserless.io/pricing
- https://github.com/browserless/browserless

### Notte

Notte now has:

- cloud browser sessions;
- profiles/accounts/vault-style primitives;
- coding-agent CLI/skills;
- CAPTCHA/proxy infrastructure;
- observability/replay.

Its CLI skill surface is MIT, but the main Notte repository is SSPL-1.0.

Independent sustained-use evidence remains thinner than Browserbase.

Disposition:

**CLOUD WATCH / PRICE-COMPETITIVE SECONDARY.**

Sources:

- https://github.com/nottelabs/notte
- https://github.com/nottelabs/notte-cli

### Anchor Browser

Anchor provides:

- authenticated cloud browsers;
- CAPTCHA bypass;
- Cloudflare Verified Browser Agents;
- managed concurrency;
- BYOC/on-prem on higher plans;
- enterprise compliance claims.

Community evidence remains comparatively thin.

Disposition:

**CLOUD WATCH.**

Source:

- https://anchorbrowser.io/testing-pricing

## Agent-native lightweight browser engines

These are important for machine pressure/offload, but they are a different lane from the user's authenticated daily browser.

### Lightpanda

Lightpanda is highly resource-efficient and agent-focused, but it is not suitable as the current sensitive authenticated-session default.

Material security history in 2026 includes patched High/Critical browser-origin/cookie isolation vulnerabilities, including cross-origin cookie leakage and Same-Origin Policy bypasses.

It remains headless and does not provide the user's normal interactive authenticated browser identity.

Disposition:

**STATELESS/LOW-TRUST RESEARCH LANE ONLY.**

Sources:

- https://github.com/lightpanda-io/browser
- https://github.com/lightpanda-io/browser/security

### Moli

Moli is a newer Rust browser with Windows support, standard CDP/WebDriver/BiDi surfaces, profile/cookie/storage controls, on-demand layout/rendering, and permissive Apache-2.0/MIT licensing.

Its own published benchmark reports materially better compatibility than Lightpanda/Obscura while using far less memory than Chrome, but these remain vendor/project benchmarks.

The project explicitly has no persistent GUI window and does not pursue pixel-perfect/full-media Chromium parity.

Disposition:

**PROMISING STATELESS/DEDICATED-HEADLESS LANE; NOT DAILY REAL-PROFILE REPLACEMENT.**

Source:

- https://github.com/lexmount/moli

### Obscura

Obscura is an Apache-2.0 Rust/V8 headless browser with CDP and claimed anti-detect support.

The project is extremely active, but current issues show ongoing browser-semantics compatibility work and an open request for persistent MCP cookie/session storage.

Disposition:

**WATCH FOR HEADLESS/OFFLOAD, NOT AUTHENTICATED DAILY PROFILE.**

Source:

- https://github.com/h4ckf0r0day/obscura

### h5i

h5i is unusually interesting for a different reason: it focuses on agent red-teaming, explicit network policy, auditability, sandboxing and request recording rather than pretending to be a normal user's browser.

This makes it potentially useful for future bounded security/testing workflows, not as the user's general authenticated browser.

Disposition:

**SECURITY/TESTING DONOR, NOT PRIMARY BROWSER.**

Source:

- https://github.com/h5i-dev/h5i

## Revised research tiers

This is **not yet an empirical benchmark order**.

### Tier A — first-party / strongest real-profile research

1. Microsoft Playwright MCP extension
2. Microsoft Playwright CLI + browser.bind
3. Aside CLI/MCP/REPL
4. Browser Harness

### Tier B — architecturally attractive real-profile options

5. Panerelay + agent-browser
6. Playwriter
7. BrowserOS neo
8. open-browser-use
9. Opera browser CLI / Neon MCP

### Diagnostics substrate

10. Chrome DevTools MCP

### Watch / current mismatch

11. Agent360 Browser MCP
12. smaller real-profile bridges

### Cloud/offload

- Browserbase
- Kernel
- Browserless
- Steel
- Notte
- Hyperbrowser
- Anchor
- Cloudflare Browser Run/Kitesurf

### Lightweight/headless infrastructure lane

- Moli
- Lightpanda
- Obscura
- h5i

## Consequences for custom code

The new evidence increases pressure to **freeze expansion** of custom browser-control plumbing.

Especially avoid duplicating:

- Playwright CLI/MCP interaction primitives;
- standard browser session interoperability if `browser.bind` is sufficient;
- generic DevTools observability;
- generic cloud browser fleet management;
- browser-side accessibility snapshot/action schemas.

Potential WAG browser code retirement remains plausible.

But current evidence still does **not** justify retiring:

- WAG authority/admission;
- ADR-0019 local approval transition;
- durable consequential job/effect ownership;
- owner-aware cleanup/supervision;
- Guardian's continuity/context-warning mission.

## Research state

Pass 2's statement `COMMUNITY_SCAN_STOP_CONDITION = MET` is superseded by the user's explicit request to continue research.

Current markers:

```text
COMMUNITY_PASS_3 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
COMMUNITY_SCAN_STOP_CONDITION = REOPENED_BY_USER
PLAYWRIGHT_FIRST_PARTY = PROMOTED_TO_TOP_RESEARCH_TIER
ASIDE = PROMOTED_TO_HIGH_RESEARCH_TIER
BROWSER_HARNESS = HIGH_TIER_BUT_MUST_BEAT_FIRST_PARTY_PLAYWRIGHT
CHROME_DEVTOOLS_MCP = DEBUG_SUBSTRATE_NOT_LIFECYCLE_AUTHORITY
WINDOWS_ODR = STRATEGIC_WATCH_NOT_PRODUCTION_FOUNDATION
RAW_DAILY_PROFILE_CDP = STRATEGICALLY_DEMOTED
WEBMCP = SEMANTIC_LAYER_NOT_AUTHORITY_LAYER
LIGHTWEIGHT_BROWSER_LANE = SEPARATE_FROM_REAL_PROFILE_LANE
RETIRE_WAG_AUTHORITY_BOUNDARY = NO
RETIRE_OWNER_AWARE_CLEANUP = NO
NEXT_ACTION = CONTINUE_COMMUNITY_RESEARCH
```

## Next research directions

Continue research before proposing local benchmarks:

1. compare first-party Playwright MCP extension vs CLI/browser.bind failure/lifecycle semantics in detail;
2. deepen Aside Windows community evidence, cleanup, concurrency, privacy and closed-source lock-in;
3. verify Playwriter and Panerelay sustained Windows multi-agent use rather than only maintainer tests;
4. inspect BrowserOS neo/open-browser-use movement since Pass 1 for fixes to earlier blockers;
5. deepen Browserbase/Kernel/Browserless/Notte/Anchor real-user production reports;
6. track Windows ODR maturity and whether its containment model becomes available/stable on normal Windows 11 builds;
7. look for additional serious external-agent browser surfaces with real-profile access before closing the scan again.


## Native platform correction — OpenAI and Anthropic must be first-class comparators

The expanded scan found that browser-agent capability is no longer only an OSS/service-layer problem. OpenAI and Anthropic now ship native real-profile browser integrations, so the project reuse order requires evaluating those surfaces before custom browser transport.

### ChatGPT Desktop built-in browser + official ChatGPT browser extension

OpenAI currently documents two distinct browser paths on Windows and macOS:

1. a built-in browser inside ChatGPT Desktop with its own browser state; and
2. the official ChatGPT browser extension for tasks that need the user's existing browser profile, signed-in session, open tabs, and installed extensions.

The official extension is designed to let ChatGPT Work/Codex operate in background tabs without taking over the user's active browsing session. OpenAI's September 2026 release notes also state support for Edge, Brave, Opera, and Vivaldi in addition to Chrome, although feature parity differs by browser.

OpenAI has also deprecated Atlas and explicitly moved browser-agent investment into ChatGPT/Codex. Therefore Atlas is no longer a serious standalone replacement candidate.

This is strategically important for this user's stack: the native OpenAI browser path can plausibly eliminate some provider-specific ChatGPT browser-control glue if the workflow can move from ChatGPT Web to ChatGPT Desktop/Work/Codex.

But current Windows public failure evidence is substantial:

- Windows Browser/Chrome bridge setup can hang or fail to expose the privileged native pipe;
- Windows Browser Use can leave orphaned Chrome processes after Codex execution;
- the in-app browser has repeated reports where closing/finalizing the last browser tab terminates the entire desktop app and interrupts other active tasks;
- the in-app browser can steal foreground focus when opening browser windows/tabs;
- Windows browser screenshot routing has reported wrong-window fallback behavior.

These are direct matches for the user's existing machine-pressure and multi-session concerns.

Disposition:

**PROMOTE OPENAI NATIVE BROWSER STACK TO TOP RESEARCH TIER.**

However:

- it is not a ChatGPT Web production adapter;
- it is provider-specific rather than provider-neutral;
- current Windows lifecycle evidence is not strong enough to retire owner-aware cleanup;
- the browser extension/native pipe is not a public stable transport contract for arbitrary external clients.

Sources:

- https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app
- https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work
- https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- https://github.com/openai/codex/issues/32462
- https://github.com/openai/codex/issues/33662
- https://github.com/openai/codex/issues/43347
- https://github.com/openai/codex/issues/36645

### Reusing the OpenAI native browser bridge

A small independent project, `DeliciousBuding/codex-browser-bridge`, demonstrates that the ChatGPT Desktop browser bridge can be wrapped as an MCP server by speaking to the existing Windows named pipe.

This is valuable prior art because it shows that a thin composition layer may be possible without reimplementing browser/profile transport.

But the project is independent of OpenAI and relies on an internal/local bridge protocol. It has a small adoption footprint and no guarantee that the pipe/protocol remains a supported external contract.

Disposition:

**HIGH-VALUE PRIOR ART / WATCH.**
Do not build product authority on an undocumented provider-internal pipe without an accepted compatibility strategy.

Source:

- https://github.com/DeliciousBuding/codex-browser-bridge

### Claude in Chrome

Anthropic's official Claude in Chrome extension can be driven from Claude Code/Cowork and works against the user's existing authenticated browser state.

This is another native-first comparator and is especially relevant because the user already uses Claude Code.

However, Windows issue history is also materially rough:

- browser connection can remain unavailable despite correct native-host configuration;
- auto-updates have broken browser connection;
- stale/incorrect "connected" states have been reported;
- Windows named-pipe/native-host defects have occurred;
- startup can wedge when Chrome is not running;
- multi-browser/tab ownership interference has been reported;
- community users have built hooks to pin each Claude Code session to its own tab because concurrent sessions can cross-control browser tabs.

Disposition:

**PROMOTE TO NATIVE COMPARATOR, NOT RELIABILITY BASELINE.**

It is useful evidence that browser transport should be upstream/provider-native where possible, but it is not evidence that custom lifecycle/ownership supervision can be removed.

Sources:

- https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
- https://github.com/anthropics/claude-code/issues/77400
- https://github.com/anthropics/claude-code/issues/93751
- https://github.com/anthropics/claude-code/issues/62141
- https://github.com/anthropics/claude-code/issues/72677

## New local bridge prior art

### whg517/browser-bridge

This project is closer to WAG's historical browser bridge than most browser-agent libraries:

- extension + native messaging host;
- no raw remote-debugging port;
- real authenticated Chrome;
- broker multiplexing multiple MCP clients;
- service-worker/native-host restart tolerance;
- per-agent identities;
- broker auto-exit after the last client;
- per-site approval plus confirmations for higher-risk actions;
- Apache-2.0;
- Windows x64 prebuilt path.

The most important caveat is visible in its own current issue tracker: Windows broker survival across MCP client/server exit still needs explicit verification because Windows Job Object `KILL_ON_JOB_CLOSE` semantics can undermine the intended durable broker lifecycle.

Its public adoption is still small.

Disposition:

**PROMOTE TO CODE-REVIEW TIER AS A DIRECT WAG BROWSER-TRANSPORT DONOR.**
Do not promote to replacement on community evidence alone.

Source:

- https://github.com/whg517/browser-bridge

### vitalysim/browser-bridge

This project is feature-rich and demonstrates another real-profile extension + localhost server architecture with recording, network capture, security-testing tools and "watch mode".

Its own commit history contains valuable operational evidence: stale service/extension builds, socket blips, lost final batches on tab close, debugger detach reasons and abandoned intercepts all required explicit fixes.

Windows currently lacks the same built-in service/autostart integration that Linux/macOS have.

Disposition:

**USE AS FAILURE-MODE / OBSERVABILITY DONOR, NOT PRIMARY REPLACEMENT CANDIDATE.**

Source:

- https://github.com/vitalysim/browser-bridge

## BrowserOS neo re-check worsens the Windows lifecycle assessment

Fresh September issue evidence adds two severe lifecycle signals:

- Windows `browseros-claw-server` dead loopback connections can grow without bound; one report measured roughly 13.9k established sockets in five days and warned of system-wide ephemeral-port exhaustion;
- a native-messaging regression can orphan host processes; one report measured 1,196 leaked processes, ~20 GB memory and hundreds of thousands of handles in 21 hours.

These are unusually close to the user's actual machine-pressure failure mode.

BrowserOS neo remains interesting as an AI-native browser, but this evidence lowers its priority for Windows operational use until those lifecycle defects are resolved and independently revalidated.

Sources:

- https://github.com/browseros-ai/BrowserOS/issues/2592
- https://github.com/browseros-ai/BrowserOS/issues/2072

## Browserbase local CLI is not automatically cleanup-free

The newer Browserbase `browse` CLI is strategically interesting because it offers one coding-agent CLI that can work locally and route to Browserbase cloud.

But its local path is daemon-based. Official skill/reference material explicitly documents:

- `browse stop` for cleanup;
- zombie-daemon recovery using process kill;
- named sessions to prevent parallel-session conflicts;
- separate zombie cleanup per session;
- loop-process cleanup for tracing after crashes.

Therefore Browserbase's cloud path can remove local browser-process ownership, but its local CLI should not be treated as a solved replacement for SessionCommander cleanup.

Sources:

- https://www.browse.sh/
- https://github.com/browserbase/skills

## Consumer-native browser agents are relevant directionally, but not composable replacements

Google Chrome/Gemini and Microsoft Edge now have native agentic browsing surfaces:

- Gemini in Chrome can reason across tabs and, in supported markets/plans, perform auto-browse tasks with user confirmation for sensitive actions;
- Edge's Browse with Copilot can click/type/navigate locally in the browser;
- Google exposes computer-use models/APIs and WebMCP/Chrome DevTools for developers.

These confirm that agentic browsing is becoming a browser/platform primitive.

However, current consumer Gemini/Copilot browser modes do not expose the provider-neutral external coding-agent control contract WAG needs. They should not be confused with Chrome DevTools MCP, Playwright, WebMCP, or computer-use APIs.

Perplexity Comet and Dia also have community MCP/CDP wrappers, but those wrappers rely on browser-specific/CDP behavior rather than an official stable external authority surface.

Disposition:

**DIRECTIONAL WATCH, NOT WAG REPLACEMENT.**

Sources:

- https://blog.google/products-and-platforms/products/chrome/chrome-expands-apac/
- https://support.microsoft.com/en-us/microsoft-copilot/browse-with-copilot
- https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server

## Revised native-first research ordering

The earlier Tier A ordering is superseded.

For this user's actual Windows workflow, research should now distinguish **native provider paths** from **provider-neutral reusable substrates**.

### Native provider comparators

1. ChatGPT Desktop built-in browser / official ChatGPT browser extension
2. Claude in Chrome

These may be the lowest-maintenance solution for provider-specific workflows, but current Windows lifecycle issues prevent assuming they solve concurrency/cleanup.

### Provider-neutral reusable substrate tier

1. Microsoft Playwright CLI + `browser.bind()`
2. Microsoft Playwright MCP extension mode
3. Aside CLI/MCP/REPL
4. Browser Harness
5. Panerelay + Playwright/agent-browser/Browser Use
6. Playwriter
7. whg517/browser-bridge

### Diagnostics / donor tier

- Chrome DevTools MCP
- vitalysim/browser-bridge
- h5i

### AI-native browser products to monitor, not currently prefer on Windows

- BrowserOS neo
- open-browser-use
- Opera/Neon browser CLI
- Agent360 Browser MCP
- other smaller bridges

## Replacement-impact correction

The expanded evidence suggests a narrower future WAG architecture may be viable:

```text
Provider/browser-native transport
    OR
Playwright/Panerelay/bridge substrate
            |
            v
thin provider adapter
            |
            v
WAG authority / ownership / approvals / durable effects
```

Potentially retireable if an upstream winner is proven:

- WAG-owned browser action schema;
- WAG-owned tab/snapshot/navigation mechanics;
- provider-specific Chrome/Edge transport;
- generic DevTools collection;
- browser launch/profile plumbing.

Still not retireable from current evidence:

- WebChat admission and opaque ownership;
- capability/risk policy;
- ADR-0019 local approval boundary;
- durable verify/mutation effect ownership;
- audit/evidence;
- owner-aware process cleanup for any local daemon/browser path;
- Guardian context/continuity functions.

The strategic goal is increasingly **make WAG thinner**, not **build a better browser**.
