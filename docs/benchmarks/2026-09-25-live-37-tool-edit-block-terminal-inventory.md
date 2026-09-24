# WAG live 37-tool secret-safe edit + terminal inventory

Date: 2026-09-25
Status: PASS

## Runtime

```text
behavior source:
805165068f9fdd9c950a6da5cf97dce64bf2b73b
feat: add safe block edit and terminal inventory

runtime:
E:/WAG-Runtime/805165068f9f

activation:
E:/WAG-Acceptance/promotion-logs/activate-805165068f9f.json
state = SUCCEEDED
previousCli = E:/WAG-Runtime/827b2583fee0/dist/cli.js
```

DevSpace was not restarted.

## New production tools

The deployed production MCP assembly exposes 37 tools.

Added over the accepted 35-tool surface:

```text
file.edit_block
machine.terminal.list
```

Private-local authority remains:

```text
authority.mode = AUTONOMOUS_LOCAL
kill_switch    = CLEAR
Goal Lease     = not used
```

## file.edit_block

`file.edit_block` replaces one exact unique text block through the durable mutation coordinator.

The raw file is read only inside the trusted backend. The caller supplies only:

```text
workspace_id
path
old_string
new_string
```

WAG derives the current full-file SHA-256 internally, requires the old block to occur exactly once,
and then uses the normal durable mutation/CAS/effect-boundary path.

This removes the need to round-trip a whole file after `file.read` has redacted secrets.

Live proof:

1. created a temporary file containing a secret-shaped `API_KEY` plus `mode=old`;
2. `file.read` returned a redaction marker and did not expose the raw secret;
3. `file.edit_block` changed only `mode=old` to `mode=new`;
4. trusted raw verification proved the original secret bytes were preserved;
5. cleanup removed the temporary directory.

Durable mutation receipts:

```text
create = mut_3d5b0895-6698-407b-b462-9625803794a0
edit   = mut_78f45a71-2d91-4224-a168-ef1ff588a53c
```

## machine.terminal.list

A live interactive terminal was opened through WAG and immediately appeared in
`machine.terminal.list` under the same caller-owned workspace.

The acceptance then sent bounded input, observed `WAG_TERM_LIST_OK` in bounded output, closed the
terminal, and removed its scratch directory.

Observed:

```text
terminalListed       = true
terminalMarkerSeen   = true
cleanup              = true
```

## Verification

Before promotion:

```text
focused mutation/local-machine/direct-MCP batch = 43/43 PASS
surface                                            = 24/24 PASS
typecheck                                          = PASS
build                                              = PASS
diffcheck                                          = PASS
exact-path git diff --check                        = PASS
```

Behavior commit contains exactly eight implementation/test paths.

## Frozen connector

This ChatGPT conversation still exposes the older 16-tool cached catalog. That remains a client
catalog issue, not an automation blocker: the existing bridge still handles ordinary local
open/list/search/read/write/command work.

Dedicated `file.edit_block` and `machine.terminal.list` are available from the deployed production
MCP assembly now and will become directly callable when the connector catalog refreshes.
