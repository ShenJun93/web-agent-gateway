# AI-native Browser Community Experience Scan — Pass 4

Date: 2026-09-19
Status: RESEARCH RECEIPT — deeper lifecycle/standards/community audit; no local benchmark
Repository: `ShenJun93/web-agent-gateway`

## Purpose

Continue the user-requested community/prior-art research after Pass 3.

This pass deliberately does **not** install or benchmark local browser tooling. It deepens the evidence where the previous pass changed the architecture most:

1. OpenAI native browser reliability on current Windows builds.
2. Claude in Chrome ownership/reliability on Windows.
3. Microsoft Playwright CLI vs MCP extension vs `browser.bind()`.
4. WebMCP maturity and its relationship to WAG authority.
5. Direct real-profile bridge lifecycle gaps.
6. Cloud/offload lifecycle and lock-in.
7. Whether current evidence changes what WAG/Guardian/SessionCommander should own.

Remote canonical `main` was fresh-verified at:

`c80fc60d2ccceac34e456869c9ad494d8e08727f`

before this pass was written.

The local Windows Desktop Commander device remains unavailable, so local worktree/HEAD is not independently verified.

## Architectural authority remains unchanged

ADR-0018 and ADR-0019 remain normative.

A browser integration may replace:

- browser launch/attachment;
- profile/session plumbing;
- tab/action/snapshot mechanics;
- browser session interoperability;
- generic DevTools collection;
- cloud browser provisioning.

It does **not** automatically replace:

- trusted caller admission;
- opaque workspace/resource ownership;
- capability/risk policy;
- local operator approval authority;
- durable consequential-effect ownership;
- audit/evidence contracts;
- browser proposal vs consequential execution separation.

This distinction matters even more with WebMCP because a page-provided `consequentialHint` is metadata from an untrusted origin, not an execution credential or WAG approval.

## Executive result

The evidence increasingly points toward a **thinner WAG above upstream browser substrates**, not a new AI-native browser or a growing WAG-owned browser action platform.

The emerging reuse order is:

```text
provider-native browser path
    ->
site-native structured WebMCP tool when available
    ->
first-party Playwright substrate
    ->
managed cloud browser for offload/high concurrency
    ->
third-party real-profile bridge only for a measured gap
    ->
generic DOM/pixel/computer-use fallback
```

No current upstream removes the need for WAG authority/policy/approval/evidence.

No current Windows local browser path has enough public lifecycle evidence to retire owner-aware cleanup.

## 1. OpenAI native browser — native-first, not Windows lifecycle baseline

OpenAI's current browser direction is strategically important because provider-native transport should be preferred before custom adapters when the user is already operating inside ChatGPT/Codex.

Current product direction includes:

- ChatGPT/Codex desktop built-in browser;
- browser extension path for tasks that need the user's existing authenticated browser profile;
- WebMCP/site-tool support in the built-in browser;
- Atlas retired in favor of browser work inside ChatGPT/Codex.

However, current Windows issue evidence remains materially relevant to the user's exact failure mode.

### Orphan browser processes

OpenAI Codex issue #32462 remains open and reports Chrome processes left behind after `codex exec` on Windows, consuming CPU until manually killed.

Source:
- https://github.com/openai/codex/issues/32462

### Foreground focus interference

Issue #33662 remains open and was updated in September. It reports the in-app Browser bringing Codex to the foreground when a browser surface is opened, interrupting work in another active application.

Source:
- https://github.com/openai/codex/issues/33662

### Browser-use teardown crash remains reproducible on September builds

Issue #43347 remains open.

Independent comments report the Windows desktop application crashing immediately after Browser Use teardown across multiple builds, including:

- `26.901.6511.0`;
- `26.903.9818.0`;
- `26.908.4834.0`.

One September report correlated ten Browser Use closures with browser-process Crashpad captures between September 11 and September 14.

Importantly, some reproductions still had ordinary browser tabs open. The failure correlates with Browser Use session/tab teardown rather than requiring the entire browser UI to reach zero tabs.

Issue #36645 separately documents similar automatic Browser Use teardown crashes and later reproductions across newer Windows packages.

