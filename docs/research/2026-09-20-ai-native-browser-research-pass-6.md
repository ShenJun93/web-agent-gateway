# AI-native Browser Research — Pass 6

Date: 2026-09-20
Status: RESEARCH RECEIPT — source/community/security review; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start of pass: `e8ac691b09e80a2a9925163ed04e652479928d05`

## Purpose

Continue the user-requested browser research without starting local benchmarks.

Pass 6 concentrates on:
- first-party Chrome/Playwright lifecycle and multi-agent isolation;
- deeper source review of Browser Controller, Agent360 and provider-specific adapters;
- new local real-profile bridges that materially improve ownership/cleanup/effect verification;
- proprietary AI-native browsers/agent systems that have enough funding or market momentum to create replacement pressure.

## Executive conclusion

Pass 6 does **not** justify building a new browser or removing WAG authority.

It does change the research map in five ways:

1. **Chrome DevTools for agents is now a first-party comparator, not background prior art.**
   It is stable, supports existing logged-in Chrome with explicit browser consent, supports concurrent-page routing experiments, and exposes WebMCP/DevTools semantics. It is strong enough that WAG should not recreate Chrome debugging/action primitives.
   It is **not** a lifecycle baseline: current public issues still show Windows auto-connect timeouts, isolated Chrome orphaning after MCP death, long-lived CPU/memory retention and duplicate-process/reconnect failure modes.

2. **Playwright shared browser context must not be treated as an ownership boundary.**
   2026 issues show cross-client DOM/page-event bleed and recorder sink collision in shared-browser-context mode. Use isolated contexts or an external owner/session contract for concurrent agents.

3. **Browser Controller source quality improved further.**
   Its current security design has an out-of-band enrollment secret plus exact extension-origin pinning and token-authenticated IPC/WS. The daemon has per-client session IDs, heartbeat eviction, per-session rate limits, per-tool timeouts and aborts in-flight calls when a client disappears.
   The remaining blocker is production proof and Windows ACL/hostile-same-user validation, not absence of architecture.

4. **New donors materially strengthen the Windows lifecycle/authority prior art.**
   - `LAPSrj/browser-mcp`: explicit root-PID capture, Windows `taskkill /F /T`, shared-profile sidecar/refcount, session-scoped tab ownership.
   - `maestrojeong/browser-rs-mcp`: per-owner capability auth + managed-mode secret-broker design, but no current Windows build.
   - `uiuing/browser-agent`: explicit post-action verification, risk tiers, site policies, authorization memory and audit traces.

5. **Well-funded proprietary AI browsers reinforce the architecture split rather than replace it.**
   Polar and Hark show strong investment in long-running authenticated browser work. They are useful product/UX comparators but do not expose a provider-neutral local trust/lifecycle substrate that can replace WAG/SessionCommander.

## 1. Chrome DevTools for agents — PROMOTE FIRST-PARTY CHROME COMPARATOR

Official Chrome documentation now describes Chrome DevTools for agents as stable.

Relevant current capabilities:
- `chrome-devtools-mcp` for MCP hosts;
- CLI path for shell automation;
- `--autoConnect` into an active Chrome 144+ profile;
- explicit Chrome permission prompt before an agent attaches;
- access to the user's live tabs, extensions and authenticated state;
- `--experimentalPageIdRouting` for concurrent agents that intentionally share one server;
- `--isolated` for separate temporary profiles;
- WebMCP/custom page tools available experimentally.

This creates strong replacement pressure on:
- generic CDP wrappers;
- Chrome inspection/network/console tooling;
- custom existing-profile attach plumbing;
- custom Chrome-specific debugging surfaces.

### Current lifecycle/reliability blockers

Public evidence is still inconsistent with using it as cleanup authority:

- issue #2675 (2026-09-06): Windows Desktop + `--autoConnect` can accept Chrome's consent prompt but then `list_pages` times out, while a standalone MCP client works;
- issue #2621 (2026-08-26): isolated/temp-profile Chrome can survive MCP death as an orphan process tree;
- issue #2431: reported long-lived memory growth under active sessions;
- issue #2599: long-lived server can retain an active page and continue CPU consumption;
- issue #1763: repeated MCP reconnects can leave multiple processes attached to the same endpoint and cause `Network.enable` timeout;
- older long-running auto-connect reports document reconnect churn and repeated permission prompts.

Therefore:

```text
CHROME_DEVTOOLS_FOR_AGENTS = FIRST_PARTY_CHROME_COMPARATOR
REPLACE_GENERIC_CHROME_DEVTOOLS_WRAPPERS = YES_WHERE_SUFFICIENT
REPLACE_OWNER_AWARE_CLEANUP = NO
REPLACE_WAG_AUTHORITY = NO
```

Important platform limitation for this user:
the strongest automatic existing-session path is Chrome-first. Edge remains less direct and still has separate discovery/support gaps.

