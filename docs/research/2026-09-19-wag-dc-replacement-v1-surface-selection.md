# WAG DC Replacement v1 — Surface Selection Research Receipt

Date: 2026-09-19
Status: RESEARCH RECEIPT — dated evidence for a trust-boundary/capability decision
Research cut: 2026-09-19
Consumers: `docs/superpowers/specs/2026-09-19-wag-dc-replacement-v1-design.md`, `docs/adr/0020-make-private-stdio-the-dc-replacement-surface.md`

## Question

The DC Replacement Workflow Benchmark v1 measured a concrete gap set for WAG against Remote Desktop Commander
(`docs/benchmarks/2026-09-17-dc-replacement-live-benchmark-v1-attempt-1.md`). DC completed R0, R1, R2, V1, C1 and D1.
WAG's Browser Adapter was recorded `BLOCKED_CAPABILITY` for R1, R2, V1, C1 and D1.

Browser Inspect v2 later closed R1/R2 on the browser profile, and Browser Verify Approval v1 closed V1 on the browser
profile behind a local operator approval. Tier C and Tier D remain unauthorized on the browser profile by ADR-0018 and
ADR-0019.

This receipt answers one question with current evidence: **which WAG surface should carry the DC repository-engineering
replacement, and is that surface's authority already accepted?**

## Evidence 1 — Remote Desktop Commander current identity

Local npm registry resolution on 2026-09-19, Node `v24.20.0`, npm `12.0.2`:

```text
@wonderwhy-er/desktop-commander version          = 0.2.51
@wonderwhy-er/desktop-commander dist-tags.latest = 0.2.51
time.modified                                    = 2026-09-17T13:24:27.448Z
```

The version measured during the 2026-09-17 live benchmark was `0.2.50`. The pinned benchmark version is therefore one
patch behind current latest. That difference does not change anything this receipt concludes, and no formal benchmark
number is re-pinned here.

## Evidence 2 — Remote Desktop Commander stated capability surface

Fetched 2026-09-19 from `https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/README.md`.

Documented capability classes:

- file read/write, directory create/list, move, file metadata;
- file and content search;
- surgical text replacement (`edit_block`) and full file rewrite;
- shell command execution with streaming output, interactive process sessions, process listing and termination;
- runtime configuration mutation via `set_config_value` covering `blockedCommands`, `defaultShell`,
  `allowedDirectories`, `fileReadLineLimit`, `fileWriteLineLimit`, `telemetryEnabled`.

This is the surface WAG is being asked to replace for repository-engineering workflows. It is materially broader than
the measured benchmark workflows; ADR-0018 already fixes replacement as workflow-scoped, not surface-scoped.

## Evidence 3 — Remote Desktop Commander stated security model

Fetched 2026-09-19 from `https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/SECURITY.md`
and the same README.

Upstream states, in its own words:

- it is "an amplifier of whatever the connected AI client asks it to do";
- it assumes "the connected AI client — and the account driving it — is trusted and uncompromised";
- its controls are "safety guardrails that reduce accidental or unintended actions, not a security sandbox";
- it "does not protect against a compromised AI account or prompt injection reaching a trusted client";
- "path-based and command-based restrictions can be circumvented by design";
- "directory restrictions are guardrails, not sandboxing — terminal commands can reach files" outside them;
- README: `allowedDirectories` "currently only restricts filesystem operations, not terminal commands".

This confirms the 2026-09-17 benchmark observation (`DC_ALLOWED_DIRECTORIES = []` meaning ambient machine access) is the
documented upstream model and not a local misconfiguration.

Consequence for WAG: DC's approval/containment properties are **not** the bar to copy. WAG's replacement claim must rest
on equal workflow outcomes plus a real, enforced approval boundary — not on matching DC's tool catalogue.

## Evidence 4 — current provider position on custom MCP and write actions

Fetched 2026-09-19 from `https://developers.openai.com/api/docs/mcp`. The OpenAI Help Center article
`https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt` returned HTTP 403 to direct fetch
on this date; its content was reached only through search summaries and is therefore treated as weaker evidence.

Current documented statements:

- "ChatGPT currently requires manual confirmation in any conversation before write actions can be taken."
- Read-only tools may skip approval: a compatibility example "exposes only read-only `search` and `fetch` tools, so its
  API request skips approval for those tools."
- "It is possible for write actions to occur even if the MCP server has tagged the action as read only, making it even
  more important that you trust the custom MCP server before deploying to ChatGPT."
- Full MCP support including modify/write actions is documented as rolling out to ChatGPT Business, Enterprise and Edu.
- The platform document describes only remote servers reached over public URLs; it does not document a localhost or
  private transport, which is consistent with the 2026-09-17 finding that private/on-premises servers are expected to
  use a tunnel rather than public exposure.

