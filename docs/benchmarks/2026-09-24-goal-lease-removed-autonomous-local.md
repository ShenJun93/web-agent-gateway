# Goal Lease removed from private-local WAG automation

Date: 2026-09-24
Status: LIVE

## Decision

Goal Lease is no longer an authority prerequisite for the private stdio / WAG Local execution plane.

The trusted private-local runtime now authorizes consequential local work from:

- fixed private stdio adapter identity;
- caller-owned durable workspace handles;
- live workspace identity re-observation;
- the emergency kill switch;
- existing path/CAS/process bounds in each tool.

There is no per-goal issuance, successor, rollover, TTL, budget lease, or human approval step on this
execution plane.

Historical Goal Lease rows and compatibility parsing may remain in the durable store/source for
older browser-oriented flows, but they are not consulted by private-local command, mutation, commit,
or machine execution.

## Source and runtime

```text
source HEAD:
7a6e266ac39249320a5d0327950d5b89a7e03879

runtime:
E:/WAG-Runtime/7a6e266ac392

activation:
E:/WAG-Acceptance/promotion-logs/activate-7a6e266ac392.json
state = SUCCEEDED
```

The migration commit is:

```text
7a6e266ac39249320a5d0327950d5b89a7e03879
refactor: remove Goal Lease from private local automation
```

## Live authority projection

The running connector reports:

```text
authority.mode        = AUTONOMOUS_LOCAL
authority.kill_switch = CLEAR

FILE_WRITE    = granted / AUTONOMOUS_LOCAL_PROFILE
GIT_COMMIT    = granted / AUTONOMOUS_LOCAL_PROFILE
LOCAL_COMMAND = granted / AUTONOMOUS_LOCAL_PROFILE
GIT_PUSH      = denied / non-grantable
```

No `lease` object participates in the live capability projection.

## Config cleanup

All three current private-local configs have no active Goal Lease selector:

```text
wag-live.config.json    goalLeaseId = absent
wag-live-b.config.json  goalLeaseId = absent
wag-live-c.config.json  goalLeaseId = absent
```

`sessionCorrelation` remains only for stable identity/audit continuity. It grants no execution
authority and may be minted by WAG automation.

## Autonomous lane C proof

WAG created the C config/session/worktree and executed the full positive path without issuing any
Goal Lease:

```text
session:
session_7faa1e4c-7472-4be6-8a41-baac11d16c66

workspace:
E:/WAG-Acceptance/multi-lane-c-d8fd901d

branch:
wag/acceptance-lane-c-d8fd901d

old HEAD:
d8fd901d3a16cfa587a4211aadece255be99d11a

file.create:
mut_eac505db-4b4c-4560-96f1-ca298f60bc60
SUCCEEDED

git diff --check:
exit 0

git.commit:
cmt_c0569af0-a662-432b-96dc-1833770096d8
SUCCEEDED

new HEAD:
c38f39def9611e0ed681c8df4916730fa6f35f7d
```

The production MCP assembly used for this proof exposed 22 tools, including the machine surface.

## Verification

Before promotion:

```text
typecheck = PASS
build     = PASS
diffcheck = PASS
bootstrap = 14/14 PASS
surface   = 54/54 PASS

focused autonomous/local batches:
52/52 PASS
15/15 PASS
11/11 PASS
16/16 PASS
26/26 PASS
```

The dedicated autonomous policy tests prove durable mutation and commit use
`POLICY_APPROVED` with no lease id and re-check the kill switch immediately before effects.

## Remaining human boundary

Private-local WAG execution has no Goal Lease boundary.

Browser Goal UI Delegation remains a separate browser-facing authority mechanism. It is not required
for WAG Local/DC-replacement automation.
