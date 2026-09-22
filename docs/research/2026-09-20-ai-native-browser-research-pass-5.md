# AI-native Browser Research — Pass 5

Date: 2026-09-20
Status: RESEARCH RECEIPT — community/prior-art/security review; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start of pass: `33ca394a63a31665e4e6f2dbf8394cb0fbed779c`

## Purpose

Continue research beyond Pass 4 because the user explicitly requested more community/prior-art evidence before any local benchmark.

This pass does not reopen the "build a new AI browser" direction. It tests whether newer real-profile bridges, provider-specific adapters, WebMCP developments, or cloud-browser evidence materially change the likely thin-WAG architecture.

Research priorities:

1. real authenticated Chrome/Edge on Windows;
2. multi-agent ownership/isolation;
3. cleanup/orphan-process behavior;
4. fail-closed errors instead of false success;
5. local IPC authentication;
6. provider-specific reuse opportunities;
7. WebMCP maturity/security;
8. managed-browser lifecycle/cost evidence.

No local install, browser launch, benchmark, or process mutation was performed.

## Executive conclusion

Pass 5 changes the candidate ordering again.

### Promote for further source/community review

1. **Browser Controller (`compnew2006/browser-controller`)**
   - strongest new architecture for authenticated local multi-agent Chrome found in this pass;
   - explicit per-client `sessionId`, per-tab mutex, tab locks, exact tab targeting, no-focus operation, bounded timeouts, token + enrollment-secret pairing, loopback-only extension transport;
   - Windows named-pipe IPC is documented;
   - MIT;
   - current public adoption is still tiny and its README comparison table is stale about Playwright MCP (Playwright now has an existing-browser extension path), so maintainers' claims are not independent production proof.

2. **Chrome Agent Bridge (`cmsflash/agent-browser-mcp`)**
   - strongest explicit thread-to-tab-group isolation design found so far;
   - every agent call is tied to a mandatory `threadTitle`; extension enforces that each thread can only see/touch its own Chrome group;
   - real-profile test harness covers reconnect, freeze recovery, cleanup and focus-steal behavior;
   - uniquely documents a Chrome saved-tab-group residue failure: close alone can leave synced group artifacts; cleanup must ungroup then close;
   - important limitation: local shell access is explicitly trusted; hub/relay auth is not a WAG-strength authority boundary;
   - Windows-specific test evidence is not as strong as macOS/test-profile evidence.

3. **Agent360 Browser MCP (`Agent360dk/browser-mcp`)**
   - active release/commit cadence and concrete operational work on multi-session tab ownership, optional profile pairing, stdin-close cleanup and idle timeout;
   - human-in-the-loop `browser_ask_user` is strategically useful;
   - however current open issue #19 records the most dangerous reliability class: a tool can return `ok:true` while a React-controlled field did not actually change application state;
   - port-range design can generate repeated failed bind attempts under contention; relevant to 10–15 concurrent sessions;
   - pairing is opt-in in the current architecture, so WAG must not rely on zero-config local trust.

4. **codex-browser-bridge (`DeliciousBuding/codex-browser-bridge`)**
   - high-value **provider-specific adapter/donor**, not provider-neutral substrate;
   - reuses ChatGPT Desktop's existing `codex-browser-use-*` Windows named pipe and official Chrome/Edge extension instead of recreating OpenAI-specific browser transport;
   - MIT, Rust, bounded reconnect and output handling, live E2E history;
   - browser ownership includes explicit existing-tab discovery/claiming semantics;
   - depends on an OpenAI-private/undocumented pipe/protocol and inherits ChatGPT Desktop browser lifecycle failures;
   - should create replacement pressure on any WAG code that attempts to duplicate the ChatGPT Desktop pipe, but cannot replace WAG authority or ChatGPT Web integration.

### Keep Playwright first-party as primary provider-neutral substrate

Nothing in Pass 5 displaces the Pass 4 ordering:

```text
coding-agent browser substrate -> Playwright CLI first
generic MCP existing-browser substrate -> Playwright MCP extension first
shared Playwright context -> Browser.bind() / shared context before custom broker
```

But current issues mean Playwright is not a lifecycle/cleanup baseline:

