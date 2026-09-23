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
