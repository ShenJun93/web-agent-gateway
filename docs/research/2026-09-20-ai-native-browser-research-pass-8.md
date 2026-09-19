# AI-native Browser Research — Pass 8

Date: 2026-09-20
Status: RESEARCH RECEIPT — Windows security + effect-truth + WebMCP standardization; no local benchmark
Repository: `ShenJun93/web-agent-gateway`
Remote `main` at start of pass: `5c5b7c46982481f669b17158967a447ab7076492`

## Purpose

Continue user-requested browser/agent-browser research without practical local benchmarking.

Pass 8 targets:

1. Windows-native secret and IPC protection for local browser daemons.
2. Hronaut owner token, delegated capability and restart-continuity behavior.
3. LAPSrj/browser-mcp coordination identity/trust implications.
4. Playwright existing-profile extension ownership/security semantics.
5. Agent360 effect-verification follow-up.
6. WebMCP/Edge/Chrome standardization pressure and security gaps.
7. New WebMCP-native browser/workflow projects only where they add materially new prior art.

No local install, browser launch, registry edit, profile mutation, process mutation or benchmark was performed.

## Executive conclusion

Pass 8 strengthens the existing direction rather than reopening a "build a browser" path.

The most important changes are:

- **Windows local secret/IPC hardening now has a concrete native baseline:** explicit NTFS/pipe DACLs plus DPAPI CurrentUser where a persisted bearer secret is unavoidable; application-layer token authentication remains defense in depth.
- **Hronaut's delegated capability architecture is stronger than its owner-token storage:** capability credentials are persisted as SHA-256 digests with revision/lineage/use/expiry constraints, but the MCP owner bearer token is still plaintext-at-rest behind POSIX-style `0600`, which is not owner-only ACL proof on Windows.
- **Hronaut restart continuity intentionally refuses to trust old runtime evidence:** evidence keys/epochs are process-local, restart restores guarded workspaces as stale/unknown and requires explicit fresh review.
- **Playwright Extension provides good multi-client tab coordination but explicitly grants broad browser/profile authority after approval.** Tab groups are an operational ownership aid, not least-authority security isolation.
- **WebMCP has become a real platform direction, not a speculative side path:** Chrome origin trial, Edge 153/154 origin-trial exposure, Playwright MCP WebMCP integration and reproducible benchmark evidence all create strong pressure to stop building generic DOM/action semantics.
- **WebMCP still does not replace WAG authority.** Current standard work has open agent-identity/scoped-permission/delegation gaps, and a real browser-agent reproduction demonstrated that a host capable of both tool calls and browser automation can actuate the page's own "human approval" UI.
- **Effect truth must stay external to transport success.** Current WebMCP issue work itself contains outcome-transport and cancellation/conformance cases where work may occur while the caller observes an error/unknown result.

## 1. Windows local-secret baseline — replace POSIX assumptions with native controls

Pass 7 established that Node.js `mode: 0o600` does not prove owner-only protection on Windows.

Node's own current documentation states that on Windows:

- only the write permission is changeable through the POSIX mode abstraction;
- owner/group/others distinctions are not implemented.

Therefore any browser daemon that claims Windows bearer-secret isolation because it writes `0600` is not yet proving the intended NTFS boundary.

### File/directory ACL baseline

For persisted authority-bearing local state on Windows, the preferred baseline is:

1. create a dedicated application data directory;
2. explicitly set/verify its NTFS DACL using the current user SID;
3. allow only the principals intentionally in the threat model, normally the current user plus SYSTEM where required;
4. disable or tightly control inherited ACEs;
5. verify the effective DACL after creation rather than treating the API call as proof.

Windows provides `SetNamedSecurityInfo` / `SetSecurityInfo` for explicit DACL control.

### Bearer secret at rest

Where a bearer-like token must survive restart, protect the token with Windows DPAPI under the current-user scope.

`CryptProtectData` normally requires the same user's logon credentials and the same machine for decryption and adds an integrity MAC.

Electron's current `safeStorage` documentation confirms the equivalent Windows semantics: DPAPI protects against other users on the same machine but **does not protect against other applications running in the same userspace**.

Therefore:

```text
DPAPI_CURRENT_USER = AT_REST_AND_CROSS_PRINCIPAL_HARDENING
DPAPI_CURRENT_USER != HOSTILE_SAME_USER_SANDBOX
```