- Memory Saver discarded/frozen targets can wedge an existing-profile MCP/CDP initialization;
- persistent-profile concurrency is constrained;
- attached browsers are not necessarily owned/killed by Playwright;
- Windows persistent-profile/download and idle-timeout edge cases remain live.

### Strong demotions

- **BrowserMCP/browsermcp.io**: large star count but stale public core plus open auth/reconnect/DoS defects; do not let popularity override current source/issue evidence.
- **hangwin/mcp-chrome**: unresolved 2026 reports include SSRF/path traversal, CORS/origin bypass, missing auth/HTTPS, transport breakage and weak security disclosure posture; not acceptable as a trusted real-profile substrate.
- **Vibe MCP on Windows**: feature set is attractive, especially remote outbound relay, but current Windows issue #129 reports failure to stabilize across tested versions and CI issue #157 shows deterministic browser-CLI status timeout on clean main. Non-loopback MCP authentication remains a tracked security requirement (#132).
- **public-browser symlink/default-profile bypass pattern**: do not adopt a strategy whose value depends on routing around Chrome's default-profile remote-debugging hardening.
- **original YetiBrowser MCP**: archived.

## 1. Browser Controller

Repository:
https://github.com/compnew2006/browser-controller

License:
MIT.

### Architecture

```text
MCP client
  -> thin stdio client
  -> shared local daemon
  -> authenticated localhost WebSocket
  -> MV3 extension
  -> exact target tab
```

Each client receives a session id. Calls identify exact `tabId`. Same-tab actions serialize while different tabs can run in parallel.

Important mechanisms:

- per-tab mutex;
- tab locking;
- visual control shield;
- bounded per-tool timeouts;
- only idempotent reads retry on timeout;
- side-effecting operations do not auto-retry;
- daemon refuses to kill an unknown process occupying its port;
- multiple profiles use separate ports;
- reconnecting an agent with the same name replaces the old entry.

### Security design

`SECURITY.md` is unusually explicit for a small project.

Current design uses:

- loopback-only WebSocket;
- exact pinned extension Origin;
- per-daemon auth token;
- a separate one-time enrollment secret for first-contact pairing;
- enrollment required for HTTP control endpoints, closing the old TOFU race;
- local secrets stored under `~/.browser-controller/` with intended mode `0600`;
- Chrome extension permissions are acknowledged as broad and equivalent to powerful browser control.

This is materially stronger than bridges that expose an unauthenticated localhost WebSocket.

### Important caution

The README comparison table says Playwright MCP does not use the existing browser and lacks multi-agent support. That is stale against current Playwright extension/shared-browser-context behavior.

Therefore:
**use Browser Controller's source/test design as evidence; do not use its competitor table as current market truth.**

### Current disposition

```text
BROWSER_CONTROLLER = PROMOTE_TO_SOURCE_REVIEW_TIER
PRODUCTION_PROOF = INSUFFICIENT
WAG_AUTHORITY_REPLACEMENT = NO
LIKELY_DONOR = TAB_OWNERSHIP,LOCAL_PAIRING,BOUNDED_RETRY,DAEMON_MULTIPLEXING
```

## 2. Chrome Agent Bridge

Repository:
https://github.com/cmsflash/agent-browser-mcp

### Distinctive contribution

This project treats browser ownership as a first-class isolation contract rather than merely a convention.

Every tool takes a mandatory `threadTitle`.
The extension maps it to exactly one private tab group.
The model does not receive a generic "list all groups" or "select arbitrary group" primitive.

This is aligned with WAG's preference for unforgeable/opaque ownership better than many generic browser tool catalogs.

### Cleanup finding that matters to this project

The project documents and tests a Chrome behavior that can leave residue:

- closing tabs in a Chrome tab group can leave a saved group artifact;
- Chrome may sync that saved group to the user's account;
- their safe cleanup sequence is **ungroup first, then close tabs**.

This is directly relevant to the user's recurring "dọn rác / no residue" requirement.

### Lifecycle handling

The project includes:

- hub/relay failover;
- reconnect by durable `threadTitle`;
- 24-hour abandoned workspace GC;
- freeze/discard recovery;
- explicit avoidance of focus stealing;
- real-profile smoke/reconnect/isolation harnesses.

