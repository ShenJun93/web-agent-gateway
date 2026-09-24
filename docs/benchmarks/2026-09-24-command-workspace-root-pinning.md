# WAG command.run canonical-workspace root pinning receipt

Date: 2026-09-24
Branch: feat/full-harness-browserport-v1
Parent: ce53368ac3523f6e2f2b755f9f6a80d09b9ae9bc
Status: SOURCE-GREEN / NOT RUNTIME-PROMOTED

## Bug

A multi-worktree acceptance attempt opened a successor worktree correctly: workspace.open and
repo.snapshot observed the successor root and branch. The same opaque workspace id passed to
command.run nevertheless executed with process.cwd() from another WAG worktree.

The DevSpace workspace binding was correct. The defect was in the argv runner:

- createGateway.commandRun validated a workspace-relative cwd, default '.';
- resolveVerifyProfile encoded only that relative cwd;
- the WAG-owned helper passed input.cwd directly to child_process.spawn;
- therefore '.' was resolved relative to the DevSpace process cwd instead of the caller-owned
  canonical workspace root.

This allowed a correct workspace handle to execute a command in the wrong worktree.

## Fix

The existing argv runner now accepts an optional trusted executionRoot in its encoded payload.

- executionRoot is internal WAG data, not a caller-supplied MCP field;
- when present, it must be absolute;
- child cwd becomes join(executionRoot, relativeCwd);
- command.run supplies workspace.canonicalRoot;
- the canonical root remains gzip/base64url payload data and never appears as shell syntax.

Verify profiles that do not supply executionRoot retain their previous payload shape and exact
planSha256 algorithm. Durable verify jobs therefore do not drift merely because command.run gained
workspace-root pinning.

## Measured gates

Focused command/verify/DC regressions:

```text
24 tests
24 pass
0 fail
```

This includes a real runner test launched from a different process cwd. The child probe still ran in
the exact executionRoot.

Strict TypeScript check:

```text
src/verify-runner.ts
src/verify-profile.ts
src/server.ts
PASS
```

Exact-path:

```text
git diff --check -- src/verify-runner.ts src/verify-profile.ts src/server.ts test/command-workspace-root.test.ts
PASS
```

## Parallel-lane boundary

These pre-existing dirty Browser Harness paths belong to another concurrent session and are not part
of this transaction:

- src/browser-harness/browser-port.ts
- src/browser-harness/cdp-browser-backend.ts
- src/browser-harness/cdp-protocol.ts
- src/browser-harness/node-cdp-transport.ts
- test/browser-harness-semantic.test.ts

Whole-repository build is intentionally not used as this transaction's verdict while those paths are
mid-edit.

## Runtime boundary

No live WAG runtime or connector was promoted by this transaction. The currently running runtime
therefore continues to exhibit its pre-fix command cwd behavior until this commit is integrated and
promoted through the normal WAG cutover path.