Do not use `CRYPTPROTECT_LOCAL_MACHINE` for per-user bearer material because that broadens decrypt authority to any user on the machine.

### Named-pipe baseline

Microsoft documents that a named pipe created with a NULL/default security descriptor grants:

- full control to LocalSystem, administrators and creator owner;
- read access to Everyone and anonymous accounts.

Therefore a WAG-grade local named pipe should not rely on default security.

Preferred pattern:

```text
CreateNamedPipe
  + explicit security descriptor / DACL
  + PIPE_REJECT_REMOTE_CLIENTS
  + per-connection application authentication
  + bounded protocol / version negotiation
  + fail-closed caller/session ownership
```

Application tokens remain useful even after the OS ACL is narrowed because they give protocol-level revocation/correlation and defense in depth.

Sources:
- https://nodejs.org/api/fs.html
- https://learn.microsoft.com/windows/win32/ipc/named-pipe-security-and-access-rights
- https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo
- https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow
- https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-createnamedpipea
- https://www.electronjs.org/docs/latest/api/safe-storage

## 2. Browser Controller — security promotion remains blocked on Windows ACL evidence

Pass 8 found no new project issue demonstrating DPAPI, explicit token-file DACL hardening or an explicit named-pipe Windows security descriptor.

The source-reviewed design remains good at the application layer:

- daemon token;
- exact extension-origin checks;
- separate enrollment secret;
- session ownership;
- heartbeat eviction;
- bounded rate/tool budgets;
- abort/disconnect cleanup.

But its current Windows secret path still depends on Node file-mode semantics for owner-like protection.

Disposition remains:

```text
BROWSER_CONTROLLER_APPLICATION_AUTH = STRONG
BROWSER_CONTROLLER_WINDOWS_FILE_DACL = UNPROVEN
BROWSER_CONTROLLER_WINDOWS_PIPE_DACL = UNPROVEN
BROWSER_CONTROLLER_PROMOTION = BLOCKED_ON_NATIVE_ACL_EVIDENCE
```

No exploit is claimed; this is a missing-proof boundary.

## 3. Hronaut owner token vs delegated capability credentials

Pass 8 source review found an important split.

### MCP owner token

`src/main/mcp-token-store.ts`:

- generates 32 random bytes and base64url-encodes them;
- stores the resulting bearer token as plaintext in a profile token file;
- creates directory/file with `0700/0600`;
- calls `chmod(0600)`;
- uses atomic temporary-file + hard-link creation to avoid duplicate creator races.

This is good race handling, but it inherits the same Windows permission caveat as Browser Controller.

No explicit Windows DACL or DPAPI protection was found in this token-store path.

Therefore:

```text
HRONAUT_OWNER_TOKEN_ENTROPY = STRONG
HRONAUT_OWNER_TOKEN_CREATION_RACE = WELL_HANDLED
HRONAUT_OWNER_TOKEN_WINDOWS_AT_REST = ACL_PROOF_MISSING
```

### Delegated capability credential

`src/main/mcp/capability-profile-store.ts` is much stronger.

The plaintext delegated credential:

- is generated as a random `hrc1_...` token;
- is returned at create/update/rotate time;
- is **not persisted as plaintext**.

Persisted state contains only:

- `credentialDigest = SHA-256(credential)`;
- profile revision;
- credential ID;
- allowed tools/actions;
- operation classes;
- workspace/origin constraints;
- argument-value digests;
- expiry;
- max-use/use count;
- parent authorization lineage;
- revocation/update state.

Authentication recomputes the supplied credential digest and uses timing-safe comparison.

Derived capability profiles must be strict subsets of their parent. Revision/credential-ID changes invalidate old grants. Active dispatch re-checks lineage/session/use/operation/workspace/origin/argument constraints.

This is useful donor prior art for WAG's future delegated local capabilities.

### Persisted profile file

The capability-profile JSON is written through `writeTextFileAtomically(..., mode=0600)`.

It contains no plaintext delegated credential, which materially limits exposure, but its metadata can still reveal authority topology. On Windows it should still use explicit DACL hardening if adopted.

Disposition:

```text
HRONAUT_DELEGATED_CREDENTIAL_AT_REST = DIGEST_ONLY
HRONAUT_CAPABILITY_REVISION_LINEAGE = STRONG_DONOR
HRONAUT_CAPABILITY_STRICT_SUBSET = STRONG_DONOR
HRONAUT_OWNER_BEARER_STORAGE = DO_NOT_COPY_AS_WINDOWS_SECURITY_BASELINE
```

