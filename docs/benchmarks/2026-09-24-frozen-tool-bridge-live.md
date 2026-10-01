# Frozen WAG tool snapshot -> autonomous local-machine bridge (live)

Date: 2026-09-24
Status: PASS

## Purpose

Prove that ChatGPT does not need a connector-catalog refresh before WAG can replace Desktop
Commander for local-machine work.

The current ChatGPT-side WAG connector still exposes the older repository-oriented tool names.
The runtime therefore bridges those existing names to the trusted autonomous-local machine backend
when `workspace.open` returns a local-machine workspace.

No Goal Lease, operator approval, Desktop Commander call, or human shell relay participates.

## Source/runtime

```text
source behavior commit:
bd15eeb82002ed84cf117de4f3a4ca493fa94cea
feat: bridge frozen WAG tools to local machine

runtime:
E:/WAG-Runtime/bd15eeb82002/dist/cli.js

activation receipt:
E:/WAG-Acceptance/promotion-logs/activate-bd15eeb82002.json

activation state:
SUCCEEDED

previous runtime:
E:/WAG-Runtime/d817519feb61/dist/cli.js
```

## Pre-promotion verification

```text
typecheck = PASS
build     = PASS
diffcheck = PASS
surface   = 24/24 PASS
```

The surface regression specifically proves a frozen 16-tool client can route local-machine
`workspace.open`, `repo.list`, `repo.search`, `file.read`, and bounded `command.run`
without sending those calls to DevSpace.

## Live proof through the currently cached connector

Opened:

```text
C:/Users/PACMAP/AppData/Local/WAG-Local
workspace = ws_acc051dd-aea4-4e8b-9ea4-2917fad7ac31
authority.mode = AUTONOMOUS_LOCAL
authority.kill_switch = CLEAR
```

Live capability projection:

```text
REPOSITORY_READ = granted / WORKSPACE_OWNED
FILE_READ       = granted / WORKSPACE_OWNED
VERIFY          = granted / PROFILE_SCOPED
FILE_WRITE      = granted / AUTONOMOUS_LOCAL_PROFILE
GIT_COMMIT      = granted / AUTONOMOUS_LOCAL_PROFILE
LOCAL_COMMAND   = granted / AUTONOMOUS_LOCAL_PROFILE
GIT_PUSH        = denied / REMOTE_EFFECT_NOT_GRANTED
```

Existing cached `repo.search` successfully searched the local WAG-Local directory rather than a
Git/DevSpace workspace and returned matches from:

```text
logs/wag-b-runtime.json
WagLocalBServer.mjs
```

Existing cached `file.read` read:

```text
Start-WagLocalTunnel.ps1
sha256 = a73e9569895867067c7a57087c83b178e3642d7118b2a04d28698224036c1f2b
size   = 3696
```

Existing cached `command.run` executed this local argv directly through WAG:

```text
powershell.exe -NoLogo -NoProfile -Command "Write-Output WAG_FROZEN_BRIDGE_OK"

exitCode = 0
output   = WAG_FROZEN_BRIDGE_OK
cwd      = C:/Users/PACMAP/AppData/Local/WAG-Local
```

This command previously failed on the frozen compatibility path because it was incorrectly forced
through verification-profile argv validation. The bridge now preserves the cached tool's bounded
argv/time/output schema while dispatching the argv to `LocalMachineContext.commandRun`.

## Full current production surface

Fresh direct-MCP readiness projects 33 tools:

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

A future connector catalog refresh can expose the dedicated machine names directly, but it is no
longer a prerequisite for local automation: the already-cached tool names provide the compatibility
bridge now.
