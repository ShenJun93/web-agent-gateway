# WAG WebChat-to-Local Coding Mission Lock — 2026-09-17

Status: architecture/product research receipt; no runtime or authority change

Repository base: `07b0dc42ae40cc6a1a598a256630bbfd7e0a8fd9`

Advisory input: `WAG_GLOBAL_AI_MARKET_STRATEGY_2026-2028.md` (research cut 2026-09-15). The advisory memo correctly frames WAG as a thin local trust/capability gateway, but this receipt refreshes provider facts and locks the project's two actual product goals against current canonical Git/spec/ADR state.

## Executive decision

WAG has two product goals and they must be evaluated together:

1. **Replace Remote Desktop Commander on the selected WebChat -> local development/work path.** Replacement means the target WebChat workflows no longer depend on Remote Desktop Commander in their production path. It does not mean cloning every Desktop Commander filesystem, shell, document, process, configuration, or multi-device feature.
2. **Give WebChat agents local development outcomes comparable to Claude Code/Codex where WAG grants the capability.** Comparable means useful outcomes such as repository exploration, bounded code changes, verification/build/test execution, change inspection, and eventually reviewed version-control/process operations when evidence justifies them. It does not mean making WAG an agent planner, model runtime, memory system, subagent framework, IDE, browser engine, or unrestricted shell.

The invariant is therefore:

> WebChat reasoning stays outside the local trust boundary. WAG gives that reasoning client narrowly scoped local hands, with WAG-owned identity, resource binding, policy, approval, durable effect ownership, audit, and replaceable execution backends.

ChatGPT Web remains the reference provider and the direct Desktop Commander replacement target. Provider neutrality is a core architecture property so later WebChat providers can consume the same local capability contract without provider-specific execution logic.
## 1. Canonical project origin and current correction

The approved 2026-09-09 V0 design stated the original problem directly: Remote Desktop Commander was useful for ChatGPT Web Plus, but remote/session latency made many small coding calls expensive and difficult to diagnose. Its objective was a provider-neutral gateway exposing a small MCP surface to Web AI clients while delegating local execution to proven upstream components.

ADR-0001 then made the architecture decision explicit: do not fork Desktop Commander, DevSpace, or LocalAnt wholesale. DevSpace is the upstream local execution backend; Desktop Commander is a benchmark/donor rather than WAG's foundation.

The current README has since generalized the durable architecture correctly: WAG is a provider-neutral, least-authority local trust/capability gateway. ADR-0014 locks WAG-owned authority, containment, durable-effect semantics, and narrow capability ports independent of provider, transport, or executor.

The correction needed after the 2026-09-16 market re-benchmark is not to shrink the product mission to "a policy gateway for local coding agents." The canonical project still exists to make Web AI clients useful against local resources. Local coding agents such as Claude Code and Codex are reference experiences and market evidence, not the primary product host.

Therefore:

- **ChatGPT Web -> WAG -> local** is the current reference implementation of the mission;
- **future WebChat -> same WAG core -> local** is the provider-neutral expansion path;
- **Claude Code/Codex -> WAG** conformance remains useful compatibility evidence, but is not the reason WAG exists;
- WAG must not grow generic execution merely to imitate local coding-agent internals.

## 2. Current Desktop Commander baseline

Remote Desktop Commander currently exposes a hosted Streamable HTTP MCP relay plus a local device agent. Its published surface includes filesystem reads/writes, search, code editing, persistent terminal/process sessions, process kill/inspection, document operations, configuration, and multi-device controls.

Its published security model is intentionally broad: tools execute with the paired user's OS permissions; the connected AI account is trusted; allowed directories and command blocking are guardrails rather than a sandbox. The hosted service is currently labeled beta.
This makes Desktop Commander the correct **baseline to replace for selected WebChat workflows**, but a poor feature-parity target. Copying its whole surface would import exactly the broad machine authority WAG was designed to avoid.

Current upstream references:

- Remote Desktop Commander: <https://github.com/desktop-commander/remote-desktop-commander>
- Remote Desktop Commander security model: <https://github.com/desktop-commander/remote-desktop-commander/blob/main/SECURITY.md>
- Desktop Commander MCP local tool inventory: <https://github.com/wonderwhy-er/DesktopCommanderMCP>

