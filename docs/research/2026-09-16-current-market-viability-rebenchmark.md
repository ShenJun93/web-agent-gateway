# Current-Market Viability Re-benchmark — 2026-09-16

Status: evidence gate after Trusted Adapter Admission v1 and MCP v2 compatibility spike

Repository base: `bc0ad9937be68381d84e98e561ca66fbaf8942c4`

## Question

Re-evaluate whether WAG still solves a distinct current problem after major changes in first-party coding agents, MCP clients, browser automation, and ChatGPT product access since the original 2026-09-09/10 V0 gate.

This is not a license to widen WAG authority. It asks whether the next milestone should add capability at all.

## Historical value evidence retained

The accepted V0 read/verify benchmark remains historical evidence:

- Remote Desktop Commander subset median: `18.020 s`, sample p95 `24.184 s`;
- WAG loopback warm median: `1.185 s`, sample p95 `1.191 s`;
- WAG Quick Tunnel warm median: `2.377 s`, sample p95 `2.766 s`;
- historical loopback speedup: `15.202x`;
- historical Quick Tunnel speedup: `7.582x`;
- the comparable subset used eight calls on both paths, so the gain came from lower call overhead rather than tool-turn reduction.

The V0.1 gate later proved recoverable MCP task results across transport replacement in the same WAG runtime.
## Fresh latency evidence and comparability limit

The historical benchmark fixture at HEAD `57bcd8421936f3e44dba4eda80bbb98f583f8432` was explicitly disposable. A fresh machine search found no surviving `src-math.js` fixture, so this gate does not recreate a different fixture and mislabel it as a comparable latency rerun.

Five fresh Desktop Commander no-op `start_process` diagnostics measured total process-call times of:

`652 ms`, `810 ms`, `986 ms`, `1221 ms`, `867 ms`

Median diagnostic total: `867 ms`.

These measurements show that the current remote process-call floor is materially lower than many individual calls in the old baseline. They are not the deterministic eight-action scenario and therefore do not establish a new WAG/DC speedup ratio. The old 15.202x/7.582x figures remain historical only.

Current Desktop Commander package observation: `@wonderwhy-er/desktop-commander@0.2.50` is the latest npm version observed on 2026-09-16. Its current remote service exposes filesystem, terminal, search, and code tools to remote-MCP clients and is explicitly beta.

Primary sources:

- <https://github.com/mcp/wonderwhy-er/desktop-commander>
- <https://github.com/desktop-commander/remote-desktop-commander>
- <https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md>

Recent public issues report OAuth/session/config-recovery failures in the beta remote path. Treat those as operational risk signals, not as a general reliability verdict.
## OpenAI market change

The original product-access assumption has changed materially.

Current OpenAI documentation says Codex is included across ChatGPT plans and can be used through the desktop app, CLI, IDE extension, and web. In desktop/local workflows, Codex works with local folders, repositories, terminals, and developer tools. ChatGPT Work on desktop can also use local files and desktop apps with permission.

Primary sources:

- <https://help.openai.com/en/articles/11369540>
- <https://help.openai.com/en/articles/20001275/>

Therefore the old thesis that a ChatGPT subscriber needs WAG primarily to spend subscription quota on local coding is stale. First-party local coding access now exists.

A narrower access gap remains. Work on web/mobile cannot directly access local computer files, and Codex is not selectable as a web/mobile chat experience. Full custom MCP in ChatGPT developer mode is currently limited to Business and Enterprise/Edu; Pro may connect read/fetch MCP, and ChatGPT does not connect directly to localhost/private MCP servers. OpenAI documents Secure MCP Tunnel as the private/on-prem path for supported products.

Source:

- <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>

The Plugin Directory is now the primary discovery surface for reusable ChatGPT/Codex workflows, and availability/action permissions remain plan/workspace/app controlled.

Source:

- <https://help.openai.com/en/articles/20001256/>
## Cross-provider local-agent market

The same commoditization exists outside OpenAI.

Anthropic documents Claude Code as part of one Pro/Max subscription with Claude web/desktop/mobile, providing terminal and IDE coding workflows. Local machine inspection confirms Claude Code `2.1.260` is installed on this Windows machine.

Source:

- <https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan>

Google Gemini CLI `0.54.4` is also installed locally. Current Gemini CLI documentation exposes local/remote MCP configuration, per-server tool allowlists, trust flags, approval modes, allowed-path safety checks, and enterprise MCP controls.

Sources:

- <https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md>
- <https://github.com/google-gemini/gemini-cli/blob/main/docs/admin/enterprise-controls.md>

