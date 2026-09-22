# AI-native Browser Research — Pass 7

Date: 2026-09-20
Status: RESEARCH RECEIPT — targeted source/fix-velocity/security review; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start of pass: `2b811148fc3e8ee2499397acb0fd64066cb97a5f`

## Purpose

Continue the user-requested browser research without running local benchmarks.

Pass 7 targets the unresolved gates from Pass 6:

1. Browser Controller Windows secret/pipe security.
2. LAPSrj/browser-mcp stale sidecar, orphan and crash recovery.
3. Chrome DevTools for agents fix velocity.
4. Playwright multi-client fixes and safe topology.
5. whg517/browser-bridge Windows Job Object evidence.
6. Agent360 false-success/effect-verification closure.
7. codex-browser-bridge inherited ChatGPT/Codex Desktop pipe semantics.
8. independent Hark/Polar evidence.
9. new projects only when they contribute a genuinely new authority/ownership/effect primitive.

No local install, browser launch, benchmark, registry change, process mutation or profile mutation was performed.

## Executive conclusion

Pass 7 changes several assumptions from Pass 6.

### 1. Browser Controller security architecture is strong, but its Windows secret/IPC claim is not yet proven strongly enough

Source confirms:

- fixed Windows named pipe `\\.\pipe\browser-controller`;
- every IPC client must authenticate with the daemon token;
- extension WebSocket requires the token plus exact extension-origin pinning;
- HTTP control endpoints require a separate enrollment secret;
- the daemon supports per-client sessions, heartbeat eviction, rate budgets, bounded tool timeouts and abort-on-disconnect.

However, its token and enrollment files are created through Node `fs.writeFileSync(..., {mode: 0o600})`.

Node's current documentation explicitly states that on Windows only the write permission is changeable through POSIX mode bits and the owner/group/others distinction is not implemented.

Therefore:

```text
BROWSER_CONTROLLER_MODE_0600_ON_WINDOWS != PROOF_OF_OWNER_ONLY_NTFS_ACL
```

This does not prove an exploit. It means the Windows file ACL boundary is **unverified**.

The named pipe itself is also created through Node/libuv with no project-visible explicit Windows security descriptor. Microsoft documents that a named pipe created with the default security descriptor grants full control to LocalSystem, administrators and the creator owner, while also granting read access to Everyone and anonymous users. Browser Controller's application-level token still blocks an unauthenticated client from issuing calls, but if the token file is readable by another local principal the two controls are not independent.

Required promotion gate:

- inspect actual NTFS DACLs on `token.json` and `enrollment.json`;
- inspect actual DACL on `\\.\pipe\browser-controller`;
- preferably add explicit owner-only ACL hardening or another Windows-native secret store/security descriptor;
- keep hostile-same-user out of scope unless stronger OS isolation is explicitly designed.

Disposition:

```text
BROWSER_CONTROLLER = HIGH_SOURCE_REVIEW
WINDOWS_TOKEN_FILE_ACL = UNPROVEN
WINDOWS_PIPE_DACL = UNPROVEN
APPLICATION_TOKEN_AUTH = STRONG_DESIGN
PRODUCTION_PROMOTION = BLOCKED_ON_WINDOWS_ACL_EVIDENCE
```

Sources:
- https://github.com/compnew2006/browser-controller
- https://github.com/compnew2006/browser-controller/blob/main/SECURITY.md
- https://nodejs.org/api/fs.html
- https://learn.microsoft.com/windows/win32/ipc/named-pipe-security-and-access-rights

## 2. LAPSrj/browser-mcp crash recovery is stronger than Pass 6 recorded

Commit history shows concrete recovery work beyond simple PID/refcount coordination.

### Shared-profile coordination

The sidecar records:

- root browser PID;
- CDP/relay ports;
- process name;
- spawn time;
- attached browser-mcp sessions.

A companion lock is created atomically. Dead browser-mcp session PIDs are pruned during lock acquisition.

### Kill ordering was corrected

Earlier cleanup could delete the sidecar before the browser tree was proven dead. If browser teardown partially failed, the next process could see a locked profile but no coordination record.

The current recovery sequence is explicitly:

```text
mark/refcount sidecar
-> kill exact root browser tree
-> wait for Windows PID death
-> finalize/remove sidecar
```

This is directly aligned with SessionCommander's exact-owned cleanup design.

### Orphan adoption exists

