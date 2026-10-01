# WAG live 35-tool large-read parity

Date: 2026-09-24
Status: PASS

## Behavior source/runtime

```text
source behavior commit:
827b2583fee066a4dd55918c2a29d0bde3bd7b37
feat: add paged local reads and recursive listing

runtime:
E:/WAG-Runtime/827b2583fee0

activation:
E:/WAG-Acceptance/promotion-logs/activate-827b2583fee0.json
state = SUCCEEDED
previousCli = E:/WAG-Runtime/9f17e555dfa9/dist/cli.js
```

DevSpace was not restarted.

## Surface

The full deployed production MCP assembly exposes 35 tools. The increment over the accepted
34-tool surface is:

```text
machine.read_many
```

Existing machine tools were extended without widening authority:

```text
machine.read
  offset?: integer
  length?: 1..1000 lines

machine.list
  depth?: 1..8
```

Private-local authority remains:

```text
authority.mode = AUTONOMOUS_LOCAL
kill_switch    = CLEAR
Goal Lease     = not used
```

## Large-read bounds

Unpaged `machine.read` retains the historical 64 KiB response bound.

When the caller supplies `offset` or `length`:

- the source file is still bounded to 16 MiB;
- at most 1000 logical lines are selected;
- returned content remains bounded to 64 KiB;
- the response reports `offset`, `length`, `total_lines`, `has_more` and `truncated`;
- `raw_sha256` is the hash of the complete raw file, not merely the returned page;
- secret-shaped values remain redacted.

`machine.read_many` accepts at most 20 paths and isolates per-file failures so one missing file
does not discard successful reads from the same batch.

Recursive `machine.list` is bounded to depth 8 and 1000 entries and does not recurse through
symbolic-link entries.

## Source verification

```text
focused large-read/DC-parity/direct-MCP batch = 31/31 PASS
typecheck                                      = PASS
build                                          = PASS
diffcheck                                      = PASS
git diff --check on exact behavior paths       = PASS
direct-MCP readiness                           = READY
projected full surface                         = 35 tools
```

## Live deployed proof

The deployed runtime itself was loaded from `E:/WAG-Runtime/827b2583fee0`, bootstrapped through
the normal private runtime, attached to DevSpace, and exposed through the production MCP server.

Observed:

```text
stableSessionId = session_d9e39801-87fd-40f5-92b7-999a48609f1d
toolCount       = 35
machine.read_many present = true
mutation context = true
commit context   = true
command context  = true
machine context  = true
```

A temporary 1200-line file larger than 64 KiB was created under `E:/WAG-Acceptance`.

Plain read was refused with the pagination guidance. Paged read returned:

```text
offset      = 100
length      = 3
total_lines = 1201
has_more    = true
raw_sha256  = 2722a7adcb2d90e3c5be24628f0db4623f1317e7ce3c652f0637e0dea2d0fbb2
first line  = line-0100 ...
```

`machine.read_many` returned exact normalized content for two existing files while preserving the
third file's bounded `Gateway denied missing path` error in the same result.

Recursive listing at depth 3 observed:

```text
machine-large-read-live/tree/deep/b.txt
depth = 2
```

The temporary acceptance tree was recursively deleted at the end of the proof.

## Frozen connector

This ChatGPT conversation still exposes the cached 16-tool catalog. That is a client-side catalog
cache only. The active WAG runtime is the 35-tool runtime above, and existing frozen
`workspace.open` / `repo.search` / `command.run` / file mutation bridges continue to prevent a
human-shell fallback while the client catalog remains stale.
