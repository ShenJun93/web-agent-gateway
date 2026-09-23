# Multi-Session Goal Lease — live workspace identity and command effect-boundary revalidation

Date: 2026-09-24

## Authority for this receipt

Repository/source/runtime evidence is authoritative for this slice. Chat history is not.

Fresh baseline at measurement:

```text
workspace = E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1
branch    = feat/goal-ui-delegation-v1
HEAD      = f1c8cc54cb47b23253992993ba9e583f9864ce60
dirty     = true
```

This is a **source-only hardening slice**. It is not committed or promoted. The live WAG runtime
remains the previously promoted `f1c8cc54...` runtime.

This receipt extends, rather than rewrites, the earlier source receipt:

```text
docs/benchmarks/2026-09-24-goal-lease-stable-workspace-identity.md
```

## Gap found after the earlier stable-identity source gate

The earlier source candidate persisted a stable workspace fingerprint at `workspace.open` and
propagated that fingerprint through Goal Lease requests. A fresh runtime test exposed a remaining
TOCTOU gap:

1. `workspace.open` observed filesystem/repository object A and persisted fingerprint A.
2. an identity-bound Goal Lease admitted A;
3. the filesystem/repository object behind the same canonical root was replaced by object B;
4. the running direct runtime still used the cached durable fingerprint A for `command.run`;
5. authority therefore remained admissible until the workspace was reopened/rebound.

The failing proof was added first in:

```text
test/workspace-identity-runtime-revalidation.test.ts
```

Before the fix it failed with:

```text
Missing expected rejection:
replacing the filesystem object at the same canonical root must invalidate command authority
```

The implementation below was made only after that failure was reproduced.

## Decision implemented

A persisted workspace identity is an admission binding, not a permanent observation of the object
currently mounted behind a path.

For identity-bound production workspaces, WAG now re-observes the live DevSpace workspace identity
at consequential boundaries and compares it to the durable identity binding.

The live observation is over the same stable fields accepted by the earlier workspace-identity
slice:

```text
canonicalRoot
backendKind
filesystem device identity
filesystem inode/file-id identity
git top-level, when present
absolute git dir, when present
absolute git common dir, when present
```

Branch and HEAD remain outside this fingerprint. Git branch/HEAD are still separate Goal Lease
commit CAS bindings.

### Direct stdio command path

`src/repository-engineering-runtime.ts` now has a fresh workspace-identity observer used by
`command.run` authority evaluation. It reopens the canonical root through DevSpace, observes the
current filesystem/Git identity and records/compares it through `WorkspaceIdentityRegistry`.

If the object behind the root changed, `WorkspaceIdentityRegistry.record()` refuses identity
drift instead of silently replacing the durable identity.

For migration safety, a durable workspace record created before `workspace_identity_v1` and
having no identity row remains root-bound. New production `workspace.open` calls bind the
workspace identity before returning the workspace handle, so new handles take the live-observation
path.

### Mutation and commit effect paths

The Goal Lease resolver wiring now exposes two distinct workspace identity sources:

```text
workspaceFingerprint
    cached durable identity for request/admission evaluation

liveWorkspaceFingerprint
    fresh DevSpace observation for the last effect-boundary revalidation
```

`DurableMutationCoordinator` awaits `liveWorkspaceFingerprint` immediately before the
filesystem write authority check.

`DurableCommitCoordinator` awaits `liveWorkspaceFingerprint` immediately before the backend is
allowed to perform the commit/ref-moving operation.

An identity change after admission therefore invalidates the effect instead of inheriting the old
workspace authority.

### Browser operator runtime

The browser operator assembly wires the same fresh DevSpace identity observer into the mutation and
commit effect paths. Stable workspace identity is therefore not a direct-stdio-only protection.

### command.run process-spawn boundary

A second TOCTOU window existed after command authority preflight:

```text
MCP command.run
  -> commandContext.authorize()
  -> cwd/path/profile validation
  -> executor.execCommand()
```

Authority could change between the first authorization and process spawn.

`src/server.ts` now supports an internal `beforeExecute` callback on `gateway.commandRun`.
The MCP handler still performs the early command authority preflight, then supplies a second
`commandContext.authorize(workspace_id)` callback. `gateway.commandRun` invokes it after
cwd/path/argv validation and immediately before `executor.execCommand`.

The callback is runtime-only. It is not part of the MCP input schema, so a client cannot inject,
disable or replace it.

The resulting boundary is:

```text
MCP command.run
  -> authority preflight
  -> bounded cwd/path/argv validation
  -> authority revalidation
  -> executor.execCommand
```

## Current measured source bytes