Sources:
- https://developer.chrome.com/docs/devtools/agents/
- https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect
- https://developer.chrome.com/docs/devtools/agents/get-started/configuration
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2675
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2621
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2431
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1763

## 2. Playwright multi-client isolation — HARDEN THE ASSUMPTION

Playwright remains the primary provider-neutral browser substrate, but Pass 6 found stronger evidence that **shared context != isolated ownership**.

Recent public evidence:
- `microsoft/playwright-mcp#1631`: parallel clients could receive DOM/page state belonging to a sibling client through shared BrowserContext page events;
- `microsoft/playwright#42608`: with `--shared-browser-context`, one client's recorder sink can overwrite another client's recorder state.

The correct architectural lesson is not to abandon Playwright.

It is:

```text
PLAYWRIGHT_ACTION_SUBSTRATE = STRONG
PLAYWRIGHT_SHARED_CONTEXT = NOT_AN_AUTHORITY_BOUNDARY
MULTI_AGENT_OWNER_IDENTITY = RETAIN_OUTSIDE_SHARED_CONTEXT
SHARED_CONTEXT_EFFECT_VERIFICATION = REQUIRED
```

For WAG, keep opaque owner/session identity and avoid assuming Playwright's shared-context routing is sufficient isolation for consequential workflows.

Sources:
- https://github.com/microsoft/playwright-mcp/issues/1631
- https://github.com/microsoft/playwright/issues/42608

## 3. Browser Controller — stronger source-level promotion

Repository:
https://github.com/compnew2006/browser-controller

Pass 6 source review confirms several properties that are directly relevant to this user's 10–15-session workload.

### Admission / local transport

Current security model includes:
- loopback-only extension WebSocket;
- exact pinned extension Origin;
- random daemon auth token;
- separate enrollment secret delivered out-of-band;
- enrollment secret required for control-plane HTTP endpoints;
- token-authenticated IPC clients;
- Windows named-pipe IPC rather than a public TCP broker for MCP clients.

The enrollment secret closes the project's earlier first-contact TOFU race.

### Lifecycle

Current daemon source includes:
- unique per-client session ID;
- heartbeat/pong eviction of half-open clients;
- per-session call budget;
- per-tool AbortController;
- when a client socket closes, in-flight calls are aborted and the exact session's tab locks are released;
- live same-name clients are allowed to coexist; only stale same-name clients are replaced.

This is materially stronger than a bridge whose cleanup depends only on process exit.

### Remaining gap

The project still has little independent sustained-use evidence.

Windows named-pipe ACL behavior and hostile-same-user assumptions need explicit verification. A secret on the pipe is useful, but it is not automatically equivalent to OS principal isolation.

Disposition:

```text
BROWSER_CONTROLLER = KEEP_HIGH_SOURCE_REVIEW
KEY_DONOR = LOCAL_PAIRING,SESSION_ID,TAB_LOCK,BOUNDED_RETRY,HEARTBEAT_CLEANUP
INDEPENDENT_PRODUCTION_PROOF = LOW
WINDOWS_ACL_EVIDENCE = STILL_NEEDED
```

## 4. Agent360 Browser MCP — FALSE-SUCCESS IMPROVEMENT, BLOCKER NOT FULLY CLOSED

Repository:
https://github.com/Agent360dk/browser-mcp

The project released v1.29.2 on 2026-09-19 and now explicitly measures whether many foreground interaction events actually reached the page, returning an error instead of silently claiming success.

This is an important response to issue #19.

However the project's own current documentation still states that the worst false-success class is not fully eliminated and still points to #19.

Operational implication:

```text
AGENT360_EFFECT_VERIFICATION = IMPROVING
ISSUE_19_CLASS = STILL_OPEN
PROMOTE_TO_PRIMARY = NO
KEEP_AS_EFFECT_VERIFICATION_DONOR = YES
```

Source:
- https://github.com/Agent360dk/browser-mcp
- https://github.com/Agent360dk/browser-mcp/issues/19

## 5. LAPSrj/browser-mcp — PROMOTE WINDOWS LIFECYCLE DONOR

Repository:
https://github.com/LAPSrj/browser-mcp

This small Playwright-based project contains unusually concrete Windows lifecycle mechanics.

Relevant design:
- persistent sessions have idle and wall TTLs;
- attach-CDP auto-launch records the exact root browser PID;
- on Windows, teardown uses `taskkill /F /T` against the recorded root PID rather than killing by image name;
- attached user-managed browser is deliberately not closed;
- multiple MCP servers can share one `user_data_dir`;
- a sidecar records root PID, CDP port and attached sessions;
- last session leaving triggers exact browser-tree teardown;
- per-session tab ownership uses opener relationships;
- Edge and Chrome paths are stated as live-validated on Windows/WSL.