Sources:
- https://github.com/openai/codex/issues/43347
- https://github.com/openai/codex/issues/36645

### Interpretation

OpenAI native browser remains the first comparator for OpenAI-specific workflows because it minimizes custom integration.

It is **not** evidence that Windows browser lifecycle supervision is solved.

Current disposition:

```text
OPENAI_NATIVE_BROWSER = NATIVE_FIRST_COMPARATOR
OPENAI_NATIVE_WINDOWS_LIFECYCLE = NOT_BASELINE_RELIABLE_YET
RETIRE_LOCAL_CLEANUP_FROM_OPENAI_EVIDENCE = NO
```

## 2. Claude in Chrome — useful native integration, unresolved ownership semantics

Claude in Chrome remains the native comparator when Claude Code/Cowork needs the user's existing authenticated Chrome state.

But current Windows evidence still includes connection and ownership ambiguity.

### Native-host connection failures

Issue #77400 was closed as stale/not-planned rather than with verified fix evidence. The report contained a valid-looking Windows native-host registration yet Claude Code remained unable to connect.

Issue #62141 was closed as duplicate after an auto-update broke the browser connection.

Sources:
- https://github.com/anthropics/claude-code/issues/77400
- https://github.com/anthropics/claude-code/issues/62141

A closed/stale issue must not be treated as proof that the failure class is fixed.

### Stale/ghost browser registration

Issue #93751 is open from September 12.

Its follow-up corrected an initial assumption about which machine owned the registration, but the remaining evidence is still important:

- a browser registration associated with a powered-off Windows machine continued to receive advancing `connectedAt` values;
- `isLocal` semantics were not behaving as an intuitive ownership boundary;
- the incident demonstrates that browser identity/registration state can be misleading to an agent.

Source:
- https://github.com/anthropics/claude-code/issues/93751

### Multi-browser/tab ownership interference

Issue #72677 documented:

- `switch_browser` prompting every connected browser, including a browser the user wanted excluded;
- tab interference/reparenting across browser instances.

It was closed as stale/not-planned, not by a verified ownership redesign.

Source:
- https://github.com/anthropics/claude-code/issues/72677

### Interpretation

Claude in Chrome is useful evidence that provider-native browser transport should be preferred when it works.

It is not yet a trustworthy provider of our ownership/supervision semantics.

Current disposition:

```text
CLAUDE_IN_CHROME = NATIVE_FIRST_COMPARATOR
CLAUDE_BROWSER_OWNERSHIP = DO_NOT_DELEGATE_WAG_AUTHORITY
CLAUDE_NATIVE_CLEANUP_BASELINE = NOT_ESTABLISHED
```

## 3. Microsoft Playwright is becoming the main provider-neutral convergence point

Pass 3 promoted first-party Playwright above Browser Harness.

Pass 4 strengthens that conclusion.

Current Playwright combines five pieces that used to require separate projects:

1. coding-agent CLI;
2. MCP server;
3. extension attachment to the user's real authenticated Chrome/Edge;
4. `Browser.bind()` session interoperability;
5. WebMCP page-tool exposure.

This is more strategically important than any individual command or benchmark result.

### Playwright CLI

Official Playwright documentation now explicitly positions `playwright-cli` as the coding-agent interface.

The documentation distinguishes:

- CLI for coding agents where context/token efficiency matters;
- MCP for persistent iterative agent loops where a tool protocol is useful.

Current CLI capabilities include:

- named sessions;
- persistent profiles;
- Chrome/Firefox/WebKit selection;
- extension/CDP/endpoint attachment;
- `list`, `close-all`, `kill-all`, and per-session data deletion;
- visual dashboard;
- explicit idle timeout;
- WebMCP discovery/call commands.

Source:
- https://github.com/microsoft/playwright/blob/main/docs/src/getting-started-cli.md

### Real authenticated browser extension

The official Playwright Extension can attach to the user's existing browser/profile and reuse:

- cookies;
- authenticated sessions;
- normal browser state.

More importantly for this project, the current extension already has an ownership primitive:

- multiple clients may connect simultaneously;
- each client receives its own tab group;
- one tab belongs to one client at a time;
- users can move tabs between groups;
- connections can be inspected/disconnected individually.

That is upstream prior art for a large part of the custom multi-agent tab-ownership problem.

Source:
- https://github.com/microsoft/playwright/blob/main/packages/extension/README.md

### Browser.bind()

`Browser.bind()`, available since Playwright v1.59, makes a Playwright-launched browser available through a named pipe or WebSocket endpoint so CLI, MCP, and other Playwright clients can connect to the same browser.

It supports:

- a session title;
- associated workspace directory;
- metadata;
- named-pipe/default local binding;
- optional host/port WebSocket mode.

This is an upstream session-sharing/interoperability primitive and should be evaluated before any new WAG-owned browser-session broker.

Source:
- https://github.com/microsoft/playwright/blob/main/docs/src/api/class-browser.md

### Lifecycle ownership is explicit, not magical

Playwright documentation makes an important distinction:

- a browser launched/owned by Playwright can be shut down under its idle policy;
- an existing browser attached through extension/CDP is **not owned by Playwright**;
- timeout on an attached browser disconnects the automation client and leaves browser/pages open.

This is the correct ownership behavior for a user's daily browser, but it means external cleanup/supervision remains necessary for Playwright-owned daemons and any other task-owned process.

Source:
- https://github.com/microsoft/playwright/blob/main/docs/src/getting-started-mcp.md

### Current failure evidence

Playwright is not yet "boring infrastructure" for the user's exact Windows workload.

#### Memory Saver discarded-tab wedge

Playwright issue #41714 remains open.

On Windows 11, one discarded/frozen tab in a long-lived real Chrome profile can make every CLI command time out. The issue diagnosis was confirmed against Playwright source: response rendering awaits tab titles across all tabs, allowing one unresponsive target to block every command.

Source:
- https://github.com/microsoft/playwright/issues/41714

The corresponding MCP issue #1757 reports the same class of failure during MCP initialization against a real profile.

Source:
- https://github.com/microsoft/playwright-mcp/issues/1757

#### Persistent-profile Windows download crash

Playwright MCP issue #1754 reports the MCP server connection closing when a file download starts under a persistent profile on Windows.

Source:
- https://github.com/microsoft/playwright-mcp/issues/1754

#### Historical lifecycle gaps show why owner-aware cleanup still matters

Playwright issue #42428 documented detached CLI daemons becoming unreachable and surviving for days when their control socket path disappeared. It is now closed, and current CLI has idle-timeout semantics, but the history is relevant to our acceptance design.

Issue #40165 documented a broken `kill-all` matcher and was fixed quickly.

Issue #42152 documented Windows daemon console-window behavior and was also closed.

Sources:
- https://github.com/microsoft/playwright/issues/42428
- https://github.com/microsoft/playwright/issues/40165
- https://github.com/microsoft/playwright/issues/42152

These closures are positive velocity signals, not proof that forced-failure cleanup needs no empirical verification.

### Playwright skill permission concern

Issue #42745 is open.

The bundled coding-agent skills grant broad patterns including `Bash(npx:*)` / `Bash(npm:*)`, which in some agent permission systems can pre-authorize arbitrary package execution beyond Playwright.

Source:
- https://github.com/microsoft/playwright/issues/42745

Implication for this project:

If Playwright CLI is eventually tested, do not blindly accept generated skill permission grants. Prefer:

- skills-less operation; or
- a locally reviewed/narrowed skill.

### Disposition

```text
PLAYWRIGHT = PRIMARY_PROVIDER_NEUTRAL_SUBSTRATE
PLAYWRIGHT_CLI = PREFERRED_CODING_AGENT_INTERFACE
PLAYWRIGHT_MCP_EXTENSION = PREFERRED_GENERIC_MCP_REAL_PROFILE_INTERFACE
PLAYWRIGHT_BROWSER_BIND = PRIMARY_UPSTREAM_SESSION_INTEROP_PRIMITIVE
PLAYWRIGHT_LIFECYCLE = MUST_STILL_PASS_WINDOWS_FAILURE_ACCEPTANCE
PLAYWRIGHT_SKILL_PERMISSIONS = REVIEW_BEFORE_ADOPTION
```

