# New Chat Handoff — AI-native Browser Community Scan

Date: 2026-09-19
Repository: `ShenJun93/web-agent-gateway`
Canonical branch: `main`

## User directive

Continue researching community experience and prior art. Do **not** stop at Pass 2 and do **not** run local benchmarks yet.

Sunk cost does not protect WAG/Guardian/SessionCommander browser code. Prefer native/standard/proven upstream solutions when evidence is stronger.

## Canonical authority

Fresh-read in this order:

1. Git `main` / remote HEAD.
2. `README.md`.
3. `docs/adr/0018-lock-webchat-local-coding-mission.md`.
4. `docs/adr/0019-separate-browser-proposal-from-consequential-authority.md`.
5. Research receipts:
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan.md`
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-2.md`
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-3.md`
   - `docs/research/2026-09-19-ai-native-browser-replacement-pressure-audit.md`
6. Chat history last.

This handoff is not authority when Git disagrees.

## Verified research state

Passes 1–3 plus a replacement-pressure audit are complete.

No local install or benchmark was run in Pass 3.

Remote `main` was fresh-verified at
`0b39345f39e1725ec41a75ef4a567c9a4b18564f`
before the Pass 3 branch was created and remained unchanged before handoff update.

The local Windows Desktop Commander device was offline, so local worktree/HEAD remains unverified.

## Major correction to Pass 2

Pass 2's claim that the community stop condition was met is **superseded by the user's explicit request to continue research**.

Do not jump directly to Browser Harness/Panerelay benchmarking.

New evidence promoted first-party/native options that were missing from Pass 2.

## Native provider comparators

### OpenAI

Current OpenAI browser stack includes:

- ChatGPT Desktop built-in browser with its own browser state;
- official ChatGPT browser extension for existing Chrome/Edge/Brave/Opera/Vivaldi profiles, signed-in sessions and open tabs;
- browser work in ChatGPT Work/Codex;
- WebMCP/site tools in the built-in browser.

Atlas has been deprecated in favor of browser work inside ChatGPT/Codex.

This is the first thing to compare for provider-specific OpenAI workflows.

However Windows public evidence remains rough:
- native browser/Chrome bridge setup failures;
- orphan Chrome processes;
- foreground focus stealing;
- repeated in-app-browser teardown crashes that can terminate the entire desktop app and interrupt concurrent tasks.

Conclusion:
**native-first comparator, not Windows lifecycle baseline.**

### Anthropic

Claude in Chrome is the native comparator for Claude Code/Cowork and existing authenticated Chrome.

Public Windows evidence includes:
- native-host connection failures;
- stale connected states;
- auto-update regressions;
- named-pipe defects;
- startup wedge when Chrome is absent;
- multi-browser/tab ownership interference.

Conclusion:
**use native where stable; do not assume it removes supervision/ownership needs.**

## Provider-neutral top research tier

Do not treat this as benchmark order yet.

1. Microsoft Playwright CLI + `browser.bind()`
2. Microsoft Playwright MCP extension mode
3. Aside CLI/MCP/REPL
4. Browser Harness / Browser Use
5. Panerelay + Playwright/agent-browser/Browser Use
6. Playwriter
7. whg517/browser-bridge

### Why Playwright moved up

First-party Playwright now offers:
- coding-agent CLI;
- extension attachment to existing Chrome/Edge;
- persistent/isolated profiles;
- session interoperability;
- explicit idle cleanup for owned sessions;
- WebMCP support.

But important limits remain:
- persistent profile lock/orphan conflicts;
- Memory Saver/discarded tab can wedge commands;
- Windows persistent-profile failure paths;
- attached/extension browser is not owned by Playwright, so timeout detaches rather than killing browser/pages;
- network origin rules are explicitly not a security boundary.

### Why Browser Harness moved down from Pass 2 #1

It remains strong but current issues include:
- Windows auth-token/workspace permission-hardening gap;
- daemon-start race that can orphan one daemon;
- Windows test scaffolding failures;
- Browser Use Windows teardown orphan reports;
- shared-browser tab ownership gaps;
- telemetry/redaction concern;
- current daemon/cold-start reliability work.

It now must demonstrate a material advantage over first-party Playwright rather than being assumed the default.

### Panerelay

Still one of the strongest thin-transport designs:
- existing Chrome/Edge;
- explicit domain/tab authorization;
- no raw remote-debugging port;
- background/no-focus intent;
- engine-neutral Connect;
- browser process ownership deliberately unavailable.

Weakness:
independent adoption is small and real Windows release evidence needs more depth.

### whg517/browser-bridge

Direct WAG prior art:
- extension + native messaging;
- broker multiplexing multiple MCP clients;
- per-agent identities;
- browser/service-worker restart tolerance;
- site approval/high-risk confirmations;
- Apache-2.0;
- Windows prebuilt support.

Current blocker:
open verification issue around Windows broker survival vs Job Object lifetime semantics.

### Aside

High UX fit, but proprietary/closed source.
External live testing has found permission/hang/silent-denial semantics that require host deadlines and explicit result verification.
Privacy/sync/model paths are not purely local.

## BrowserOS neo correction

Do not promote BrowserOS neo as the Windows base yet.

Fresh issue evidence includes:
- dead loopback connections accumulating to system-level socket pressure;
- native messaging host orphaning with extreme process/memory/handle accumulation;
- idle session death/tab ownership loss;
- localhost/origin hardening issues;
- CPU-loop snapshot issue.

It remains useful product prior art but currently maps too closely to the user's existing cleanup bottleneck.

## Diagnostics and standards

Keep separate from browser ownership:

- Chrome DevTools MCP: first-party debug/observability substrate, not lifecycle owner.
- WebMCP: semantic page-tool layer, not local authority.
- Windows ODR/MCP containment: strategic future Windows isolation/discovery layer, still prerelease and not a current real-profile solution.

Chrome 136+ remote-debugging security changes also demote raw CDP-to-default-daily-profile architectures.

## Cloud/offload lane

Continue research, but do not build browser fleet infrastructure.

Current set:
- Browserbase
- Kernel
- Browserless
- Steel
- Notte
- Hyperbrowser
- Anchor
- Cloudflare Browser Run/Kitesurf

Browserbase's local `browse` CLI still uses a daemon and documents zombie-daemon cleanup; only the cloud path actually removes local browser-process ownership.

## Lightweight/headless lane

Separate from daily authenticated browser:

- Moli
- Lightpanda
- Obscura
- h5i

These may matter for cheap/stateless/low-trust work but should not be confused with a real-profile replacement.

## Replacement-pressure result

### Freeze expansion now

Do not add generic custom browser mechanics to WAG/Guardian unless new evidence demands them:

- browser action schema;
- tab/snapshot/navigation primitives;
- provider-specific Chrome/Edge transport;
- generic DevTools collection;
- cloud browser fleet management.

### Potentially retire later after evidence

- WAG-owned browser action/attachment plumbing;
- provider-specific browser glue;
- generic session-sharing mechanics if upstream contracts suffice.

### Retain

Current evidence still does not replace:

- WAG admission/ownership/capability policy;
- ADR-0019 local approval transition;
- durable consequential-effect ownership;
- audit/evidence;
- owner-aware cleanup for local browser/bridge processes;
- Guardian context measurement / continuity / early handoff warning.

Guardian should not grow into a browser automation platform.

SessionCommander should become narrower: supervise selected local browser bridges/runtimes, not implement browser semantics.

## Research rule

Continue community/prior-art research before local empirical tests.

Prefer:
1. upstream/official capability and security docs;
2. detailed issue reports with reproductions;
3. maintainer fixes/release velocity;
4. repeated independent sustained-use reports;
5. vendor claims only when clearly labeled.

Do not infer quality from stars or one Reddit comment.

## Next research directions

1. Deepen OpenAI native browser Windows reliability and whether newer September builds resolve July/August teardown/orphan defects.
2. Deepen Claude in Chrome multi-session ownership and Windows reliability after recent releases.
3. Compare Playwright CLI vs MCP extension vs `browser.bind()` lifecycle semantics and resource footprint.
4. Audit Browser Harness telemetry/privacy, Windows permission hardening, daemon ownership and issue response.
5. Audit Panerelay/whg517 browser-bridge Windows native-host lifecycle with independent evidence.
6. Track open-browser-use Windows native-host/socket issues and community growth.
7. Deepen Aside concurrency/cleanup/lock-in/privacy evidence.
8. Compare cloud Browserbase/Kernel/Browserless/Steel/Notte/Anchor on sustained production failure/reconnect/cost evidence.
9. Track Windows ODR maturity.
10. Continue looking for serious real-profile coding-agent browser bridges before closing the scan again.

## Decision markers

```text
COMMUNITY_PASS_3 = COMPLETE
REPLACEMENT_PRESSURE_AUDIT = COMPLETE
LOCAL_BENCHMARK_RUN = NO
COMMUNITY_SCAN_STOP_CONDITION = REOPENED_BY_USER
NEW_CUSTOM_BROWSER = FREEZE
GENERIC_WAG_BROWSER_ACTION_GROWTH = FREEZE
OPENAI_NATIVE_BROWSER = TOP_NATIVE_COMPARATOR
CLAUDE_IN_CHROME = TOP_NATIVE_COMPARATOR
PLAYWRIGHT = PRIMARY_PROVIDER_NEUTRAL_RESEARCH_TIER
ASIDE = HIGH_RESEARCH_TIER
BROWSER_HARNESS = HIGH_TIER_MUST_BEAT_FIRST_PARTY_PLAYWRIGHT
PANERELAY = HIGH_VALUE_THIN_TRANSPORT_DONOR
WHG517_BROWSER_BRIDGE = DIRECT_WAG_TRANSPORT_DONOR
BROWSEROS_NEO_WINDOWS = DEMOTED_PENDING_LIFECYCLE_FIXES
CHROME_DEVTOOLS_MCP = DEBUG_SUBSTRATE_NOT_LIFECYCLE_AUTHORITY
WINDOWS_ODR = STRATEGIC_WATCH_NOT_PRODUCTION_FOUNDATION
WAG_AUTHORITY_CORE = RETAIN
ADR_0019_APPROVAL_BOUNDARY = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN_BOUNDED
GUARDIAN_BROWSER_AUTOMATION_SCOPE = FREEZE
GUARDIAN_CONTINUITY_SCOPE = RETAIN
NEXT_ACTION = CONTINUE_COMMUNITY_RESEARCH
```
