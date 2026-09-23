# Direct MCP lease-only effects — live acceptance

Date: 2026-09-24

## Deployed source

```text
branch       = feat/goal-ui-delegation-v1
source HEAD  = 9bc795a3a01383bc0c5253fe638e82a44210013c
commit       = feat: harden Goal Lease direct MCP effects
runtime      = E:/WAG-Runtime/9bc795a3a013/dist/cli.js
health       = ok
executor     = devspace
protocol     = 2026-07-28
```

Activation receipt:

```text
E:/WAG-Acceptance/promotion-logs/activate-9bc795a3a013.json
state       = SUCCEEDED
previousCli = E:/WAG-Runtime/f1c8cc54cb47/dist/cli.js
cli         = E:/WAG-Runtime/9bc795a3a013/dist/cli.js
launcherPid = 29764
```

DevSpace was not restarted.

## Live authority

Fresh `workspace.open` / `capabilities.describe` after activation resolved the human-issued
bridge lease `lease_mueozzh6_65e886b1` as ACTIVE.

```text
FILE_WRITE    granted=true  requires_human=false  GOAL_LEASE_GRANTED
GIT_COMMIT    granted=true  requires_human=false  GOAL_LEASE_GRANTED
LOCAL_COMMAND granted=true  requires_human=false  GRANTED
GIT_PUSH      granted=false grantable=false       REMOTE_EFFECT_NOT_GRANTED
```

The bridge lease commit binding still names predecessor HEAD
`f1c8cc54cb47b23253992993ba9e583f9864ce60`. That is intentional: it must not silently authorize
another commit after HEAD moved. A human-reviewed successor is required before the next source
commit.

## Live no-approval write proof

A reversible mutation was executed against
`docs/benchmarks/2026-09-24-direct-mcp-lease-only-effects.md`.

First call:

```text
mutation = mut_2fea6e36-4d3f-411c-bf50-22b8c54db0b4
state    = SUCCEEDED
base     = 10fd798d051f88937210bfbd8f25826f90ddab519363ccc252c9fd8bca7246cb
result   = bc27baec167d097bfa69c58b2c92fe1e2a3422391dd52132b5b567a213d0472a
```

The direct MCP tool call itself returned the terminal `SUCCEEDED` record. It did not return
`approval_required` and no browser/operator action was performed.

The reverse mutation:

```text
mutation = mut_b7f6595b-1582-402f-a56f-3fffec47a6be
state    = SUCCEEDED
base     = bc27baec167d097bfa69c58b2c92fe1e2a3422391dd52132b5b567a213d0472a
result   = 10fd798d051f88937210bfbd8f25826f90ddab519363ccc252c9fd8bca7246cb
```

Final raw SHA equals the original raw SHA exactly:

```text
10fd798d051f88937210bfbd8f25826f90ddab519363ccc252c9fd8bca7246cb
```

Therefore the live direct write path is proved to execute under Goal Lease authority without a
per-change operator review and the probe left the committed file byte-identical.

## Source gates measured before promotion

```text
typecheck                         PASS
build                             PASS
surface                           53/53 PASS
bootstrap                         14/14 PASS
issuer/runtime targeted           29/29 PASS
Goal Lease/identity/effect batch  37/37 PASS
direct/session/security batch     102/102 PASS
mutation/operator/helper batch    28/28 PASS
durable runtime/acceptance         3/3 PASS
file.read                          4/4 PASS
dc-replacement.integration         2/2 PASS
diffcheck                         PASS
```

The long `test/dc-replacement.acceptance.ts` contract was rewritten from per-change browser
approval to lease-only effects. It no longer fails at the old approval/tool-inventory assertions,
but the full production-local scenario exceeds the 30-second `command.run` ceiling in this
environment, so no PASS claim is made for that one long-running test.

## Approval architecture after this activation

Direct stdio / WAG Local:

```text
unique matching Goal Lease -> effect
no/ambiguous/out-of-scope lease -> deny
per-change browser approval -> NOT A FALLBACK
```

Browser operator runtime remains a separate browser proposal/review surface.

Human-only Goal Lease issuance remains unchanged. `git.push` remains denied/non-grantable.

## Next authority boundary

Before another source commit, issue a successor Goal Lease bound to the current branch/HEAD and,
when desired, the measured stable workspace identity. Do not rewrite the existing lease's immutable
bindings and do not bypass branch/HEAD CAS.
