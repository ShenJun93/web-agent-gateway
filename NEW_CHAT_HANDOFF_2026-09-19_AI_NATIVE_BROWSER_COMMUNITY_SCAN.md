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
5. Current research receipts through:
   - `docs/research/2026-09-20-ai-native-browser-research-pass-6.md`
   - `docs/research/2026-09-20-ai-native-browser-research-pass-7.md`
   plus Pass 1–5 and the replacement-pressure audit referenced by earlier receipts.
6. Chat history last.

This handoff is not authority when Git disagrees.

## Verified research state

Passes 1–7 plus the replacement-pressure audit are complete.

No local install/benchmark was run in Pass 7.

Remote `main` was fresh-verified at:
`2b811148fc3e8ee2499397acb0fd64066cb97a5f`
before the Pass 7 branch was created.

## Current architecture direction

```text
DO NOT BUILD A NEW AI-NATIVE BROWSER.

Chrome-specific live debugging
  -> Chrome DevTools for agents comparator

provider-neutral browser automation
  -> Playwright primary substrate
  -> explicit isolated BrowserContext per independent owner

provider-specific ChatGPT/Codex Desktop browser path
  -> reuse thin adapter/native pipe
  -> do not clone private transport into WAG core

real-profile multi-agent browser control
  -> source donors only until Windows ACL/ownership evidence is adequate

consequential authority
  -> WAG ADR-0019

effect truth
  -> generation-bound preconditions
  -> CONFIRMED / FAILED / UNKNOWN
  -> no blind replay after UNKNOWN

local runtime/process lifecycle
  -> SessionCommander/Cleanup exact-owned supervision retained
```

## Pass 7 material changes

### Browser Controller — Windows ACL gate discovered

Source confirms strong application-level auth/session design, but its token/enrollment files rely on Node `mode: 0600`.

Node documents that Windows does not implement owner/group/others POSIX mode distinctions. Therefore `0600` is not proof of owner-only NTFS ACL.

The named pipe is also created without project-visible explicit Windows security descriptor. Token auth remains useful, but actual file/pipe DACLs must be verified/hardened before promotion.

### LAPSrj/browser-mcp — lifecycle donor strengthened

Commit history confirms:

- atomic shared-profile coordination;
- dead-session pruning;
- kill exact browser tree before sidecar finalization;
- wait for Windows PID death before deleting coordination state;
- orphaned authenticated browser adoption using launch signature;
- stale relay health probe and relay-only repair.

Keep as lifecycle prior art, not authority. Sidecar authentication/PID-reuse/tamper resistance remains unresolved; do not copy the WSL `0.0.0.0` relay.

### Chrome DevTools — blocker set corrected

- #2431 memory issue is closed/fixed in 1.7.0.
- #2675 Windows autoConnect timeout remains open.
- new #2778 shows lazy autoConnect + consent + host tool timeout can form a restart loop on Windows.
- latest public release found in Pass 7 remains 1.9.0 (2026-09-08).
- #2621 follow-up reproduces stale temp-profile cleanup after SIGKILL but did not reproduce the original long-lived Chrome-root symptom on current stable; issue remains open.

Conclusion:
first-party Chrome action/debug comparator, **not lifecycle authority**.

### Playwright — fix velocity better than Pass 6 wording

- #1631 closed.
- #42608 closed/fixed.
- concurrent clients require explicit topology:
  - isolated BrowserContext per client for separate agents; or
  - shared BrowserContext only when shared state is intentional.

Playwright remains primary provider-neutral substrate. BrowserContext isolation is useful infrastructure, not WAG authority.

### whg517/browser-bridge

Issue #192 remains open with no Windows Job Object result. Do not promote shared broker lifetime contract.

### Agent360

Issue #19 remains open.

The durable lesson is tri-state effect truth:

```text
CONFIRMED
FAILED
UNKNOWN
```

Transport success, DOM movement or unrelated page movement is not enough to prove target effect. `UNKNOWN` must not cause blind replay.

### codex-browser-bridge / ChatGPT-Codex Desktop native pipe

Thin reuse is valuable and creates strong pressure against rebuilding the provider-specific pipe.

But the bridge inherits upstream pipe ACL/lifecycle and can enumerate/claim tabs; that is not WAG opaque ownership.

