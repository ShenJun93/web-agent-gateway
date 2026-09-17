# External WebChat-to-Local Coding Bridges Audit — 2026-09-17

Status: research receipt only; no runtime, dependency, provider, or authority change

Repository base: `7950151a41c9cceca2f285b584482130b3702bbd`

Repos audited:
- `totec448-spec/chat-on-steroids`
- `serbyte-development/shellby-mcp`
- `liyana31811/Codexless`
- `miuuyy/codex-chatgpt-web`
- `Rakeem-C/cursor-chatgpt-web`
- `leeguooooo/chatgpt-use`

## Executive decision

None of the six repos should be imported wholesale or made a WAG runtime dependency now.

The audit identifies four donor classes worth carrying into the WAG roadmap:
1. **Repository discovery + bounded batch context** from Chat On Steroids and Codexless, directly relevant to current R1/Tier-R gap.
2. **Immutable reviewed multi-file change-set patterns** from Chat On Steroids and Codexless, relevant to future C1/D1 after the consequential admission gate.
3. **Turn/request ownership, receipts, idempotency, and fail-visible uncertainty** from codex-chatgpt-web and chatgpt-use, useful for provider/browser acceptance and possibly a stronger future Browser admission design.
4. **Persistent-process lifecycle mechanics** from Shellby MCP, donor-only and deferred until a measured workflow proves semantic verify/task profiles insufficient.

WAG must keep its current mission boundary: provider/model reasoning remains outside the local trust boundary; WAG owns identity, resource binding, policy, approvals, durable effects, audit and replaceable execution backends.
## Audit criteria

Each repository was evaluated against the mission lock rather than feature count: ability to improve WebChat -> local coding outcomes, reduce round trips/browser fragility, preserve provider-neutral core semantics, reduce authority relative to Desktop Commander, and fit WAG-owned caller/workspace/approval/effect/audit boundaries.

Code reuse is secondary to contract reuse. A donor is useful only when its behavior can be expressed behind WAG capability ports without importing its planner, model routing, browser ownership, ambient shell authority, or provider-specific trust assumptions.

## 1. Chat On Steroids

Strong donor for the coding-facing Core surface, but not as a runtime dependency.

Useful patterns:
- bounded multi-path `read` with directory listing/globs and aggregate output budgets;
- shell-free `find` for filename/glob/text discovery when command execution is unavailable;
- multi-file `apply_patch` with preflight before writes and independent create/edit/move/delete permissions;
- connector surfaces separated by authority (`Core` vs optional `Desktop`);
- caller identity tied to conversation/extension evidence rather than a model-supplied credential;
- exact-surface tests and runtime permission checks even when a cached schema still lists a tool.

These directly support a WAG R1 design and a future reviewed change-set design. The important product lesson is that search/read batching should make the cheap path require fewer WebChat round trips.
Do not import its trust model. Its own security policy states that approved-path checks are not a kernel/VM sandbox, `exec_command` is not confined to approved roots, and command/desktop capabilities act with the logged-in user's authority. Desktop-wide control and detailed local recording are outside the current WAG coding mission.

Its setup uses ChatGPT Developer Mode plus an MCP tunnel and a companion extension. That is useful interoperability evidence, but the browser automation/companion layer remains provider-UI dependent. The repository also explicitly warns not to route around provider safety decisions. Its September changelog records an account-warning incident for the maintainer; treat that as project-specific risk evidence, not proof of a general provider rule.

Decision: `DONOR_FOR_R1_AND_CHANGESET = YES`; `RUNTIME_DEPENDENCY = NO`; `DESKTOP_CONTROL = OUT_OF_SCOPE`.

## 2. Codexless

Architecturally the closest external project to WAG's product mission: normal ChatGPT uses reviewed local tools, while Codex is invoked only when its model/harness is actually needed.

Useful patterns:
- exact public tool allowlist enforced at registration and in tests;
- bounded multi-file reads and project-context operations;
- guarded precise edits using exact expected text and optional SHA-256 verification;
- fail-visible authority denials: a remote caller cannot silently select a stronger Codex permission profile;
- prepare/commit task consent with replay-safe task identity and app-held commit capability;
- bounded browser actions exposed as user-intent operations rather than raw selectors/CDP/JavaScript;
- uncertain mutation dispatch is not blindly replayed.

The strongest reusable lesson is surface admission: internal capability availability is explicitly not a public safety claim. WAG already follows this principle and should preserve exact allowlists as future surfaces grow.
Do not turn WAG into a Codex wrapper. Codexless deliberately inherits the local Codex authorization ceiling and uses Codex App Server as an execution source. WAG's mission requires WAG-owned authority and replaceable backends, so Codex may be an optional executor/donor but must not become the authority root.

OpenAI officially describes Codex App Server as a client-friendly bidirectional JSON-RPC interface to the Codex harness. This makes an executor spike technically credible. However, current upstream documentation is actively evolving, including recent documentation-location churn around app-server. Therefore no dependency switch is justified by this audit alone.