### Replacement interpretation

A valid statement is:

> WAG has replaced Desktop Commander for workflow X when the target WebChat completes workflow X through WAG with accepted reliability/security/performance evidence and Desktop Commander is absent from that production path.

An invalid statement is:

> WAG has not replaced Desktop Commander until it has every generic shell, file, document, process, configuration, and machine-management feature Desktop Commander exposes.

Replacement must therefore be declared by **workflow/capability tier**, not as an all-or-nothing clone claim.

## 3. What "Claude Code/Codex-like" means

Claude Code and Codex are useful reference experiences because they show the user outcomes expected from a modern coding agent.

Anthropic documents Claude Code as a local coding agent that can explore repositories and history, edit files, run commands/tests, create commits/PRs, and ask for confirmation around consequential actions. Claude Code also exposes tool allow/deny controls and permission modes; Anthropic's 2026 auto-mode work explicitly addresses approval fatigue, prompt injection in tool results, and dangerous-action classification.

OpenAI documents Codex as a coding experience for local folders, repositories, terminals, developer tools, tests, commands, and review. Codex permission/sandbox work similarly separates read/edit/command authority and uses sandboxing/approvals rather than assuming every model action should have ambient machine authority.

Primary references:

- Claude Code common developer use cases: <https://support.claude.com/en/articles/14553517-claude-code-common-developer-use-cases>
- Claude Code auto mode security design: <https://www.anthropic.com/engineering/claude-code-auto-mode>
- ChatGPT Work and Codex: <https://help.openai.com/en/articles/20001275/>
- OpenAI Codex Windows sandbox engineering: <https://openai.com/index/building-codex-windows-sandbox/>
The transferable lesson is **outcome parity, not tool parity**. A WebChat using WAG should be able to reach the same useful local development outcomes through safer semantic contracts even when WAG never exposes a raw `bash`/PowerShell tool.

Required outcome families are:

- understand an unfamiliar repository;
- locate relevant code efficiently;
- read bounded source/context;
- inspect repository state and changes;
- propose and apply reviewable code changes;
- run relevant tests/build/lint/verification;
- inspect produced artifacts/results;
- perform narrowly reviewed local Git/process operations only when a concrete workflow requires them;
- recover or fail explicitly when an effect outlives a request or its outcome becomes ambiguous.

Planner loops, subagents, model memory, model selection, browsing strategy, and provider-side session management stay with the provider. WAG supplies local capability, not reasoning orchestration.

## 4. WebChat provider reality in September 2026

### ChatGPT Web

OpenAI currently states that Work on web/mobile runs in the cloud and cannot directly access files on the user's computer. Codex can work with local folders/repositories/terminals in the desktop experience, but Codex is not selectable as a web/mobile experience.

For MCP, OpenAI currently documents full MCP including write/modify for Business, Enterprise, and Edu. Pro may connect MCPs with read/fetch permissions. ChatGPT does not connect directly to localhost/private MCP; supported private/on-prem/developer-machine MCP uses Secure MCP Tunnel.

Implication: the WAG Browser Adapter remains strategically valid for the reference ChatGPT Web path, especially where the account/product path does not provide the required full private MCP surface. The Business + Secure MCP Tunnel stdio path is a parallel native transport when the user adopts that product path.

Primary references:

- <https://help.openai.com/en/articles/20001275/>
- <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>
### Claude Web

Anthropic currently supports custom remote MCP connectors on Claude web/Cowork/Desktop for Free, Pro, Max, Team, and Enterprise plans (Free limited to one custom connector). Those remote connections originate from Anthropic cloud infrastructure and require a remotely reachable MCP server. Local MCP/OS access remains a Desktop/Claude Code mechanism rather than a direct claude.ai localhost connection.

Implication: Claude Web is a strong second-provider candidate for WAG because it can potentially consume the same WAG semantic contract through a native remote-MCP transport instead of provider-DOM/browser automation. A provider-specific browser adapter should not be built when direct remote MCP satisfies the required semantics and trust model.

Primary references:

- <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
- <https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors>

### Gemini Spark / Gemini Web

Google added custom Connected Apps for Gemini Spark using MCP server URLs. Current documentation says these custom apps work in Gemini Spark on web/mobile, but availability is constrained: current setup documentation requires eligible Spark access, age 18+, a personal Google account in the US, English, and an MCP server following the standard specification. Google explicitly says third-party MCP servers are the user's responsibility to supervise and trust.

