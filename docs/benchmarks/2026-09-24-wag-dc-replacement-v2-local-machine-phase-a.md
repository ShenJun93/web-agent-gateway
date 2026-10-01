# WAG DC Replacement v2 — Local Machine Phase A Source Receipt

Date: 2026-09-24
Status: SOURCE GREEN; LIVE DOGFOOD PENDING PROMOTION/AUTHORITY

## Trigger

Live multi-session acceptance exposed that the only installed WAG launcher is machine-local:

```text
C:/Users/PACMAP/AppData/Local/WAG-Local/Start-WagLocalTunnel.ps1
```

The current WAG could not inspect that path because all useful execution was behind DevSpace roots.
Remote Desktop Commander was offline, leaving manual PowerShell relay as the only path.

That contradicts the automation target and the intended meaning of "DC replacement".

## Implemented source slice

New local-machine execution path:

```text
src/local-machine-runtime.ts
src/executor/local-machine-file-mutation.ts
```

Wired through:

```text
Goal Lease policy
repository-engineering runtime
private stdio MCP server
CLI stdio assembly
direct-MCP readiness projection
```

Production projected direct surface is now 21 tools:

```text
health
workspace.open
machine.open
machine.describe
machine.list
machine.read
machine.command.run
machine.process.start
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

The shipped default five-tool surface remains unchanged when repository engineering is not enabled.

## Bounds

- machine roots are exact Goal Lease roots, not model-selected global authority;
- stable session + adapter are exact lease bindings;
- machine workspace identity is realpath + filesystem device/inode;
- read paths use existing realpath/symlink confinement;
- writes reuse durable mutation records and pre-effect Goal Lease revalidation;
- local file backend uses exact UTF-8 reads, base-content CAS and post-write verification;
- local argv has argument count/size, timeout and output bounds;
- no caller-supplied environment;
- sanitized environment excludes runtime credentials;
- output uses bounded credential-shape redaction;
- process start revalidates immediately before spawn;
- kill switch remains above all leases;
- running WAG checkout remains self-modification protected.

## Source verification

```text
local-machine focused tests    5 pass / 0 fail
bootstrap regression           14 pass / 0 fail
surface + direct-MCP batch     54 pass / 0 fail
surface + runtime regression   20 pass / 0 fail
typecheck                       exit 0
build                           exit 0
diffcheck                       exit 0
```

Live readiness instrument against `wag-live.config.json` reports:

```text
projected tools = 21
DIRECT_MCP_LOCAL_READINESS = READY
```

## Not yet claimed

This receipt does not claim live machine control yet.

The running deployed runtime is still `9bc795a3a013` and cannot expose the new machine tools.
A new exact-path source commit, promotion, human-issued machine Goal Lease and live self-dogfood are
still required.

No Desktop Commander result counts as acceptance for the v2 dogfood gate.
