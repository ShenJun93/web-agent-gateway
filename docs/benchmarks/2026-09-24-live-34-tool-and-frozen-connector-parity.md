# WAG live 34-tool + frozen-connector parity

Date: 2026-09-24
Status: PASS

## Runtime

```text
source behavior HEAD = 9f17e555dfa909e567a3c13a2ac7d64abd172c30
runtime              = E:/WAG-Runtime/9f17e555dfa9
activation            = ALREADY_ACTIVE
authority.mode        = AUTONOMOUS_LOCAL
Goal Lease required   = false
```

## Full deployed MCP surface

A production MCP assembly created from the deployed runtime listed 34 tools:

```text
health
workspace.open
capabilities.describe
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

The readiness instrument initially reported 33 because it omitted
`capabilities.describe`. Production was correct; the instrument was fixed and now reports 34.
The direct-MCP readiness contract then passed 9/9.

## Live 34-tool dogfood

The deployed runtime, not a source-only fake, completed:

- `machine.open` on `E:/WAG-Acceptance`;
- `machine.mkdir`;
- bounded local argv execution;
- `machine.read`;
- `machine.info`;
- recursive `machine.search`;
- `machine.move`;
- durable `file.create` on a machine workspace;
- durable `mutation.result`;
- process start/list/inspect/terminate;
- interactive PowerShell terminal open/input/output/close;
- recursive cleanup with `machine.delete`.

Durable machine mutation:

```text
mutation = mut_1a22dbe6-a9dc-4a91-86ad-142e30e89345
state    = SUCCEEDED
sha256   = 4e9a0ad1de8218065b78158a84da518812098a44f4bef25631a23b80dc422048
```

The temporary acceptance directory was removed after the proof.

## Frozen ChatGPT connector compatibility

The current ChatGPT conversation still exposes the older 16-tool cached connector schema.
That no longer blocks local automation.

Using only those existing tool names, the live connector opened:

```text
C:/Users/PACMAP/AppData/Local/WAG-Local
```

and returned:

```text
authority.mode = AUTONOMOUS_LOCAL
kill_switch    = CLEAR
```

Through the frozen bridge it then:

1. read `Start-WagLocalTunnel.ps1` with credential-shaped values redacted;
2. listed the WAG-Local directory;
3. ran a local PowerShell process inspection;
4. created `logs/frozen-connector-autonomy-live.txt`;
5. read back the exact SHA-256;
6. deleted the file again and verified the path was absent.

Frozen-connector durable mutation:

```text
mutation = mut_c2cd05fb-9773-43a8-a91e-6d4495fc54d1
state    = SUCCEEDED
sha256   = b9c929dc93b73061930d1db1194220190630212249ae0a7487e215f518090517
```

This proves a client-side tool-catalog refresh is not required for ordinary local filesystem and
command automation. The richer machine.* schemas remain available when the client refreshes, but
the old connector is no longer a human-relay blocker.

## Verification

```text
local-machine parity batch = 13/13 PASS
direct/autonomous batch     = 46/46 PASS
surface                     = 24/24 PASS
bootstrap                   = 14/14 PASS
direct readiness after fix  = 9/9 PASS
typecheck                    = PASS
build                        = PASS
diffcheck                    = PASS
```
