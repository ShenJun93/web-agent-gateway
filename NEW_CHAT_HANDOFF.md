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
365100ef92c0b304bee2082b6799f002f7d72c0d
feat: add native tool usage diagnostics

current source/runtime HEAD:
365100ef92c0b304bee2082b6799f002f7d72c0d
feat: add native tool usage diagnostics
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
E:/WAG-Runtime/365100ef92c0

activation:
E:/WAG-Acceptance/promotion-logs/activate-365100ef92c0.json

state:
SUCCEEDED

previous:
E:/WAG-Runtime/350b9fd47d56/dist/cli.js
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

Full deployed production assembly exposes 42 tools:

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

Runtime `aa12f6e228ad` is active from exact committed source HEAD
`aa12f6e228ad2f46b5587ea4dab4247ca695f385`
(`feat: add native image read parity`).

Fresh direct-MCP readiness projects 42 tools and includes `machine.image.read`.
Activation receipt `E:/WAG-Acceptance/promotion-logs/activate-aa12f6e228ad.json` is
`SUCCEEDED`; DevSpace was not restarted.

Native image support is bounded to 4 MiB and validates PNG/JPEG/WEBP/GIF signatures. The tool returns
image bytes as a native MCP image content item while structured metadata contains only path, MIME,
size and SHA-256.

The live proof deliberately used the **frozen existing `file.read` tool name**, not the newly
published name. It opened `C:/Users/PACMAP/AppData/Local/WAG-Local`, created a temporary 1x1 PNG,
and `file.read` returned:

```text
mime_type          = image/png
size_bytes         = 68
sha256             = 749de74b69c1255b49e30dc2033b90521227e9f5575842cbec4b0b0d865ac83a
content[0].type    = image
structured base64  = absent
```

The temporary image was deleted after the proof. This closes local image inspection without waiting
for provider-side connector-catalog refresh.

Receipt:
`docs/benchmarks/2026-09-25-live-42-tool-native-image-read.md`.

The preceding 41-tool runtime `365100ef92c0` remains the accepted diagnostics baseline for
`diagnostics.recent` and `diagnostics.usage`; those capabilities carry forward in the 42-tool
runtime.

Before image promotion:

```text
local image/DC + machine MCP = 9/9 PASS
direct/frozen/MCP surface    = 27/27 PASS
surface                      = 24/24 PASS
bootstrap                    = 14/14 PASS
typecheck                    = PASS
build                        = PASS
diffcheck                    = PASS
```

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

1. add bounded document/PDF extraction when it materially avoids external shell/tool fallback;
2. persist diagnostics across runtime restart if operational history beyond one process becomes useful;
3. add audio/media metadata or preview only when a real workflow needs it;
4. continue reducing frozen-connector dependence when provider-side catalog refresh lags runtime deployment.

## Project isolation

Do not modify UAF or PFP while working WAG unless the user explicitly switches project scope.

Do not restart DevSpace unless fresh evidence proves it necessary.
