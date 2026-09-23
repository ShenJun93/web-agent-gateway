# Multi-workspace development lanes — source acceptance

Date: 2026-09-23

## Goal

Allow one human-issued direct-stdio Goal Lease to cover more than one exact local development
worktree without turning Git authority into an ambient branch grant.

This is the minimum composition needed for concurrent local project lanes behind one trusted WAG
caller:

- mutation authority remains exact-root + path-pattern bounded;
- `command.run` remains exact-root + lease bounded;
- each writable Git lane gets its own exact branch and starting-HEAD compare-and-swap;
- a workspace may be granted edit/test authority without being granted commit authority;
- the existing single-workspace `branch` + `headSha` lease shape remains valid.

## Why this is workspace isolation, not provider-session identity

The private stdio connector deliberately derives one trusted caller session from the locally written
`sessionCorrelation`. ChatGPT chat identity is not a tool argument and the tunnel does not provide
trusted per-chat identity to WAG.

Therefore this milestone does **not** claim that WAG can cryptographically distinguish Chat A from
Chat B when both use the same connector. That would require a different trusted identity source or
separate connector/runtime lanes.

What WAG can enforce with the current trusted inputs is stronger workspace isolation: the caller may
hold one lease naming several canonical workspace roots, while consequential Git history authority
is independently pinned per root.

## Binding extension

A commit-granting lease may now use either the existing single-workspace shape:

```text
commitSemantics = commit-to-bound-branch
branch           = feat/a
headSha          = <HEAD-A>
```

or a multi-workspace shape:

```text
commitSemantics = commit-to-bound-branch
commitBindings  = [
  { workspaceRoot = E:/worktrees/a, branch = feat/a, headSha = <HEAD-A> },
  { workspaceRoot = E:/worktrees/b, branch = feat/b, headSha = <HEAD-B> }
]
```

The two forms are mutually exclusive. Every `commitBindings.workspaceRoot` must already appear in
the lease's exact `workspaceRoots` allowlist, and a root may appear at most once.

A root present in `workspaceRoots` but absent from `commitBindings` may still receive mutation or
`command.run` authority if the rest of the lease grants it, but a commit from that root is denied
with `COMMIT_NOT_GRANTED`.

## Fail-closed properties pinned by tests

`test/goal-lease-multi-workspace.test.ts` proves:

1. workspace A is admitted only against A's branch and HEAD;
2. workspace B is admitted only against B's branch and HEAD;
3. branch or HEAD values cannot be borrowed across roots;
4. a third edit/test-only workspace cannot commit;
5. duplicate commit roots are malformed;
6. a commit root outside `workspaceRoots` is malformed;
7. legacy and multi-workspace commit bindings cannot be mixed;
8. `commitBindings` cannot exist under `commitSemantics: none`;
9. the real `DurableCommitCoordinator` executes two pending commits from two workspaces through one
   lease and records both as successful under their own CAS bindings.

The focused direct-MCP surface gate also imports the existing legacy Goal Lease policy and autonomous
commit suites, so the additive extension is checked against the old single-workspace behavior.

## Measured gate

After the extension:

```text
surface    47 tests, 47 pass, 0 fail
typecheck  pass
build      pass
diffcheck  pass
```

The repository-wide `npm test` profile still exceeds the current 30-second verification-runner
ceiling. That is recorded as a runner timeout, not as a test failure.

## Remaining production gate

This document is source acceptance, not a claim that the new code is already the live tunnel
runtime.

Production readiness still requires:

1. commit this slice;
2. build and promote that commit to the separate `E:/WAG-Runtime/... ` runtime;
3. issue one successor human Goal Lease whose `workspaceRoots` and `commitBindings` name two
   disposable development worktrees;
4. reconnect/fresh-discover the direct MCP surface so `command.run` is visible to the client;
5. run two independent workspace lanes concurrently through edit -> test/command -> commit;
6. prove that each lane changes only its own worktree/branch and that a cross-lane branch/HEAD
   attempt is denied.

PFP is not an acceptance write target and receives no autonomous write or command grant.

## Live production acceptance receipt

The production gate above was exercised through the live d8fd stdio runtime and ChatGPT custom
connector after a manual tool-metadata refresh exposed the newly registered `command.run` tool.

Measured live result:

```text
ChatGPT-discovered WAG tools   14
command.run                    present
Lane A start HEAD              d8fd901d3a16cfa587a4211aadece255be99d11a
Lane A committed HEAD          e222e27beab2fab7d90ec31daa7dafb41f47e5bc
Lane B start HEAD              d8fd901d3a16cfa587a4211aadece255be99d11a
Lane B committed HEAD          517aac66921baae2f37558c1e08d90f5fc19bc19
focused multi-workspace test   4 pass, 0 fail
```

Both lanes independently completed mutation -> `command.run` -> commit under the same human-issued
successor Goal Lease. Each commit proposal was bound to its own workspace root, branch and original
d8fd HEAD, and both durable commit records reached `SUCCEEDED` with different trees and commit
SHAs.

A second live commit proposal on lane A after its HEAD advanced remained `PENDING_APPROVAL` rather
than being auto-admitted by the lease. This is the expected stale-HEAD CAS refusal signal: the lease
remained bound to d8fd and did not authorize a second commit from the advanced lane.

The focused `test/goal-lease-multi-workspace.test.ts` run passed all four tests, including rejection
of cross-root branch/HEAD borrowing and malformed/ambiguous multi-workspace bindings.

After the stale-CAS probe was reverted, `git diff HEAD --name-only` was empty and
`git diff HEAD --check` exited zero in both acceptance worktrees. `repo.snapshot` may still report
`MM` for the committed benchmark file because WAG's commit backend uses a private index and does
not reset the operator's index; no index reset was performed to manufacture a clean status.

No DevSpace restart or second promotion was required for acceptance. PFP was not opened as an
acceptance workspace and received no mutation, command or commit authority.

