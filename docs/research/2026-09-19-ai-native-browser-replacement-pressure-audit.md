# AI-native Browser Replacement Pressure Audit

Date: 2026-09-19
Status: RESEARCH RECEIPT — architecture/replacement analysis from community + upstream evidence
Local benchmark: NOT RUN
Repository: `ShenJun93/web-agent-gateway`

## Purpose

Translate the browser ecosystem research into one question:

**Which existing WAG / Guardian / SessionCommander responsibilities should stop growing, which can plausibly be retired, and which still have no adequate upstream replacement?**

This audit is not a migration approval. It is a reuse/retirement pressure map.

Canonical authority remains ADR-0018 and ADR-0019.

## Core finding

The browser ecosystem is converging quickly enough that WAG should **not** build a browser platform.

The likely durable architecture is:

```text
native provider browser
or
Playwright / Panerelay / vetted bridge
or
managed cloud browser
          |
          v
thin compatibility adapter
          |
          v
WAG authority / policy / approval / durable effects
```

The custom value should move upward toward authority and evidence, not downward into browser mechanics.

## Layer-by-layer replacement pressure

### 1. Browser action primitives

Examples:
- open/navigate/tab select;
- accessibility snapshot;
- click/type/scroll;
- screenshots;
- network/console/DevTools;
- form/upload/download browser mechanics.

Replacement pressure: **VERY HIGH**

Strong upstreams now include:
- official ChatGPT browser/extension;
- Microsoft Playwright CLI/MCP;
- Chrome DevTools MCP;
- Claude in Chrome;
- agent-browser;
- Browser Harness;
- Playwriter;
- Panerelay-connected engines;
- managed browser providers.

Decision implication:

**Freeze new generic WAG browser-action features unless a measured workflow cannot be expressed through an upstream substrate.**

### 2. Existing authenticated-browser attachment

Replacement pressure: **HIGH**

Current serious paths:
- ChatGPT official extension for OpenAI-native workflows;
- Claude in Chrome for Anthropic-native workflows;
- Playwright MCP extension mode;
- Panerelay Connect;
- Playwriter;
- Browser Harness;
- open-browser-use;
- whg517/browser-bridge;
- Aside.

Important correction:
raw CDP against the daily Chrome profile should not be the preferred architecture. Chrome 136+ deliberately restricts remote debugging against the default user-data directory for security reasons.

### 3. Browser session interoperability / multi-client routing

Replacement pressure: **MEDIUM-HIGH**

Promising upstream mechanisms:
- Playwright `browser.bind()`;
- Playwright shared/attached session modes;
- Panerelay participant/session mapping;
- whg517/browser-bridge broker;
- Playwriter sessions/tab groups;
- provider-native browser session management.

But public evidence still shows session-crossing and ownership bugs across major products:
- Claude-in-Chrome multi-session tab confusion;
- Browser Harness shared-browser ownership gaps;
- Playwright profile-lock/orphan conflicts;
- BrowserOS session/tab ownership loss;
- Browserbase local daemon named-session requirements.

Decision implication:

Do not invent another general multi-client browser protocol. But do keep an external owner/session identity at the WAG boundary until an upstream contract demonstrates isolation.

### 4. Local browser/process lifecycle ownership

Replacement pressure: **MEDIUM**

Cloud browsers can remove this responsibility for offloaded work.

Local candidates have not eliminated it:
- OpenAI Browser Use has public Windows orphan/teardown defects;
- Claude in Chrome has native-host/pipe defects;
- Browser Harness has daemon races/orphan issues;
- Playwright attached/extension browser is explicitly not owned by the server;
- Playwright persistent profiles have orphan-lock cases;
- Browserbase Browse local mode documents zombie-daemon cleanup;
- BrowserOS has severe Windows socket/process leakage reports;
- whg517/browser-bridge still has an open Windows broker-lifetime verification issue;
- Opera/Playwriter/other bridges keep persistent local bridge processes.

Decision implication:

**Do not retire SessionCommander/Cleanup Sidecar owner-aware cleanup yet.**
Instead reduce its scope to supervising selected local browser bridges/runtimes.

### 5. Browser/profile security boundary

Replacement pressure: **LOW-MEDIUM**

Useful upstream controls exist:
- OpenAI/Anthropic site/action approvals;
- Panerelay domain/tab authorization;
- whg517/browser-bridge site approval/high-risk confirmation;
- Playwright filesystem restrictions and network controls;
- browser extension permission boundaries;
- cloud provider isolation.

But none substitutes for WAG's consequential authority model.

Playwright explicitly documents that allowed/blocked origins are not a security boundary.
WebMCP/Chrome security guidance explicitly treats prompt injection as an unresolved probabilistic risk and recommends deterministic guardrails.

Decision implication:

**Keep WAG authority outside the browser runtime.**

### 6. Consequential local execution authority

Replacement pressure: **LOW**

No browser candidate in this scan provides the exact ADR-0019 contract:

```text
browser/model proposes bounded intent
-> separate local authority approves exact intent
-> durable WAG core owns consequential execution
```

