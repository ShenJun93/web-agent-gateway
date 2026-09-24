# Current handoff — WAG Autonomous Local / DC Replacement

Date: 2026-09-24
Status: LIVE / AUTOMATION-FIRST

## Canonical truth rule

Do not reconstruct state from chat history.

Fresh-check, in this order:

1. Git branch/HEAD and the exact worktree snapshot.
2. Current source/tests.
3. Live runtime activation receipt.
4. Live WAG capability projection.
5. Durable mutation/commit/process receipts.

If this file conflicts with fresh runtime/source evidence, fresh evidence wins and this file should be updated.

## Source and runtime

```text
workspace:
E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1

branch:
feat/goal-ui-delegation-v1

HEAD:
e8e846f9ea8c6d8873922a22d06b6393d4fb7d8a

latest commit:
e8e846f fix: prevent redacted local file round-trip corruption

runtime:
E:/WAG-Runtime/e8e846f9ea8c/dist/cli.js

activation receipt:
E:/WAG-Acceptance/promotion-logs/activate-e8e846f9ea8c.json

activation state:
ALREADY_ACTIVE
```

DevSpace was not restarted for this promotion.

The worktree is intentionally private-index-like. Many paths may appear as staged deletion plus
untracked replacement even when the worktree bytes are the intended current bytes. Never use broad
`git reset`, `git clean`, `checkout -- .` or `restore .` to make status look clean.

Use exact paths for every commit and inspect the resulting commit receipt.

## Authority model

Private stdio / WAG Local is the trusted autonomous-local plane.

```text
authority.mode        = AUTONOMOUS_LOCAL
authority.kill_switch = CLEAR

FILE_WRITE    = granted / AUTONOMOUS_LOCAL_PROFILE
GIT_COMMIT    = granted / AUTONOMOUS_LOCAL_PROFILE
LOCAL_COMMAND = granted / AUTONOMOUS_LOCAL_PROFILE
GIT_PUSH      = denied / non-grantable
```

Goal Lease is retired from live private-local execution.

There is no per-goal issue, successor, TTL, budget lease, rollover or human confirmation step for
normal private-local filesystem, command, process, terminal or exact-path commit work.

`sessionCorrelation` is reconnect/audit identity only. It grants no execution authority and WAG may
mint one for a new autonomous lane.

The emergency stop is:

```text
npm run autonomy:stop
npm run autonomy:stop -- --status
npm run autonomy:stop -- --clear
```

It is re-read at consequential effect boundaries.

## Browser boundary remains separate

Browser content is untrusted.

Browser filesystem/Git effects remain proposal-only and require local operator review.

Goal UI Delegation is browser Run/dispatch authority only. It never grants private-local filesystem,
Git, process or terminal authority.

Do not automate passwords, passkeys, MFA, auth consent, payments, signing, identity verification,
operator Approve/Reject, browser Run, or Goal UI Delegation issuance/renewal.

## Current private-MCP surface

Fresh readiness projects 33 tools:

```text
health
workspace.open
machine.open
machine.describe
machine.list
machine.read
machine.search
machine.info
machine.mkdir
machine.move
machine.delete
machine.command.run
machine.process.start
machine.process.list
machine.process.inspect
machine.process.terminate
machine.terminal.open
machine.terminal.output
machine.terminal.input
machine.terminal.close
repo.list
repo.search
repo.snapshot
repo.diff
file.read
verify.run
command.run
mutation.preview
file.replace
file.create
mutation.result
git.commit
git.commit.result
```

ChatGPT can retain an older 16-tool connector snapshot. This is not an execution blocker.

The compatibility bridge lets the existing names operate on local-machine workspaces:

- `workspace.open` falls back to a local-machine workspace when DevSpace cannot admit the root;
- `repo.list` dispatches to local directory listing;
- `repo.search` dispatches to bounded recursive local search;
- `file.read` dispatches to local UTF-8 read with secret redaction;
- `file.create` / `file.replace` use the local-machine durable mutation backend;
- `command.run` dispatches to bounded local argv execution.

