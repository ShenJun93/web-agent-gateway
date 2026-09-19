# WAG DC Replacement v1 — Design

Date: 2026-09-19
Status: APPROVED DESIGN — implementation authorized by this milestone; distribution/provider actions are not
Decision authority: ADR-0018, ADR-0020, ADR-0021, ADR-0022
Depends on: ADR-0003, ADR-0008, ADR-0009, ADR-0011, ADR-0014, ADR-0015, ADR-0017, ADR-0019
Research: `docs/research/2026-09-19-wag-dc-replacement-v1-surface-selection.md`
Measured gap: `docs/benchmarks/2026-09-17-dc-replacement-live-benchmark-v1-attempt-1.md`
Benchmark contract: `docs/superpowers/specs/2026-09-17-dc-replacement-workflow-benchmark-suite-v1-design.md`
Acceptance plan: `docs/superpowers/plans/2026-09-19-wag-dc-replacement-v1-acceptance.md`

## Purpose

Make WAG able to perform, on the private/Business stdio production surface, every repository-engineering workflow the
DC Replacement Workflow Benchmark v1 measured Remote Desktop Commander completing — R0, R1, R2, V1, C1, D1 — without
adding an execution primitive, a dependency, a listener, or any authority the project has not already accepted.

Scope is deliberately narrow: two capability projections onto one existing surface, plus the production wiring that
makes the already-accepted local approval path reachable outside a test fixture.

Non-goals are listed in full at the end. In particular this design does not touch the Browser Adapter, does not add
shell/process/Git-write capability to any surface, and does not perform distribution, signing or provider actions.

## Problem statement

The measured production gap, fresh-read from source at `7d85395`:

```text
serve-stdio  ->  createGatewayMcpServer(gateway)      // no mutationContext
                 health, workspace.open, repo.snapshot, file.read, verify.run
```

Consequences:

1. `repo.search` exists in `src/repository-inspection.ts` and is already accepted on both browser profiles, but the
   production stdio surface cannot discover anything. R1 is unreachable, so D1 is unreachable.
2. `DurableMutationCoordinator`, `DevspaceFileMutationBackend` and the operator review server are implemented,
   reviewed and tested, but are assembled only in `test/durable-mutation-mcp-fixture.ts`. C1 is unreachable in
   production, so D1 is unreachable twice over.
3. `createGateway` has no `repoSearch` method at all; the browser path reaches search through
   `AdmittedWorkspaceRegistry.search`, which the stdio path does not use.

## Design overview

```text
                 ┌─────────────────────────── local machine ───────────────────────────┐
                 │                                                                     │
  MCP client ───►│  serve-stdio                                                        │
  (Business /    │    ├─ health / workspace.open / repo.list / repo.search             │
   tunnel /      │    ├─ repo.snapshot / repo.diff / file.read / verify.run            │
   local)        │    ├─ mutation.preview  ──► durable record, NO write                │
                 │    └─ mutation.result   ──► bounded state view                      │
                 │                                   │                                 │
                 │           local operator ◄────────┘  (separate loopback HTTP)       │
                 │                │ approve exactly one record, single use             │
                 │                ▼                                                    │
                 │        DurableMutationCoordinator ──► DevspaceFileMutationBackend    │
                 │                                              │                      │
                 │                                       pinned DevSpace                │
                 └─────────────────────────────────────────────────────────────────────┘
```

The MCP caller may propose and may read. Only the local operator may cause a write. This is the same decomposition
ADR-0019 accepted for browser verification, applied to the surface where ADR-0020 places DC replacement.

## Capability profile

### Default profile — unchanged

With no `repositoryEngineering` block in the private config, `serve-stdio` exposes exactly, and in exactly this order:

```text
health
workspace.open
repo.snapshot
file.read
verify.run
```

This is byte-identical to the currently accepted Business stdio five-tool contract. `test/business-stdio.acceptance.ts`
keeps asserting it unchanged.

### Extended profile — local opt-in only

With both options configured, the surface becomes, in exactly this order:

```text
health
workspace.open
repo.list
repo.search
repo.snapshot
repo.diff
file.read
verify.run
mutation.preview
mutation.result
```

Each flag is independent. `inspect` alone yields eight tools; `mutation` alone yields seven.

`inspect` admits the whole read-only set — `repo.list`, `repo.search` and `repo.diff` — because they are one
authority class, not three. `repo.list` returns the immediate tracked and untracked-not-ignored entries of one
directory; `repo.diff` returns the bounded working-tree diff against `HEAD`. Both are specified by ADR-0021.

Opt-in is a local JSON file the operator writes. It is never derived from tool arguments, transport metadata, provider
identity, environment supplied by the MCP client, or repository content.