After a browser-mcp process crash, the project can discover an orphaned browser launched for the requested profile using a multi-field launch signature rather than only a PID:

- browser process identity;
- exact `--user-data-dir`;
- `--remote-allow-origins=*`;
- `--remote-debugging-port`.

When exactly one candidate is found, it can rebuild relay/sidecar state and adopt the same authenticated browser instead of spawning a profile-lock competitor.

### Stale relay recovery exists

The project also fixed the case:

```text
browser root alive
+ relay dead
+ sidecar still present
```

The exact CDP endpoint is now probed. If browser CDP is healthy, only the relay is replaced and the authenticated browser is preserved. If CDP is also unavailable, the operation fails rather than spawning a conflicting browser.

### Remaining gaps

This promotes LAPSrj as a **lifecycle donor**, not an authority donor.

Still unresolved from current source/community evidence:

- no cryptographic authentication of the sidecar was established in this pass;
- PID liveness alone is insufficient as a general identity primitive under PID reuse, even though orphan adoption also checks launch signature;
- malicious/stale sidecar tampering under a hostile local principal has not been proven contained;
- its WSL relay can bind `0.0.0.0`, broader than WAG's preferred loopback-only boundary;
- independent community production evidence remains very small.

Disposition:

```text
LAPSRJ_BROWSER_MCP = STRONG_WINDOWS_LIFECYCLE_DONOR
KILL_THEN_FINALIZE_ORDER = ADOPT_AS_PRIOR_ART
ORPHAN_ADOPTION = STRONG_PRIOR_ART
STALE_RELAY_RECOVERY = STRONG_PRIOR_ART
SIDECAR_AUTHORITY = NOT_WAG_GRADE
WSL_0_0_0_0_RELAY = DO_NOT_COPY
```

Key commits:
- `f608a41ec491a1a91bad1aa29e7f528ccedcd970`
- `c6b7929bf2b9f31847922b0be7ca170c99ad7d9b`
- `0a543c022723b26636cbd797c635164d38a597bd`
- `2cbbdc406c86be06dd6fcc46092a2a50ec5a10f9`

Repository:
- https://github.com/LAPSrj/browser-mcp

## 3. Chrome DevTools for agents — correct the blocker set

Pass 6 grouped memory, autoConnect and orphan concerns together. Pass 7 separates resolved from unresolved evidence.

### Memory issue #2431 — resolved

Issue #2431 was closed as completed. The investigation found a large retained per-page DevTools/source-map cost rather than a simple generic request collector leak. The project moved source-map loading toward lazy behavior and reports the fix in 1.7.0.

Therefore:

```text
CHROME_DEVTOOLS_2431_MEMORY = FIXED_IN_1_7_0
```

Do not continue citing #2431 as a current blocker without a fresh regression.

### Windows autoConnect #2675 — still open

Issue #2675 remains open. The reporter reproduced the timeout even after:

- activating tabs;
- using a clean profile;
- using a single active tab;
- removing the npx/cmd launch layer.

The same Chrome profile works from a standalone MCP client, while the integrated host path times out.

### New autoConnect readiness issue #2778 — strengthens the lifecycle concern

A new issue opened 2026-09-19 against 1.9.0 / Chrome 153 / Windows identifies a separate readiness problem:

```text
MCP initializes
-> first tool lazily starts Chrome connection
-> Chrome asks for consent
-> host tool timeout expires
-> host kills MCP
-> next MCP repeats consent
```

The proposed direction is a readiness state machine/background connection rather than tying consent to one tool call's lifetime.

As of this pass, the latest public release remains **1.9.0 (2026-09-08)**. No release containing a #2675/#2778 closure was found.

### Orphan issue #2621 — narrow the claim

The original report observed long-lived orphan Chrome roots after MCP death.

A later minimal reproduction on current stable Chrome reproduced the **temporary profile directory surviving SIGKILL**, but did not reproduce the Chrome process tree surviving. The maintainer requested reliable current-version process reproduction before adopting a sentinel fix.

Therefore the accurate current claim is:

```text
SIGKILL_TEMP_PROFILE_CLEANUP_GAP = REPRODUCED
LONG_LIVED_CHROME_ROOT_ON_CURRENT_STABLE = NOT_REPRODUCED_IN_FOLLOWUP
ISSUE_2621 = STILL_OPEN
```

### Current disposition

Chrome DevTools remains the first-party Chrome inspection/action comparator and creates strong pressure against custom CDP/DevTools wrappers.