Implication: Gemini Spark is a real WebChat/MCP target candidate, but not yet a universal provider path. WAG must record product/region/account eligibility at acceptance time rather than treating Gemini support as globally available.

Primary references:

- <https://support.google.com/gemini/answer/17171264?hl=en>
- <https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DDesktop&hl=en-TZ>

### Kimi Web / Kimi Code

Current official Kimi evidence now distinguishes two useful facts. **Kimi Code** is already a local coding-agent product with CLI/Desktop, a locally hosted browser UI, MCP stdio/HTTP support, built-in Read/Bash/Grep-style tooling, permissions, and subagents. Separately, Kimi's current plugin documentation says the **Kimi Web experience supports MCP and Skills in plugins** for supported Kimi experiences/models.

Implication: Kimi Web is now a plausible native-MCP WebChat target rather than an unproven browser-adapter target. Acceptance must still verify the exact model/product/plugin eligibility and whether a custom WAG MCP endpoint can expose the required tool semantics under the user's account. Kimi Code remains a reference coding experience, not the product path WAG is trying to replace.

Kimi references:

- <https://www.kimi.com/en/help/plugins-and-skills/overview>
- <https://www.kimi.com/code/docs/en/kimi-code-cli/guides/web.html>
- <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html>

### Additional WebChat/native-MCP evidence

The same architectural pattern is broader than the providers above. xAI documents custom MCP connectors in Grok conversations, requiring an internet-reachable server. Perplexity documents custom remote MCP connectors for eligible paid plans. Microsoft 365 Copilot supports MCP-backed custom/federated connectors under enterprise/admin controls; current federated-connector guidance emphasizes read-only tools.

These products are not automatic WAG roadmap commitments. They are evidence that provider-native remote MCP is becoming a common WebChat extension boundary, so WAG should avoid provider-DOM integration unless a target product lacks a stable native path.

Primary references:

- <https://docs.x.ai/grok/connectors>
- <https://www.perplexity.ai/changelog/what-we-shipped---march-13-2026>
- <https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/set-up-custom-federated-connectors>

No support claim should be made for Qwen or any other WebChat not explicitly proven by current official host documentation during its acceptance gate.
## 5. Provider integration rule

The provider matrix implies a strict adapter hierarchy:

1. use a provider-native remote/private MCP path when it supports the required WAG semantics and security;
2. use a WAG-owned browser/native adapter only when the WebChat product cannot consume the needed MCP path directly;
3. keep provider-specific code at request detection/result delivery/capability reporting boundaries;
4. never duplicate WAG policy, execution logic, durable state, or approval logic inside provider adapters;
5. do not use browser automation as the production transport when a stable provider-native protocol exists.

This preserves the existing Browser Adapter design ranking while updating the provider facts: ChatGPT Web may need the owned browser/native path; Claude Web can already use remote MCP; Gemini Spark can use remote MCP under current eligibility constraints.

Provider neutrality therefore means **one local capability/control plane with replaceable host transports**, not one universal transport.

## 6. Current WAG capability gap against Goal 1

Current canonical surfaces are intentionally narrow.

Default/private stdio exposes exactly:

- `health`;
- `workspace.open`;
- `repo.snapshot`;
- `file.read`;
- `verify.run`.

Browser Adapter v1 exposes exactly:

- `health`;
- `workspace.open`;
- `file.read`.