Provider/browser action confirmations are useful UX but do not automatically satisfy:
- local code/process/Git authority;
- immutable reviewed proposal binding;
- durable single-use approval;
- restart recovery;
- outcome-unknown handling;
- effect ownership.

Decision implication:

**WAG's approval/effect core remains differentiated and should not be coupled to any browser vendor.**

### 7. Browser observability

Replacement pressure: **VERY HIGH**

Do not build generic replacements for:
- Chrome DevTools MCP;
- Playwright devtools/network/console;
- Browserbase/managed recordings;
- browser traces;
- HAR/network capture;
- generic replay.

WAG should consume bounded evidence produced by these systems when useful.

### 8. Cloud browser fleet management

Replacement pressure: **VERY HIGH**

Do not build browser VM/container fleet infrastructure.

Current credible providers include:
- Browserbase;
- Kernel;
- Browserless;
- Steel;
- Notte;
- Hyperbrowser;
- Anchor;
- Cloudflare Browser Run/Kitesurf.

Choose only when a measured workload benefits from offload.

## Candidate-by-candidate implication

### ChatGPT Desktop browser + official extension

What it can replace:
- OpenAI-provider browser transport;
- authenticated Chrome attachment for ChatGPT Work/Codex;
- background browser actions;
- some provider-specific browser glue.

What it cannot replace:
- ChatGPT Web adapter requirement in ADR-0018;
- provider-neutral WAG core;
- local consequential authority;
- independent cleanup guarantees.

Current Windows risk:
- Browser/Chrome bridge installation and pipe failures;
- orphan Chrome reports;
- in-app WebView teardown can terminate the desktop app;
- focus-stealing reports.

Action:
**Native comparator; do not build competing OpenAI-specific browser mechanics without first proving a Web-only need.**

### Claude in Chrome

What it can replace:
- Claude-specific browser bridge;
- real-profile automation from Claude Code/Cowork.

What it cannot replace:
- provider-neutral WAG;
- multi-provider/browser ownership;
- deterministic local effect authority.

Windows risk:
- native-host connection failures;
- stale connected state;
- update regressions;
- tab/session interference.

Action:
**Use native for Claude where stable; do not use it as lifecycle baseline.**

### Microsoft Playwright CLI / MCP

What it can replace:
- most generic browser automation/action schema;
- browser launch/attach mechanics;
- snapshot/action routines;
- much browser testing infrastructure;
- some session-sharing plumbing.

What it cannot replace:
- authority;
- attached-browser ownership/cleanup;
- external approval transitions.

Important current evidence:
- Playwright CLI now gives explicit idle cleanup for owned headless sessions and exits daemons when control sockets disappear;
- extension/attached browsers remain externally owned and explicit idle timeout only disconnects;
- a discarded Chrome Memory Saver tab can wedge commands;
- Windows persistent-profile/download defects remain current;
- origin allow/block controls are explicitly not security boundaries.

Action:
**Highest-priority provider-neutral substrate. Build around it before extending WAG browser mechanics.**

### Aside

What it can replace:
- real-profile browser UX;
- background agent tabs;
- auth/password handling;
- browser action layer;
- some session/history workflows.

What it cannot replace:
- inspectable provider-neutral infrastructure;
- WAG authority.

Risk:
- closed-source/proprietary;
- server-backed sync/model paths;
- external live testing found permission/hang/silent-denial semantics that require host deadlines and result verification.

Action:
**Strong operational candidate, weak strategic dependency candidate until failure/privacy/lock-in are acceptable.**

### Browser Harness / Browser Use

What it can replace:
- real-Chrome browser action layer;
- CLI/MCP browser tooling;
- some local/cloud unification.

Current blockers:
- Windows token-directory hardening gap;
- daemon-start race can orphan;
- Windows test scaffolding gaps;
- Browser Use core has Windows teardown orphan reports;
- telemetry issue reports script/stdout/helper-argument upload on the wrong redaction path;
- shared-browser ownership gaps.

Action:
**High replacement potential, but no longer default #1 ahead of Playwright native surfaces.**

### Panerelay

What it can replace:
- direct browser login-state plumbing;
- custom tab-authorization bridge;
- raw debug-port attachment;
- engine-specific connection glue.

Strength:
- narrowly scoped Fetch vs Connect authority;
- explicit tab/domain authorization;
- browser process ownership deliberately unavailable;
- engine choice remains external.

Limitation:
- low independent adoption;
- Windows real-Chrome stable release evidence still needs stronger proof.

Action:
**Strong architecture donor and potential thin transport.**

### whg517/browser-bridge

What it can replace:
- WAG native messaging transport;
- multi-MCP-client browser broker;
- extension/service-worker resilience mechanics.

Strength:
- Apache-2.0;
- explicit broker ownership;
- site approval/high-risk confirmations;
- Windows prebuilt support.

Limitation:
- small adoption;
- open Windows broker-survival verification issue.

Action:
**Direct WAG transport donor; code-review deeply before building equivalent mechanics.**

### Playwriter