It still does not own the lifecycle baseline for this project because Windows autoConnect readiness remains unresolved and abnormal-exit cleanup is not an accepted exact-owned contract.

Sources:
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2431
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2675
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2621
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2778
- https://github.com/ChromeDevTools/chrome-devtools-mcp/releases
- https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/CHANGELOG.md

## 4. Playwright fix velocity is materially better than the Pass 6 wording

Two multi-client defects used in Pass 6 are now closed.

### #1631 — closed

The maintainer clarified the intended topology:

For concurrent MCP clients, use either:

- `--isolated`: an isolated BrowserContext per client while sharing the Browser; or
- `--shared-browser-context`: intentionally share one BrowserContext.

The historical default persistent-profile behavior is not safe to assume for multiple concurrent HTTP clients.

### #42608 — closed/fixed

The shared-context recorder sink collision was fixed upstream.

Current release notes also include:

- explicit idle-timeout behavior;
- safer shared-context `browser_close`;
- recorder separation;
- timeout instead of indefinite hang for a wrong-profile extension token;
- additional workspace/symlink hardening.

### Architectural conclusion

The correction is not "Playwright cannot do multi-client."

It is:

```text
PLAYWRIGHT_MULTI_CLIENT = SUPPORTED_WITH_EXPLICIT_TOPOLOGY
OWNER -> ISOLATED_BROWSER_CONTEXT = PREFERRED_FOR_SEPARATE_AGENTS
SHARED_BROWSER_CONTEXT = INTENTIONAL_SHARED_STATE
SHARED_BROWSER_CONTEXT != WAG_AUTHORITY_BOUNDARY
ATTACHED_BROWSER != SERVER_OWNED_BROWSER
```

For WAG, owner/session identity, approval and consequential authority stay outside Playwright even when Playwright provides the browser isolation primitive.

Sources:
- https://github.com/microsoft/playwright-mcp/issues/1631
- https://github.com/microsoft/playwright/issues/42608
- https://github.com/microsoft/playwright-mcp

## 5. whg517/browser-bridge Windows Job Object gate — no progress

Issue #192 is still open with no recorded Windows result.

Its acceptance checklist still requires evidence that the shared broker survives:

- normal server exit;
- forced server kill;
- real MCP-client exit;
- two-client sharing;
- one-client exit while the other remains;
- Windows Job Object inspection.

The issue itself identifies the remediation pressure:

- `CREATE_BREAKAWAY_FROM_JOB` if the parent Job allows breakaway;
- otherwise independent broker startup such as a scheduled task;
- otherwise explicitly document unsupported client topology.

Disposition remains:

```text
WHG517_BROWSER_BRIDGE = STRONG_TRANSPORT_DONOR
WINDOWS_MULTI_CLIENT_LIFETIME = UNPROVEN
ISSUE_192 = OPEN
LIFECYCLE_BASELINE = NO
```

Source:
- https://github.com/whg517/browser-bridge/issues/192

## 6. Agent360 issue #19 yields a stronger effect contract

Issue #19 remains open.

The important result of the latest work is not just another click/fill implementation. It is an improved result model.

Measured/source-reviewed failures included:

- a controlled select whose visible/app state succeeds while an early rollback check reports failure;
- a controlled input clear step that appears successful but appends rather than replaces;
- page-level fingerprints that can be changed by unrelated UI activity;
- same-length content changes that defeat length-only fingerprints.

v1.29.2 improves several of these checks, but a published schema/description mismatch was then found: one side documented `maybe_landed` while the extension returned a Danish field name. The maintainer says this is corrected on main for the next release. Current npm evidence still showed 1.29.2 during this pass.

The most important reusable design is the **third outcome**:

```text
CONFIRMED
FAILED
UNKNOWN / LANDED_UNVERIFIED
```

If unrelated page state changes, that movement is evidence that something happened but **not evidence that the requested effect happened**.

Therefore:

```text
TRANSPORT_OK != EFFECT_CONFIRMED
DOM_MUTATED != APP_STATE_CONFIRMED
PAGE_CHANGED != TARGET_EFFECT_CONFIRMED
UNKNOWN -> NO_BLIND_RETRY
```

This should become a WAG-level durable-effect contract rather than a browser-specific convention.

Sources:
- https://github.com/Agent360dk/browser-mcp/issues/19
- https://github.com/Agent360dk/browser-mcp
- https://www.npmjs.com/package/@agent360/browser-mcp