Consequence for WAG: the provider's own confirmation prompt is explicitly **not** a sufficient authority boundary, and
the provider explicitly shifts trust onto the MCP server. A WAG-owned local operator approval is therefore not
redundant with the provider prompt — it is the only boundary that is actually enforced locally.

## Evidence 5 — current WAG surfaces, fresh-read from source at `7d85395`

`src/server.ts` currently builds three distinct MCP surfaces.

```text
createBrowserAdmittedMcpServer        (Browser Inspect v2)
  health, workspace.open, repo.search, repo.snapshot, file.read

createBrowserVerifyAdmittedMcpServer  (Browser Verify v3)
  health, workspace.open, repo.search, repo.snapshot, file.read, verify.preview, verify.result

createGatewayMcpServer                (private / Business stdio)
  health, workspace.open, repo.snapshot, file.read, verify.run
  + mutation.preview, mutation.result  ONLY when a mutationContext is supplied
```

`src/stdio-server.ts` calls `createGatewayMcpServer(options.gateway)` with no `mutationContext`. `src/cli.ts` wires
`serve-stdio` through that path. Therefore, on the shipped production stdio path today:

- `repo.search` is **not registered at all**, although it is already accepted and exposed on both browser profiles and
  is implemented once in `src/repository-inspection.ts`;
- `mutation.preview` / `mutation.result` are **never reachable in production**; the accepted
  `DurableMutationCoordinator` is assembled only inside `test/durable-mutation-mcp-fixture.ts`.

`test/business-stdio.acceptance.ts` pins the shipped default to exactly five tools.

## Evidence 6 — gap table against the measured benchmark

| Scenario | DC 0.2.50 measured | WAG browser v3 | WAG private stdio (shipped) |
| --- | --- | --- | --- |
| R0 bounded read | COMPLETE | available (`file.read`) | available (`file.read`) |
| R1 discovery/search | COMPLETE | available (`repo.search`) | **absent** |
| R2 repository state | COMPLETE | available (`repo.snapshot`) | available (`repo.snapshot`) |
| V1 named verify | COMPLETE | proposal + local approval | available (`verify.run`) |
| C1 reviewed change | COMPLETE | forbidden (ADR-0018/0019) | **implemented but not wired** |
| D1 integrated loop | COMPLETE | forbidden (needs C1) | **blocked by R1 + C1 wiring** |

The private stdio surface is one read-only projection and one wiring decision away from covering every measured
repository-engineering workflow. The browser surface cannot reach C1/D1 without a stronger isolation decision that
ADR-0019 explicitly defers.

## Evidence 7 — authority already accepted for the private stdio path

- ADR-0003 separates the safe tool surface from the privileged executor.
- ADR-0008 gates file patch behind a local single-use approval.
- ADR-0009 splits pending and approved TTL.
- ADR-0011 requires durable reviewed change records.
- ADR-0014 locks core control-plane contracts.
- ADR-0015 requires trusted caller context.
- ADR-0017 scopes its read-only restriction to the **Browser** admission path, on the stated grounds that the browser
  discovery/bootstrap secret lives in the same-user trust domain.
- ADR-0018 scopes replacement to selected workflows and forbids consequential **Browser Adapter** authority.
- ADR-0019 reaffirms that the forbidden class is direct consequential **browser** authority.

No accepted ADR forbids projecting an already-implemented, already-approval-gated mutation capability onto the private
stdio surface. The private stdio caller is a locally launched, locally configured child process holding the owner token
from the local environment; it is not the browser admission path whose bootstrap ADR-0017 declined to trust.

## Conclusions

```text
DC_CURRENT_LATEST = 0.2.51
DC_BENCHMARK_PINNED = 0.2.50
DC_SECURITY_MODEL = GUARDRAILS_NOT_SANDBOX_UPSTREAM_STATED
DC_PARITY_TARGET = WORKFLOW_OUTCOMES_NOT_TOOL_CATALOGUE
PROVIDER_CONFIRMATION = NOT_A_SUFFICIENT_AUTHORITY_BOUNDARY
DC_REPLACEMENT_SURFACE = PRIVATE_BUSINESS_STDIO
BROWSER_SURFACE_FOR_TIER_C_D = BLOCKED_BY_ADR_0018_0019
MEASURED_STDIO_GAPS = REPO_SEARCH_PROJECTION + MUTATION_WIRING
NEW_EXECUTION_PRIMITIVE_REQUIRED = NONE
NEW_DEPENDENCY_REQUIRED = NONE
ARCHITECTURE_DECISION_REQUIRED = YES_SEE_ADR_0020
```
