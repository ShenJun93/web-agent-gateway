# New Chat Handoff — AI-native Browser / Agent-browser Research

Date: 2026-09-20
Repository: `ShenJun93/web-agent-gateway`
Canonical branch: `main`

## User directive

Continue research. **Do not run local benchmarks yet.**

Do not preserve WAG/Guardian/SessionCommander browser code because of sunk cost. Prefer native/standard/proven upstream where evidence is stronger, but do not retire authority/lifecycle guarantees without evidence.

## Canonical authority

Fresh-read in this order:

1. Git `main` / remote HEAD.
2. `README.md`.
3. `docs/adr/0018-lock-webchat-local-coding-mission.md`.
4. `docs/adr/0019-separate-browser-proposal-from-consequential-authority.md`.
5. Current research receipts:
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan.md`
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-2.md`
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-3.md`
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-4.md`
   - `docs/research/2026-09-19-ai-native-browser-replacement-pressure-audit.md`
   - `docs/research/2026-09-20-ai-native-browser-research-pass-5.md`
   - `docs/research/2026-09-20-ai-native-browser-research-pass-6.md`
6. Chat history last.

This handoff is not authority when Git disagrees.

## Verified research state

Passes 1–6 plus the replacement-pressure audit are complete.

No local install/benchmark was run in Pass 6.

Remote `main` was fresh-verified at:
`e8ac691b09e80a2a9925163ed04e652479928d05`
before the Pass 6 branch was created.

## Current architecture direction

```text
DO NOT BUILD A NEW AI-NATIVE BROWSER.

provider-specific workflow
  -> provider-native browser where accepted

Chrome-specific live debugging / real Chrome
  -> Chrome DevTools for agents first-party comparator

provider-neutral browser automation
  -> Playwright primary substrate

real-profile multi-agent ownership
  -> Browser Controller / Chrome Agent Bridge / Panerelay / vetted bridge donors

consequential local effects
  -> WAG ADR-0019 proposal -> local approval -> durable effect core

local runtime/process lifecycle
  -> SessionCommander / Cleanup Sidecar exact-owned supervision until upstream proves zero-residue recovery
```

## Pass 6 changes

### Chrome DevTools for agents — PROMOTED

Now treat Google Chrome DevTools for agents as a first-party Chrome comparator.

Strong:
- stable official surface;
- existing logged-in Chrome via `--autoConnect`;
- explicit Chrome permission prompt;
- live tabs/extensions/application state;
- concurrent-page routing experiment;
- WebMCP/custom page tooling.

Current blockers:
- Windows `--autoConnect` timeout issue #2675;
- orphan isolated Chrome issue #2621;
- long-lived memory/CPU retention reports;
- duplicate/reconnect process conflicts.

Conclusion:
**do not recreate generic Chrome DevTools/CDP features, but do not make it lifecycle authority.**

### Playwright — still provider-neutral primary, but shared context is not isolation

Recent issues demonstrate cross-client DOM/page/recorder bleed under shared BrowserContext modes.

Conclusion:
- keep Playwright as action substrate;
- keep owner/session identity outside Playwright shared context;
- do not use shared context as WAG authority boundary.

### Browser Controller — remains top source-review candidate

Source review confirms:
- separate enrollment secret;
- exact extension Origin pin;
- token-authenticated IPC and WebSocket;
- Windows named-pipe IPC;
- unique session IDs;
- heartbeat eviction;
- per-session rate limits;
- bounded per-tool timeouts;
- abort in-flight calls + release exact session locks on disconnect.

Gap:
- independent sustained-use evidence remains thin;
- Windows named-pipe ACL / hostile-same-user evidence still needed.

### Agent360 — improving but #19 class still open

v1.29.2 adds stronger event/effect checks and honest failures for several interaction classes.

But project's own docs still point to issue #19 for remaining false-success behavior.

Use as effect-verification donor, not primary substrate yet.

### LAPSrj/browser-mcp — PROMOTED Windows lifecycle donor

Distinctive Windows mechanics:
- exact root browser PID;
- `taskkill /F /T` exact tree teardown;
- sidecar with root PID/CDP port/attached sessions;
- shared-profile refcount;
- last-session teardown;
- session-scoped tabs;
- Edge + Chrome stated live-validated.

Security caution:
- WSL relay may bind `0.0.0.0`; threat review required.
- community/adoption evidence remains tiny.

### browser-rs-mcp — PROMOTED authority donor, not Windows candidate