Therefore manual connector Refresh is not required for ordinary inspect/read/write/command work.

## DC-replacement local-machine capabilities

Current source/live behavior supports:

### Filesystem

- open/describe caller-owned local-machine workspace;
- list;
- bounded recursive search;
- metadata/info;
- UTF-8 read with secret redaction;
- create/replace through durable mutation records;
- mkdir;
- move/rename;
- exact delete and explicit recursive directory delete.

### Commands and processes

- bounded argv execution;
- sanitized child environment;
- no caller-supplied environment;
- secret-redacted bounded output;
- detached owned process start;
- process list/inspect;
- PID-identity checked termination.

### Interactive terminal

- WAG-owned PowerShell/cmd/bash sessions;
- bounded base64 input;
- bounded output buffer;
- secret-redacted output;
- caller/workspace ownership;
- explicit close/termination;
- emergency-stop checks before effects.

### Git

- exact-path commit only;
- private index / Git plumbing;
- repository identity, branch, HEAD and tree CAS;
- safe Git environment and hooks/filter execution hardening;
- `git.push` remains unavailable/non-grantable.

## Frozen connector bridge live proof

The currently visible ChatGPT WAG connector can autonomously open:

```text
C:/Users/PACMAP/AppData/Local/WAG-Local
```

and perform local list/read/write/command through the already-cached tool names.

Latest live redaction-roundtrip acceptance on runtime `e8e846f9ea8c`:

```text
created:
logs/redacted-roundtrip-live-probe.txt
mutation = mut_ee4dbbc1-1f6e-4cfe-9b28-844be08c8644
state    = SUCCEEDED

file.read returned:
API_KEY=<REDACTED>

attempted redacted full-content file.replace:
mutation = mut_1cd4cdb3-f9f0-4e61-b46c-5ecbd34f7b38
state    = FAILED

cleanup:
CLEAN=True
```

This proves a redacted read cannot be accidentally round-tripped back into a secret-bearing local
file.

## Independent sessions

Lane B:

```text
workspace:
E:/WAG-Acceptance/multi-lane-b-d8fd901d

branch:
wag/acceptance-lane-b-d8fd901d

HEAD:
6a87dbe20cdbcdc04568b11cb7c1744fb66c5142

stable session:
session_e2dad5f3-4961-4134-b5f9-3a35b58d3248

persistent B runtime:
PID 35932
E:/WAG-Runtime/e8e846f9ea8c
state = READY
```

Lane C:

```text
workspace:
E:/WAG-Acceptance/multi-lane-c-d8fd901d

branch:
wag/acceptance-lane-c-d8fd901d

HEAD:
c38f39def9611e0ed681c8df4916730fa6f35f7d
```

A/B/C private-local execution no longer depends on any per-goal grant.

## Verification at current source

Fresh current checks:

```text
typecheck = PASS
build     = PASS
diffcheck = PASS
surface   = 24/24 PASS

local-machine runtime/DC-parity/MCP/file backend = 12/12 PASS
autonomous + browser authority separation        = 55/55 PASS
durable mutation/store                           = 12/12 PASS
harness + workspace identity                     = 26/26 PASS
```

Do not claim a whole-repository pass unless it is explicitly run and completes.

## Current automation rule

Desktop Commander is not part of the normal workflow.

If WAG cannot perform a local-machine task that DC would normally perform, treat that as a WAG
capability gap. Prefer adding a bounded WAG capability plus acceptance test over asking the user to
relay shell commands or re-enabling DC.

A normal private-local task should not require the user to:

- copy/paste PowerShell;
- inspect process trees manually;
- edit WAG launchers manually;
- refresh connector tools before ordinary local work;
- issue per-task authority;
- restart DevSpace.

Human interaction remains only at genuine human-presence/security boundaries, especially browser
authority, authentication/consent, payment/signing and provider/account enrollment.

## Do not mutate unrelated projects

Do not modify UAF or PFP while working this WAG project unless the user explicitly switches project
scope.

Do not restart DevSpace unless fresh evidence shows it is required.