## 7. codex-browser-bridge — strong provider adapter, inherited authority remains opaque

`DeliciousBuding/codex-browser-bridge` reuses the Windows `codex-browser-use-*` named pipe already exposed by the ChatGPT/Codex desktop browser stack.

Useful source properties:

- no separate Chrome CDP listener;
- each pipe connection gets its own browser session/turn;
- per-tab operation locks;
- explicit existing-tab discovery and claiming;
- passive reconnect after pipe death;
- attached-tab cache cleared on reconnect/finalize;
- bounded diagnostics and protocol framing.

This is strong evidence **against rebuilding the OpenAI-specific browser transport** in WAG.

But it is not an ownership/authority replacement:

- it is a client of the upstream named pipe, so it does not define the pipe's Windows ACL;
- no project-level evidence establishes that upstream pipe ACL as a WAG-grade principal boundary;
- `codex_user_tabs` can enumerate existing browser tabs exposed by upstream;
- `codex_claim_tab` can claim an existing visible tab;
- its session/claim semantics are not the same as WAG opaque workspace ownership.

Public OpenAI Codex issue evidence confirms that the browser-use native pipe exists on Windows, but also records Windows builds where the pipe is present while Browser Use integration/handshake fails. This reinforces a reuse-not-reimplement strategy without treating the path as boring lifecycle infrastructure.

Disposition:

```text
CODEX_BROWSER_BRIDGE = PROVIDER_SPECIFIC_ADAPTER_DONOR
REBUILD_CHATGPT_DESKTOP_PIPE = NO
UPSTREAM_PIPE_ACL = INHERITED_AND_UNPROVEN
TAB_CLAIM != OPAQUE_WAG_OWNERSHIP
WAG_AUTHORITY_REPLACEMENT = NO
```

Sources:
- https://github.com/DeliciousBuding/codex-browser-bridge
- https://github.com/openai/codex/issues/19693
- https://github.com/openai/codex/issues/20846

## 8. Hronaut — new effect/authority donor, not a proven replacement

Pass 7 discovered Hronaut because it introduces genuinely new primitives rather than another generic action catalog.

Hronaut is a separate visible Electron/Chromium browser with:

- persistent named workspaces;
- isolated profile/site state;
- restart-safe workspace resume capabilities;
- human pause/takeover;
- site policies;
- action-authority fences;
- typed stale/precondition outcomes;
- explicit `OUTCOME_UNKNOWN`;
- optional post-write read-back.

Its public design explicitly treats page/DOM/screenshot/model text as **untrusted input**, not authority.

For a consequential action it binds the request to:

- workspace/tab identity;
- top-level origin;
- navigation generation;
- observation/human-interaction generations;
- policy version;
- operation/target class;
- private target fingerprint.

If context changes before dispatch it returns a typed no-effect rejection. If context changes after dispatch, it discards the normal result and returns `OUTCOME_UNKNOWN` with `retrySafe:false`.

This is strong prior art for WAG.

### Independent observer verification is not complete

Open issue #187 proposes a separate observer context for claims such as "the public can see this post." It correctly distinguishes writer-context read-back from public observation.

### Multi-agent ownership is still evolving

Open issue #190 proposes explicit revocable leases/ownership claims for shared workspace/tab mutation. That means current durable workspace identity should not be mistaken for a complete concurrent-writer authority model.

### Maturity / lock-in

Current public evidence is small:

- project is very new;
- independent user reports are scarce;
- Windows release is unsigned;
- source is available but ongoing use is subscription licensed rather than permissive OSS.

Disposition:

```text
HRONAUT = AUTHORITY_EFFECT_VERIFICATION_DONOR
KEY_DONOR = ACTION_FENCE,GENERATION_BINDING,OUTCOME_UNKNOWN,OBSERVER_CONTEXT
WINDOWS_DAILY_DRIVER = NOT_PROVEN
MULTI_AGENT_LEASE_MODEL = OPEN_ISSUE
LICENSE_LOCK_IN = NON_PERMISSIVE
WAG_REPLACEMENT = NO
```

Sources:
- https://github.com/hronaut/hronaut
- https://github.com/hronaut/hronaut/blob/main/docs/UNTRUSTED_PAGE_CONTENT.md
- https://github.com/hronaut/hronaut/issues/187
- https://github.com/hronaut/hronaut/issues/190
- https://hronaut.dev/

## 9. Hark / Polar — product pressure, not infrastructure authority