```text
src/repository-engineering-runtime.ts
030c5223c84ac6b749ab80328617cca0e274e6693b655cc181c2489c544d82ec

src/browser-operator-runtime.ts
c7e2f05c451535221209df3b930a52ea7cd6ed907a86293b1980de4c6542af7a

src/durable-mutation.ts
8f78ad83cb5fc6020c0e86b0078c618fa578fefda0693d0181d72d00d325611c

src/git-commit.ts
15a50d62b35620602e4a36558891c431cca37388ed4b3895101d7d02f813feed

src/server.ts
90d88d24fff3b32723ac084fd0130af6682c14778d6bf106b7941d522f12fdb5

test/workspace-identity-runtime-revalidation.test.ts
163027d657676d1e8acbb3522a4c69ca3e88f50f177e9080159d6724971b94d2

test/workspace-identity-effect-revalidation.test.ts
bb17d8179e1bf9322aa12cbc51670cb58a30c7fe436cacfa6bf4aaa7da026c69

test/command-effect-revalidation.test.ts
325ddc39a2593a61db8388b600046587863261500f4bf35fde39feb8a64746c0
```

## Fresh measured gates

### Compile

```text
npm.cmd run typecheck
=> PASS

npm.cmd run build
=> PASS
```

### Goal Lease / identity / direct runtime focused gate

```text
npx.cmd tsx --test --test-concurrency=1 \
  test/command-effect-revalidation.test.ts \
  test/workspace-identity-runtime-revalidation.test.ts \
  test/workspace-identity-effect-revalidation.test.ts \
  test/workspace-identity.test.ts \
  test/goal-lease-effect-revalidation.test.ts \
  test/goal-lease-policy.test.ts \
  test/goal-lease-resolver.test.ts \
  test/repository-engineering-runtime.test.ts

=> 41 pass, 0 fail
```

This gate includes direct command workspace drift, mutation/commit workspace drift, process-spawn
authority revalidation, revoke/ambiguity effect-boundary checks, resolver semantics and hot
issue/revoke/ambiguity behavior.

### Browser / atomic budget / admitted workspace gate

```text
npx.cmd tsx --test --test-concurrency=1 \
  test/browser-operator-runtime.test.ts \
  test/goal-lease-atomic-budget.test.ts \
  test/admitted-workspace.test.ts

=> 12 pass, 0 fail
```

### MCP surface gate

```text
npx.cmd tsx --test --test-concurrency=1 \
  test/dc-replacement-surface.test.ts \
  test/mcp-surface.test.ts

=> 15 pass, 0 fail
```

This confirms the internal `beforeExecute` boundary did not add a client-supplied authority field
or change the accepted public/direct tool schema.

### Direct MCP readiness/session gate

```text
npx.cmd tsx --test --test-concurrency=1 \
  test/direct-mcp-session-binding.test.ts \
  test/direct-mcp-readiness.test.ts

=> 48 pass, 0 fail
```

This includes exact direct-tool discovery, identity-injection refusal, stable session separation,
legacy `goalLeaseId` non-authority semantics, two distinct connector lanes, commit CAS/path/kill
constraints and exact-workspace command authority.

Do not sum these batches as a unique test total; some policy coverage overlaps. Do not infer that
the entire repository suite passed.

## New regression proofs

`test/workspace-identity-runtime-revalidation.test.ts` proves that a direct runtime which has
already opened a workspace rejects command authority when the live filesystem identity changes
behind the same canonical root.

`test/workspace-identity-effect-revalidation.test.ts` proves both:

- mutation: identity A admits, identity B is observed at the final boundary, no filesystem write occurs;
- commit: identity A admits, identity B is observed at the final boundary, the commit backend is not called.

`test/command-effect-revalidation.test.ts` drives the MCP command path and proves:

```text
first authority check  = PASS
second authority check = DENY
executor.execCommand   = 0 calls
```

The process therefore cannot spawn after authority is revoked at the final boundary.

## Mutation backend observation

Whole-file updates on several existing text files can still report the already-known
`OUTCOME_UNKNOWN / DivergentTarget` trailing-newline edge. For those operations, the file was
re-read and its actual SHA/content verified before any later work. No blind retry, broad reset,
clean, restore or shell-write bypass was used.

`src/server.ts` exceeded the bounded whole-file replacement input. Its three small changes were
therefore applied as exact-fragment durable mutations, each with the current base SHA and each
finishing `SUCCEEDED`.

## Status

```text
multi-active durable resolver                   = SOURCE GREEN
stable workspace identity model                 = SOURCE GREEN
fresh live identity at command authorization    = SOURCE GREEN
fresh live identity before filesystem write     = SOURCE GREEN
fresh live identity before Git ref effect       = SOURCE GREEN
browser effect-path live identity               = SOURCE GREEN
command authority recheck before process spawn  = SOURCE GREEN
atomic budget guard                             = SOURCE GREEN
typecheck/build                                 = PASS

commit                                           = NOT DONE
promotion                                        = NOT DONE
live identity-bound successor lease              = NOT DONE
live A/B/C multi-session acceptance              = NOT DONE
```

The source HEAD is still `f1c8cc54cb47b23253992993ba9e583f9864ce60`. The existing human-issued
lease has a stale Git commit HEAD binding for an earlier source HEAD, so this source-only slice must
not bypass that CAS.

The next authority-changing step remains a human-reviewed successor Goal Lease. That successor
should bind the exact measured workspace identity fingerprint(s) for the intended workspace(s).
Human-only issuance, revocation, successor review and `sessionCorrelation` boundaries remain
unchanged.

Do not promote or claim this hardening live until the successor authority exists and the deployed
runtime has passed the live multi-session acceptance matrix.