What it can replace:
- real-profile attach;
- programmable Playwright action surface;
- multi-session relay;
- remote access/tunnels.

Risk:
- attachment/disconnect issues;
- relay lifecycle/token issues;
- smaller proof base.

Action:
**Secondary reusable substrate, especially if its one programmable surface proves materially simpler than MCP tool catalogs.**

### open-browser-use

What it can replace:
- custom native-host/extension real-Chrome bridge;
- provider-specific browser transport.

Strength:
- local-first;
- multi-language SDKs;
- local policy controls;
- active WebMCP work.

Risk:
- very small independent community base;
- current Windows native-host discovery issue;
- current socket unlink/EPERM issue.

Action:
**Watch/code-review; not enough evidence to retire WAG transport.**

### BrowserOS neo

What it can replace in theory:
- dedicated agent browser;
- persistent identity;
- MCP browser integration;
- some browser-side agent orchestration.

Current Windows evidence blocks promotion:
- native messaging host process leak report;
- dead-loopback socket accumulation report;
- session expiry/tab ownership loss;
- localhost/origin hardening issues;
- CPU-loop snapshot issue.

Action:
**Do not choose as the user's Windows operational base until lifecycle regressions clear.**

### Browserbase Browse + cloud

What it can replace:
- browser action CLI;
- cloud browser fleet;
- persistent remote contexts;
- hosted observability.

Local mode limitation:
- daemon/zombie cleanup is documented;
- named sessions are required to avoid parallel conflicts.

Cloud mode:
- materially reduces local process pressure but adds service dependency/cost/lock-in.

Action:
**Good offload lane; not proof that local cleanup code can disappear.**

## Guardian impact

### Freeze/retire candidate scope

Guardian should not grow into:
- a generic browser automation layer;
- tab navigation engine;
- browser process manager;
- DevTools collector.

### Preserve

Guardian's distinct mission remains:
- session context measurement;
- early handoff warning;
- continuity checkpoint/recovery;
- lightweight UI that does not materially degrade browser performance.

Browser control should be delegated to a chosen upstream.

## SessionCommander impact

SessionCommander should become **narrower**, not be deleted yet.

Keep:
- owner-aware process accounting;
- task/session process association;
- stale daemon/native-host detection;
- bounded reclaim;
- cleanup evidence.

Avoid:
- browser-specific action logic;
- browser automation protocol semantics;
- recreating provider session managers.

If future empirical evidence shows the selected local substrate always contains its own process tree and leaves zero residue under forced failure, browser-specific cleanup can then be retired.

## Cleanup Sidecar impact

Keep as:
- quarantine/recovery fallback;
- independent cleanup verifier.

Do not make it the normal lifecycle path for a browser substrate that routinely leaks. A candidate that requires constant Sidecar cleanup should be considered operationally failing.

## Long-term Windows direction

Windows ODR/MCP containment may eventually reduce:
- MCP server discovery/registration;
- packaging;
- OS isolation;
- resource grants;
- audit plumbing.

Because ODR is still prerelease and current containment does not directly access the user's interactive browser/apps, do not block current work on it.

But avoid large irreversible investment in custom Windows MCP registration/containment without rechecking ODR maturity first.

## Current architecture recommendation

Without running local benchmarks yet:

```text
DO NOT BUILD A NEW AI-NATIVE BROWSER.

Prefer:

provider-native browser
  where the workflow is provider-specific

otherwise

Playwright-first provider-neutral substrate
  + optional Panerelay / vetted real-profile bridge
  + cloud offload when local browser ownership is unnecessary

under

WAG authority / approval / durable-effect boundary

with

SessionCommander/Cleanup Sidecar only for bounded local lifecycle supervision
```

This is a research direction, not an empirical acceptance decision.

## Decision markers

```text
NEW_CUSTOM_BROWSER = FREEZE
GENERIC_WAG_BROWSER_ACTION_GROWTH = FREEZE
PROVIDER_SPECIFIC_BROWSER_GLUE = RETIRE_WHERE_NATIVE_IS_ACCEPTED
PLAYWRIGHT = PRIMARY_PROVIDER_NEUTRAL_SUBSTRATE_TO_RESEARCH
PANERELAY = HIGH_VALUE_THIN_TRANSPORT_DONOR
WHG517_BROWSER_BRIDGE = DIRECT_WAG_TRANSPORT_DONOR
OPENAI_NATIVE_BROWSER = TOP_PROVIDER_NATIVE_COMPARATOR
CLAUDE_IN_CHROME = TOP_PROVIDER_NATIVE_COMPARATOR
WAG_AUTHORITY_CORE = RETAIN
ADR_0019_APPROVAL_BOUNDARY = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN_BOUNDED
GUARDIAN_BROWSER_AUTOMATION_SCOPE = FREEZE
GUARDIAN_CONTINUITY_SCOPE = RETAIN
CLOUD_BROWSER_FLEET_BUILD = DO_NOT_BUILD
LOCAL_BENCHMARK_RUN = NO
RESEARCH_CONTINUES = YES
```
