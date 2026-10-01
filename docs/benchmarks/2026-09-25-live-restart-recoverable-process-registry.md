# Live restart-recoverable local process registry

Date: 2026-09-25
Status: PASS

## Source/runtime

```text
source commit:
14d3fd11a4099b8105fb851dbbd36d3d3057bd38
feat: persist autonomous local process registry

runtime:
E:/WAG-Runtime/14d3fd11a409

activation:
E:/WAG-Acceptance/promotion-logs/activate-14d3fd11a409.json

state:
SUCCEEDED
```

No DevSpace restart was required.

## Design

WAG-started detached processes are now persisted in a per-stable-session registry beside the durable
private-local state database.

A registry record contains only:

```text
process_id
canonical workspace root
pid
executable
cwd
started_at
creation_date
state / exit_code
```

It deliberately does **not** persist full argv because argv may contain credentials or other
sensitive values.

Recovered records are not trusted solely by PID. A current workspace must reopen the same canonical
root, and termination still requires the live process creation identity to equal the persisted
creation identity. External-process observations remain short-lived/in-memory and therefore do not
silently become durable termination authority across restarts.

## Source verification

```text
local-machine + repository runtime = 16/16 PASS
local-machine focused              = 5/5 PASS
typecheck                          = PASS
build                              = PASS
diffcheck                          = PASS
```

The focused process-registry test also proves an argv secret marker is absent from the durable
registry file.

## Live restart simulation

Acceptance used two separate Node processes against the deployed runtime and the same stable WAG
session.

Process A:

```text
stableSessionId = session_d9e39801-87fd-40f5-92b7-999a48609f1d
workspaceId     = ws_42bba3e7-539e-48f4-ad3a-e7b2369bf2a0
processId       = proc_8cc04a3b-7002-4a61-928f-09314c6f8f15
pid             = 29636
registry        = persisted
```

Process A then closed its repository-engineering runtime and exited while the detached child stayed
alive.

A completely separate recovery process reopened the same canonical root under the same stable
session:

```text
reopenedWorkspaceId = ws_8651f4c4-7d44-42bb-bf8e-414ba643be6c
processId           = proc_8cc04a3b-7002-4a61-928f-09314c6f8f15
pid                 = 29636
recovered           = true
registrySecretFree  = true
terminated          = true
state               = TERMINATED
```

This proves the process record no longer depends on one in-memory WAG process or one opaque
workspace id.

## Remaining terminal gap

Detached process recovery is live.

Interactive terminals still keep their child pipes and output buffer in the WAG process that opened
them. A true terminal restart boundary therefore requires a persistent terminal broker (or equivalent
OS-backed reconnectable I/O owner), not merely serialising the current in-memory map. That remains
the next process/terminal parity task; it should not be claimed as solved by metadata persistence
alone.