### Security limitation

The README explicitly says anything with local shell access could connect; the trust model is comparable to a local CDP port.

Therefore its ownership model is valuable, but its local admission model is weaker than WAG ADR-0019.

### Current disposition

```text
CHROME_AGENT_BRIDGE = PROMOTE_TO_OWNERSHIP_DONOR_TIER
KEY_DONOR = THREAD_TO_TABGROUP_OWNERSHIP,TRUE_GROUP_CLEANUP,PROFILE_FAIL_CLOSED_ROUTING
LOCAL_AUTHORITY_BOUNDARY = INSUFFICIENT_FOR_WAG
WINDOWS_PROOF = NEEDS_MORE_EVIDENCE
```

## 3. Agent360 Browser MCP

Repository:
https://github.com/Agent360dk/browser-mcp

### Relevant strengths

- existing logged-in Chrome;
- one server per agent conversation;
- up to 20 concurrent sessions by documented design;
- tab-group ownership per conversation;
- stdin-close process exit plus 4-hour idle safety net;
- optional `BROWSER_MCP_TOKEN` profile/server pairing;
- human-in-the-loop `browser_ask_user`;
- active maintenance and self-audit work.

### Current failure evidence

Issue #19:
https://github.com/Agent360dk/browser-mcp/issues/19

The project documents a case where React-controlled inputs/selects report success while the application state never received the event.

This failure class is more dangerous than an explicit timeout because the agent continues with a false belief.

For WAG evaluation:
**effect verification is mandatory; transport success must never be treated as UI-effect success.**

Issue #18:
https://github.com/Agent360dk/browser-mcp/issues/18

When the port range is full, one call can trigger repeated full-range bind probes. Maintainer intentionally keeps this behavior for fast port reclaim.

At 10–15 concurrent sessions, this must be treated as a real capacity/lifecycle question, not cosmetic logging noise.

Issue #11:
https://github.com/Agent360dk/browser-mcp/issues/11

On Windows/Threads-like virtualized SPAs, scroll tools can fail to cause lazy loading while reporting normal completion; wheel-event injection is the workaround.

### Current disposition

```text
AGENT360_BROWSER_MCP = PROMOTE_TO_TARGETED_RESEARCH
HITL_DONOR_VALUE = HIGH
CONCURRENCY_DONOR_VALUE = MEDIUM_HIGH
FALSE_SUCCESS_RISK = HIGH
PAIRING_MUST_BE_EXPLICIT = YES
BENCHMARK_NOW = NO
```

## 4. Vibe MCP

Repository:
https://github.com/VibeTechnologies/vibe-mcp

License:
Apache-2.0.

### Why it remains strategically interesting

Its strongest differentiator is remote control without an inbound port on the user's machine:

```text
browser extension -> outbound WSS relay -> remote agent
```

The README also now acknowledges that Playwright MCP supports existing logged-in browser via extension and multi-agent shared context; that correction is a useful market signal.

### Windows blocker

Issue #129:
https://github.com/VibeTechnologies/vibe-mcp/issues/129

On Windows 11, the reporter tested multiple versions from 0.1.0 through 0.3.2:

- later versions: relay daemon reported spawned but never bound the requested localhost port;
- DevTools backend used a POSIX `/tmp/*.sock` path and failed on native Windows;
- old 0.1.0 path connected/disconnected repeatedly.

This is direct evidence against using Vibe as the primary Windows local lane today.

Issue #157:
https://github.com/VibeTechnologies/vibe-mcp/issues/157

Clean-main CI and local runs reproduce a deterministic `browser-cli status` timeout, blocking subsequent E2E suites.

Issue #132:
https://github.com/VibeTechnologies/vibe-mcp/issues/132

Non-loopback HTTP MCP needs explicit client authentication; Host validation alone is acknowledged as insufficient.

### Current disposition

```text
VIBE_LOCAL_WINDOWS = DEMOTE
VIBE_REMOTE_OUTBOUND_PATTERN = KEEP_AS_ARCHITECTURE_DONOR
VIBE_REMOTE_BEARER = SECRET_HIGH_AUTHORITY
WAG_REPLACEMENT = NO
```

## 5. codex-browser-bridge

