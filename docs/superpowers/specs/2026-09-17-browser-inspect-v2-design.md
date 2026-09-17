# Browser Inspect v2 — Read-Only Repository Discovery Design

Date: 2026-09-17
Status: DRAFT FOR USER REVIEW — architecture direction approved; implementation not yet authorized
Decision authority: ADR-0014, ADR-0017, ADR-0018
Evidence: `docs/benchmarks/2026-09-17-dc-replacement-live-benchmark-v1-attempt-1.md`
Research: `docs/research/2026-09-17-external-webchat-local-coding-bridges-audit.md`

## Purpose

Close the measured WAG Tier-R gaps without opening consequential Browser Adapter authority.

Attempt 1 established the DC reference outcomes for R0, R1, and R2. WAG's Browser Adapter precheck then proved that the accepted browser profile exposes exactly `health`, `workspace.open`, and `file.read`; it cannot perform repository discovery/search or repository state inspection.

Browser Inspect v2 adds only the two semantic read-only capabilities required by that evidence:

- `repo.search` for bounded repository discovery;
- `repo.snapshot` for bounded Git/repository state inspection.

This milestone advances Goal 1 and Goal 2 only at the read/inspect layer. It does not authorize verification, mutation, shell, process, Git write, browser mutation, or generic MCP forwarding.

## Decision summary

Introduce a new browser profile rather than silently widening Browser Adapter v1.

`BROWSER_INSPECT_PROFILE = browser.chatgpt.native.inspect.v2`
`BROWSER_ADAPTER_PROTOCOL_VERSION = 2`
`BROWSER_INSPECT_TOOLS = health, workspace.open, repo.search, repo.snapshot, file.read`

Browser Adapter v1 remains the historical accepted three-tool profile. Browser Inspect v2 receives a distinct adapter identity and protocol revision so existing v1 durable resources do not acquire v2 authority by upgrade side effect.

The production runtime does not need to serve v1 and v2 simultaneously. A v2 release is an atomic runtime/native-host/extension profile upgrade. Rollback uses the accepted v1 release rather than compatibility aliases inside the v2 authority surface.

## Non-goals

Browser Inspect v2 does not add or expose:

- `verify.run` or durable verify jobs;
- `mutation.preview`, `mutation.result`, or any file-write capability;
- raw shell, arbitrary commands, PTY, or general process management;
- Git branch/commit/worktree/push or other Git mutation;
- unbounded directory traversal or a generic filesystem search API;
- regular-expression search supplied by the model;
- submodule recursion, textconv, external diff, or repository-configured executable helpers;
- browser composer mutation, automatic result submission, or provider-side planning;
- a generic MCP passthrough or a backend-native DevSpace tool surface.

Existing explicit user relay/result-delivery behavior is unchanged by this milestone. Any relay friction is measured in Layer B and cannot be hidden when making a replacement/economics claim.

## Why a new v2 profile

ADR-0017 accepted the v1 Browser Adapter only as an exact three-tool read-only profile. Adding tools under the same identity would make historical receipts ambiguous and could let a durable v1 adapter session appear to retain the same authority while its server-side capabilities changed.

The v2 identity makes authority growth explicit:

- adapter id becomes `browser.chatgpt.native.inspect.v2`;
- browser wire protocol becomes version `2`;
- v1 requests are rejected by a v2 native host and vice versa;
- v1-owned workspace records fail the normal exact `owner/session/adapter` check under a v2 caller;
- a user reopens the workspace under v2 rather than silently inheriting it.

The admission request still carries no model-controlled profile, adapter, owner, session, or capability selector. Runtime composition fixes the v2 adapter identity and exact capability profile server-side.

## Exact tool surface

The Browser Inspect v2 MCP server registers exactly five tools in this order:

1. `health`
2. `workspace.open`
3. `repo.search`
4. `repo.snapshot`
5. `file.read`

Tool discovery must fail closed if the underlying admitted MCP server returns a missing or additional tool. The native link must compare exact sets, not merely check that required names are present.

All five tools are read-only from the Browser profile's perspective. MCP annotations describe that property but do not enforce it; WAG's server composition, ownership checks, path policy, and fixed backend operations are the enforcement boundary.

`verify.run`, mutation tools, jobs, shell/process, Git writes, browser mutation, and generic forwarding must remain undiscoverable and return tool-not-found if invoked against the v2 admitted MCP server.

## `repo.search` contract

`repo.search` is a repository-scoped fixed-string discovery capability, not a shell alias.

Input schema:

```text
workspace_id: string
query: string                 # 1..256 UTF-8 bytes; no NUL/CR/LF
ignore_case?: boolean         # default false
max_results?: integer         # default 20; range 1..50
context_lines?: integer       # default 1; range 0..2
```

V2 searches tracked working-tree text only. It does not search `.git`, ignored/untracked files, submodules, binary content, textconv output, or files denied by the central sensitive-path policy. Untracked-file search may be considered later only if a measured workflow requires it.

The query is always literal. No regex, glob, shell, pathspec, command option, or backend-specific syntax is accepted from the caller.

Result shape is provider-neutral and contains only workspace-relative evidence:

```text
matches[]: { path, line, text, before[], after[] }
truncated: boolean
```

Results are ordered deterministically by normalized relative path, line number, then match text. Absolute roots, DevSpace workspace ids, backend URLs, local credentials, and command text are never returned.

Each returned line is bounded before serialization. The complete structured `repo.search` result must stay below 64 KiB; hitting a result, line, context, backend-output, or serialization budget sets `truncated: true` or returns a bounded failure rather than silently emitting partial malformed evidence.

Search execution has a fixed server-side timeout and backend-output budget; neither is caller-selectable. The initial implementation target is a 5-second search deadline. Timeout fails visibly and never falls back to a broader command surface.

A no-match search is a successful result with `matches: []` and `truncated: false` unless an execution/output budget prevented a complete bounded search.

## Search backend and injection boundary

Core WAG code depends on a semantic repository-inspection port rather than exposing DevSpace `exec_command`.

The initial DevSpace implementation may use Git's fixed-string search because Git documents `git grep -F` as literal matching, `-n` as line-number output, and `-I` as binary-file exclusion. It must explicitly avoid submodule recursion and textconv.

Because DevSpace accepts a command string, raw model/user query bytes MUST NOT be concatenated or interpolated into shell syntax. The backend adapter must pass query data through an argv-safe mechanism or a fixed helper that decodes bounded data and invokes Git with an argument array. Shell metacharacters remain data.

Implementation acceptance must include adversarial literal queries containing quotes, semicolons, pipes, redirection characters, dollar signs, backticks, parentheses, ampersands, and command-like text, and prove no side effect occurs.

If an argv-safe fixed helper cannot be proven portable on the supported DevSpace hosts, implementation stops and researches a safer upstream/native search primitive rather than weakening this contract.

No external repository dependency from the donor audit is introduced. Chat On Steroids and Codexless are contract donors only.

## `repo.snapshot` contract

Browser v2 projects the existing WAG repository-state semantic outcome through the admitted workspace service; it does not expose Git commands.

Input schema:

```text
workspace_id: string
max_files?: integer           # default 100; range 1..200 for Browser v2
```

The result preserves the current semantic fields:

```text
branch
head
dirty
status[]
diffStat
files[]
filesTruncated
```

The admitted implementation must retain the existing protections: `GIT_OPTIONAL_LOCKS=0`/`--no-optional-locks`, `core.fsmonitor=false`, no external diff, no textconv, and no submodule recursion. Repository configuration must not gain an executable path through snapshot.

Browser-v2 aggregation additionally bounds status entries, diff-stat bytes, tracked-file count, and total structured output so the result remains below 64 KiB. If backend truncation would remove structural markers or make state ambiguous, the call fails visibly rather than returning a misleading partial snapshot.

Snapshot execution also uses a fixed server-side timeout/output budget that the caller cannot raise. Timeout or structurally incomplete backend output is a visible failure, not a partial-success response.

The default/private MCP `repo.snapshot` contract remains compatible. Shared repository-inspection code may strengthen deterministic bounds, but this milestone must not widen default/private authority or change its tool inventory.

## Durable workspace ownership

`repo.search` and browser `repo.snapshot` route through `AdmittedWorkspaceService`, not through the default MCP server's in-memory workspace map.

For every operation the service:

1. loads the durable workspace record by opaque id;
2. requires exact `ownerId`, `sessionId`, and `adapterId` equality;
3. resolves/reopens the DevSpace binding only after canonical-root revalidation;
4. invokes the semantic repository-inspection backend;
5. returns only bounded provider-neutral evidence.

Unknown and foreign-owned workspace ids produce the same bounded `Gateway denied workspace` failure. Browser v2 must preserve this non-oracle behavior across read, search, and snapshot.

A WAG restart may drop the in-memory DevSpace binding but not durable ownership. Search and snapshot must recover by reopening the recorded canonical root exactly as `file.read` does today; restart cannot transfer a workspace to another caller/session/profile.

## Sensitive-path and workspace containment policy

