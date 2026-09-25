# Current handoff — WAG Autonomous Local / DC Replacement

Date: 2026-09-25
Status: LIVE / AUTOMATION-FIRST

## Canonical truth rule

Do not reconstruct current state from chat history. Fresh-check:

1. source branch/HEAD and worktree snapshot;
2. current source/tests;
3. active runtime receipt;
4. live capability projection;
5. durable mutation/commit/process receipts.

Fresh evidence wins over this file.

## Canonical source

```text
workspace:
E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1

branch:
feat/goal-ui-delegation-v1

behavior commit:
603f1be08a4af9a9d93059364639abafea90339d
feat: expose runtime identity through health

current source/runtime HEAD:
603f1be08a4af9a9d93059364639abafea90339d
feat: expose runtime identity through health
```

Documentation-only commits may make Git HEAD newer than the behavior commit.

The worktree is intentionally private-index-like. Many paths can appear as staged deletion plus
untracked replacement while worktree bytes are intentional.

Never use broad:

```text
git reset
git clean
checkout -- .
restore .
```

Use exact paths for every commit and inspect its receipt.

## Live runtime

```text
runtime:
E:/WAG-Runtime/603f1be08a4a

activation:
E:/WAG-Acceptance/promotion-logs/activate-603f1be08a4a.json

state:
SUCCEEDED

previous:
E:/WAG-Runtime/91817b796d8c/dist/cli.js
```

DevSpace was not restarted.

## Authority

Private stdio / WAG Local:

```text
authority.mode        = AUTONOMOUS_LOCAL
authority.kill_switch = CLEAR

FILE_WRITE    = granted / AUTONOMOUS_LOCAL_PROFILE
GIT_COMMIT    = granted / AUTONOMOUS_LOCAL_PROFILE
LOCAL_COMMAND = granted / AUTONOMOUS_LOCAL_PROFILE
GIT_PUSH      = denied / non-grantable
```

Goal Lease is retired from private-local execution.

No per-goal issue/successor/TTL/budget/rollover/human confirmation is required for normal local
filesystem, command, process, terminal or exact-path commit work.

`sessionCorrelation` is reconnect/audit identity only and may be minted by WAG.

Emergency stop:

```text
npm run autonomy:stop
npm run autonomy:stop -- --status
npm run autonomy:stop -- --clear
```

Browser Goal UI Delegation remains a separate human browser-Run boundary. Browser-originated
filesystem/Git effects remain operator reviewed.

## Production MCP surface

Full deployed production assembly exposes 43 tools:

```text
health
workspace.open
capabilities.describe
machine.open
machine.describe
machine.list
machine.read
machine.read_many
machine.image.read
machine.pdf.extract
machine.search
machine.search_continue
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
machine.terminal.list
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
file.edit_block
file.append
file.create
mutation.result
git.commit
git.commit.result
diagnostics.recent
diagnostics.usage
```

The current ChatGPT conversation may still display the older 16-tool connector catalog. This is not
a normal automation blocker: existing tool names bridge local open/list/search/read/write/command
work to the local-machine backend.

## Latest live acceptance

Runtime `603f1be08a4a` is active from exact committed source HEAD
`603f1be08a4af9a9d93059364639abafea90339d`
(`feat: expose runtime identity through health`).

Activation receipt
`E:/WAG-Acceptance/promotion-logs/activate-603f1be08a4a.json` is `SUCCEEDED`; DevSpace was not
restarted.

The existing frozen `health` tool is now the primary runtime self-inspection bridge. Live result:

```text
toolCount       = 6
mcpToolCount    = 43
authorityMode   = AUTONOMOUS_LOCAL

runtime.cli_path     = E:\WAG-Runtime\603f1be08a4a\dist\cli.js
runtime.runtime_root = E:\WAG-Runtime\603f1be08a4a
runtime.source_head  = 603f1be08a4af9a9d93059364639abafea90339d
runtime.capability   = autonomous-local-runtime-v1
runtime.deployed     = true
```

The health response also returns the exact 43 live tool names and bounded restart-persistent
diagnostics summary. A stale provider-side connector catalog therefore no longer hides either the
real WAG surface or the active deployed runtime identity.

Receipts:

- `docs/benchmarks/2026-09-25-live-runtime-identity-health.md`
- `docs/benchmarks/2026-09-25-live-health-surface-self-inspection.md`
- `docs/benchmarks/2026-09-25-live-persistent-diagnostics.md`

## DC-replacement capabilities

Filesystem:
- bounded/recursive list and search;
- paged read and multi-read;
- metadata;
- durable create/replace;
- secret-safe exact block edit;
- mkdir/move/delete.

Processes:
- bounded argv;
- start/list/inspect/terminate;
- WAG-started detached process registry persists per stable session across runtime reconstruction;
- recovered process records re-bind by canonical workspace root and revalidate PID creation identity;
- registry persists executable/cwd/identity only, never full argv;
- external termination only after PID creation-identity observation.

Terminal:
- open/list/input/output/close;
- caller/workspace ownership;
- bounded input/output and redaction.

Git:
- exact-path commit only;
- repository/branch/HEAD/tree identity checks;
- no push.

## Automation rule

Desktop Commander is not the normal workflow.

If WAG cannot perform a local task that DC would normally perform, treat that as a WAG capability
gap. Add a bounded WAG capability and acceptance test instead of asking the user to relay shell
commands.

Normal private-local work should not require the user to copy PowerShell, inspect a process tree,
edit WAG launchers, refresh tools, issue per-task authority, or restart DevSpace.

## Remaining parity backlog

Next useful improvements:

1. add bounded audio/media metadata or preview only when a real workflow needs it;
2. add native office/document extraction only when it materially avoids external conversion fallback;
3. continue reducing frozen-connector dependence when provider-side catalog refresh lags runtime deployment;
4. add richer WAG-native operational/runtime self-inspection where it removes shell fallback.

## Project isolation

Do not modify UAF or PFP while working WAG unless the user explicitly switches project scope.

Do not restart DevSpace unless fresh evidence proves it necessary.
