# WAG DC Replacement v2 — Automation-First Local Machine Control

Date: 2026-09-25
Status: LIVE / CORE LOCAL AUTOMATION ACCEPTED

## Mission

WAG replaces Desktop Commander as the normal execution gateway for local-computer work.

A normal private-local task must not require the user to relay PowerShell, inspect process trees,
edit launchers, refresh the connector catalog, issue a per-task authority object, or restart
DevSpace.

If a local task cannot be completed through WAG, treat that as a WAG capability gap and prefer a
bounded WAG capability plus acceptance proof over a Desktop Commander fallback.

## Architecture

```text
ChatGPT
  |
  v
private stdio WAG
  |
  +-- stable caller/session identity
  +-- caller-owned workspaces
  +-- live workspace-identity revalidation
  +-- autonomous-local kill switch
  +-- durable mutation / exact Git commit receipts
  |
  +-- DevSpace repository backend
  |
  +-- local-machine backend
        filesystem
        bounded argv
        process lifecycle
        interactive terminal
        WAG runtime/launcher management
```

DevSpace is one backend, not WAG's filesystem boundary.

## Authority model

Private stdio / WAG Local is `AUTONOMOUS_LOCAL`.

There is no Goal Lease, per-goal issuance, successor, TTL grant, budget lease, rollover, or
per-change human approval on this plane.

`sessionCorrelation` is reconnect/audit identity only and may be minted by WAG.

Consequential local effects remain bounded by:

- the fixed private stdio adapter;
- caller-owned durable workspace handles;
- canonical-root and path validation;
- live filesystem/repository identity re-observation;
- exact base-content CAS for mutation;
- branch/HEAD/tree/identity CAS for commit;
- bounded argv/time/output/input;
- sanitized child environments and secret redaction;
- PID creation-identity checks for process termination;
- the autonomous-local emergency stop immediately before effects.

`git.push` and remote Git effects are unavailable/non-grantable.

Browser Goal UI Delegation is separate browser Run authority. Browser-originated filesystem/Git
effects remain on the operator-review plane.

## Current production local surface

The accepted deployed surface contains 37 tools. Local-machine capabilities include:

### Filesystem

- `machine.open` / `machine.describe`
- recursive bounded `machine.list`
- paged `machine.read`
- `machine.read_many`
- bounded recursive `machine.search`
- `machine.info`
- `machine.mkdir`
- `machine.move`
- exact / explicit-recursive `machine.delete`
- durable `file.create`
- exact-hash `file.replace`
- secret-safe exact-block `file.edit_block`

### Commands and processes

- bounded argv `machine.command.run`
- detached `machine.process.start`
- `machine.process.list`
- `machine.process.inspect`
- PID-identity checked `machine.process.terminate`

### Interactive terminal

- `machine.terminal.open`
- `machine.terminal.list`
- bounded `machine.terminal.input`
- bounded/redacted `machine.terminal.output`
- `machine.terminal.close`

### Repository

- repo list/search/snapshot/diff
- bounded verify and command execution
- durable mutation receipts
- exact-path Git commit and result receipts

## Frozen connector compatibility

A ChatGPT conversation may retain an older 16-tool tool catalog.

The runtime bridges the existing names to local-machine workspaces for ordinary local
open/list/search/read/create/replace/command work, so catalog refresh is not a prerequisite for
automation.

The richer dedicated machine schemas become visible after connector refresh, but stale discovery
must not force a human-shell fallback.

## Secret-bearing edit rule

A redacted full-file read must not be written back as a replacement.

Use `file.edit_block` when editing a secret-bearing file without needing its unrelated contents.
WAG reads the raw bytes internally, requires the target block to be unique, derives the exact base
SHA itself, and executes through the normal durable mutation path.

## Current accepted evidence

- autonomous A/B/C sessions run without per-goal grants;
- WAG can inspect and repair its own machine-local launcher/runtime state;
- frozen connector read/write/command bridge is live;
- filesystem/process/terminal DC-parity dogfood is live;
- paged large reads, multi-read and recursive list are live;
- secret-safe edit-block and terminal inventory are live on runtime
  `E:/WAG-Runtime/805165068f9f`.

## Remaining parity backlog

These are improvements, not current human-relay blockers:

- explicit append primitive for log/text workflows;
- durable/recoverable process and terminal sessions across WAG restart;
- asynchronous/search-continuation handles for very large trees;
- WAG-native recent-tool-call / usage diagnostics;
- richer binary/document/media operations where they materially improve over bounded local argv.

Any new capability must preserve caller/workspace ownership, output bounds, secret handling,
kill-switch revalidation and durable effect evidence.