This is directly relevant to SessionCommander's exact-owned cleanup mission.

### Important caution

Its WSL workaround can create a Windows-side PowerShell relay bound to `0.0.0.0:<relay-port>` to bridge WSL to host CDP. That is materially broader than the loopback-only posture WAG prefers and needs a separate threat review before reuse.

The project has very little public issue/community history.

Disposition:

```text
LAPSRJ_BROWSER_MCP = PROMOTE_SOURCE_REVIEW
KEY_DONOR = ROOT_PID_OWNERSHIP,SIDECAR_REFCOUNT,WINDOWS_TREE_TEARDOWN
WSL_0_0_0_0_RELAY = SECURITY_REVIEW_REQUIRED
PRODUCTION_PROOF = LOW
```

## 6. browser-rs-mcp — PROMOTE AUTHORITY DONOR, NOT WINDOWS CANDIDATE

Repository:
https://github.com/maestrojeong/browser-rs-mcp

Distinctive design:
- one shared logged-in Chrome;
- many agents;
- managed mode with per-owner capability authentication;
- host derives an HMAC capability for an owner;
- secret broker can inject credentials while keeping long-term credential lookup/storage outside the browser server;
- Apache-2.0 and small Rust binary.

This is useful prior art for WAG's opaque owner/capability design.

Current public release targets are macOS arm64 and Linux x64, not Windows.

Disposition:

```text
BROWSER_RS_MCP = AUTHORITY_AND_MULTI_TENANT_DONOR
WINDOWS_DAILY_DRIVER = NO
WAG_REPLACEMENT = NO
```

## 7. uiuing/browser-agent — PROMOTE EFFECT-VERIFICATION / GUARDRAIL DONOR

Repository:
https://github.com/uiuing/browser-agent

This project pushes a model inside an MV3 browser-agent runtime and makes **verification** an explicit engine stage.

Notable design:
- typed tools;
- risk tiers: read / act / dangerous;
- site policies;
- authorization memory;
- confirmation prompts;
- audit logs;
- post-action verification against live DOM state;
- structured expected vs actual evidence.

Example documented pattern:
a "success" toast is not enough; a create action can verify list-count delta and expected record presence before claiming completion.

This directly addresses the false-success class seen in Agent360 and should influence WAG acceptance semantics even if this project is never adopted.

Disposition:

```text
UIUING_BROWSER_AGENT = EFFECT_VERIFICATION_DONOR
RISK_TIER_MODEL = DONOR
WAG_AUTHORITY_REPLACEMENT = NO
```

## 8. whg517/browser-bridge — WINDOWS GATE STILL OPEN

The project remains one of the stronger direct WAG transport donors:
- Rust binary;
- Chrome native messaging;
- one broker for several MCP clients;
- per-run secret;
- multi-agent workspaces;
- Windows x64 prebuilt.

But issue #192 still explicitly asks for real Windows verification that the detached broker survives MCP client/server termination when the client itself uses a Windows Job Object with `KILL_ON_JOB_CLOSE`.

That is exactly the user's workload concern.

Until real Windows evidence closes this:
**do not assume the broker lifetime contract is valid under Claude Desktop/Cursor-style containment.**

Source:
- https://github.com/whg517/browser-bridge/issues/192

## 9. New small bridge set — watch, do not benchmark yet

### TWP-Technologies/Browser-MCP

Interesting:
- local multiplexed browser MCP;
- Agent Session IDs and tab locking;
- releases through v0.6.1 contain fixes for stale/recoverable transports and session-scoped artifacts;
- Chrome Web Store extension exists.

Weak evidence:
- very small public repository/community;
- essentially no issue history;
- Chrome Web Store install volume remains small.

Keep as code-review donor only.

### Tenmomo Browser Agent

Chrome Web Store description claims:
- local broker;
- each MCP session controls only tabs it created;
- user/other-session tabs remain read-only;
- per-tab command serialization;
- finance-domain one-request approval;
- password/autofill stores excluded;
- execution-time URL recheck.

But version 0.3.0 changed to a stateless HTTP MCP endpoint where loopback requests skip authentication. This is not automatically compatible with WAG's same-user threat model.

Keep as policy-design donor, not production candidate.

### Browser Agent / other new MV3 agents

Several new extensions now advertise local-only MCP, existing logged-in Chrome and multiplexing. Most lack sustained independent usage, reproducible failure evidence or mature disclosure posture.

Do not spend benchmark time solely on feature parity.

## 10. Proprietary AI-native browsers / funded agent systems

### Polar

Polar raised $5.7M led by Madrona in July 2026. Its founders include people who worked on Perplexity Comet.

Product direction:
- authenticated browser;
- long-running knowledge-work automation;
- scheduled workflows;
- saved prompts;
- parallel task execution;
- users often use Polar as an automation browser while keeping another daily driver.