OpenAI Codex CLI `0.153.4` and Windows package `OpenAI.Codex 26.908.9136.0` are installed locally. Read-only CLI help confirms current Codex supports external MCP servers, configurable sandbox policy, and explicit approval policy. Claude CLI help likewise exposes MCP configuration, tool allow/disallow controls, and permission modes.

No Claude/Gemini/Codex model prompt was run against WAG or repository contents for this gate; these are binary/configuration capability observations only.

## Browser automation market

Generic browser automation is also established upstream. OpenAI's desktop built-in browser and WebMCP site tools can work with supported websites. Playwright MCP provides Chrome/Edge/Firefox/WebKit execution, persistent or isolated profiles, CDP/server attachment, and extension mode that reuses existing authenticated browser tabs.

Sources:

- <https://help.openai.com/en/articles/20001423>
- <https://github.com/microsoft/playwright/blob/main/docs/src/getting-started-mcp.md>
- <https://github.com/mcp/microsoft/playwright-mcp>
## Differentiation assessment

**Generic local coding access:** no longer distinct. Codex, Claude Code, Gemini CLI, and Desktop Commander all provide mature local file/process/coding paths. WAG should not build a generic shell, Git frontend, terminal agent, or process manager merely to match those products.

**Generic browser automation:** no longer distinct. Browser execution should remain an upstream/reused backend concern. WAG should not build a browser engine or broad browser-tool catalog.

**ChatGPT Web to local machine:** still a real but narrower niche. Browser Adapter v1 proves a read-only local path from ChatGPT Web where web Chat/Work lacks direct local-file access. That niche does not by itself justify consequential browser authority.

**Provider-neutral trust/capability layer:** remains distinct enough to preserve. Current hosts offer their own sandboxes, approvals, tool filters, and MCP controls, but WAG's accepted design combines provider-neutral semantic tools with WAG-owned caller/resource identity, exact durable ownership, local approval/fingerprint semantics, secret isolation, bounded schemas, audit, and a narrow replaceable executor boundary.

The value is therefore not “another coding agent.” It is a thin local trust/capability gateway that can present the same least-authority semantic contract to multiple reasoning hosts without making any host's transport/session/model identity authoritative.

## What the evidence does not justify

This gate does not justify:

- Exact-Owner Process Manager v1 as the automatic next milestone;
- arbitrary shell/process/PTY exposure;
- Git write authority;
- browser mutation projection;
- a generic browser automation engine;
- MCP v2 production migration while the accepted v1 Tasks projection lacks a stable upstream replacement;
- replacing Codex, Claude Code, Gemini CLI, Playwright MCP, or Desktop Commander at their generic execution responsibilities.
## Next milestone

The smallest evidence-driven next milestone is **Thin Gateway Consolidation and Host Conformance**.

Its default scope is compatibility and consolidation, not capability growth:

- keep existing WAG tool surfaces and authority unchanged;
- prove the current semantic gateway can be configured/consumed cleanly by representative current MCP-capable hosts such as Codex, Claude Code, and Gemini CLI without handing WAG their generic shell/browser responsibilities;
- test schema/tool-surface, transport, approval-boundary, and failure-mode compatibility using synthetic or local fixtures;
- keep real third-party model invocation optional and separately authorized because it sends data to another provider;
- remove or reword stale roadmap/product assumptions only when evidence proves them obsolete;
- open a new capability milestone only if conformance evidence identifies a concrete unmet trust/capability requirement.

This milestone may legitimately end with no production code change.

## Gate result

`GENERIC_LOCAL_CODING_ACCESS_DIFFERENTIATOR = NO_LONGER_DISTINCT`

`GENERIC_BROWSER_AUTOMATION_DIFFERENTIATOR = NO_LONGER_DISTINCT`

`CHATGPT_PLUS_PRIVATE_FULL_MCP = STILL_BLOCKED`

`CHATGPT_DESKTOP_LOCAL_CODING = AVAILABLE`

`PROVIDER_NEUTRAL_POLICY_GATEWAY = VIABLE_NICHE`

`PROCESS_MANAGER_NEXT = NOT_JUSTIFIED`

`BROWSER_MUTATION_NEXT = NOT_JUSTIFIED`

`MCP_V2_PRODUCTION_MIGRATION = DEFER`

`CURRENT_MARKET_VIABILITY_REBENCHMARK = PASS_WITH_REFRAMED_SCOPE`

`NEXT_MILESTONE = THIN_GATEWAY_CONSOLIDATION_AND_HOST_CONFORMANCE`