### Hark Handoff

Independent reporting confirms Hark is a heavily funded browser/computer-use effort, but Handoff remains a research preview.

The public demo and benchmark claims are not equivalent to repeatable sustained-use evidence on user accounts. A third-party technical review likewise cautions that vendor demos/internal harnesses do not establish production success, pricing or service levels.

Keep it as a model/product comparator, not an infrastructure dependency.

### Polar

Independent hands-on reporting found meaningful resource/reliability problems during early access, including high credit burn, device heat and a browser crash under a small tab count.

That strengthens the Pass 6 decision to keep Polar as UX/product evidence rather than a Windows operational foundation.

Disposition:

```text
HARK = HIGH_FUNDING_RESEARCH_PREVIEW
POLAR = UX_COMPARATOR_WITH_INDEPENDENT_RESOURCE_FAILURE_REPORTS
PROPRIETARY_AGENT_BROWSER_REPLACES_WAG = NO
```

Sources:
- https://techcrunch.com/2026/08/05/hark-previews-its-browser-use-agent-for-completing-tasks/
- https://hark.com/articles/introducing-hark-handoff
- https://wavect.io/blog/hark-handoff-computer-use-agent-review/

## 10. WAG-level effect-verification contract to carry forward

Across Agent360, Hronaut and the failure evidence in Playwright/Chrome, Pass 7 supports an explicit WAG contract independent of which browser substrate wins.

For every consequential effect:

### Before dispatch

Bind authority to immutable or versioned facts:

- exact owner/session/workspace;
- capability;
- target class/opaque target identity;
- origin/navigation generation;
- current approved plan/fingerprint;
- approval generation where required.

If any required fact changes before dispatch:

```text
NO_EFFECT
+ typed stale/policy/ownership rejection
+ retrySafe=true only when no effect was dispatched
```

### After dispatch

Do not equate protocol success with effect success.

Reconcile against a target-relevant postcondition.

Possible outcomes:

```text
EFFECT_CONFIRMED
EFFECT_FAILED
OUTCOME_UNKNOWN
```

`OUTCOME_UNKNOWN` includes:

- transport loss after dispatch;
- contradictory evidence;
- only unrelated page state changed;
- observer context unavailable when the claim requires independent observation;
- navigation/context drift after dispatch;
- external system accepted but final state cannot be proven.

For `OUTCOME_UNKNOWN`:

```text
retrySafe = false
blind automatic replay = forbidden
reconciliation = required
```

For public/audience-dependent outcomes, author-context read-back alone is not authoritative. Where economically justified, use an independent read-only observer context.

This contract should be added before WAG grows another consequential browser surface.

## Updated architecture map

```text
Chrome-specific debugging / live Chrome
  -> Chrome DevTools for agents first-party comparator

Provider-neutral browser automation
  -> Playwright primary action substrate
  -> explicit isolated BrowserContext per independent owner

Provider-specific ChatGPT/Codex desktop browser path
  -> reuse upstream native pipe / thin adapter
  -> do not clone its private transport into WAG core

Real-profile multi-agent browser control
  -> Browser Controller / Chrome Agent Bridge / Panerelay donors
  -> no promotion until Windows ACL/ownership evidence is sufficient

Windows shared-profile lifecycle
  -> SessionCommander exact-owned supervision retained
  -> LAPSrj kill-then-finalize + orphan-adoption patterns are strong donors

Consequential authority
  -> WAG ADR-0019 retained

Effect truth
  -> pre-dispatch generation fence
  -> target-relevant postcondition
  -> CONFIRMED / FAILED / UNKNOWN
  -> no blind retry after UNKNOWN

Persistent separate agent browser
  -> Hronaut useful authority/evidence donor
  -> not production-proven enough to replace current architecture

Cloud execution
  -> Browserbase primary comparator
  -> Kernel second
  -> Steel open-source fallback
```

## What this means for existing custom code

### Freeze / avoid building

- generic browser action catalogs;
- generic CDP/DevTools wrappers;
- another Chrome launcher/profile manager;
- a new ChatGPT/Codex Desktop named-pipe clone;
- generic multi-client browser protocol;
- browser-semantic logic inside SessionCommander;
- generic browser automation inside Guardian.

### Retain

- WAG admission and opaque ownership;
- ADR-0019 proposal/effect split;
- local approval;
- durable consequential effects/jobs;
- bounded audit/evidence;
- Guardian continuity/context protection;
- SessionCommander exact-owned runtime/process supervision;
- Cleanup Sidecar independent fallback/verifier.