Public company claims include tasks running 15+ hours and millions of actions. Community discussion is currently much thinner than the company claims.

Interpretation:
**important UX/product comparator, not an infrastructure dependency candidate.**

### Hark Handoff

Hark is extremely well-funded and is training an action-oriented browser/computer-use system.

Current public evidence is still preview/vendor-demo heavy; TechCrunch explicitly notes that the launch video only shows part of the process, so effectiveness cannot be inferred from the demo.

Interpretation:
**watch model/runtime progress; no current reason to replace local WAG architecture.**

### Aside

Community evidence is mixed:
- some users like logged-in cross-site agent work and ability to reuse existing Claude/ChatGPT subscriptions;
- repeated reports mention bloat, crashes, sign-outs and privacy-policy concern.

Treat as UX comparator, not operational base.

### Phi Browser

Interesting open/local-first browser direction, but macOS-only. Community security discussion has raised stale Chromium/privacy disclosure concerns; the project has since revised policy/docs.

Not relevant to the user's Windows operational base today.

### BrowserOS / Cteno / other "Agent OS" products

The market increasingly uses "Browser OS" / "Agent OS" language.

Most products do not yet expose the exact combination needed here:
- provider-neutral local browser substrate;
- Windows sustained reliability;
- multi-agent exact ownership;
- consequential local authority split;
- deterministic cleanup.

Do not let branding itself change architecture.

## 11. Strategic correction after Pass 6

The provider-neutral ordering becomes more precise:

```text
For Chrome-specific live debugging / existing Chrome:
  Chrome DevTools for agents first-party comparator

For provider-neutral browser automation:
  Playwright remains primary substrate

For real-profile multi-agent ownership:
  Browser Controller / Chrome Agent Bridge / Panerelay / vetted bridge donors

For Windows process lifecycle:
  retain SessionCommander exact-owned supervision;
  study LAPSrj root-PID/refcount pattern

For consequential authority:
  retain WAG ADR-0019

For outcome truth:
  add explicit effect verification inspired by Agent360 + uiuing/browser-agent

For cloud offload:
  Browserbase first comparator, Kernel second, Steel open-source fallback
```

## What remains to research — Pass 7, still no benchmark

1. Browser Controller Windows named-pipe ACL implementation and token-file permissions on NTFS.
2. LAPSrj browser-mcp source/tests for root-PID reuse, stale sidecar recovery and malicious/stale sidecar handling.
3. Chrome DevTools #2675/#2621/#2431 fix velocity and whether later releases close Windows/orphan concerns.
4. Playwright shared-context fixes after #1631/#42608.
5. whg517/browser-bridge #192 real Windows result.
6. Agent360 #19 full closure rather than partial honest-failure mitigation.
7. codex-browser-bridge named-pipe ACL/multi-client ownership inherited from ChatGPT Desktop.
8. independent Polar/Hark sustained-use failure evidence.
9. effect-verification designs that can be reused without building another browser agent runtime.
10. only promote additional small bridges if they introduce a materially new ownership/security/lifecycle primitive.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_6 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE
BUILD_NEW_BROWSER = NO

PLAYWRIGHT_PROVIDER_NEUTRAL_PRIMARY = YES
CHROME_DEVTOOLS_FOR_AGENTS = PROMOTE_FIRST_PARTY_CHROME_COMPARATOR
PLAYWRIGHT_SHARED_CONTEXT = NOT_AUTHORITY_BOUNDARY

BROWSER_CONTROLLER = KEEP_HIGH_SOURCE_REVIEW
AGENT360 = KEEP_EFFECT_VERIFICATION_DONOR
LAPSRJ_BROWSER_MCP = PROMOTE_WINDOWS_LIFECYCLE_DONOR
BROWSER_RS_MCP = PROMOTE_AUTHORITY_DONOR_NO_WINDOWS
UIUING_BROWSER_AGENT = PROMOTE_EFFECT_VERIFICATION_DONOR
WHG517_BROWSER_BRIDGE = KEEP_WINDOWS_GATE_OPEN

POLAR = PRODUCT_UX_COMPARATOR
HARK = WATCH_HIGH_FUNDING_LOW_INDEPENDENT_PROOF
ASIDE = UX_COMPARATOR_MIXED_RELIABILITY_PRIVACY
PHI = MAC_ONLY_NOT_CURRENT_WINDOWS_BASE

WAG_AUTHORITY_CORE = RETAIN
ADR_0019_APPROVAL_BOUNDARY = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN
GENERIC_BROWSER_ACTION_BUILD = FREEZE
EFFECT_VERIFICATION_REQUIREMENT = STRENGTHEN

NEXT_ACTION = PASS_7_TARGETED_SOURCE_AND_FIX_VELOCITY_RESEARCH
```