## 4. WebMCP has crossed from speculative prior art into a real convergence signal

WebMCP should still not be described as a finished standard.

The current specification is a W3C Community Group Report and explicitly states that it is not a W3C Standard and not on the W3C Standards Track.

Source:
- https://webmachinelearning.github.io/webmcp/

However, current ecosystem convergence is material:

- the specification has active Microsoft/Google participation;
- Chrome is experimenting with WebMCP;
- current Playwright main can discover and invoke page-registered WebMCP tools;
- Playwright MCP can surface page tools as MCP tools;
- Playwright CLI has `webmcp-list` / `webmcp-call`;
- OpenAI's current browser direction includes WebMCP/site tools in supported browser workflows.

Playwright commit `78ff4260d79b924724bdcc4ccd89e463b8f43b0d` on 2026-09-18 explicitly added page-registered WebMCP tools to the MCP surface.

### Security interpretation

WebMCP does **not** remove the trust problem.

The spec itself discusses:

- indirect prompt injection;
- tool poisoning;
- output injection;
- intent misrepresentation;
- privacy leakage;
- same-origin concerns.

A page can declare annotations such as:

- `readOnlyHint`;
- `untrustedContentHint`;
- `consequentialHint`.

Those are useful semantic hints.

They are not independent authority.

For WAG:

```text
WEBMCP_TOOL_METADATA = UNTRUSTED_SEMANTIC_INPUT
WEBMCP_CONSEQUENTIAL_HINT = NOT_APPROVAL
ADR_0019_LOCAL_AUTHORITY_TRANSITION = STILL_REQUIRED
```

### Strategic consequence

WAG should avoid building a new generic browser action ontology if the ecosystem is converging toward page-native structured tools plus Playwright.

Prefer:

```text
site WebMCP tool
  -> Playwright structured browser control
  -> generic browser interaction
  -> CUA/pixel fallback
```

This ordering should remain capability-detected rather than hard-coded to one browser/provider.

## 5. Direct real-profile bridges — useful donors, still behind Playwright

### whg517/browser-bridge

The architecture remains highly relevant to WAG:

- extension + native messaging;
- no raw remote-debugging port;
- shared broker;
- multiple MCP clients;
- per-agent identities;
- site approval/high-risk confirmation concepts;
- Apache-2.0;
- Windows path.

But issue #192 is still open with no completed Windows result.

The repository itself identifies the key uncertainty: a broker spawned by an MCP server may be killed when a Windows MCP host places the process tree in a Job Object with `KILL_ON_JOB_CLOSE`.

This can invalidate the design assumption that the broker survives one MCP client exiting.

Source:
- https://github.com/whg517/browser-bridge/issues/192

Disposition:
**high-value transport/security donor; not a verified Windows replacement.**

### open-browser-use

Two current issues materially block promotion:

- #20: Windows 11/Chrome 151 native host cannot be found even when registry/manifest/executable checks appear correct and the host works when spawned manually;
- #22: a failed socket dial may cause the CLI to unlink a live native-host socket because permission denial is treated as a stale socket.

Sources:
- https://github.com/iFurySt/open-browser-use/issues/20
- https://github.com/iFurySt/open-browser-use/issues/22

Disposition:
**watch/code-review; do not put above first-party Playwright.**

### Playwriter

Playwriter remains useful prior art for explicit user-attached real tabs.

Current issues include:

- slow attachment/frequent disconnect reports;
- MCP transport closing while the parent agent remains alive;
- model retries creating duplicate tabs;
- detached relay startup not enforcing the configured token in one startup path.

Sources:
- https://github.com/remorses/playwriter/issues/40
- https://github.com/remorses/playwriter/issues/88
- https://github.com/remorses/playwriter/issues/119
- https://github.com/remorses/playwriter/issues/122

Disposition:
**keep as UX/real-profile donor, not top lifecycle candidate.**

