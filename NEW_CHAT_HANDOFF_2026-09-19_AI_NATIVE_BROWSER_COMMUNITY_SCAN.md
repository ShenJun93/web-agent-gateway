# New Chat Handoff — AI-native Browser Community Scan

Date: 2026-09-19
Repository: `ShenJun93/web-agent-gateway`
Canonical branch: `main`

## User directive

Continue researching community experience and prior art. **Do not run local benchmarks yet.**

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
6. Chat history last.

This handoff is not authority when Git disagrees.

## Verified research state

Passes 1–4 plus the replacement-pressure audit are complete.

No local install/benchmark was run in Pass 4.

Remote `main` was fresh-verified at
`c80fc60d2ccceac34e456869c9ad494d8e08727f`
before Pass 4 was written.

The local Windows Desktop Commander device remained offline, so local worktree/HEAD remains unverified.

## Pass 4 correction / synthesis

### Native provider paths remain first comparators, not lifecycle baselines

OpenAI:
- native ChatGPT/Codex browser path remains first for OpenAI-specific workflows;
- Windows orphan-Chrome issue remains open;
- foreground-focus issue remains open;
- Browser Use teardown crashes remain independently reproduced through September builds including `26.908.4834.0`.

Anthropic:
- Claude in Chrome remains first for Claude-specific workflows;
- Windows native-host failures, stale registrations and multi-browser ownership issues remain relevant;
- stale/not-planned issue closure is not evidence of a verified fix.

Conclusion:
**use provider-native where appropriate, but do not delegate WAG authority or retire owner-aware cleanup from current evidence.**

### Playwright is now the primary provider-neutral substrate

Current first-party Playwright combines:

- coding-agent CLI;
- MCP server;
- real authenticated Chrome/Edge extension;
- multi-client tab-group ownership;
- `Browser.bind()` session interoperability;
- persistent/isolated profiles;
- explicit owned-session idle cleanup;
- WebMCP discovery/invocation.

Research preference:

- coding agent with shell -> **Playwright CLI first**;
- generic MCP/chat client needing real authenticated profile -> **Playwright MCP extension first**;
- shared upstream Playwright session -> evaluate **`Browser.bind()` before custom broker code**.

Important blockers remain:

- Memory Saver/discarded real-profile tabs can wedge every CLI/MCP command;
- Windows persistent-profile/download failures exist;
- attached browsers are not owned by Playwright, so timeout detaches rather than killing tabs/browser;
- bundled coding-agent skill permission patterns currently deserve manual review before adoption.

### WebMCP is now strategically material

WebMCP is still a W3C Community Group draft, not a W3C Standard.

But adoption/convergence is now real enough to affect architecture:

- Chrome experimentation;
- Playwright CLI/MCP integration;
- Playwright main now surfaces page-registered WebMCP tools;
- OpenAI browser direction includes site/WebMCP tools.

Preferred semantic path:

```text
site-native WebMCP
  -> Playwright structured browser control
  -> generic DOM/browser actions
  -> CUA/pixel fallback
```

Page-provided annotations such as `consequentialHint` are untrusted semantic input and **must not replace ADR-0019 local approval authority**.

### Third-party real-profile bridges

- `whg517/browser-bridge`: strong direct WAG donor, but Windows Job Object broker-survival issue #192 remains unverified.
- `open-browser-use`: Windows native-host-not-found issue and live-socket unlink behavior remain open.
- Playwriter: useful UX prior art, but disconnect/relay-token/duplicate-tab failure evidence remains.
- Browser Harness remains relevant but must demonstrate a measured advantage over first-party Playwright before custom adoption.

### BrowserOS neo stays demoted on Windows

Fresh issue evidence still includes:

- unreaped loopback sockets growing to ~13.9k and system network pressure;
- ~300-second idle MCP session expiry causing tab-ownership loss;
- broad MCP listener bind;
- localhost/origin hardening issues.

Do not spend local benchmark time here before lifecycle/security hardening materially improves.

### Cloud/offload

Only the **cloud path** removes local Windows browser-process ownership.

First research pair:
- Browserbase
- Kernel

Open-source/self-host fallback:
- Steel

Browserless remains credible infrastructure but SSPL/commercial self-host licensing is strategically less attractive for a reusable substrate.

Notte/Hyperbrowser/Anchor remain watch candidates.

## Replacement pressure

### Freeze

Do not expand custom:

- browser action/snapshot schema;
- tab/navigation mechanics;
- provider-specific Chrome/Edge transport;
- generic DevTools collection;
- browser session-sharing broker unless upstream Playwright cannot meet the requirement;
- cloud browser fleet management.

### Potentially retire later after evidence

- WAG-owned browser launch/attachment;
- WAG browser action/snapshot/navigation plumbing;
- provider-specific browser glue;
- custom multi-client session sharing when Playwright extension/`browser.bind()` is sufficient.

### Retain

- WAG admission/ownership/capability policy;
- ADR-0019 local approval transition;
- durable consequential-effect ownership;
- audit/evidence;
- bounded owner-aware cleanup for WAG-owned local processes;
- Guardian context/continuity/early-handoff functions.

SessionCommander should supervise selected task-owned runtimes, not implement browser semantics.

## Next research directions — still no benchmark

1. Deep-diff Playwright CLI vs MCP extension vs `browser.bind()` ownership, cleanup, token storage and failure semantics.
2. Audit Playwright extension threat model and profile-token exposure.
3. Track WebMCP security/interoperability and real site adoption.
4. Track OpenAI #43347/#36645/#32462/#33662 for verified September+ fixes.
5. Track Claude browser ownership/native-host issues, especially #93751.
6. Track whg517/browser-bridge Windows Job Object verification and open-browser-use Windows fixes.
7. Collect independent production failure/reconnect/cost evidence for Browserbase vs Kernel.
8. Track Windows ODR/MCP containment maturity.
9. Continue discovery only for serious real-profile bridges that provide a capability first-party Playwright lacks.

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
WHG517_BROWSER_BRIDGE = DONOR_PENDING_WINDOWS_JOB_OBJECT_EVIDENCE

CLOUD_PRIMARY_RESEARCH = BROWSERBASE,KERNEL
CLOUD_OPEN_SOURCE_FALLBACK = STEEL

WAG_AUTHORITY_CORE = RETAIN
ADR_0019_APPROVAL_BOUNDARY = RETAIN
OWNER_AWARE_LOCAL_CLEANUP = RETAIN_BOUNDED
GUARDIAN_CONTINUITY_SCOPE = RETAIN
GUARDIAN_BROWSER_AUTOMATION_SCOPE = FREEZE
SESSIONCOMMANDER_BROWSER_SEMANTICS = DO_NOT_EXPAND

NEXT_ACTION = CONTINUE_TARGETED_COMMUNITY_AND_SECURITY_RESEARCH
```