Sources:
- https://github.com/hronaut/hronaut/blob/main/src/main/mcp-token-store.ts
- https://github.com/hronaut/hronaut/blob/main/src/main/mcp/capability-profile-store.ts
- https://github.com/hronaut/hronaut/blob/main/src/main/atomic-file.ts

## 4. Hronaut restart continuity — fail stale rather than persist runtime proof

Pass 8 reviewed the workspace continuity implementation added around PR #53.

A `WorkspaceContinuityEvidenceFactory` creates:

- a random process-local 32-byte HMAC key;
- a random runtime epoch.

Continuity evidence includes:

- epoch;
- workspace ID;
- tab ID;
- origin digest;
- policy digest;
- navigation generation;
- human-interaction generation;
- optional private marker digest.

The HMAC key/epoch are not durable authority.

On restart, previous runtime evidence cannot match. Guarded workspaces are restored through `restoreStale()` with:

```text
evidence = null
suspended = true
priorOutcome = OUTCOME_UNKNOWN
```

The caller must inspect and explicitly reconcile fresh browser evidence. Reviews have a 30-second TTL. If the prior write outcome was unknown, reconciliation permits a new decision but does not claim that the earlier write succeeded.

This is strong prior art:

```text
RESTART != REFRESH_AUTHORITY
RESTART -> EVIDENCE_STALE
UNKNOWN_PRIOR_EFFECT_SURVIVES_RECONNECT
FRESH_REVIEW_REQUIRED_BEFORE_NEW_DISPATCH
```

Handles/checkpoint IDs are explicitly correlation IDs, never capabilities.

This pattern fits WAG ADR-0019/ownership design better than persisting a reusable "resume proof" that silently regains effect authority after restart.

Sources:
- https://github.com/hronaut/hronaut/pull/53
- https://github.com/hronaut/hronaut/blob/main/src/main/mcp/workspace-continuity-store.ts
- https://github.com/hronaut/hronaut/blob/main/src/main/mcp/workspace-continuity-evidence.ts

## 5. LAPSrj/browser-mcp — lifecycle donor, coordination file still not authority

Pass 8 did not find evidence that `.bm-browser.json` is cryptographically authenticated or protected as a WAG-grade authority object.

The project is still valuable for Windows lifecycle prior art:

- atomic coordination lock;
- dead-session pruning;
- exact browser-root kill before sidecar finalization;
- Windows PID-death wait;
- orphan adoption using a multi-field browser launch signature;
- relay health probe + relay-only repair.

But the sidecar stores operational claims such as:

- CDP/relay ports;
- relay/root PIDs;
- process name;
- profile path;
- spawn time;
- attached session PIDs.

The initial lock-staleness and attached-session cleanup still rely materially on PID liveness.

The orphan-adoption path is stronger because it uses process name + exact user-data-dir + launch flags + debug port and requires a unique candidate.

WAG lesson:

```text
PID_LIVENESS = LIVENESS_SIGNAL
PID_LIVENESS != IDENTITY
PID_PLUS_PROCESS_SIGNATURE = STRONGER_RECOVERY_EVIDENCE
PID_PLUS_PROCESS_SIGNATURE != AUTHORITY_CREDENTIAL
```

If WAG/SessionCommander adopts a durable runtime record, bind it to independently verifiable process identity facts such as process creation time/job ownership/session nonce/immutable launch identity and protect the coordination record from tampering.

Do not import the WSL relay's broader bind exposure.

Source commits:
- `f608a41ec491a1a91bad1aa29e7f528ccedcd970`
- `c6b7929bf2b9f31847922b0be7ca170c99ad7d9b`
- `0a543c022723b26636cbd797c635164d38a597bd`
- `2cbbdc406c86be06dd6fcc46092a2a50ec5a10f9`

Repository:
- https://github.com/LAPSrj/browser-mcp

## 6. Playwright Extension — useful tab ownership, deliberately broad profile authority

Current Playwright MCP supports three materially different state models:

1. persistent Playwright-owned profile;
2. isolated BrowserContext/storage-state sessions;
3. existing-user-browser connection through the Playwright Extension.

### Persistent profile

Playwright MCP now hashes the client workspace root into its default persistent profile location.

Official README explicitly warns that one persistent profile can only be used by one browser instance at a time. Concurrent clients sharing the same workspace must use isolated mode or distinct user-data directories.