Public OpenAI issue evidence also shows Windows browser-use pipes can exist while integration/handshake still fails.

### Hronaut — new authority/effect donor

Hronaut adds genuinely relevant prior art:

- durable named workspaces;
- restart-safe resume capability;
- human pause/takeover;
- pre-dispatch generation/action fences;
- `OUTCOME_UNKNOWN` after uncertain dispatch;
- proposed independent observer context.

But:
- project/community is very new;
- Windows build unsigned;
- source-available subscription license;
- explicit multi-agent lease model is still an open issue;
- independent public-outcome observer is still an open issue.

Use as authority/effect-verification donor, not replacement.

### Hark / Polar

Remain product/UX comparators. Hark is still research-preview/vendor-demo heavy; Polar has independent early reports of resource/reliability problems.

## Current replacement/freeze map

Freeze:
- generic DOM/action catalog in WAG;
- generic CDP wrappers;
- custom browser launcher/profile engine;
- new provider-specific ChatGPT Desktop pipe clone;
- generic browser automation in Guardian;
- browser-semantic features in SessionCommander.

Retain:
- WAG caller/admission/opaque ownership;
- capability policy;
- ADR-0019 proposal/effect split;
- local approval;
- durable effects/jobs;
- audit/evidence;
- Guardian context/continuity;
- SessionCommander exact-owned process/runtime supervision;
- Cleanup Sidecar independent fallback/verifier.

Strengthen:
- Windows native ACL evidence for secrets and local IPC;
- process identity beyond PID liveness;
- validated coordination state;
- generation-bound preconditions;
- tri-state effect reconciliation;
- independent observer evidence where audience matters.

## Pass 8 — still research only

Research next:

1. Compare Windows-native ACL hardening in Browser Controller, Hronaut and other local browser daemons.
2. Find donors using explicit Windows DACL/SID/DPAPI/Credential Manager rather than POSIX mode assumptions.
3. Audit Hronaut token storage, resume capability persistence, connection ownership and Windows ACL behavior.
4. Audit LAPSrj sidecar trust against PID reuse/tampering and find stronger coordination-identity patterns.
5. Re-check Chrome DevTools #2675/#2778/#2621 and releases.
6. Re-check Agent360 1.30 and #19 closure.
7. Inspect Playwright extension/shared-browser ownership after current fixes.
8. Research Chromium/Edge/WebMCP native standardization that could obsolete custom bridges.
9. Continue independent sustained-use failure/recovery evidence for Hark/Polar/Hronaut/BrowserOS only when signal is real.
10. Keep the proposed WAG effect-verification contract as research output; do not implement yet.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_7 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE
BUILD_NEW_BROWSER = NO

BROWSER_CONTROLLER_WINDOWS_ACL = UNPROVEN
LAPSRJ_BROWSER_MCP = STRONG_WINDOWS_LIFECYCLE_DONOR

CHROME_DEVTOOLS_2431_MEMORY = FIXED_1_7_0
CHROME_DEVTOOLS_2675 = OPEN
CHROME_DEVTOOLS_2778 = OPEN
CHROME_DEVTOOLS_2621 = OPEN_NARROWED
CHROME_DEVTOOLS_LIFECYCLE_BASELINE = NO

PLAYWRIGHT_1631 = CLOSED
PLAYWRIGHT_42608 = CLOSED
PLAYWRIGHT_MULTI_CLIENT = EXPLICIT_TOPOLOGY_REQUIRED
PLAYWRIGHT_SHARED_CONTEXT = NOT_AUTHORITY_BOUNDARY

WHG517_192 = OPEN
AGENT360_19 = OPEN
WAG_EFFECT_RESULT = CONFIRMED_FAILED_UNKNOWN
UNKNOWN_BLIND_RETRY = FORBIDDEN

CODEX_BROWSER_BRIDGE = PROVIDER_ADAPTER_DONOR
CODEX_BROWSER_PIPE_ACL = INHERITED_UNPROVEN

HRONAUT = AUTHORITY_EFFECT_DONOR
HRONAUT_REPLACEMENT = NO

WAG_AUTHORITY_CORE = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN
GENERIC_BROWSER_ACTION_BUILD = FREEZE

NEXT_ACTION = PASS_8_WINDOWS_SECURITY_AND_EFFECT_TRUTH_RESEARCH
```