## Configuration

`src/private-config.ts` gains one optional strict block:

```jsonc
{
  "allowedRoots": ["<absolute>"],
  "devspace": { "baseUrl": "...", "resourceUrl": "..." },
  "verifyProfiles": { "unit": { "argv": ["npm", "test"], "timeoutMs": 30000, "maxOutputTokens": 4000 } },
  "browserVerifyProfiles": [],

  "repositoryEngineering": {
    "inspect": true,
    "mutation": {
      "statePath": "<absolute path to the durable state database>",
      "ownerId": "local.private.stdio"
    }
  }
}
```

Validation rules, all fail-closed at load time:

- the whole block is optional; absent means both capabilities disabled;
- `inspect` defaults to `false`;
- `mutation` is absent by default;
- `mutation.statePath` is required when `mutation` is present and must be absolute;
- `mutation.ownerId` is optional, defaults to `local.private.stdio`, and must match the existing caller-context
  authority pattern `^[A-Za-z0-9._:-]{1,128}$`;
- the schema stays `.strict()`, so an unknown key is a config error rather than a silent capability.

`statePath` is a local operator decision and is never echoed to the MCP client.

## Caller identity

The stdio caller context is constructed locally, per process, through the existing
`createGatewayCallerContext`:

```text
ownerId   = config.repositoryEngineering.mutation.ownerId   (default 'local.private.stdio')
sessionId = 'sid_' + randomUUID()                            (fresh every gateway process)
adapterId = 'private.stdio.v1'                               (fixed literal)
```

No field is readable or influenceable by the client. Because `sessionId` is per process and
`DurableMutationCoordinator` enforces owner+session+adapter identity on `mutation.result`, a restarted gateway cannot
read a mutation proposed by a previous process, and no MCP caller can inherit another session's record.

Local operator authority is deliberately independent of the caller session, and this milestone does not change that.
A proposal left pending across a restart therefore keeps its original, never-refreshed deadline and remains reviewable
by the local operator until it expires; `reconcile()` expires it on startup if the deadline has already passed. The
operator sees the exact workspace, path, diff and fingerprint before approving, so this is a reviewed decision, not an
inherited authority. What a restart can never do is let a *remote* caller read, approve, resume or replay a record.

## Component changes

### 1. `createGateway` gains `repoSearch`

Symmetric with the existing `repoSnapshot` wrapper, using the same `DevspaceRepositoryInspectionBackend` instance:

```ts
async repoSearch(workspaceId: string, options: { query: string } & RepoSearchOptions)
```

Clamping is identical to the accepted browser projection in `AdmittedWorkspaceRegistry.search`:

```text
ignoreCase   default false
maxResults   default 20, clamped to [1, 50]
contextLines default 1,  clamped to [0, 2]
```

It resolves `devspaceWorkspaceId` and `canonicalRoot` from the same workspace binding `file.read` and `repo.snapshot`
use, and emits a `repo.search` telemetry trace like every other gateway method. No new path policy is written; the
backend already enforces the bounded `git grep` helper.

### 1b. `createGateway` gains `repoList` and `repoDiff`

Both delegate to the same shared `DevspaceRepositoryInspectionBackend`, emit `repo.list` / `repo.diff` telemetry
traces, and resolve the same workspace binding as every other read. Their bounds and the argv-not-shell handling of a
caller-supplied path are specified by ADR-0021.

### 2. `createGatewayMcpServer` gains an explicit `inspect` switch

```ts
createGatewayMcpServer(gateway, { repoSearch?: boolean, mutationContext?: MutationMcpContext })
```

`repo.search`, `repo.list` and `repo.diff` are registered only when `inspect === true`, immediately after `workspace.open`, with the same input
schema, the same `validSearchQuery` guard, and the same read-only annotations already used on the browser profile.
Both existing call sites keep their current behavior when the option is omitted.

### 3. `startGatewayStdioServer` forwards the profile

`GatewayStdioServerOptions` gains optional `repoSearch` and `mutationContext` and passes them straight through. No
behavior changes when they are absent.

### 4. New `src/repository-engineering-runtime.ts`

One module owns the assembly that currently lives in the test fixture, so production and tests share one path:

```ts
startRepositoryEngineeringRuntime(config, { now? }): Promise<RepositoryEngineeringRuntime>

interface RepositoryEngineeringRuntime {
  repoSearch: boolean;
  openWorkspaceId?: (canonicalRoot: string) => string;
  attach(executor: DevspaceExecutor): Promise<void>;
  mutationContext?: MutationMcpContext;
  operator?: { origin: string; bootstrapUrl: string };
  close(): Promise<void>;
}
```

Ordering is forced by existing contracts and is the same order the accepted fixture uses:

1. if mutation is enabled, open `SqliteDurableStore(statePath)` and build the caller context;
2. expose `openWorkspaceId` so `workspace.open` persists a durable workspace record owned by that exact caller tuple —
   `DurableMutationCoordinator.preview` looks the workspace up in the store, so this hook is mandatory, not optional;
3. after the gateway bootstraps, `attach(executor)` constructs
   `DurableMutationCoordinator({ store, backends: [new DevspaceFileMutationBackend(executor)] })`,
   awaits `coordinator.reconcile()`, and starts `startOperatorServer({ coordinator })` on loopback;
4. `close()` tears down operator server then store, idempotently, and never throws past the caller.

When mutation is disabled the module returns `{ repoSearch, attach: noop, close: noop }` and opens no database, binds
no port and creates no caller context.

### 5. CLI wiring

`serve-stdio`:

```text
load config
start repository-engineering runtime        (store + caller context, or nothing)
bootstrap private gateway                   (with openWorkspaceId when present)
attach(executor)                            (coordinator + reconcile + operator server)
emit {"type":"gateway.profile",...} and, when mutation is enabled,
     {"type":"gateway.operator","origin":"…","urlFile":"…"}  on stderr (never the token)
start stdio server with { inspect, mutationContext }
emit {"type":"gateway.ready","mode":"stdio"} on stderr
```

`doctor` stays a read-only preflight. It prints the resolved capability profile so an operator can confirm locally what
a given config would expose, but it does **not** attach: no coordinator is built, no operator review port is bound and
no bootstrap URL is issued. It then closes the engineering runtime before returning.

Nothing is emitted at all for the shipped default profile, so existing `doctor` and `serve-stdio` output is unchanged
for an unconfigured gateway.

Teardown order on every exit path, including failures: stdio server, engineering runtime, private gateway runtime.
Each step is individually guarded so one failure cannot skip the others.

#### Where the operator bootstrap token goes

stdout is the MCP transport and must never carry it.

stderr is not safe either, and the first draft of this design was wrong about that. The argument was that stderr
belongs to the launcher, which already holds `DEVSPACE_OAUTH_OWNER_TOKEN`, so nothing new is exposed. But the owner
token travels *inward* through the environment, whereas stderr travels *outward*: for the supported deployment the
launcher is the remote-facing tunnel client, and an MCP client is permitted to log, buffer or forward a child's
stderr. Those are not the same exposure.

So the gateway announces only the operator **origin** on stderr and writes the single-use bootstrap URL to
`<statePath>.operator-url` with restrictive permissions, removing it on shutdown. That file carries the same exposure
as the state database beside it, and never leaves the machine. On Windows the mode bits are advisory, which is
stated rather than relied on.

The bootstrap URL, session cookie, CSRF token and `statePath` MUST NOT appear in any MCP response, tool result, error
message, or telemetry event, and the bootstrap token MUST NOT appear on stderr.

## Workflow coverage

How each measured benchmark scenario is satisfied on the extended stdio profile:

| Scenario | Path | Authority |
| --- | --- | --- |
| R0 bounded read | `workspace.open` -> `file.read` | read-only, path-policy bounded |
| R1 discovery | `workspace.open` -> `repo.search` / `repo.list` | read-only, bounded `git grep` and `git ls-files`, tracked and untracked-not-ignored only |
| R2 repository state | `workspace.open` -> `repo.snapshot` / `repo.diff` | read-only, bounded `git status/rev-parse/diff/ls-files` |
| V1 named verification | `verify.run` with a configured profile | named profile only; no argv/env from the client |
| C1 reviewed change | `mutation.preview` -> **local operator approval** -> `mutation.result` | write only after single-use local approval |
| D1 integrated loop | R1 -> file.read -> V1 -> C1 -> V1 -> R2 | composition of the above; no new authority |

D1 is explicitly a composition. This design adds nothing for D1 beyond making R1 and C1 reachable.

`repo.list` and `repo.diff` are not required by the measured benchmark scenarios; they were added under ADR-0021
because working the loop without them forced a shell for two ordinary steps — enumerating a directory and reading the
change that was just approved.

## What WAG still does not do

Recorded so the replacement claim stays honest against the documented DC surface:

```text
shell / arbitrary command execution      NOT PROVIDED
interactive process sessions / PTY       NOT PROVIDED
process listing / termination            NOT PROVIDED
file create                              REVIEWED, never overwriting (ADR-0022)
file move / delete                       NOT PROVIDED
directory create / list                  NOT PROVIDED
full-file rewrite                        NOT PROVIDED  (bounded before/after replacement only)
Git writes / commit / branch / push      NOT PROVIDED
runtime configuration mutation           NOT PROVIDED
ambient filesystem reach                 NOT PROVIDED  (allowedRoots is enforced, not advisory)
```