Decision: `DONOR_FOR_SURFACE_ADMISSION_EDIT_GUARDS = STRONG_YES`; `CODEX_APP_SERVER_OPTIONAL_EXECUTOR_SPIKE = RESEARCH_CANDIDATE`; `CODEX_AUTHORITY_AS_WAG_AUTHORITY = NO`.

## 3. Shellby MCP

Strong donor for process lifecycle and remote ChatGPT identity observations; weak fit as a trust model.

Useful patterns:
- remote subject binding using OpenAI-provided subject metadata, with session treated as operational context rather than durable authorization;
- strict exact `/mcp` exposure behind tunnel policy and localhost Host/Origin guards;
- modern/legacy MCP serving from one registration factory;
- persistent shell request IDs, retained records, explicit request conflicts, output cursors, bounded transcripts, hibernation and reset semantics;
- process-group cleanup and explicit separation between execution state and output pagination.

These mechanics are valuable if WAG later proves that named verify/task profiles are insufficient. They are not evidence that WAG needs a shell now.

Do not import its local trust assumptions: local MCP is intentionally unauthenticated, named shell IDs are not per-caller ACLs, workspace location is guidance rather than a filesystem boundary, `apply_patch` retains host filesystem authority, and child resource use is not sandboxed.

Decision: `PROCESS_LIFECYCLE_DONOR = YES_IF_MEASURED`; `SHELL_SURFACE_NOW = NO`; `TRUST_MODEL = DO_NOT_COPY`.

## 4. codex-chatgpt-web

Useful as a browser/provider bridge donor and acceptance-harness reference, not as WAG core.

Useful patterns:
- one turn-scoped random capability token binds a ChatGPT browser turn to the exact outer local tool environment;
- an MCP call can invoke only a tool actually advertised by that active outer turn;
- connector identity/version is treated as an ABI and stale legacy identities fail rather than silently falling back;
- task-bound browser tabs, exact ownership leases and bounded concurrency prevent cross-task chat reuse;
- uncertain or stale browser state fails explicitly instead of selecting another model/transport;
- lifecycle drain distinguishes active HTTP work from active browser/tool work before shutdown.

This is relevant to the unresolved consequential Browser admission/isolation gate: WAG should study turn-bound capability binding and exact connector-version identity as possible ingredients, but must adapt them to WAG-owned caller/workspace/effect semantics rather than inherit an outer Codex trust root.

The project explicitly treats consumer ChatGPT browser automation as distinct from a supported API contract and documents DOM/UI drift as a principal risk. Therefore its browser worker should not become WAG's preferred production transport when native MCP/Apps paths are available.

Decision: `BROWSER_ADMISSION_DONOR = YES`; `PRODUCTION_BROWSER_ENGINE_DEPENDENCY = NO`.

## 5. cursor-chatgpt-web

This fork is primarily a specialist-model bridge: Cursor remains the parent agent and GPT Web supplies reasoning in isolated Temporary Chats. It is not a local-capability gateway replacement.

Useful patterns are narrow but real: focused delegation envelopes, per-role/path leases, bounded five-tab concurrency, FIFO queueing, explicit `awaitingTools`/resume state, and fail-closed model/UI capability detection. These can inform acceptance-harness isolation and provider-side tool-loop diagnostics.

Do not import its planner/delegation behavior into WAG. Parent-agent orchestration, specialist selection, browser model routing and ChatGPT Temporary Chat management belong above WAG's trust boundary.

Decision: `ACCEPTANCE_HARNESS_DONOR = LIMITED_YES`; `WAG_CORE = NO`.

## 6. chatgpt-use

The project is intentionally browser-driven and experimental, but it contains strong reliability patterns for any WebChat automation/acceptance harness.

Useful patterns:
- write a durable request receipt before submission;
- distinguish `submitted: no`, `yes`, and `unknown` so ambiguous sends are never blindly retried;
- request IDs are single-use when a request may have reached ChatGPT;
- status/resume can recover by recorded conversation identity without resending;
- conversation/server record is treated as authoritative for completion while the page is treated mainly as an input device;
- structured output is locally validated and schema failure is not silently repaired by spending another turn;
- read-only local profile is the default for tunneled/local-tool mode.

These patterns should influence WAG provider/browser test harnesses and any future provider-side delivery receipt design. They should not move into WAG core as browser scraping or an Anthropic/OpenAI compatibility proxy.

Decision: `DELIVERY_RECEIPT_DONOR = STRONG_YES`; `BROWSER_PROXY_RUNTIME = NO`.

## Cross-repository integration decision

Immediate production integration: none. No new dependency, browser engine, model router, shell, Codex requirement, or provider-specific execution path is authorized by this audit.