Repository:
https://github.com/DeliciousBuding/codex-browser-bridge

License:
MIT.

### Why this changes build-vs-reuse pressure

The project does not create another browser.

It discovers the ChatGPT Desktop browser named pipe:
`\\.\pipe\codex-browser-use-*`

and adapts that existing provider bridge to MCP.

This makes it a useful answer to:
"Should WAG write its own OpenAI Desktop browser transport?"

Current evidence says:
**probably not, unless this adapter proves insufficient.**

### Strengths

- Rust single binary;
- current MCP protocol support including 2026-07-28 path;
- pipe auto-reconnect;
- bounded timeouts;
- explicit tab discovery and claim semantics;
- cookie value redaction by default;
- raw CDP allowlisting/blocks;
- path validation for file input;
- live E2E history against ChatGPT Desktop + Chrome;
- supply-chain checks.

### Boundary

The bridge enumerates provider-owned named pipes and dials them; it does not create or strengthen the pipe ACL.

Therefore the security of pipe creation/ACL still belongs to ChatGPT Desktop/OpenAI.

It also depends on an internal provider protocol whose compatibility can change without a public standard.

### Current disposition

```text
CODEX_BROWSER_BRIDGE = HIGH_VALUE_OPENAI_SPECIFIC_ADAPTER
DUPLICATE_OPENAI_PIPE_IMPLEMENTATION_IN_WAG = FREEZE_BY_DEFAULT
PROVIDER_NEUTRAL = NO
CHATGPT_WEB_REPLACEMENT = NO
ADR_0019_REPLACEMENT = NO
```

## 6. BrowserMCP/browsermcp.io

Repository:
https://github.com/BrowserMCP/mcp

Public popularity is not sufficient evidence.

Current public core has severe problems:

- public source history is old relative to current issue traffic;
- README/public architecture has monorepo/build limitations;
- open MV3 reconnect/session-state failures;
- open local WebSocket authentication concern;
- open server-crash/recursion defect;
- Windows process cleanup defects.

### Current disposition

```text
BROWSERMCP_IO = DEMOTE
STAR_COUNT_AS_QUALITY_SIGNAL = REJECT
FIRST_EMPIRICAL_ROUND = NO
```

## 7. hangwin/mcp-chrome

Repository:
https://github.com/hangwin/mcp-chrome

Current open 2026 reports include:

- SSRF/path traversal in file-upload/native-host paths;
- CORS/origin bypass enabling a website to drive the MCP server;
- request for authentication/HTTPS;
- transport connection bugs;
- requests for a security contact/private reporting path.

Recent issue velocity is high while public master commit cadence is much older.

### Current disposition

```text
MCP_CHROME_HANGWIN = SECURITY_DEMOTE
REAL_PROFILE_ARCHITECTURE_VALUE = YES
TRUSTED_SUBSTRATE = NO
```

## 8. Vortex, Chromanche, claude-browser-bridge, smaller bridges

### Vortex

Repository:
https://github.com/benbergg/vortex-browser

Architecture uses native messaging plus a local server and exposes many useful verification-oriented tools.

Issue history shows active work on "honest failure" and selector/observation correctness.

However independent adoption remains small and the current published architecture/documentation is not a clearer Windows win over Playwright/Browser Controller.

Disposition:
**WATCH / code-review donor.**

### claude-browser-bridge

Repository:
https://github.com/skrabe/claude-browser-bridge

Strong ideas:

- native messaging;
- owner-only Unix socket;
- pinned extension id;
- credential popup keeps secrets out of model context;
- tab safety;
- programmable multi-step `run` tool.

But the installer/IPC path is currently Unix/macOS oriented, not a native Windows contender.

Disposition:
**architecture donor, not current Windows candidate.**

### Chromanche

Repository:
https://github.com/marcobazzani/Chromanche

Real-profile local bridge with active reliability work, but Windows install path is still secondary/manual/WSL-oriented and community volume is small.

Disposition:
**WATCH.**

### Browser Bridge / Real Browser MCP / chrome-faithful / similar

These remain valuable code-review references but none has enough independent sustained-use evidence to displace the stronger shortlist.

## 9. WebMCP maturity update

Official Chrome status remains experimental.