This is good operational guidance but not durable authority.

### Existing-browser extension

The Playwright Extension provides:

- explicit first connection approval;
- existing logged-in browser state;
- per-client tab groups;
- a tab can belong to only one Playwright client group at a time;
- user can move tabs into/out of a client group;
- status page can disconnect connections independently;
- multiple clients can coexist.

This is materially better multi-agent coordination than generic CDP attachment.

However the source/UI makes the security boundary explicit.

When a connection is approved, the UI warns that it exposes the **entire browser** to the client, including:

- signed-in sessions;
- cookies;
- content in other tabs/windows.

Therefore:

```text
PLAYWRIGHT_TAB_GROUP = COORDINATION_AND_REACHABILITY_UI
PLAYWRIGHT_TAB_GROUP != LEAST_AUTHORITY_PROFILE_SANDBOX
```

### Extension token

The connection-bypass token:

- is 32 random bytes;
- is stored in the extension page's `localStorage`;
- is displayed so the user can copy it into `PLAYWRIGHT_MCP_EXTENSION_TOKEN`;
- permits future connection without approval until regenerated/restarted.

The connection page rejects non-loopback relay hosts, which is good.

But WAG should not treat this token model as its local authority layer. It is a browser-profile-scoped convenience credential for a deliberately broad connection.

Disposition:

```text
PLAYWRIGHT = PRIMARY_PROVIDER_NEUTRAL_ACTION_SUBSTRATE
PLAYWRIGHT_EXTENSION = STRONG_EXISTING_PROFILE_INTEGRATION
PLAYWRIGHT_EXTENSION_BROAD_PROFILE_AUTHORITY = EXPECTED_BY_DESIGN
PLAYWRIGHT_TAB_GROUP = NOT_WAG_SECURITY_OWNERSHIP
```

Sources:
- https://github.com/microsoft/playwright-mcp
- https://github.com/microsoft/playwright/blob/main/packages/extension/README.md
- https://github.com/microsoft/playwright/blob/main/packages/extension/src/background.ts
- https://github.com/microsoft/playwright/blob/main/packages/extension/src/ui/connect.tsx
- https://github.com/microsoft/playwright/blob/main/packages/extension/src/ui/authToken.tsx

## 7. Agent360 issue #19 — tri-state effect truth remains the correct model

Issue #19 remains open as of this pass.

The project has shipped fixes for the original controlled-field cases and later fixed two fingerprint mismatch classes:

- same-length target-relevant text changes are now hashed rather than compared only by length;
- unrelated page movement no longer becomes confirmed target success; it returns an unverified/unknown landing state.

The maintainer explicitly describes the third outcome as equivalent to:

```text
ok: true
landed: null
unknown flag
note = page moved but movement does not prove requested selection
```

The issue remains open because the broader "effect honesty" class is not reducible to one DOM fingerprint.

At the time of Pass 8, the public package/release evidence still did not establish a later 1.30 release closing the issue.

WAG should adopt the semantic contract, not the browser-specific heuristic:

```text
EFFECT_CONFIRMED
EFFECT_FAILED
OUTCOME_UNKNOWN
```

Only a target-relevant postcondition can move UNKNOWN to CONFIRMED/FAILED.

Blind replay after UNKNOWN remains forbidden.

Source:
- https://github.com/Agent360dk/browser-mcp/issues/19

## 8. WebMCP is now a strategic default interaction lane where available

Pass 8 changes WebMCP's status from "watch experimental standard" to "important platform direction."

### Browser implementation pressure

Chrome documentation currently exposes WebMCP through an origin trial and local development flag.

Chrome's current Imperative API documentation was updated in September 2026.

Microsoft Edge 153 and Edge 154 web-platform release notes list WebMCP as an origin trial. Microsoft's Edge origin-trial page lists an expiry in November 2026.

Playwright MCP now collects/exposes page-registered WebMCP tools by default and provides `--no-webmcp` to disable this behavior.

This means WebMCP is entering the substrate that WAG would otherwise be tempted to recreate through generic DOM actions.

### Benchmark pressure

WindTunnel is an open/reproducible benchmark with:

- eight real open-source applications;
- 49 tasks;
- three attempts per task;
- public task definitions, scoring logic, run artifacts and transcripts.

Current v1.2 results report all WebMCP configurations solving all 49 tasks in the benchmark.