Useful:
- per-owner capability auth;
- managed multi-tenant mode;
- secret-broker design.

Current public builds are macOS/Linux, not Windows.

### uiuing/browser-agent — PROMOTED effect-verification donor

Useful design:
- post-action verification against live DOM;
- expected vs actual evidence;
- risk tiers;
- site policies;
- confirmation prompts;
- authorization memory;
- audit traces.

This is strong prior art for WAG result/effect verification without requiring adoption of the whole runtime.

### whg517/browser-bridge — Windows gate remains open

Issue #192 still requests real Windows evidence that broker survives client/server death under Windows Job Object `KILL_ON_JOB_CLOSE`.

Do not assume its multi-client broker lifetime on the user's workload until that is verified.

## Proprietary / funded browser layer

### Polar

$5.7M seed led by Madrona, ex-Comet team, focused on long-running authenticated knowledge-work automation.

Relevant as product/UX comparator.
Not a provider-neutral local infrastructure replacement.

### Hark Handoff

Very heavily funded browser/computer-use system. Current public evidence is still preview/vendor-demo heavy; independent sustained-use evidence is not yet enough for architecture decisions.

### Aside

Mixed community experience:
- strong logged-in cross-site automation reports;
- also bloat/crash/sign-out/privacy complaints.

UX comparator only.

### Phi

Interesting local/open browser direction but currently macOS-only, so not the Windows operational base.

## Current replacement/freeze map

Freeze:
- new generic DOM/action catalog in WAG;
- generic CDP wrappers;
- custom browser launch/profile engine;
- another general multi-client browser protocol;
- ChatGPT Desktop private pipe clone while codex-browser-bridge/native path is sufficient;
- cloud browser fleet infrastructure;
- Guardian generic browser automation;
- SessionCommander browser-semantic features.

Retain:
- WAG caller/admission/opaque ownership;
- capability policy;
- ADR-0019 proposal/effect split;
- local approval;
- durable effects/jobs;
- audit/evidence;
- Guardian context/continuity;
- SessionCommander exact-owned process/runtime supervision;
- Cleanup Sidecar as independent fallback/verifier.

Strengthen:
- explicit post-action/effect verification;
- fail-closed ownership;
- bounded timeout/recovery;
- exact process-tree cleanup evidence.

## Pass 7 — still research only

Research next:

1. Browser Controller Windows named-pipe ACL and NTFS token/enrollment permissions.
2. LAPSrj stale/malicious sidecar handling, PID reuse, crash recovery and Windows process ownership.
3. Chrome DevTools #2675/#2621/#2431 fix velocity/current release state.
4. Playwright fixes after #1631/#42608 and recommended safe multi-client topology.
5. whg517/browser-bridge #192 Windows Job Object result.
6. Agent360 #19 full closure.
7. codex-browser-bridge inherited ChatGPT Desktop named-pipe ACL and multi-client semantics.
8. independent Polar/Hark long-duration failure evidence.
9. additional projects only when they add a genuinely new authority/ownership/lifecycle primitive.
10. convert best external effect-verification ideas into a WAG-level contract before any browser implementation grows.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_6 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE
BUILD_NEW_BROWSER = NO

PLAYWRIGHT_PROVIDER_NEUTRAL_PRIMARY = YES
CHROME_DEVTOOLS_FOR_AGENTS = FIRST_PARTY_CHROME_COMPARATOR
PLAYWRIGHT_SHARED_CONTEXT = NOT_AUTHORITY_BOUNDARY

BROWSER_CONTROLLER = HIGH_SOURCE_REVIEW
LAPSRJ_BROWSER_MCP = WINDOWS_LIFECYCLE_DONOR
BROWSER_RS_MCP = AUTHORITY_DONOR_NO_WINDOWS
UIUING_BROWSER_AGENT = EFFECT_VERIFICATION_DONOR
AGENT360 = EFFECT_VERIFICATION_DONOR_ISSUE19_OPEN
WHG517_BROWSER_BRIDGE = WINDOWS_LIFETIME_GATE_OPEN

WAG_AUTHORITY_CORE = RETAIN
ADR_0019_APPROVAL_BOUNDARY = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN
GENERIC_BROWSER_ACTION_BUILD = FREEZE
EFFECT_VERIFICATION_REQUIREMENT = STRENGTHEN

NEXT_ACTION = PASS_7_TARGETED_SOURCE_AND_FIX_VELOCITY_RESEARCH
```