Current Chrome documentation:

- WebMCP entered origin trial in Chrome 149;
- it is still described as a proposed web standard and subject to change;
- APIs require origin isolation and Permissions Policy;
- Chrome's security guidance explicitly warns that indirect prompt injection remains a fundamental risk;
- `readOnlyHint`, `untrustedContentHint`, and `consequentialHint` are semantic hints, not trusted authorization.

Current specification issue traffic in September 2026 includes unresolved questions around:

- page-enforced write boundaries;
- an agent that can both invoke tools and automate the page potentially completing a page's own human-approval step;
- caller/tool lifecycle and in-flight unregister behavior;
- structured refusal vs success/error semantics;
- output/result shape.

### Important architecture consequence

A page can lie about a hint.
An injected page can contain adversarial content.
An agent with generic UI control can potentially bypass a page-local approval ritual.

Therefore:

```text
WEBMCP_SEMANTICS = HIGH_VALUE
WEBMCP_AUTHORITY = UNTRUSTED
CONSEQUENTIAL_HINT = SIGNAL_ONLY
WAG_LOCAL_APPROVAL = STILL_REQUIRED
```

Preferred future path remains:

```text
site-native WebMCP
  -> structured Playwright/native tools
  -> generic DOM/browser actions
  -> pixel/CUA fallback
```

with WAG policy/authority outside the page.

Official sources:
- https://developer.chrome.com/docs/ai/webmcp
- https://developer.chrome.com/docs/ai/webmcp/secure-tools
- https://developer.chrome.com/blog/ai-webmcp-origin-trial
- https://github.com/webmachinelearning/webmcp/issues

## 10. Provider-native Windows lifecycle update

Provider-native remains the first comparator, not the lifecycle baseline.

Current issue evidence still includes:

### OpenAI

- orphaned Chrome/browser processes on Windows;
- foreground focus stealing;
- Browser Use teardown exiting/crashing the desktop app;
- closing the last Browser Use tab crashing current Windows desktop builds.

### Claude

- native-host/packaging/ACL failures on Windows;
- stale "connected" browser status when no browser process is running;
- browser calls reporting success without actual browser effects.

These failures directly support keeping:

- exact-owned process supervision;
- explicit liveness/effect checks;
- cleanup fallback;
- no claim that "connected" equals "usable".

## 11. Cloud lane update

### Browserbase

Current official pricing:

- Free: 3 concurrent, 1 browser-hour;
- Developer: $20/month, 25 concurrent, 100 browser-hours, then $0.12/hr;
- Startup: $99/month, 100 concurrent, 500 browser-hours, then $0.10/hr.

Independent/anecdotal high-volume report (~10k sessions) says:

- spin-up and managed operations were materially easier than self-managed Chrome;
- stealth was useful for many targets;
- billing minimums made very short tasks expensive;
- batching tasks into reused sessions was the common workaround.

Important current Stagehand/security findings from Pass 4 remain relevant:
domain policy is not a WAG-grade authority boundary and session cleanup must be explicit.

### Kernel

Current official pricing:

- Free: 5 concurrent + $5 monthly usage credits;
- Hobbyist: $30/month, 10 concurrent;
- Startup: $200/month, 150 concurrent;
- usage billed by GB-second with no idle charge, per current vendor claims.

Kernel has a compelling architecture for idle-heavy human-in-the-loop flows:

- managed auth;
- durable profiles;
- standby/idle model;
- long-lived sessions;
- open-source browser image/SDKs.

But independent production/community evidence remains materially thinner than Browserbase.

Vendor benchmark claims against Browserbase should be treated as vendor claims, not accepted comparative truth.

### Cloud disposition

```text
CLOUD_FIRST_COMPARATOR = BROWSERBASE
CLOUD_SECOND_COMPARATOR = KERNEL
KERNEL_IDLE_MODEL = STRATEGICALLY_INTERESTING
INDEPENDENT_KERNEL_EVIDENCE = STILL_THIN
STEEL = OPEN_SOURCE_FALLBACK
CLOUD_PROVIDER_POLICY = NOT_WAG_AUTHORITY
```

## 12. Updated replacement map

### Freeze custom work now

Do not expand WAG to implement:

- generic DOM action catalogs;
- generic accessibility snapshot/action engines;
- arbitrary CDP wrappers;
- browser launch/profile engines;
- generic cloud browser provisioning;
- provider-specific ChatGPT Desktop named-pipe clone;
- WebMCP tool discovery/execution engine if first-party substrate exposes it.

### Strong donor/reuse set

```text
Playwright CLI/MCP/extension/Browser.bind
Browser Controller
Chrome Agent Bridge
Agent360 Browser MCP
codex-browser-bridge (OpenAI-specific)
WebMCP
Browserbase / Kernel
```

### WAG durable core still justified

Keep:

- trusted caller/admission;
- opaque workspace/session ownership;
- capability/risk policy;
- browser-proposal vs consequential-effect separation;
- local approval;
- secret isolation;
- durable effect/job ownership;
- audit/evidence;
- provider/substrate conformance;
- bounded cleanup fallback.

### Guardian

Keep context/continuity responsibilities.
Do not grow generic browser automation into Guardian.

### SessionCommander / Cleanup Sidecar

Keep exact-owned runtime supervision and residue cleanup until upstream empirical evidence proves:

- deterministic process exit;
- no orphan browser/daemon;
- no stale socket/pipe/port;
- bounded recovery after forced kill;
- no cross-session ownership confusion.

Do not make SessionCommander understand browser semantics unless exact evidence requires it.

## 13. Research state after Pass 5

Do **not** local benchmark yet solely because earlier passes suggested a shortlist.

The user asked for deeper research, and Pass 5 found enough new prior art to justify one more source/community narrowing pass.

### Next research targets

1. **Browser Controller**
   - Windows named-pipe ACL/auth implementation;
   - daemon orphan/restart behavior;
   - independent users/issues/releases;
   - source-level tab-lock/session ownership invariants.

2. **Chrome Agent Bridge**
   - Windows support and port ownership;
   - whether relay custom-header admission is adequate against arbitrary local clients;
   - real multi-profile failure behavior;
   - independent adoption.

3. **Agent360**
   - whether false-success issue #19 is fixed in a released version;
   - exact shipped state of profile pairing vs main branch;
   - process counts/residue under 10–15 concurrent sessions;
   - independent usage beyond maintainer reports.

4. **Playwright**
   - follow current discarded-tab/Memory Saver issue to resolution;
   - exact shared-browser-context isolation and extension token semantics;
   - lifecycle difference between launched vs attached browser.

5. **codex-browser-bridge**
   - exact Windows pipe ACL inherited from ChatGPT Desktop;
   - multi-client/session ownership behavior;
   - compatibility break history when ChatGPT Desktop changes.

6. **WebMCP**
   - track issue #297/#298-class approval/write-boundary decisions;
   - identify actual non-demo production adopters;
   - assess whether Chrome client-side confirmations become normative.

7. **Cloud**
   - find more independent Kernel production evidence;
   - compare explicit idle/session cleanup guarantees against Browserbase.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_5 = COMPLETE
LOCAL_BENCHMARK = NOT_RUN
BUILD_NEW_BROWSER = NO
PLAYWRIGHT_PROVIDER_NEUTRAL_PRIMARY = YES
BROWSER_CONTROLLER = PROMOTE_SOURCE_REVIEW
CHROME_AGENT_BRIDGE = PROMOTE_OWNERSHIP_DONOR
AGENT360 = PROMOTE_TARGETED_RESEARCH
CODEX_BROWSER_BRIDGE = PROMOTE_OPENAI_SPECIFIC_ADAPTER
VIBE_WINDOWS = DEMOTE_CURRENT
BROWSERMCP_IO = DEMOTE_STALE_SECURITY
MCP_CHROME_HANGWIN = DEMOTE_SECURITY
WEBMCP = SEMANTIC_FAST_PATH_NOT_AUTHORITY
BROWSERBASE = CLOUD_FIRST_COMPARATOR
KERNEL = CLOUD_SECOND_COMPARATOR
WAG_AUTHORITY_CORE = KEEP
OWNER_AWARE_CLEANUP = KEEP
NEXT_ACTION = PASS_6_DEEP_SOURCE_AND_COMMUNITY_NARROWING
```