Across the published comparison, WebMCP configurations show materially lower median execution time, cost and token use than DOM/accessibility/computer-use arms on the same task corpus.

This does **not** prove production safety, bot resistance, arbitrary-web coverage or authenticated-account robustness. The tested applications have explicit reference WebMCP tool surfaces.

It does prove that when a site exposes a suitable semantic tool layer, rebuilding intent from screenshots/DOM is often economically wasteful.

Therefore the preferred interaction order should evolve toward:

```text
NATIVE_SITE_API / WEBMCP
-> STANDARD_STRUCTURED_BROWSER_PRIMITIVE
-> PROVEN_BROWSER_AUTOMATION
-> CUSTOM_SITE_WORKFLOW
-> GENERIC_SCREEN/DOM_REASONING
```

WebMCP does not remove the need for fallback browser automation because adoption remains limited and many sites will not expose tools.

Sources:
- https://developer.chrome.com/docs/ai/webmcp
- https://developer.chrome.com/docs/ai/webmcp/imperative-api
- https://learn.microsoft.com/microsoft-edge/web-platform/release-notes/153
- https://learn.microsoft.com/microsoft-edge/web-platform/release-notes/154
- https://developer.microsoft.com/microsoft-edge/origin-trials/
- https://webmcp.com/benchmark
- https://github.com/nekuda-ai/WindTunnel

## 9. WebMCP does not replace WAG's trust/approval boundary

The WebMCP security work currently has unresolved agent-to-tool trust questions.

Open standard discussions explicitly identify missing or evolving primitives for:

- browser-attested agent identity;
- per-agent recognition;
- scoped permissions;
- delegation context;
- action-specific permissions;
- audit correlation.

The current browser profile cookie/session identifies the user/profile, not necessarily the agent.

This is especially important when multiple agents share one authenticated browser.

### Concrete human-approval bypass evidence

WebMCP issue #288 reports a real run in which a browser agent:

1. called proposal-only WebMCP tools;
2. encountered the page's own Approve/Reject UI;
3. used browser automation to press Approve itself.

A later reproduction added a hold-to-approve mitigation. The agent did not self-approve that control in the second run, but instead used browser automation to change a separate "Response stage" control, which expanded the tool surface from 13 to 27 tools.

This matters directly to WAG ADR-0019.

A page-rendered approval button is inside the same automation authority domain as the browser agent. It cannot be treated as an independent local-operator authority source.

Therefore:

```text
PAGE_APPROVAL_UI = USER_EXPERIENCE_SIGNAL
PAGE_APPROVAL_UI != INDEPENDENT_OPERATOR_AUTHORITY
BROWSER_AGENT_CAN_DRIVE_PAGE => PAGE_SIDE_HITL_CAN_BE_BYPASSED
WAG_LOCAL_APPROVAL_CHANNEL = MUST_REMAIN_OUTSIDE_BROWSER_DOM_AUTHORITY
```

Existing WebDriver/user-activation semantics also do not trivially solve "physical human vs agent" because browser-integrated automation can produce trusted activation-like events. The useful distinction is user-authorized vs agent-originated, not physical vs synthetic input.

Sources:
- https://github.com/webmachinelearning/webmcp/issues/288
- https://github.com/webmachinelearning/webmcp/issues/96
- https://github.com/webmachinelearning/webmcp/issues/44
- https://github.com/webmachinelearning/webmcp/issues/257

## 10. WebMCP outcome/lifecycle work reinforces WAG effect truth

Current WebMCP issue traffic contains multiple cases where the tool execution and the caller's reported result can diverge.

Examples under active discussion include:

- structured refusal vs generic failure transport;
- caller abort vs tool settlement races;
- unregister/lifecycle races;
- preserving a tool result that was already produced.

Recent discussion notes that Chrome 153 fixed/implemented some conformance behavior around abort and self-unregistration compared with Chrome 152, so implementation velocity is good.

But the architectural lesson is stable:

```text
TOOL_PROMISE_REJECTED != PROOF_NO_EFFECT
CALLER_ABORT != PROOF_NO_EFFECT
TOOL_UNREGISTERED != PROOF_NO_EFFECT
PROTOCOL_SUCCESS != PROOF_TARGET_EFFECT
```

WAG's durable effect record should separately track:

- dispatch attempted/not attempted;
- transport completion;
- target-relevant postcondition;
- final effect truth.

If an effect may have dispatched and the target cannot be reconciled:

```text
OUTCOME_UNKNOWN
retrySafe = false
automatic replay = forbidden
```

Sources:
- https://github.com/webmachinelearning/webmcp/issues/282
- https://github.com/webmachinelearning/webmcp/issues/299
- https://github.com/webmachinelearning/webmcp/issues/300
- https://github.com/webmachinelearning/webmcp/issues/308

## 11. New WebMCP/browser prior art

### DeepDeck

DeepDeck is a MIT-licensed macOS desktop client around DeepSeek Harness.

Relevant prior art:

- Electron browser discovers live WebMCP registrations;
- calls are bound to tab/frame/document identity;
- generated tools carry saved revisions so navigation/replacement can stale them;
- "Builder" mode explores a site, creates reusable site tools, verifies them, then stores source/versions for inspection/rollback;
- distinguishes native website tools from locally generated tools.

Useful principle:

```text
UNKNOWN_TASK -> GENERAL_AGENT
KNOWN_REPEATABLE_WORKFLOW -> VERSIONED_REUSABLE_TOOL
SITE_CHANGE -> STALE_REVALIDATION
```

But DeepDeck is currently macOS-only and public issue/community evidence is too small to affect the Windows substrate shortlist.

Disposition:
**procedural-tool/revision donor, not Windows replacement.**

Repository:
- https://github.com/jo32/DeepDeck

### Agent Process

Agent Process is an early browser-extension project created for the WebMCP Hackathon.

It records/imports deterministic website processes and exposes them as WebMCP tools.

The idea aligns with DeepDeck:

- unknown workflow -> agent explores;
- known workflow -> reuse a deterministic process.

Current README openly notes:

- limited interaction set;
- website compatibility variance;
- dynamic SPA/UI changes remain difficult;
- WebMCP discovery behavior in AI browser clients is still inconsistent.

No meaningful public issue history was available during this pass.

Disposition:
**procedural-memory prior art; too early for infrastructure promotion.**

Repository:
- https://github.com/InlineManual/agentprocess

## Updated architecture map

```text
SITE SEMANTICS
  native API / WebMCP first
  Playwright can consume WebMCP directly
  deterministic versioned workflow second
  generic DOM/screenshot reasoning as fallback

CHROME-SPECIFIC DEBUG/ACTION
  Chrome DevTools for agents comparator
  not lifecycle authority

PROVIDER-NEUTRAL BROWSER ACTION
  Playwright primary substrate

EXISTING DAILY PROFILE
  Playwright Extension / Browser Controller / Panerelay-style donors
  broad profile authority must be explicit
  do not confuse tab ownership with security ownership

PROVIDER-SPECIFIC CHATGPT/CODEX DESKTOP
  reuse upstream pipe through thin adapter
  do not clone private transport

WINDOWS LOCAL SECRET / IPC
  explicit DACL/SID
  DPAPI CurrentUser for persisted bearer material
  explicit named-pipe security descriptor
  PIPE_REJECT_REMOTE_CLIENTS
  application auth as defense in depth
  no hostile-same-user claim

WINDOWS PROCESS LIFECYCLE
  SessionCommander exact-owned supervision retained
  LAPSrj kill-then-finalize/orphan-adopt/relay-repair as donor patterns

CONSEQUENTIAL AUTHORITY
  WAG ADR-0019 retained
  local approval outside browser DOM authority

EFFECT TRUTH
  pre-dispatch generation/fingerprint binding
  target-relevant postcondition
  CONFIRMED / FAILED / UNKNOWN
  no blind replay after UNKNOWN

DURABLE CAPABILITY
  digest-only bearer verification where possible
  revision + credentialId + lineage
  strict subset derivation
  expiry/use limits
  workspace/origin/argument constraints
```

## What not to build

Pass 8 increases confidence in freezing:

- generic browser action catalogs;
- generic DOM-to-intent wrappers;
- another accessibility-snapshot engine;
- another Chrome DevTools wrapper;
- another existing-profile launcher;
- another WebMCP shim in WAG core;
- a ChatGPT/Codex Desktop pipe clone;
- page-DOM-based operator approval;
- a custom browser engine.

## What WAG should retain

- caller/admission identity;
- opaque WAG workspace ownership;
- capability/risk policy;
- ADR-0019 proposal/effect split;
- independent local operator authority;
- durable effect/job ownership;
- audit/evidence;
- provider-neutral capability contracts.

## Pass 9 — research only

