# Autonomous Local — Goal Lease Removed — Live Acceptance

Date: 2026-09-24
Status: PASS

## Source/runtime

- source HEAD before this receipt: `3964bdfa791bf0f360693815cbbca32afb533c92`
- runtime: `E:/WAG-Runtime/3964bdfa791b`
- runtime capability: `autonomous-local-runtime-v1`
- activation receipt: `E:/WAG-Acceptance/promotion-logs/activate-3964bdfa791b.json`
- activation state: `SUCCEEDED`
- previous runtime: `E:/WAG-Runtime/16c13ab9a30f/dist/cli.js`

## Live authority projection

```text
authority.mode        = AUTONOMOUS_LOCAL
authority.kill_switch = CLEAR

FILE_WRITE    = granted / AUTONOMOUS_LOCAL_PROFILE / requires_human=false
GIT_COMMIT    = granted / AUTONOMOUS_LOCAL_PROFILE / requires_human=false
LOCAL_COMMAND = granted / AUTONOMOUS_LOCAL_PROFILE / requires_human=false

GIT_PUSH      = denied / grantable=false / REMOTE_EFFECT_NOT_GRANTED
```

There is no Goal Lease object, selector, issuer, resolver, rollover, TTL or lease budget in the
private-local execution path.

## Live command proof

A direct `command.run` on the source workspace executed:

```text
git.exe diff --check
exitCode = 0
```

No browser/operator approval and no per-goal grant was requested.

## Promotion proof

`scripts/promote-autonomous-runtime.ts --promote-current`:

1. creates a detached clean checkout of the exact committed HEAD;
2. runs typecheck and build there;
3. prepares a versioned runtime;
4. schedules detached activation;
5. atomically switches the WSL wrapper;
6. restarts only the WAG tunnel;
7. waits for readiness;
8. writes a durable activation receipt;
9. rolls back automatically if activation fails.

The first prepare attempt correctly failed before activation because four autonomous-local test
fixes were only present in the dirty development worktree. Those files were committed, then the
same clean-checkout promotion passed. This proves promotion does not silently deploy uncommitted
working-tree state.

## Boundary retained

Goal UI Delegation remains a separate browser-Run authority mechanism. It does not grant
private-local filesystem/Git authority.

The autonomous-local emergency stop remains available as `npm run autonomy:stop`.
