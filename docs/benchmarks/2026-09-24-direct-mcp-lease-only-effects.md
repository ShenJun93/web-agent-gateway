# Direct MCP lease-only effects — source acceptance

Date: 2026-09-24

## Baseline

```text
workspace = E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1
branch    = feat/goal-ui-delegation-v1
HEAD      = f1c8cc54cb47b23253992993ba9e583f9864ce60
live      = E:/WAG-Runtime/f1c8cc54cb47/dist/cli.js
```

Repository/runtime evidence is authoritative for this slice. Chat history is not.

The live runtime above still uses the earlier direct-stdio behavior until this source candidate is
committed and promoted.

## Decision

Direct stdio / WAG Local consequential effects are Goal-Lease-only.

For `mutation.preview`, `file.replace`, `file.create` and `git.commit`:

- one uniquely matching Goal Lease -> execute immediately and return the terminal result;
- no matching lease, ambiguous lease, expired/revoked authority, budget/path/session/workspace
  mismatch, or failed branch/HEAD CAS -> deny;
- there is no direct-stdio fallback to `PENDING_APPROVAL` and no per-change browser approval step.

The browser operator runtime remains a separate proposal/review surface. Its operator server and
browser-specific review semantics were not removed.

`GIT_PUSH` remains denied and non-grantable.

## Implementation

`src/server.ts` adds an internal `leaseOnly` mode to the direct mutation/commit contexts.
The direct handler persists the immutable plan, immediately calls the existing policy admission,
and returns the coordinator's terminal result. A policy refusal terminalizes the just-created
record via the existing reject transition before returning an MCP error, so no direct request is
left pending for the operator.

`src/repository-engineering-runtime.ts` marks the private-stdio mutation and commit contexts
`leaseOnly: true`. Capability preflight now reports no matching lease as denied with
`GOAL_LEASE_REQUIRED` and `requires_human=false` rather than advertising a human-review
fallback.

The existing browser assembly does not set `leaseOnly`, so its review contract is unchanged.

## Goal Lease issuer ceiling defect

The human issuance CLI previously combined:

```text
notBefore = createdAt - 1000
expiresAt = createdAt + ttlMs
```

Thus `--ttl-minutes 720` created a validity interval of twelve hours plus one second, while the
runtime correctly caps a lease at exactly twelve hours. Such a row was shown as time-active by the
old diagnostic but could never admit a request.

The issuer now uses:

```text
notBefore = createdAt - 1000
expiresAt = notBefore + ttlMs
```

so the documented 720-minute ceiling is actually valid.

## Source hardening composed in this candidate

This candidate also carries the source-only hardening receipts already present on this worktree:

- request-time multi-active resolver;
- pre-effect mutation and commit authority revalidation;
- atomic SQLite Goal Lease budget reservation;
- stable workspace identity;
- live workspace identity re-observation before command/write/ref effects;
- command authority revalidation immediately before process spawn.

The intended commit must include the complete changed `src/`, `test/` and `scripts/` dependency
set rather than only the newest files; otherwise a clean checkout would omit modules imported by
the current source.

## Measured gates on the current working-tree bytes

```text
npm run typecheck
PASS

npm run build
PASS

surface profile
53 pass, 0 fail

bootstrap profile
14 pass, 0 fail

authority/runtime targeted gate
29 pass, 0 fail

Goal Lease / identity / effect batch
37 pass, 0 fail

direct/session/security/runtime batch
102 pass, 0 fail

durable mutation / file create / operator / identity helper batch
28 pass, 0 fail

durable runtime + durable acceptance batch
3 pass, 0 fail

file.read batch
4 pass, 0 fail

dc-replacement.integration
2 pass, 0 fail

git diff --check
PASS
```

`test/dc-replacement.acceptance.ts` was updated from the old operator-approval contract to the
lease-only contract. Under the bounded `command.run` harness it no longer fails at the old
approval assertion, but the full production-local test exceeds the tool's 30-second execution
ceiling, so this receipt does not claim a PASS for that one test.

Do not infer that the entire repository suite passed.

## Authority used for this source slice

A human-issued bridge lease is active for the source workspace and exact private-stdio session.
It grants bounded `mutation.preview`, `git.commit`, and `command.run` authority with path,
budget, branch and HEAD constraints. The source mutations in this slice reached terminal
`SUCCEEDED` through Goal Lease policy; no browser approval was clicked.

Human-only Goal Lease issuance remains unchanged. The legacy configured `goalLeaseId` is not a
runtime selector.

## Next gate

1. exact-path Git commit of the complete self-contained source/test/script candidate;
2. build a runtime from the committed HEAD, not from dirty working-tree bytes;
3. activate by restarting the WAG tunnel/runtime only; do not restart DevSpace;
4. fresh capability and live direct-effect acceptance;
5. verify a direct write returns a terminal result without an operator review item.

Until those steps succeed, the lease-only direct effect behavior is SOURCE GREEN, NOT YET LIVE.