## 6. BrowserOS neo — fresh evidence keeps it demoted on Windows

BrowserOS remains interesting product prior art, but September Windows evidence maps too closely to the user's existing bottleneck.

### Dead loopback connection accumulation

Issue #2591 reports `browseros-claw-server.exe` accumulating unreaped ESTABLISHED loopback connections.

Measured report:

- roughly 13,870 server-side established sockets over five days;
- system-wide Windows network failures associated with ephemeral-port/buffer exhaustion;
- connections begin accumulating again after restart.

Source:
- https://github.com/browseros-ai/BrowserOS/issues/2591

### Idle session death loses tab ownership

Issue #2705 reports BrowserOS neo MCP sessions dying after roughly 300 seconds idle.

The client initially treats an SSE 404 as recoverable, but the next POST discovers the session is gone and reconnects with a new session identity, causing previously owned tabs to become inaccessible.

Source:
- https://github.com/browseros-ai/BrowserOS/issues/2705

### Network exposure / local-data hardening

Issue #2706 reports the MCP control port bound to `0.0.0.0` while sibling internal ports bind loopback. The reporter did not establish remote exploitation, so this is evidence of a broad listening surface, not proof of unauthorized remote browser control.

Issue #2648 documents a code path where originless loopback GET requests may read protected conversation/scheduled-job data.

Sources:
- https://github.com/browseros-ai/BrowserOS/issues/2706
- https://github.com/browseros-ai/BrowserOS/issues/2648

Disposition:

```text
BROWSEROS_NEO_WINDOWS = DEMOTED
BROWSEROS_LOCAL_TEST = DEFER_UNTIL_LIFECYCLE_HARDENING_IMPROVES
```

## 7. Cloud/offload — only the cloud path actually removes local browser-process ownership

The key architectural question is not "which cloud browser has the longest feature list?"

It is:

> Which path actually removes Windows browser/process ownership from this machine while preserving enough authentication, observability and recovery?

### Browserbase

Browserbase remains the strongest first cloud comparator.

Current strengths:

- managed browser sessions;
- persistent context/profile support;
- session recording/live observability;
- substantial concurrency;
- established Stagehand ecosystem.

Current Stagehand issues show that managed maturity is not the same as semantic correctness:

- domain policy bypass for service-worker/WebSocket paths;
- navigation/wait races;
- CDP drop/session-crash paths;
- extension/session creation timeouts;
- Windows local `browse` CLI focus/daemon issues.

Sources:
- https://github.com/browserbase/stagehand/issues/2945
- https://github.com/browserbase/stagehand/issues/2910
- https://github.com/browserbase/stagehand/issues/2918
- https://github.com/browserbase/stagehand/issues/2782

Important distinction:

**Browserbase cloud can remove local browser-process ownership. Browserbase local CLI cannot be assumed to do so.**

### Kernel

Kernel remains the strongest second cloud comparator because of:

- managed authentication;
- ephemeral sessions with durable profiles;
- explicit session timeout/lifecycle model;
- high concurrency tiers;
- credential/vault-oriented product design.

Independent public issue volume is thinner than Browserbase, so vendor documentation should not be treated as equivalent to community reliability evidence.

Disposition:
**cloud shortlist, especially if managed auth/lifecycle dominates.**

### Steel

Steel remains the most attractive open-source/self-host escape hatch.

But self-hosting shifts lifecycle/ops back to the user.

Current issues include:

- self-host session timeout differences;
- custom `userDataDir` behavior problems;
- rapid release/relaunch causing API termination.

Sources:
- https://github.com/steel-dev/steel-browser/issues/350
- https://github.com/steel-dev/steel-browser/issues/347
- https://github.com/steel-dev/steel-browser/issues/329

Disposition:
**fallback for lock-in avoidance, not default if the goal is reducing local operational burden.**

### Browserless

Browserless is mature cloud/headless infrastructure, but its self-host/commercial licensing is strategically less attractive than Apache/MIT alternatives for a reusable product substrate.

Current issues also include:

- timed-out WebSocket sessions appearing as crashes because a proper close frame is not sent;
- an unauthorized-connection crash report.