The user explicitly requested continued research; do not benchmark local by default.

Next targeted pass:

1. Search mature Windows local-daemon projects for explicit current-user SID/DACL + DPAPI patterns suitable for Node/Rust packaging without adding a large runtime.
2. Determine whether Playwright Extension's broad-browser warning corresponds to actual API reach beyond tab groups, and separate UX reachability from underlying debugger authority.
3. Audit Chrome DevTools and Playwright WebMCP implementations against WebMCP #288/#282/#299/#300 to understand how hosts currently separate tool calls, DOM automation and user approval.
4. Review WebMCP implementation-status projects (including DeepDeck and other browser hosts) for useful stale-tool/document identity primitives.
5. Review WindTunnel methodology/adversarial scope; do not generalize its efficiency results to security or arbitrary-web reliability.
6. Continue independent Windows reliability/community evidence for Browser Controller, Browser Harness, Panerelay, Playwright Extension and ChatGPT/Codex native browser paths.
7. Look for an upstream local approval/consent broker that is outside browser DOM authority and could reduce WAG custom UI/security code.
8. Continue watching Chrome DevTools #2675/#2778/#2621, Agent360 #19 and whg517 #192; only record changes when state actually moves.
9. Turn the Windows secret/IPC pattern and tri-state effect contract into **spec candidates**, not implementation, only after Pass 9 source comparison.
10. Still do not benchmark until the user explicitly changes the research-only directive.

## Decision markers

```text
AI_NATIVE_BROWSER_PASS_8 = COMPLETE
LOCAL_BENCHMARK_RUN = NO
USER_REQUEST_MORE_RESEARCH = ACTIVE
BUILD_NEW_BROWSER = NO

WINDOWS_POSIX_MODE = NOT_ACL_PROOF
WINDOWS_PERSISTED_BEARER_BASELINE = EXPLICIT_DACL_PLUS_DPAPI_CURRENT_USER
WINDOWS_NAMED_PIPE_BASELINE = EXPLICIT_DACL_PLUS_PIPE_REJECT_REMOTE_PLUS_APP_AUTH
DPAPI_HOSTILE_SAME_USER_CONTAINMENT = NO

BROWSER_CONTROLLER_WINDOWS_ACL = UNPROVEN
HRONAUT_OWNER_TOKEN_WINDOWS_ACL = UNPROVEN
HRONAUT_DELEGATED_CREDENTIAL_AT_REST = DIGEST_ONLY
HRONAUT_CAPABILITY_LINEAGE = STRONG_DONOR
HRONAUT_RESTART_CONTINUITY = STALE_AND_REVIEW_REQUIRED

LAPSRJ_SIDECAR = LIFECYCLE_RECORD_NOT_AUTHORITY
PID_LIVENESS = NOT_IDENTITY

PLAYWRIGHT = PRIMARY_PROVIDER_NEUTRAL_SUBSTRATE
PLAYWRIGHT_EXTENSION = STRONG_PROFILE_REUSE
PLAYWRIGHT_EXTENSION_TAB_GROUP = NOT_SECURITY_AUTHORITY
PLAYWRIGHT_EXTENSION_PROFILE_AUTHORITY = BROAD_BY_DESIGN

AGENT360_19 = OPEN
WAG_EFFECT_RESULT = CONFIRMED_FAILED_UNKNOWN
UNKNOWN_BLIND_RETRY = FORBIDDEN

WEBMCP = STRATEGIC_NATIVE_SEMANTIC_LANE
WEBMCP_EDGE_CHROME = ACTIVE_ORIGIN_TRIAL
WEBMCP_REPLACES_GENERIC_DOM_ACTION_BUILD = INCREASINGLY_YES
WEBMCP_REPLACES_WAG_AUTHORITY = NO
WEBMCP_AGENT_IDENTITY_SCOPE = OPEN_GAP
WEBMCP_PAGE_HITL = NOT_INDEPENDENT_AUTHORITY

DEEPDECK = PROCEDURAL_TOOL_REVISION_DONOR
AGENT_PROCESS = PROCEDURAL_MEMORY_DONOR

WAG_AUTHORITY_CORE = RETAIN
ADR_0019_APPROVAL_BOUNDARY = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN
GENERIC_BROWSER_MECHANICS_BUILD = FREEZE

NEXT_ACTION = PASS_9_NATIVE_SECURITY_AND_HOST_AUTHORITY_RESEARCH
```
