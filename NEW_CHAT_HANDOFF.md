# Current handoff — WAG Multi-Session Goal Lease Resolution v1

Date: 2026-09-23

## Canonical rule

Do not reconstruct project state from chat history.

Fresh-check, in this order:

1. Git branch/HEAD and worktree snapshot.
2. `AGENTS.md`.
3. `README.md` plus the latest approved spec and relevant ADRs.
4. `docs/benchmarks/2026-09-23-multi-workspace-development-lanes.md`, especially the latest
   **Multi-Session Goal Lease Resolution v1** section.
5. Current source/tests and live WAG capability state.

For the current Goal Lease slice, the benchmark receipt above is the operational handoff. If it
conflicts with live Git/source/test evidence, live evidence wins and the receipt must be updated.

## Current source baseline

```text
workspace:
E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1

branch:
feat/goal-ui-delegation-v1

HEAD:
b05ec91dbc93cb772e8d1d2b73ea4ff4ff4426d5
```

The worktree is intentionally dirty/private-index-like. Never use broad reset/clean/restore to make
status look clean.

## Current target

Goal Lease is a multi-active durable authority plane, not a singleton runtime selector.

Required resolution invariant:

```text
0 eligible leases  -> deny
1 eligible lease   -> authorize exact lease
>1 eligible leases -> deny ambiguous
```

No heuristic precedence. Human-only issuance remains. `git.push` remains denied. Proposal/approval
is separate from lease authority.

`repositoryEngineering.mutation.goalLeaseId` is legacy parsing only for this successor path; it
must not activate or prioritize a lease.

## Current implementation candidate

Key files:

```text
src/goal-lease-resolver.ts
src/goal-lease.ts
src/durable-mutation.ts
src/git-commit.ts
src/repository-engineering-runtime.ts
src/browser-operator-runtime.ts
src/private-config.ts
src/cli.ts
scripts/prepare-direct-mcp-tunnel.ts
scripts/goal-lease-delegation-control.ts

test/goal-lease-resolver.test.ts
test/repository-engineering-runtime.test.ts
test/direct-mcp-readiness.test.ts
test/direct-mcp-session-binding.test.ts
```

Fresh gate on 2026-09-23:

```text
goal-lease resolver + repository runtime = 15 pass, 0 fail
direct MCP readiness + session binding   = 48 pass, 0 fail
typecheck                                = pass
build                                    = pass
```

Do not claim the entire repository test suite passed.

## Live runtime

The currently connected WAG is healthy and still uses the existing promoted runtime. The new
multi-active resolver source candidate has not been committed/promoted in this handoff.

Live authority currently reports Goal Lease ACTIVE with FILE_WRITE, GIT_COMMIT and LOCAL_COMMAND
granted for the current WAG development workspace, while GIT_PUSH is denied/non-grantable.

## Do not mutate

- UAF
- PFP
- DevSpace configuration merely for this deployment
- Goal Lease human-only issuance boundary
- provider/account/tunnel credentials

Do not restart DevSpace unless fresh evidence proves it is required.

## Next action

Establish the exact safe runtime deployment / tunnel reconnect procedure from local source and
historical receipts. Then deploy only the WAG runtime layer needed for live acceptance.

Live acceptance must prove at least:

- independent A/B session/workspace leases;
- cross-session and cross-workspace denial;
- zero-match denial;
- duplicate-match ambiguous denial;
- revoke A without affecting B;
- issue C and successor C2 usable without WAG restart;
- branch/HEAD commit CAS;
- path/argv/budget/kill constraints;
- `git.push` remains impossible.

After live multi-session acceptance, return to UAF Task4 runtime verification.