The backend already has broader primitives (`open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, `show_changes`), but ADR-0014 correctly prevents those backend primitives from becoming automatic host authority.
The current durable control plane also already contains two important building blocks that are **not yet production WebChat authority**:

- durable reviewed existing-file mutation with WAG-owned caller/resource identity, local approval, fingerprinting, restart reconciliation, and `OUTCOME_UNKNOWN` handling;
- durable verify-job ownership and recovery independent of MCP transport state.

Against the coding-focused portion of Desktop Commander, the practical gap is therefore:

| Workflow outcome | Current WAG status | Mission relevance |
| --- | --- | --- |
| Open approved local workspace | Accepted on Browser Adapter | Required |
| Read bounded source file | Accepted on Browser Adapter | Required |
| Repository status/files/diff summary | Exists on private/default surface; not Browser Adapter | Required |
| Search code/repository efficiently | No host semantic search tool | Required for practical coding parity |
| Run known tests/build/lint | `verify.run` exists privately; not Browser Adapter | Required |
| Durable verification across request loss | Internal core exists; no current host projection | Useful where workflow duration/recovery requires it |
| Edit existing source safely | Durable mutation core exists; not Browser/Business production surface | Required |
| Multi-file/create/delete/move change set | Not an accepted WAG capability | Likely required for broad coding outcomes; must be separately designed |
| Inspect exact change/diff after edit | Partial through snapshots/internal mutation evidence | Required |
| Arbitrary shell | Intentionally absent | Not required as a public capability if semantic outcomes cover the task |
| Persistent PTY/general process manager | Intentionally absent | Only if a measured WebChat workflow cannot be served by bounded task profiles |
| Git status/history/diff | Partial through `repo.snapshot` | Required read outcome |
| Git commit/branch/worktree/push | Unauthorized | Add only per concrete workflow and risk/approval contract; push should remain a later/higher-risk gate |
| PDF/Excel/DOCX general editing | Absent | Not part of coding mission unless a real WebChat workflow adds it |
| Multi-device machine control | Absent | Explicitly outside current mission |

This table is the authoritative interpretation of "replace DC": replace the **coding/local-work outcomes we actually need**, not Desktop Commander's entire machine-management catalog.
## 7. Target capability model for WebChat coding outcomes

WAG should grow by semantic capability families, not by exposing a general remote workstation API.

### A. Inspect

Desired outcomes: understand repository shape, locate relevant symbols/text, read bounded files, inspect Git status/diff/history needed for reasoning.

Likely semantic family: repository snapshot/search/read/history primitives with strict workspace binding and bounded outputs. Exact tool names remain a later design decision.

### B. Verify / build / test

Desired outcomes: run known project checks, builds, tests, linters, generators, or artifact inspections.

Default mechanism: locally configured, named task/verify profiles with bounded environment, timeout, output budget, exact workspace ownership, and explicit recovery semantics. Do not accept arbitrary model-supplied shell strings merely for convenience.

### C. Change

Desired outcomes: modify code and configuration in reviewable units.

The existing durable one-file mutation is the security baseline. Broader coding parity should evolve toward an immutable reviewed **change set** contract rather than resurrecting raw `file.patch`: exact workspace/revision, explicit file operations, bounded before/after evidence, local review for consequential effects, post-write verification, and unknown-outcome handling.

### D. Version control

Desired outcomes: inspect local Git state and, when a concrete workflow requires it, create controlled local branches/worktrees/commits.

Git mutation must be a capability-specific port with exact repository/revision binding and approval policy. Network publication (`push`, release, merge) is a separate higher-risk capability and must never arrive as incidental "Git support."

### E. Process / task execution

Desired outcomes: keep a necessary local dev/build/test task alive, retrieve bounded output, cancel exact owned work, and recover correctly after transport loss.

Prefer semantic task profiles. Introduce a process/job manager only if benchmarked workflows prove profiles insufficient. Any such manager must obey ADR-0014 durable-job semantics and cannot become a raw shell escape hatch.
## 8. MCP direction reinforces WAG's control-plane split

MCP `2026-07-28` makes the core protocol stateless, makes requests self-describing, hardens authorization, formalizes extensions, and moves long-running Tasks into an extension. The TypeScript v2 SDK does not enable that wire revision automatically; protocol enablement remains explicit.

This reinforces existing WAG decisions rather than replacing them:

- MCP is transport/capability projection, not durable WAG authority;
- WAG caller/resource ids cannot be inferred from an MCP session;
- durable mutation/verify state remains WAG-owned;
- provider transports can change without changing local authority contracts;
- Tasks may later be a compatibility projection when justified, but cannot own WAG lifecycle truth.

Primary references:

- <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- <https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28>

## 9. Security research supports the mission boundary

NIST's 2026 AI Agent Standards Initiative and agent identity/authorization concept work explicitly emphasize secure agent interoperability, identity, authorization, auditing/non-repudiation, and controls against prompt injection when agents access external systems.

OWASP's 2026 Agent Control Standard emphasizes inspectable, traceable, instrumentable agents and portable runtime policy enforcement. The Agentic Top 10 highlights goal hijacking, tool misuse, identity/privilege abuse, supply-chain risk, and unexpected code execution.

These are direct support for WAG's differentiation: the project should improve the trust boundary between WebChat reasoning and local capabilities, not compete on planning or model intelligence.

Primary references:

- <https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure>
- <https://csrc.nist.gov/pubs/other/2026/02/05/accelerating-the-adoption-of-software-and-ai-agent/ipd>
- <https://genai.owasp.org/resource/agent-control-standard-acs/>
- <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/>
## 10. Acceptance model for Goal 1: replace Remote Desktop Commander

Desktop Commander replacement is tiered. Do not use a global yes/no claim until every workflow that the user actually intends to retire from DC has passed its own gate.

### Tier R — read / inspect

The same WebChat must open an admitted workspace, discover repository state, locate relevant code, and read the required bounded context through WAG without DC in the production path.

### Tier V — verify / build / test

The same WebChat must launch only approved semantic verification/task profiles, receive bounded results, and handle timeout/recovery according to WAG durable semantics. A hidden raw-shell fallback is a failure of this tier.

### Tier C — reviewed code change

The same WebChat must propose a bounded code change, bind it to exact caller/workspace/revision evidence, pass the required local review boundary, apply through an accepted capability port, verify postconditions, and inspect the resulting change. DC must not be used to perform the effect under test.

### Tier D — practical local-development workflow

A representative synthetic coding task must combine inspect -> change -> verify -> inspect result in one WebChat workflow. This is the minimum tier for a credible "WebChat can code locally through WAG" claim.

### Optional higher-risk tiers

Local Git mutation, long-running process management, network publication, device/app control, and similar effects get separate capability-specific gates. They do not become implied by Tier D.
Each tier compares **the same target WebChat workflow** against the best currently available Remote Desktop Commander path where an equivalent comparison is possible. Record at least:

- task completion rate and failure class;
- median and sample p95 elapsed time;
- remote tool-call count / round trips;
- silent drop count (must be zero);
- correlation/accounting completeness;
- cross-caller/resource leakage (must be zero);
- stale/foreign approval acceptance (must be zero);
- unintended destructive effect (must be zero);
- disconnect/restart recovery correctness where applicable;
- cleanup/residue correctness;
- setup and recurring maintenance cost.

The old V0 `15.202x` loopback and `7.582x` Quick Tunnel speedups remain historical evidence only; they must not be reused as current replacement claims without a comparable rerun.

A tier passes only when WAG provides either materially better workflow economics/reliability **or** a materially stronger trust/control property that justifies its overhead. Mere feature availability is insufficient.

## 11. Acceptance model for Goal 2: WebChat local coding outcome parity

"Parity" is evaluated at the workflow outcome layer, not by counting low-level tools.

A WebChat provider reaches the core coding-outcome gate when, through the same WAG capability contracts, it can complete a synthetic task that requires:

1. admit/open one local workspace;
2. inspect repository state and locate relevant code;
3. read the bounded context needed for reasoning;
4. propose and perform an accepted reviewed code change;
5. run the relevant accepted verify/build/test profile;
6. inspect final repository/change evidence;
7. return a bounded result while preserving caller/workspace ownership and audit correlation.

The provider may plan, reason, choose files, and iterate in its own model/product layer. WAG must not reproduce those agent-loop functions.
Provider-neutrality has two evidence levels:

- **architectural neutrality:** core policy/capability/durable semantics contain no provider-specific execution logic;
- **empirical neutrality:** at least two materially different WebChat providers complete the same accepted WAG coding-outcome workflow without changing core authority semantics.

ChatGPT Web is the reference provider for the first level-to-level replacement work. A second WebChat provider should use the most native stable transport available. Current evidence makes native remote MCP the preferred second-provider route. Claude Web is a strong near-term candidate; Kimi Web, Grok, Perplexity, and Gemini Spark also expose MCP-based extension paths with materially different product/account/region/admin constraints. Selection must be based on the user's actual WebChat workflow and acceptance eligibility, not provider count.

## 12. Current blocker before consequential Browser Adapter authority

ADR-0017 remains binding: the current Windows browser discovery/bootstrap credential is same-user local trust, not strong OS caller attestation. It is accepted only for the server-enforced read-only browser profile.

Therefore the mission lock does **not** authorize simply projecting `verify.run`, mutation, Git, or process capabilities through the current Browser Adapter. Before any consequential Browser/WebChat capability is enabled, a separate reviewed gate must prove a stronger bootstrap/isolation/admission design appropriate to that authority.

The exact mechanism is intentionally not selected by this research receipt. Selecting Windows IPC, credential storage, browser enterprise policy, OS identity, or another mechanism requires fresh implementation-focused research and its own acceptance evidence.

This is the most important distinction between a product roadmap and implementation authority: Goal 1/Goal 2 justify what outcomes matter; they do not waive the trust gates required to reach them.

## 13. Evidence-driven roadmap derived from the mission

This roadmap is ordering guidance, not automatic authorization.

### Phase 0 — mission lock

Persist the two product goals, acceptance vocabulary, provider hierarchy, and no-build boundaries in canonical repo documentation. No runtime change.

### Phase 1 — repeatable DC replacement workflow benchmark

Create a current, disposable, deterministic benchmark suite representing real WebChat local-development workflows. Measure WAG and Remote Desktop Commander on the same WebChat path. Inventory which DC-dependent outcomes remain.
### Phase 2 — close read/inspect gaps first

Only if Phase 1 shows a material gap, add the smallest semantic inspect capability needed for practical repository understanding (for example bounded repository search) and project already-accepted read-only semantics such as `repo.snapshot` to the reference WebChat after its transport/admission gate permits them.

### Phase 3 — bounded verify/build/test

Promote named verify/task profiles to the reference WebChat only after the consequential Browser admission/isolation prerequisite passes. Reuse the existing verify semantics and durable job core rather than introducing arbitrary command execution.

### Phase 4 — reviewed code-change workflow

Use the accepted durable mutation principles as the starting security contract. If practical coding requires more than existing-file single-fragment updates, design an immutable reviewed multi-file change-set capability separately. Do not resurrect the retired historical `file.patch` protocol.

### Phase 5 — second WebChat provider

Prove the same accepted inspect/change/verify contract through a second WebChat using native remote/private MCP first. Do not add provider-specific execution semantics to core. This phase is what upgrades provider neutrality from architecture property to empirical product evidence.

### Phase 6 — only measured higher-risk gaps

Add bounded local Git/process/device/app capability only when a real benchmark workflow remains blocked after the semantic read/change/verify path. Each effect family gets its own capability port, risk model, lifecycle, approval, and acceptance gate.

MCP protocol `2026-07-28` compatibility/enablement may be maintained separately when interoperability requires it. Protocol revision work is not itself a product milestone and cannot be used as justification for authority growth.

## 14. No-build / anti-drift list

Unless a measured workflow gap and separately approved capability contract require otherwise, WAG must not add:

- an agent planner, autonomous agent loop, provider model router, model memory, or subagent framework;
- a Claude Code/Codex clone or local IDE;
- a generic Desktop Commander clone;
- raw arbitrary shell merely to claim coding-agent parity;
- unrestricted filesystem or generic backend-native MCP passthrough;
- a browser engine or broad browser-automation tool catalog;
- multi-device remote administration;
- generic document-office tooling unrelated to an accepted local-development workflow;
- provider-specific policy, approval, durable state, or execution logic;
- a provider browser adapter when a stable native MCP path satisfies the required semantics;
- a feature solely because Claude Code, Codex, Gemini/Kimi, or Desktop Commander exposes it.

Local coding agents remain useful conformance/reference clients, but connecting Codex/Claude Code to WAG is not a substitute for proving the actual WebChat product path.
## 15. Decision

`PRIMARY_PRODUCT_CLASS = WEBCHAT_AI_HOSTS_NEEDING_BOUNDED_LOCAL_CAPABILITY`

`REFERENCE_PROVIDER = CHATGPT_WEB`

`GOAL_1 = REPLACE_REMOTE_DESKTOP_COMMANDER_ON_SELECTED_WEBCHAT_LOCAL_WORKFLOWS`

`GOAL_2 = WEBCHAT_LOCAL_CODING_OUTCOME_PARITY_WITH_CLAUDE_CODE_CODEX_VIA_WAG`

`PARITY_DEFINITION = OUTCOME_NOT_LOW_LEVEL_TOOL_SURFACE`

`DESKTOP_COMMANDER_FEATURE_PARITY = NOT_A_GOAL`

`LOCAL_CODING_AGENT_REPLACEMENT = NOT_A_GOAL`

`WAG_AGENT_PLATFORM = FORBIDDEN_BY_DEFAULT`

`WAG_GENERIC_REMOTE_WORKSTATION = NOT_A_GOAL`

`PROVIDER_NATIVE_MCP = PREFERRED_WHEN_SEMANTICALLY_AND_SECURITY_SUFFICIENT`

`PROVIDER_SPECIFIC_EXECUTION_LOGIC = FORBIDDEN_IN_CORE`

`CHATGPT_WEB_BROWSER_ADAPTER = VALID_REFERENCE_PATH`

`CLAUDE_WEB_REMOTE_MCP = STRONG_SECOND_PROVIDER_CANDIDATE`

`GEMINI_SPARK_REMOTE_MCP = REAL_BUT_ELIGIBILITY_CONSTRAINED`

`KIMI_WEB_MCP = AVAILABLE_VIA_PLUGINS_SUBJECT_TO_PRODUCT_MODEL_ELIGIBILITY`

`CONSEQUENTIAL_BROWSER_AUTHORITY = BLOCKED_PENDING_STRONGER_ADMISSION_ISOLATION_GATE`

`NEXT_IMPLEMENTATION_GATE = NONE_AUTOMATIC`

`NEXT_EVIDENCE_TASK = DESIGN_CURRENT_DC_REPLACEMENT_WORKFLOW_BENCHMARK_SUITE`

## Sources and research cut

Research cut: 2026-09-17. Primary/upstream sources were preferred; product availability must be re-verified at the time of each provider acceptance because account, plan, region, and beta status can change.

- WAG canonical Git/spec/ADR/research at repository base above.
- Remote Desktop Commander: <https://github.com/desktop-commander/remote-desktop-commander>
- Remote Desktop Commander security: <https://github.com/desktop-commander/remote-desktop-commander/blob/main/SECURITY.md>
- Desktop Commander MCP: <https://github.com/wonderwhy-er/DesktopCommanderMCP>
- OpenAI ChatGPT Work and Codex: <https://help.openai.com/en/articles/20001275/>
- OpenAI Developer mode and MCP apps in ChatGPT: <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>
- OpenAI Codex Windows sandbox: <https://openai.com/index/building-codex-windows-sandbox/>
- OpenAI Running Codex safely: <https://openai.com/index/running-codex-safely/>
- Anthropic remote MCP custom connectors: <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
- Anthropic local vs remote connectors: <https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors>
- Claude Code developer use cases: <https://support.claude.com/en/articles/14553517-claude-code-common-developer-use-cases>
- Anthropic Claude Code auto mode: <https://www.anthropic.com/engineering/claude-code-auto-mode>
- Anthropic Claude Code sandboxing: <https://www.anthropic.com/engineering/claude-code-sandboxing>
- Gemini Spark custom connected apps: <https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DDesktop&hl=en-TZ>
- Kimi Web plugins/MCP: <https://www.kimi.com/en/help/plugins-and-skills/overview>
- Kimi Code web UI: <https://www.kimi.com/code/docs/en/kimi-code-cli/guides/web.html>
- Kimi Code MCP: <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html>
- Grok custom MCP connectors: <https://docs.x.ai/grok/connectors>
- Perplexity custom remote MCP connectors: <https://www.perplexity.ai/changelog/what-we-shipped---march-13-2026>
- Microsoft 365 Copilot MCP federated connectors: <https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/set-up-custom-federated-connectors>
- MCP 2026-07-28: <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- MCP TypeScript SDK v2 protocol opt-in: <https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28>
- NIST AI Agent Standards Initiative: <https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure>
- NIST agent identity/authorization concept work: <https://csrc.nist.gov/pubs/other/2026/02/05/accelerating-the-adoption-of-software-and-ai-agent/ipd>
- OWASP Agent Control Standard: <https://genai.owasp.org/resource/agent-control-standard-acs/>
- OWASP Top 10 for Agentic Applications 2026: <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/>
