# Thin Gateway Host Conformance — 2026-09-16

Status: empirical host-conformance spike; no production implementation change

Repository base: `4902bcf308f6386fe3ad8b85da5e9ac00410a644`

## Question

Determine whether the existing WAG stdio MCP surface is already consumable by the currently installed Codex CLI, Claude Code, and Gemini CLI without adding provider-specific adapters, widening WAG authority, or sending a model prompt.

The spike used only task-owned synthetic fixtures/configuration and model-free MCP/configuration diagnostics. No repository content or synthetic fixture content was sent to a model/provider.

## Fixed WAG baseline

Before host-specific probes, the exact pinned DevSpace fixture and WAG private stdio runtime were checked independently.

Observed:

- `doctor` returned `status=ok` against the task-owned private config;
- current `npm run test:business` passed **1/1**;
- that acceptance test asserts the default WAG stdio surface is exactly:
  - `health`
  - `workspace.open`
  - `repo.snapshot`
  - `file.read`
  - `verify.run`
- no mutation, browser, process/PTY, raw shell, Git-write, approval, or ownership field was added to the MCP surface.

## Installed host versions

Measured on the Windows acceptance machine:

- Codex CLI `0.153.4`
- Claude Code `2.1.260`
- Gemini CLI `0.54.4`

These results are scoped to those installed versions. The spike did not update any host.

## Codex

Codex was isolated with a task-owned `CODEX_HOME`.

`codex mcp add` accepted the WAG stdio launcher, and `codex mcp list --json` reproduced the configured stdio command. That management command did not launch WAG, so it was treated as configuration evidence only.

For real model-free protocol evidence, the spike used Codex's app-server API. The app-server was initialized without starting a model turn, then queried with `mcpServerStatus/list`.

Observed inventory for server `wag`:

- `serverInfo.name = web-agent-gateway`
- `serverInfo.version = 0.0.0`
- `toolsError = null`
- discovered tools exactly `file.read`, `health`, `repo.snapshot`, `verify.run`, `workspace.open`
- the task-owned launcher log confirmed Codex actually spawned WAG.

Official upstream reference points:

- Codex app-server MCP status type: <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs>
- Codex MCP conformance runner using `mcpServerStatus/list`: <https://github.com/openai/codex/blob/main/scripts/mcp_conformance/run_codex_compliance.py>

This is the strongest host result because Codex exposed the full discovered WAG tool inventory without a model prompt.

## Claude Code

Claude was configured in a task-owned project and task-owned `CLAUDE_CONFIG_DIR`. Before the health-check command, both `HOME` and `USERPROFILE` were also redirected to task-owned paths so the probe would not depend on the user's normal Claude profile.

The local-scope MCP config remained inside the task-owned Claude config tree.

Model-free CLI observations:

- `claude mcp list` explicitly performed MCP server health checking;
- WAG reported `✔ Connected`;
- the task-owned launcher log confirmed Claude actually spawned WAG;
- `claude mcp get wag` also reported `Status: ✔ Connected` and the expected stdio command.

The installed Claude CLI does not expose the discovered tool catalog through these non-model management commands, so this result is transport/handshake health evidence rather than a second independent five-tool inventory assertion.

One setup attempt used a PowerShell variable name that collided with built-in `$HOME`, so that add-only command did not redirect `HOME`. Claude still wrote only the explicitly task-owned `CLAUDE_CONFIG_DIR`; no model turn occurred. The actual health-check/get probes were then rerun with corrected task-owned `HOME`, `USERPROFILE`, and `CLAUDE_CONFIG_DIR`.

## Gemini CLI

Gemini used a task-owned project configuration and task-owned `GEMINI_CLI_HOME`.

The first `gemini mcp list` correctly failed closed at the workspace-trust boundary: the project-scoped WAG server was shown as `Disabled`, and the launcher log remained empty.

Official Gemini guidance documents `GEMINI_CLI_TRUST_WORKSPACE=true` as a session-only mechanism for headless/automated trusted-workspace execution. The spike then reran the same model-free command with that environment value only for the probe process.

Observed:

- `gemini mcp list` reported WAG as `✓ ... Connected`;
- the task-owned launcher log confirmed Gemini actually spawned WAG;
- no trust rule was persisted into the user's real profile.

Official references:

- Trusted folders and session-only trust: <https://geminicli.com/docs/cli/trusted-folders/>
- MCP server configuration: <https://geminicli.com/docs/tools/mcp-server/>

The installed Gemini `mcp list` command reports connection status but not the discovered tool catalog, so this is transport/handshake health evidence.

## Cleanup and isolation

All host configs, wrappers, launcher logs, and synthetic workspace files lived under one task-owned temporary root.

After the probes:

- the harness DevSpace pid was gone;
- no `web-agent-gateway\dist\cli.js ... serve-stdio` child remained;
- the entire task-owned host-conformance root was deleted;
- canonical repository `HEAD` remained `4902bcf308f6386fe3ad8b85da5e9ac00410a644`;
- canonical Git status remained unchanged except the pre-existing untracked `.playwright-cli/` artifact.

No user MCP configuration, browser profile, registry state, package manifest, lockfile, WAG source file, or production credential was intentionally changed by this spike.

## Interpretation

The current WAG stdio protocol shape already conforms to three materially different local AI hosts without provider-specific production adapters.

Codex proves full model-free server identity and tool discovery. Claude and Gemini prove model-free stdio connection/handshake health; the separately passing WAG Business stdio acceptance fixes the authoritative five-tool WAG surface independently of host UI/diagnostic differences.

There is therefore no evidence-based reason to add host-specific adapter code, duplicate MCP servers, generic orchestration, or broader tool authority merely for Codex/Claude/Gemini compatibility.

## Decision

Host conformance passes with no production code delta.

The next useful work is not capability growth. If further implementation is proposed, first audit existing historical/experimental transport and adapter surfaces for redundancy against the reframed thin-gateway product boundary. Any deletion or consolidation remains a separate reviewed change; this receipt does not authorize it.

`WAG_DEFAULT_STDIO_FIVE_TOOL_SURFACE = PASS`

`CODEX_WAG_HOST_CONFORMANCE = PASS_FULL_INVENTORY`

`CLAUDE_WAG_HOST_CONFORMANCE = PASS_TRANSPORT_HEALTH`

`GEMINI_WAG_HOST_CONFORMANCE = PASS_TRANSPORT_HEALTH`

`WAG_TOOL_SURFACE_CHANGE = NONE`

`WAG_AUTHORITY_CHANGE = NONE`

`WAG_PACKAGE_CHANGE = NONE`

`HOST_SPECIFIC_ADAPTER_IMPLEMENTATION = NOT_REQUIRED`

`PRODUCTION_CHANGE_REQUIRED = NO`

`THIN_GATEWAY_HOST_CONFORMANCE = PASS`

`NEXT_ACTION = STOP_FEATURE_GROWTH_AND_AUDIT_REDUNDANT_SURFACES`
