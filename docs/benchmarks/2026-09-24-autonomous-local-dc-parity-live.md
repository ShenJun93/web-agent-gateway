# Autonomous-local WAG DC parity — live acceptance

Date: 2026-09-24
Status: PASS

## Result

WAG Local now performs the local-machine work that previously forced a Desktop Commander or
human-shell fallback.

The live execution plane is `AUTONOMOUS_LOCAL`. It does not require Goal Lease issuance,
successors, per-change operator review, or a human command relay.

## Behavior source/runtime

```text
behavior commit:
bd15eeb82002ed84cf117de4f3a4ca493fa94cea
feat: bridge frozen WAG tools to local machine

runtime:
E:/WAG-Runtime/bd15eeb82002/dist/cli.js

activation receipt:
E:/WAG-Acceptance/promotion-logs/activate-bd15eeb82002.json

activation state:
SUCCEEDED
```

The source later received documentation/readiness-only commit
`0a728a51960bd067910d74f9aa918d7897de42c1`; no runtime behavior changed after `bd15eeb`.

## Verification

Before activation:

```text
typecheck = PASS
build     = PASS
diffcheck = PASS
surface   = 24/24 PASS
bootstrap = 14/14 PASS

local-machine runtime/MCP/DC-parity focused batch = 9/9 PASS
autonomous/session focused batch                  = 22/22 PASS
browser-authority separation batch                = 75/75 PASS
```

Fresh direct-MCP readiness projects 33 tools, including filesystem metadata/search/mkdir/move/delete,
bounded command execution, detached process lifecycle, and interactive terminal lifecycle.

## Frozen connector compatibility

The currently cached ChatGPT connector did not need a catalog refresh.

Using only already-visible tool names, WAG opened:

```text
C:/Users/PACMAP/AppData/Local/WAG-Local
workspace = ws_acc051dd-aea4-4e8b-9ea4-2917fad7ac31
authority.mode = AUTONOMOUS_LOCAL
authority.kill_switch = CLEAR
```

The cached `repo.search` searched the local machine root and the cached `command.run` executed:

```text
powershell.exe -NoLogo -NoProfile -Command "Write-Output WAG_FROZEN_BRIDGE_OK"

exitCode = 0
output   = WAG_FROZEN_BRIDGE_OK
cwd      = C:/Users/PACMAP/AppData/Local/WAG-Local
```

Therefore a stale 16-tool client is no longer an automation blocker.

## Independent session B upgraded

The independent B runtime was moved from the older autonomous build to the same current behavior
runtime without changing B's stable identity:

```text
runtime PID      = 37152
runtime root     = E:/WAG-Runtime/bd15eeb82002
config           = E:/AI-BROWSER/wag-acceptance/wag-live-b.config.json
stable session   = session_e2dad5f3-4961-4134-b5f9-3a35b58d3248
state            = READY
```

No Goal Lease was created, renewed, selected, or consumed.

## Live local-machine DC-parity dogfood

WAG exercised the deployed runtime itself against:

```text
root      = E:/AI-BROWSER/wag-acceptance
workspace = ws_12a4b21b-3049-4f3d-b200-a70641863832
authority = AUTONOMOUS_LOCAL / CLEAR
```

### Filesystem

WAG performed all of the following through `LocalMachineContext`:

- mkdir `machine-live-dc-parity`
- bounded argv command to create a 13-byte probe
- info/stat of the probe
- UTF-8 read with SHA-256
- recursive literal search for `needle`
- move/rename to `probe-renamed.txt`
- stat after move
- exact file delete
- recursive scratch-directory delete

Readback SHA-256:

```text
bc18e33b5a7cd48da6c8f390f9e2b898486812a2353ab5646a1b05c8613773b4
```

Search visited one file and returned the expected line `alpha needle`.

### Process lifecycle

WAG started a detached owned process:

```text
process_id = proc_6e0280b1-a04c-4b53-95f2-57950b23e771
pid        = 30224
name       = node.exe
state      = RUNNING
owned      = true
```

It then:

- inspected the exact owned process record;
- listed owned processes;
- revalidated identity;
- terminated PID 30224 through the WAG-owned process handle.

Terminal state after termination: `TERMINATED`.

### Interactive terminal lifecycle

WAG opened an interactive `cmd` terminal:

```text
terminal_id = term_377ec865-7bf3-4764-a034-6964428dbcde
pid         = 24148
cwd         = E:/AI-BROWSER/wag-acceptance/machine-live-dc-parity
```

It wrote bounded base64-decoded input containing:

```text
echo WAG_TERMINAL_OK
```

The bounded output drain returned `WAG_TERMINAL_OK`, then WAG closed the terminal and verified
`TERMINATED`.

### Cleanup

Both the probe file and scratch directory were deleted by WAG at the end of the acceptance run.
No acceptance scratch state was intentionally left behind.

## Remaining boundaries

The private-local execution plane is autonomous.

The following remain intentionally separate:

- `git.push` / remote effects are not grantable by WAG Local;
- browser-originated effects remain on the browser operator-review plane;
- Goal UI Delegation is browser Run authority only and is not projected onto local-machine work;
- the global autonomous stop remains available for emergency halt.

These boundaries do not require Desktop Commander and do not reintroduce per-task Goal Lease
issuance.

## Native file-write proof through the frozen connector

The same cached connector also used its existing `file.create` and `file.replace` names directly
against the local-machine WAG-Local workspace.

```text
workspace:
C:/Users/PACMAP/AppData/Local/WAG-Local

created:
logs/frozen-file-create-probe.txt
mutation = mut_83680c71-692c-4b8c-9f71-28957b57d118
state    = SUCCEEDED
sha256   = c89ffd5ec00234604d7595c2aafe95dfe3fbfcd239b7a6bd3affc41d0cb6b933

replaced:
mutation = mut_dbd79ef1-d038-4a0f-a2fc-9bf084efdfdb
state    = SUCCEEDED
sha256   = ac837d4b4e07d8d2451b9187f39ba2c8b588eba031d5dc7c888163a1c53d691
readback = WAG_LOCAL_FILE_REPLACE_V2
```

The probe was then deleted through WAG `command.run`; the cleanup returned
`WAG_PROBE_CLEANED`.

This closes the practical stale-catalog gap for local inspect/search/read/write/command work:
ChatGPT can use the currently visible 16-tool catalog while the dedicated 33-tool machine catalog
remains cached out of the client UI.
