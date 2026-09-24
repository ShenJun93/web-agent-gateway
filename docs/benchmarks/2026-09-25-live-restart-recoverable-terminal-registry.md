# Live restart-recoverable interactive terminal registry

Date: 2026-09-25
Status: PASS

## Source/runtime

```text
source commit:
4e36ad1b41868d9b31f2d63f27e1e9064cf11877
feat: persist interactive terminal sessions

runtime:
E:/WAG-Runtime/4e36ad1b4186

activation:
E:/WAG-Acceptance/promotion-logs/activate-4e36ad1b4186.json

state:
SUCCEEDED

previous runtime:
E:/WAG-Runtime/14d3fd11a409/dist/cli.js
```

No DevSpace restart was required.

## Design

Interactive terminals can now outlive the WAG process that opened them.

A per-stable-session terminal registry is stored beside the private-local durable state. Each terminal
is owned by a detached loopback-only broker process. WAG reconnects to that broker after runtime
reconstruction using a random 256-bit token stored in a private registry file.

The returned/public terminal metadata contains:

```text
terminal_id
shell pid
broker pid
cwd
shell
started_at
state / exit_code
persistent = true
```

The broker token is never returned through MCP results and terminal output is passed through WAG
secret redaction.

Terminal close now waits for both the shell and broker processes to disappear before deleting the
registry directory. This avoids leaving a workspace cwd locked after a recovered terminal is closed.

## Source verification

```text
local-machine DC parity      = 7/7 PASS
local-machine + runtime      = 12/12 PASS (focused combined batch before final close fix: 11/12,
                              then persistent recovery re-run 7/7)
machine MCP + readiness      = 10/10 PASS
DC replacement regression   = 23/23 PASS
repository/session runtime   = 20/20 PASS
typecheck                    = PASS
build                        = PASS
diffcheck                    = PASS
```

## Live restart simulation

Acceptance used two separate Node processes against deployed runtime
`E:/WAG-Runtime/4e36ad1b4186` and the same stable private-local session.

Process A opened the terminal:

```text
stableSessionId = session_d9e39801-87fd-40f5-92b7-999a48609f1d
workspaceId     = ws_fd93109d-4977-48eb-9c99-9a09722230ad
terminalId      = term_46ebcf8d-2427-4ac5-a648-c9d7d4e12823
shellPid        = 37964
brokerPid       = 33832
persistent      = true
beforeMarker    = observed
tokenPersisted  = private
tokenLeaked     = false
```

That process then closed its repository-engineering runtime and exited while the interactive shell
and broker stayed alive.

A completely separate recovery process reopened the same canonical root under the same stable
session:

```text
reopenedWorkspaceId = ws_f4f0c960-106d-46c4-98ae-924fce4af189
terminalId          = term_46ebcf8d-2427-4ac5-a648-c9d7d4e12823
recovered           = true
afterMarker         = observed
closed              = true
state               = TERMINATED
```

This proves interactive terminal input/output ownership no longer depends on one in-memory WAG
process or one opaque workspace id.

## Current direct-MCP projection

The production assembly projects 38 tools and reports:

```text
DIRECT_MCP_LOCAL_READINESS = READY
authority = trusted private-local profile + caller-owned workspace identity
            + immediate kill-switch revalidation
per-goal authority = none
```

The ChatGPT-side connector schema may remain cached at an older tool inventory, but the deployed
runtime carries the persistent terminal implementation and the frozen connector can still reach
local work through the existing bridge.

## Remaining parity backlog

Restart-recoverable process and terminal state is closed.

The next parity items are:

1. continuation handles for very large recursive searches;
2. WAG-native recent tool-call / usage diagnostics;
3. richer binary/document/media operations where they materially outperform bounded argv.
