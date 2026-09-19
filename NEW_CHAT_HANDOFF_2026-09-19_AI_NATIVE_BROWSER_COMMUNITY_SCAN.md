# New Chat Handoff — AI-native Browser Community Scan

Date: 2026-09-20
Repository: `ShenJun93/web-agent-gateway`
Canonical branch: `main`

## User directive

Continue researching community experience, source-level prior art, security and lifecycle. **Do not run local benchmarks yet.**

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
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-4.md`
   - `docs/research/2026-09-19-ai-native-browser-replacement-pressure-audit.md`
   - `docs/research/2026-09-20-ai-native-browser-research-pass-5.md`
6. Chat history last.

This handoff is not authority when Git disagrees.

## Verified research state

Passes 1–5 plus the replacement-pressure audit are complete.

No local install/benchmark was run in Pass 5.

Remote `main` was fresh-verified at
`33ca394a63a31665e4e6f2dbf8394cb0fbed779c`
before the Pass 5 branch was created.

## Pass 5 synthesis

### Primary provider-neutral substrate remains Playwright

Keep this ordering:

```text
coding agent + shell -> Playwright CLI first
generic MCP + existing authenticated Chrome/Edge -> Playwright MCP extension first
shared Playwright browser/session -> Browser.bind()/shared context before custom broker
```

Do not treat Playwright as cleanup/lifecycle baseline yet. Current real-profile/Windows failure evidence remains relevant.

### Browser Controller — PROMOTE

`compnew2006/browser-controller` is the strongest new local architecture found in Pass 5.

Important properties:
- exact tab targeting;
- per-client session IDs;
- per-tab mutex/lock;
- shared daemon for multiple agents;
- Windows named-pipe IPC;
- loopback-only WebSocket;
- auth token + separate enrollment secret;
- fail-closed port ownership;
- bounded timeouts and no retry of side-effecting actions;
- MIT.

Caution:
- tiny public adoption;
- current README competitor comparison is stale about Playwright's existing-browser/multi-agent capability.

Use source/test design as evidence, not its market comparison.

### Chrome Agent Bridge — PROMOTE AS OWNERSHIP/CLEANUP DONOR

`cmsflash/agent-browser-mcp` enforces `threadTitle -> one private tab group`.

Key findings:
- thread cannot enumerate/touch another thread's tabs;
- profile routing fails closed rather than guesses;
- reconnect/freeze/focus-steal tests exist;
- important cleanup finding: closing a grouped set of tabs can leave a Chrome saved-group artifact that syncs to the user account; safe cleanup is ungroup then close;
- abandoned workspace GC exists.

Limitation:
- local shell is trusted; local admission is not a WAG-grade boundary.
- Windows-specific proof remains weaker than macOS/test-profile proof.

### Agent360 Browser MCP — PROMOTE TARGETED RESEARCH

Strengths:
- active maintenance;
- documented 20-session model;
- tab groups per agent;
- stdin-close + idle cleanup;
- optional profile pairing;
- human-in-the-loop tool.

Hard blockers:
- issue #19: action can report `ok:true` while React app state did not change;
- issue #18: full port contention causes repeated range-wide bind attempts;
- issue #11: Windows SPA scroll can complete without triggering lazy-load effect.

Effect verification must be a hard acceptance requirement.

### codex-browser-bridge — PROMOTE OPENAI-SPECIFIC ADAPTER

Reuses ChatGPT Desktop's `codex-browser-use-*` named pipe and provider browser extension.

Implication:
**freeze any plan to duplicate ChatGPT Desktop's private browser pipe inside WAG unless this adapter is proven insufficient.**

It remains:
- OpenAI-specific;
- dependent on private/undocumented protocol;
- not a ChatGPT Web replacement;
- not an ADR-0019 authority replacement.

### Vibe MCP — DEMOTE CURRENT WINDOWS LOCAL LANE

Feature set is strong, especially outbound remote relay.

But current evidence:
- issue #129: native Windows relay fails to stabilize across tested 0.1.0–0.3.2 versions;
- DevTools path used a POSIX `/tmp` socket on native Windows in that report;
- issue #157: clean-main browser CLI E2E `status` timeout;
- issue #132: non-loopback HTTP MCP needs real authentication, Host validation is insufficient.

Keep remote outbound architecture as a donor, not current Windows primary.

### BrowserMCP/browsermcp.io and hangwin/mcp-chrome — DEMOTE

Popularity is not enough.

Current evidence includes stale public core, unauthenticated/local-control concerns, reconnect/process defects, and for hangwin active high-risk SSRF/path/origin/auth reports.

Do not spend first-round empirical time here.

### WebMCP — semantic layer becomes more important, authority does not

Chrome origin trial is active and current docs/security guidance are evolving.

September spec discussions still include:
- page-enforced write boundaries;
- an agent that can both call WebMCP and automate UI potentially satisfying the page's own approval UI;
- lifecycle/abort/refusal semantics.

Therefore:

```text
WebMCP tool semantics = valuable
WebMCP hints = untrusted signals
consequentialHint = not authorization
WAG local approval = still required
```

Preferred semantic path remains:

```text
WebMCP -> structured Playwright/native tools -> generic DOM -> pixel/CUA fallback
```

### Provider-native paths remain comparators, not lifecycle baselines

Current OpenAI Windows browser reports still include orphan processes/focus/teardown crashes.
Current Claude Windows reports still include native-host problems and stale false-positive browser-connected state.

Keep exact liveness/effect verification and bounded cleanup.

### Cloud lane

Browserbase:
- strongest independent production/community volume;
- official current paid entry $20/mo with 25 concurrent and 100 browser hours;
- independent ~10k-session anecdote supports managed ops/stability but complains about short-task billing floor.

Kernel:
- strong managed-auth/profiles/idle model;
- current $30 Hobbyist, 10 concurrent; $200 Startup, 150 concurrent;
- vendor claims idle/no-idle-charge advantages;
- independent production evidence still thinner than Browserbase.

Keep:
```text
cloud first comparator = Browserbase
cloud second comparator = Kernel
open-source fallback = Steel
```

## Current replacement map

### Freeze custom generic browser mechanics

Do not expand:
- DOM action catalogs;
- generic snapshot engines;
- browser launch/profile engines;
- arbitrary CDP wrappers;
- custom session-sharing broker before Playwright/browser donors fail measured requirements;
- OpenAI Desktop named-pipe clone;
- generic cloud browser fleet management.

### Retain

WAG:
- caller/admission;
- opaque ownership;
- capability policy;
- ADR-0019 proposal/effect split;
- local approval;
- secret isolation;
- durable effect/job ownership;
- audit/evidence;
- substrate conformance.

Guardian:
- context/continuity/early handoff.

SessionCommander/Cleanup:
- exact-owned runtime/process supervision;
- residue cleanup until upstream proves deterministic zero-residue recovery.

## Pass 6 — still research only

Research next:

1. Browser Controller Windows named-pipe ACL/auth, daemon restart/orphan behavior, independent adoption.
2. Chrome Agent Bridge Windows support, local admission, multi-profile ownership, independent use.
3. Agent360 exact released pairing state and whether false-success #19 gets fixed.
4. Playwright discarded-tab/Memory Saver issue, attached-vs-owned lifecycle and shared-context isolation.
5. codex-browser-bridge pipe ACL inherited from ChatGPT Desktop and multi-client behavior.
6. WebMCP approval/write-boundary issue evolution and real non-demo adopters.
7. more independent Kernel production evidence vs Browserbase.
8. only discover additional real-profile bridges when they add a capability not already covered above.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_5 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE
BUILD_NEW_BROWSER = NO
PLAYWRIGHT_PROVIDER_NEUTRAL_PRIMARY = YES
BROWSER_CONTROLLER = PROMOTE_SOURCE_REVIEW
CHROME_AGENT_BRIDGE = PROMOTE_OWNERSHIP_DONOR
AGENT360 = PROMOTE_TARGETED_RESEARCH
CODEX_BROWSER_BRIDGE = PROMOTE_OPENAI_SPECIFIC_ADAPTER
VIBE_WINDOWS = DEMOTE_CURRENT
BROWSERMCP_IO = DEMOTE
MCP_CHROME_HANGWIN = DEMOTE_SECURITY
WEBMCP = SEMANTIC_FAST_PATH_NOT_AUTHORITY
BROWSERBASE = CLOUD_FIRST_COMPARATOR
KERNEL = CLOUD_SECOND_COMPARATOR
WAG_AUTHORITY_CORE = RETAIN
OWNER_AWARE_CLEANUP = RETAIN
NEXT_ACTION = PASS_6_DEEP_SOURCE_AND_COMMUNITY_NARROWING
```