Replacement is workflow-scoped per ADR-0018. WAG replaces DC on the measured repository-engineering workflows while
remaining a strictly narrower surface with an enforced approval boundary.

## Security properties

Preserved without relaxation:

- `mutation.preview` performs no write; it persists an immutable record with base hash, result hash, fingerprint and a
  bounded review deadline;
- no backend call occurs before a local operator approves that exact record;
- approval is single-use and terminal; reject and expiry are terminal and produce no write;
- caller identity is validated on `result`; a foreign owner/session/adapter fails closed;
- a restarted gateway is a new session; it cannot read a prior session's record, and the review deadline is never
  refreshed by restart, reconnect, re-preview or repeated approval;
- the operator channel is loopback-only with one-time bootstrap, HttpOnly session cookie, CSRF, Origin checks, CSP,
  `X-Frame-Options`, `no-store`, `nosniff`, and HTML escaping of workspace/path labels;
- repository content is untrusted input; a note in the repository cannot approve a mutation, widen a root, select a
  verify profile, or reach the operator channel;
- `allowedRoots` is canonicalized at load and enforced per call; path policy rejects traversal, absolute escapes and
  non-regular targets;
- secrets — owner token, operator bootstrap/session/CSRF values, `statePath` — never appear in MCP output or telemetry.

Not claimed: containment against a fully compromised same-user account. ADR-0017 and ADR-0019 already state this and
this design does not upgrade it.

## Testing strategy

Test-first, one behavior per test, no production code without a failing test.

1. **Config** — default absence, `inspect` default false, absolute `statePath`, `ownerId` pattern, strict unknown-key
   rejection, existing config behavior unchanged.
2. **Gateway** — `repoSearch` clamps, delegates to the inspection backend with the right binding, emits telemetry,
   rejects unknown workspace ids.
3. **Surface** — default five tools in order; `inspect` only; `mutation` only; both; `validSearchQuery` rejection;
   absence of `verify.preview`, `job.*`, shell/process/Git/config tools in every combination.
4. **Runtime** — disabled mode opens no store and binds no port; enabled mode reconciles before serving; `close()` is
   idempotent and ordered; `attach` failure still releases the store.
5. **CLI** — profile reported by `doctor`; operator bootstrap URL on stderr and never on stdout; teardown ordering on
   success and on each failure path.
6. **Security** — foreign caller tuple denied on `result`; restart cannot approve or read a prior session's record;
   repository-injected instruction cannot escape the root or self-approve; operator credentials absent from every MCP
   response; reject and expiry produce no write.
7. **Restart** — the four windows of the accepted verify plan applied to stdio mutation: pending across restart,
   approved-then-restart, claimed-then-restart, backend exception.
8. **Production-local acceptance** — built `dist/cli.js serve-stdio` against the real pinned DevSpace and a fresh copy
   of the committed `docs/benchmarks/fixtures/dc-replacement-v1` template, executing R0, R1, R2, V1, C1 and D1 through
   the real MCP client with a real local operator approval over the real loopback HTTP server, then verifying exact
   repository residue.

## Non-goals

This design does not:

- change the Browser Adapter tool list, adapter id, protocol revision, or admission rules;
- grant Tier C or Tier D to any browser surface;
- add shell, process, PTY, Git write, file move/delete, directory, or configuration-mutation tools anywhere;
- add a dependency, listener, tunnel, service, elevation, or OS boundary;
- change `verify.run` semantics, verify profile hashing, or durable verify job core;
- change native-host build, installation, registry, distribution, release, tag or signing state;
- perform any provider or account action, or claim any Layer B WebChat result;
- claim containment against a compromised same-user account.

## Decision markers

```text
DC_REPLACEMENT_SURFACE = PRIVATE_STDIO
DEFAULT_STDIO_PROFILE = FIVE_TOOLS_UNCHANGED
EXTENDED_STDIO_PROFILE = LOCAL_CONFIG_OPT_IN
NEW_EXECUTION_PRIMITIVE = NONE
NEW_DEPENDENCY = NONE
MUTATION_LOCAL_APPROVAL = REQUIRED
RESTART_INHERITS_APPROVAL = FORBIDDEN
OPERATOR_CREDENTIALS_REMOTE = FORBIDDEN
BROWSER_SURFACE_CHANGE = NONE
PRODUCTION_LOCAL_ACCEPTANCE = REQUIRED
SUPPORTED_HOST_WEBCHAT_EVIDENCE = SEPARATE_LATER_GATE
DISTRIBUTION_SIGNING_PROVIDER_ACTIONS = OUT_OF_SCOPE
```