Roadmap integration candidates, in order:
1. Design R1 as a bounded semantic repository search/discovery capability with batching and result budgets, borrowing the user-value patterns from Chat On Steroids and Codexless.
2. Keep `repo.snapshot` and `verify.run` as existing WAG semantics; promote them only after the relevant host admission gate, not by borrowing a broader shell.
3. For C1/D1, evolve the durable one-file mutation baseline toward an immutable reviewed multi-file change set with preflight, exact base evidence, per-operation permissions and post-write verification.
4. Research a stronger consequential Browser admission design using WAG caller identity plus turn-bound capability/connector-version ideas from codex-chatgpt-web; do not treat a browser token alone as OS caller attestation.
5. Add durable provider-delivery/request receipts to acceptance tooling so ambiguous submission is `OUTCOME_UNKNOWN`/fail-visible rather than automatic replay.
6. Only benchmark a persistent process capability if named verify/task profiles demonstrably block a required local-development workflow; Shellby then becomes a mechanics donor.

## Compatibility with current WAG state

This audit does not invalidate the mission lock or ADR-0018. It reinforces the existing ordering: close read/inspect gaps first, then consequential admission, then semantic verify/change, and add process/Git authority only from measured need.

Current code already contains `repo.snapshot`, `verify.run`, durable mutation preview/result, and exact Browser v1 read-only projection. Therefore importing Codexless command execution, CoS `exec_command`, Shellby `shell_run`, or chatgpt-use `bash` would duplicate capability while weakening the current authority boundary.

The new information is narrower: R1 should not be solved by exposing shell/grep; it should be solved by a bounded repository discovery contract. C1 should not be solved by resurrecting raw `file.patch`; it should use a reviewed change-set contract. Provider/browser uncertainty should gain durable delivery receipts rather than retries.

## Licensing / supply-chain note

The audited repositories are permissively licensed at the checked sources: Chat On Steroids, Shellby MCP, codex-chatgpt-web, cursor-chatgpt-web and chatgpt-use use MIT; Codexless uses Apache-2.0. This makes selective code reuse possible in principle, subject to notice/attribution, dependency review, provenance and WAG's normal security gates.

No code copy is approved by this research receipt. Prefer reimplementation of small contract patterns unless a concrete module has enough value to justify adopting its dependency and notice surface.

## Current OpenAI host facts relevant to the decision

As of the research cut, OpenAI documents custom MCP apps/full MCP on ChatGPT web for Business and Enterprise/Edu, with write/modify actions subject to host confirmation/blocking. ChatGPT does not connect directly to localhost; developer-machine/private MCP should use Secure MCP Tunnel. Pro remains read/fetch-only for custom MCP in the documented path.

OpenAI also publicly documents Codex App Server as a bidirectional JSON-RPC interface to the Codex harness, so an optional executor experiment is legitimate research. It is not a reason to make Codex mandatory or to move WAG authority into Codex.

## Final disposition

`WHOLESALE_IMPORT = NO`
`NEW_RUNTIME_DEPENDENCY_NOW = NO`
`R1_REPO_SEARCH_DESIGN_DONORS = CHAT_ON_STEROIDS + CODEXLESS`
`C1_CHANGESET_DESIGN_DONORS = CHAT_ON_STEROIDS + CODEXLESS`
`BROWSER_ADMISSION_RESEARCH_DONOR = CODEX_CHATGPT_WEB`
`DELIVERY_RECEIPT_ACCEPTANCE_DONOR = CHATGPT_USE`
`PROCESS_LIFECYCLE_DONOR_IF_NEEDED = SHELLBY_MCP`
`CURSOR_CHATGPT_WEB_ROLE = ACCEPTANCE_ORCHESTRATION_REFERENCE_ONLY`
`CODEX_APP_SERVER = OPTIONAL_EXECUTOR_SPIKE_ONLY`
`WAG_AUTHORITY_OWNER = UNCHANGED`
`NEXT_IMPLEMENTATION_AUTHORITY = NONE_FROM_THIS_AUDIT`

## Primary sources

Research cut: 2026-09-17. Repository default-branch documentation and implementation were preferred over third-party summaries.

- Chat On Steroids: `README.md`, `SECURITY.md`, `docs/setup.md`, `docs/tool-surface.md`, `CHANGELOG.md`, `extension/background.js`, `test/mcp.test.ts`.
- Codexless: `README.md`, `SECURITY.md`, `src/surface-contracts.mjs`, public registration tests.
- Shellby MCP: `SECURITY.md`, `wiki/pages/http-transport.md`, `wiki/pages/mcp-tool-surface.md`, `wiki/pages/persistent-shell-runtime.md`, `wiki/pages/project/open-questions-and-risks.md`.
- codex-chatgpt-web: `docs/architecture.md`, `docs/security-model.md`.
- cursor-chatgpt-web: `README.md`, `docs/cursor.md`.
- chatgpt-use: `README.md` and request/profile documentation therein.
- OpenAI: Developer mode and MCP apps in ChatGPT; `Unlocking the Codex harness: how we built the App Server`; current `openai/codex` app-server sources.

Provider/browser behavior and account eligibility remain external moving surfaces and must be reverified at the acceptance gate. This receipt authorizes research/design use only.