Sources:
- https://github.com/browserless/browserless/issues/5591
- https://github.com/browserless/browserless/issues/4792

Disposition:
**cloud/offload secondary, not preferred local foundation.**

### Notte / Hyperbrowser / Anchor

These remain watch candidates.

Their product capability is credible, but public sustained-use failure evidence is not currently strong enough to displace Browserbase/Kernel for first cloud evaluation.

## 8. Community evidence on token efficiency supports CLI-first for coding agents

Community reports increasingly distinguish browser capability from context cost.

Repeated community feedback favors CLI/direct Playwright or agent-browser-style command surfaces over large MCP browser schemas when the agent already has shell access.

This aligns with Microsoft's own current Playwright documentation.

But the conclusion should remain bounded:

- CLI often reduces schema/context overhead;
- long multi-site workflows can still consume significant context/tokens;
- CLI does not solve stale refs, frozen tabs, anti-bot challenges, or ownership by itself.

Therefore:

```text
CODING_AGENT_WITH_SHELL = PREFER_PLAYWRIGHT_CLI_FIRST
CHAT_OR_GENERIC_MCP_CLIENT = PREFER_PLAYWRIGHT_MCP_EXTENSION_FIRST
```

This is a research direction, not yet an empirical acceptance result.

## 9. Revised architecture pressure after Pass 4

### Freeze

Continue freezing new custom implementation of:

- generic browser action schema;
- generic accessibility snapshot schema;
- tab/navigation primitives;
- provider-specific Chrome/Edge transport;
- generic DevTools data collection;
- browser session-sharing broker unless upstream Playwright cannot satisfy the exact requirement;
- cloud browser fleet management.

### Likely retireable later if upstream passes acceptance

- WAG-owned browser launch/attachment mechanics;
- WAG-owned action/snapshot/navigation plumbing;
- provider-specific browser glue;
- custom multi-client tab grouping/session-sharing where Playwright extension/`browser.bind()` is sufficient.

### Retain

Current evidence still requires:

- WAG admission and opaque ownership;
- capability/risk policy;
- ADR-0019 local approval transition;
- durable consequential-effect ownership;
- audit/evidence contracts;
- owner-aware cleanup for WAG-owned local processes/daemons;
- Guardian context measurement/continuity/early handoff warning.

### Narrow SessionCommander

SessionCommander should not grow browser semantics.

Its future browser role, if needed, is narrower:

- supervise selected task-owned browser runtimes/bridges;
- know which local process tree WAG owns;
- reclaim only exact-owned residue;
- never kill the user's attached daily browser merely because an automation client disconnects.

## 10. Research tier after Pass 4

This is a research priority, **not a benchmark ranking or final product verdict**.

### Native provider comparators

- ChatGPT/Codex native browser path.
- Claude in Chrome/Cowork browser path.

Use when provider-specific workflow is acceptable, but keep lifecycle supervision assumptions conservative on Windows.

### Provider-neutral primary tier

1. Microsoft Playwright CLI.
2. Microsoft Playwright MCP extension.
3. Playwright `browser.bind()` as session interoperability primitive.
4. Aside as proprietary product comparator.
5. Browser Harness as third-party comparator that must demonstrate advantage over Playwright.
6. Panerelay as thin-transport donor.
7. whg517/browser-bridge as authority/approval/native-messaging donor.
8. Playwriter as UX/real-profile donor.

### Diagnostics

- Chrome DevTools MCP.

Do not make it browser lifecycle authority.

### Cloud/offload

Primary research pair:
- Browserbase.
- Kernel.

Strategic fallback:
- Steel.

Secondary/watch:
- Browserless.
- Notte.
- Hyperbrowser.
- Anchor.
- Cloudflare Browser Run/Kitesurf.

### Currently demoted for Windows daily authenticated use

- BrowserOS neo.
- open-browser-use until Windows/native-host maturity improves.

## 11. What to research next — still no benchmark

The user explicitly requested more research, so Pass 4 does not close the scan.

Next high-value questions:

1. **Playwright lifecycle diff**
   - Trace exact ownership and cleanup semantics for CLI-owned browser, MCP-owned browser, extension-attached browser and `browser.bind()`.
   - Determine whether current v0.1.21/v0.0.82 changes fix any earlier daemon/profile issues.

2. **Playwright extension threat model**
   - Inspect token storage/access, tab-group ownership, page-content influence, extension permissions and whether one compromised local process can reuse the profile token.

3. **WebMCP interoperability/security**
   - Track Chrome trial status and real sites exposing tools.
   - Determine how OpenAI/Playwright/Chrome map user confirmation and tool annotations.
   - Define how WAG should treat page-provided `consequentialHint` without weakening ADR-0019.

4. **OpenAI native browser September fixes**
   - Watch whether #43347/#36645 receive a confirmed fix and whether later Windows builds stop crashing during Browser Use teardown.
   - Track orphan-process #32462 and focus-stealing #33662.

5. **Claude browser ownership**
   - Track #93751 and any replacement for stale/native-host issues.
   - Look for explicit supported multi-session/tab ownership primitives rather than community hooks.

6. **Direct bridge lifecycle**
   - Track whg517/browser-bridge #192 Windows Job Object verification.
   - Track open-browser-use Windows native-host issues.
   - Search for stronger real-profile bridges only if they add a capability Playwright lacks.

7. **Cloud production evidence**
   - Collect independent sustained failure/reconnect/cost reports for Browserbase and Kernel rather than relying on feature/pricing pages.

8. **Windows process-containment evolution**
   - Continue tracking Windows ODR/MCP/container/isolation work as a future trust/lifecycle boundary, not a present production dependency.

## Decision markers

```text
COMMUNITY_PASS_4 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE
NEW_CUSTOM_BROWSER = FREEZE
GENERIC_WAG_BROWSER_ACTION_GROWTH = FREEZE

OPENAI_NATIVE_BROWSER = NATIVE_FIRST_COMPARATOR_NOT_WINDOWS_LIFECYCLE_BASELINE
CLAUDE_IN_CHROME = NATIVE_FIRST_COMPARATOR_NOT_OWNERSHIP_BASELINE

PLAYWRIGHT = PRIMARY_PROVIDER_NEUTRAL_SUBSTRATE
PLAYWRIGHT_CLI = PRIMARY_CODING_AGENT_RESEARCH_PATH
PLAYWRIGHT_MCP_EXTENSION = PRIMARY_GENERIC_MCP_REAL_PROFILE_PATH
PLAYWRIGHT_BROWSER_BIND = PRIMARY_SESSION_INTEROP_PRIMITIVE
PLAYWRIGHT_WINDOWS_FAILURE_ACCEPTANCE = STILL_REQUIRED

WEBMCP = STRATEGIC_SEMANTIC_LAYER
WEBMCP_STANDARD_STATUS = COMMUNITY_GROUP_DRAFT_NOT_W3C_STANDARD
WEBMCP_CONSEQUENTIAL_HINT = NOT_WAG_AUTHORITY

BROWSEROS_NEO_WINDOWS = DEMOTED
OPEN_BROWSER_USE = WATCH
WHG517_BROWSER_BRIDGE = CODE_REVIEW_DONOR_PENDING_WINDOWS_JOB_OBJECT_EVIDENCE

CLOUD_PRIMARY_RESEARCH = BROWSERBASE,KERNEL
CLOUD_OPEN_SOURCE_FALLBACK = STEEL
LOCAL_CLOUD_CLI_DOES_NOT_EQUAL_PROCESS_OFFLOAD = TRUE

WAG_AUTHORITY_CORE = RETAIN
ADR_0019_APPROVAL_BOUNDARY = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN_BOUNDED
GUARDIAN_CONTINUITY_SCOPE = RETAIN
GUARDIAN_BROWSER_AUTOMATION_SCOPE = FREEZE
SESSIONCOMMANDER_BROWSER_SEMANTICS = DO_NOT_EXPAND

NEXT_ACTION = CONTINUE_TARGETED_COMMUNITY_AND_SECURITY_RESEARCH
```