### Strengthen next

- Windows-native ACL evidence for local secrets/IPC;
- process identity stronger than PID-liveness alone;
- authenticated/validated coordination state;
- pre-dispatch generation binding;
- tri-state post-effect reconciliation;
- independent observer evidence for audience-dependent effects.

## Pass 8 — still research only

The user explicitly wants more research. Do not start local benchmark by default.

Next targeted pass:

1. Compare Windows-native ACL hardening patterns across Browser Controller, Hronaut and other local browser daemons.
2. Find donors using explicit Windows DACL/SID/DPAPI/Credential Manager rather than POSIX-mode assumptions.
3. Audit Hronaut current token storage, resume capability persistence, connection ownership and Windows ACL behavior.
4. Audit LAPSrj sidecar trust against PID reuse/tampering and identify stronger sidecar identity patterns.
5. Re-check Chrome DevTools #2675/#2778/#2621 and releases for fix movement.
6. Re-check Agent360 1.30 and issue #19 for actual closure.
7. Inspect Playwright extension/shared-browser ownership after the latest fixes without confusing isolation with authority.
8. Research Chromium/Edge/WebMCP native browser-control standardization that could obsolete custom bridges.
9. Find independent sustained-use evidence for Hark/Polar/Hronaut/BrowserOS only when it contains real failure or recovery evidence.
10. Turn the effect-verification contract into a proposed WAG ADR/spec only after the research phase is sufficiently stable; do not implement it yet.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_7 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE
BUILD_NEW_BROWSER = NO

BROWSER_CONTROLLER = HIGH_SOURCE_REVIEW
BROWSER_CONTROLLER_WINDOWS_TOKEN_ACL = UNPROVEN
BROWSER_CONTROLLER_WINDOWS_PIPE_DACL = UNPROVEN
POSIX_0600_ON_WINDOWS = NOT_OWNER_ONLY_ACL_PROOF

LAPSRJ_BROWSER_MCP = STRONG_WINDOWS_LIFECYCLE_DONOR
LAPSRJ_KILL_THEN_FINALIZE = PROMOTE_PRIOR_ART
LAPSRJ_ORPHAN_ADOPTION = PROMOTE_PRIOR_ART
LAPSRJ_SIDECAR_AUTHORITY = NOT_WAG_GRADE

CHROME_DEVTOOLS_2431_MEMORY = FIXED_1_7_0
CHROME_DEVTOOLS_2675 = OPEN
CHROME_DEVTOOLS_2778 = OPEN_AUTOCONNECT_READINESS
CHROME_DEVTOOLS_2621 = OPEN_PROFILE_CLEANUP_GAP_NARROWED
CHROME_DEVTOOLS_LIFECYCLE_BASELINE = NO

PLAYWRIGHT_1631 = CLOSED
PLAYWRIGHT_42608 = CLOSED
PLAYWRIGHT_MULTI_CLIENT_TOPOLOGY = EXPLICIT_ISOLATION_REQUIRED
PLAYWRIGHT_SHARED_CONTEXT = NOT_AUTHORITY_BOUNDARY

WHG517_192 = OPEN_NO_WINDOWS_RESULT
AGENT360_19 = OPEN
AGENT360_EFFECT_MODEL = CONFIRMED_FAILED_UNKNOWN

CODEX_BROWSER_BRIDGE = PROVIDER_SPECIFIC_ADAPTER_DONOR
CODEX_BROWSER_PIPE_ACL = INHERITED_UNPROVEN
REBUILD_CHATGPT_DESKTOP_BROWSER_PIPE = NO

HRONAUT = AUTHORITY_EFFECT_VERIFICATION_DONOR
HRONAUT_MULTI_AGENT_LEASE = OPEN
HRONAUT_INDEPENDENT_OBSERVER = OPEN
HRONAUT_REPLACEMENT = NO

WAG_EFFECT_RESULT = CONFIRMED_FAILED_UNKNOWN
UNKNOWN_BLIND_RETRY = FORBIDDEN

WAG_AUTHORITY_CORE = RETAIN
ADR_0019_APPROVAL_BOUNDARY = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN
GENERIC_BROWSER_ACTION_BUILD = FREEZE

NEXT_ACTION = PASS_8_WINDOWS_SECURITY_AND_EFFECT_TRUTH_RESEARCH
```