Search inherits the same central path vocabulary as `file.read`.

Before any match is exposed, its normalized relative path must pass the sensitive-path policy and canonical containment check. Matches under `.git`, `.ssh`, `.aws`, `.gnupg`, `.azure`, `.kube`, credential files, and denied `.env*` variants are omitted/denied even if Git considers them tracked.

A match whose path resolves through a symlink/junction outside the canonical workspace is never returned. Search must not follow a path outside the workspace merely to produce context.

Repository text is untrusted data. Search results may contain prompt injection, but repository content cannot alter WAG policy, capability profile, workspace ownership, or path checks. The v2 surface contains no consequential effect tool that repository text can invoke locally.

Raw backend search output is not telemetry. Telemetry records operation name, timing, bounded counts/truncation/error class, caller correlation, and success/failure without logging query contents or matched source text by default.

## Browser protocol and discovery binding

Browser protocol v2 remains a strict discriminated envelope. It adds only `repo.search` and `repo.snapshot` tool-call variants with strict schemas and retains the 256 KiB envelope ceiling as a final transport guard.

The runtime discovery record becomes version/profile bound and contains exactly:

```text
admissionUrl
bootstrapToken
protocolVersion: 2
adapterId: browser.chatgpt.native.inspect.v2
```

The native host refuses a discovery record with a missing, different, or additional profile/version field. `hello` returns protocol/profile identity and the extension requires an exact match before session binding.

Old v1 native host + v2 runtime discovery and new v2 native host + v1 runtime discovery therefore fail closed before tool execution. The page/model cannot choose the protocol/profile.

The content parser and service worker accept exactly the five v2 tool names. They retain strict argument parsing, trusted ChatGPT origin checks, request-id deduplication, tab/session correlation, side-panel-only execution, and bounded native responses.

This milestone does not auto-fill or auto-submit ChatGPT messages. Result delivery stays extension-owned/manual under the existing Browser boundary.

## MCP metadata

Browser v2 tools use truthful annotations from the trusted WAG server. Read-only tools should advertise at least `readOnlyHint: true`; where supported by the current SDK they may also declare non-destructive/idempotent/closed-world hints.

Annotations are never treated as authority. MCP's own guidance describes tool annotations as hints rather than enforcement. Exact server composition and runtime policy remain the guarantee.

## Failure semantics

Expected bounded failures include:

- `Gateway denied workspace` for unknown/foreign resources;
- existing workspace/path-policy failures for denied roots/paths;
- `Gateway denied search query` for invalid/control/oversized query input;
- `Gateway search failed` for backend execution/parsing failure without leaking raw stderr or command text;
- existing bounded local-link error redaction at the browser/native boundary;
- protocol/profile mismatch before session binding;
- tool-not-found for every capability outside the exact five-tool profile.

No fallback to DC, default MCP, arbitrary shell, direct DevSpace calls, or another local connector is permitted when a v2 operation fails.

## Test and acceptance gates

Implementation starts with TDD and must prove all of the following before release promotion.

### Unit/security gates

- protocol v2 accepts only lifecycle envelopes plus the exact five tool calls;
- v1/v2 protocol and discovery/profile mismatches fail closed;
- browser-admitted MCP exposes exactly five tools and no extras;
- extension/native link independently verifies the exact five-tool inventory;
- model/page arguments cannot set owner, session, adapter, provider, profile, bearer, backend, or capability fields;
- foreign/unknown workspace ids are indistinguishable for `read`, `search`, and `snapshot`;
- restart recovery preserves exact v2 caller/workspace ownership;
- fixed-string queries with shell metacharacters remain literal and produce no filesystem/process side effect;
- search cannot expose sensitive tracked paths, outside-workspace symlink/junction targets, `.git`, submodule content, binary content, or absolute local roots;
- search and snapshot budgets are deterministic and fail visibly on ambiguous backend truncation;
- repository-configured fsmonitor/textconv/external helpers do not execute through search/snapshot;
- `verify.run`, mutation, jobs, shell/process, Git write, and browser-mutation calls remain unavailable.

### Integration gates

Use the exact pinned DevSpace compatibility fixture and a synthetic Git repository to prove:

1. `workspace.open -> repo.search` locates a known implementation and test;
2. `workspace.open -> repo.snapshot` returns branch, full HEAD, dirty state, changed file evidence, and bounded tracked files;
3. `file.read` remains behaviorally compatible;
4. WAG restart followed by search/snapshot on the same v2-owned workspace rebinds correctly;
5. cross-session workspace use is denied after reconnect/restart;
6. full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` pass.

### Distribution/supported-host gate

Browser Inspect v2 requires a fresh native-host build/publication/install acceptance. The accepted v1 executable, manifest, receipt, and source SHA are historical v1 evidence and cannot be reused as v2 acceptance.

Before live ChatGPT acceptance, record exact source SHA, CI workflow run/artifact, executable SHA-256, manifest SHA-256, extension id, adapter id, protocol version, installed path, config hash, DevSpace identity, Node version, and post-install verifier result.

The supported-host run must prove exact five-tool discovery through the committed extension -> Native Messaging -> accepted v2 host -> WAG admission path, plus reconnect/rebind behavior. No direct MCP/native shortcut substitutes for this evidence.

### Layer-B Tier-R gate

After supported-host acceptance, rerun the benchmark on fresh fixtures/chats:

- R0: bounded sentinel read;
- R1: repository discovery through `repo.search` plus bounded read evidence;
- R2: repository state through `repo.snapshot`.

Tier R is promoted only if R0, R1, and R2 all complete through WAG with no DC fallback, no connector mixing, no security failure, and correct final residue. Existing WAG R0 Attempt 1 remains `CONTAMINATED_RUN`; it is not rewritten or deleted.

Human relay/click count, remote round trips, tool failures/retries, and elapsed time are recorded. Tier-R capability completion does not by itself prove that WAG has better workflow economics than DC if manual relay remains materially worse.

## Expected implementation boundaries

Likely implementation surfaces are limited to:

- a provider-neutral repository-inspection port/helper;
- `AdmittedWorkspaceService` search/snapshot methods;
- Browser-admitted MCP five-tool composition;
- v2 adapter identity/admission constants;
- browser protocol/discovery/native-link/native-host version binding;
- ChatGPT tool-block parser/service-worker allowlist for the two new read-only tools;
- focused unit/security/integration/distribution tests.

Do not use this milestone to refactor mutation, durable verify jobs, default/private MCP, provider orchestration, or unrelated browser UI.

If implementation discovers that safe/portable search requires a materially different execution architecture, stop and return to design review rather than adding raw shell authority.

## Security argument

The authority delta from v1 is read-only repository metadata/content discovery within an already admitted exact-owned workspace.

The important distinction is that search increases **information reach within the workspace** even though it adds no write effect. Therefore its acceptance must treat sensitive-path filtering, workspace escape, output bounding, prompt-injection content, and cross-caller ownership as security properties rather than UX details.

No model-supplied value becomes executable syntax. No repository text becomes authority. No v1 caller automatically upgrades to v2. No raw backend primitive becomes host-visible.

Consequential Browser authority remains blocked under ADR-0018 after this milestone. Tier V/C/D work requires a separate stronger admission/isolation decision.

## External evidence refreshed for this design

Research cut: 2026-09-17.

- MCP maintainers state that tool annotations such as `readOnlyHint` are hints, not enforcement; deterministic authorization/runtime controls must provide hard guarantees: <https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/>.
- Git documents `git grep -F` for fixed-string search, `-n` for line evidence, and `-I` for binary exclusion; textconv and submodule recursion are separately controlled: <https://git-scm.com/docs/git-grep>.
- OpenAI currently documents that ChatGPT does not connect directly to localhost MCP; supported developer-machine/private MCP uses Secure MCP Tunnel, while full MCP capability is plan/product dependent: <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>.
- Donor-repository findings remain advisory only; no audited external repository becomes a runtime dependency from this design.

## Decision markers

`MILESTONE = BROWSER_INSPECT_V2`
`GOAL_1_DELTA = CLOSE_R1_R2_READ_INSPECT_GAPS`
`GOAL_2_DELTA = PRACTICAL_REPOSITORY_DISCOVERY_AND_STATE_INSPECTION`
`ADAPTER_ID = browser.chatgpt.native.inspect.v2`
`WIRE_PROTOCOL = 2`
`TOOL_COUNT = 5`
`REPO_SEARCH = BOUNDED_FIXED_STRING_TRACKED_TEXT_ONLY`
`REPO_SNAPSHOT = EXISTING_SEMANTICS_VIA_ADMITTED_WORKSPACE`
`SHELL_AUTHORITY = NOT_EXPOSED`
`CONSEQUENTIAL_BROWSER_AUTHORITY = STILL_BLOCKED`
`TIER_R_PROMOTION = REQUIRES_FRESH_LAYER_B_R0_R1_R2`
`IMPLEMENTATION_AUTHORITY = PENDING_WRITTEN_SPEC_USER_REVIEW`
