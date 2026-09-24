# WAG DC Replacement v2 — Automation-First Local Machine Control

Date: 2026-09-24
Status: IMPLEMENTATION IN PROGRESS
Supersedes the scope limitation in: `2026-09-19-wag-dc-replacement-v1-design.md`

## Mission

WAG must replace Desktop Commander for local-computer work rather than only repository engineering.

The human authorizes a bounded goal. WAG then performs every machine-local step inside that authority
without asking the human to relay PowerShell, inspect processes, copy files, or restart local WAG
components manually.

```text
HUMAN = authority decision
WAG   = execution, observation, recovery, receipts

human relay of shell commands = failure of the automation target
```

DevSpace remains one privileged execution backend. It is no longer the boundary of the gateway.

## Architecture

```text
ChatGPT
  |
  v
private stdio WAG
  |
  +-- Goal Lease resolver / kill switch / durable authority
  |
  +-- DevSpace backend
  |     repository inspection / verify / repo commands / git
  |
  +-- local-machine backend
        filesystem inspection
        exact-file mutation
        bounded argv execution
        detached process start
        WAG runtime/launcher management
```

The two backends share the same stable caller identity, Goal Lease resolution, path scope, durable
workspace records, stable workspace identity and pre-effect revalidation.

## Authority model

Local-machine capability is not derived from `allowedRoots`.

`allowedRoots` continues to bound the historical DevSpace `workspace.open` surface.
Machine-local roots are admitted by a human-issued Goal Lease and opened through `machine.open`.

A lease must name:

- exact canonical machine root;
- exact session and adapter;
- exact machine tools;
- path patterns for read/write operations;
- budget and lifetime.

No machine capability may issue, renew, widen or revoke its own Goal Lease.

The running gateway checkout remains protected by `SELF_MODIFICATION_REFUSED`. WAG upgrades are
built beside the running checkout and activated through external runtime/launcher state, never by
rewriting the approver in place.

## Phase A production surface

The first production slice exposes:

```text
machine.open
machine.describe
machine.list
machine.read
machine.command.run
machine.process.start
```

Existing durable mutation tools operate on a machine workspace through the new
`local-machine` file backend:

```text
mutation.preview
file.replace
file.create
mutation.result
```

`machine.command.run` is intentionally powerful and therefore separately leased. It accepts argv,
not a shell string, does not accept caller-supplied environment variables, uses a sanitized child
environment, applies time/output bounds, revalidates authority immediately before spawn, and
redacts obvious credential-shaped output before returning it.

A caller may explicitly run `pwsh.exe -Command ...` as argv when the human grant includes
`machine.command.run`. WAG does not pretend such a process is confined to the root: the root is
the authority context and cwd boundary, not an operating-system sandbox.

`machine.process.start` is a separately grantable detached-process capability with the same
sanitized environment and immediate pre-spawn authority revalidation.

## Follow-on parity

Phase A removes the blocker that forced human PowerShell relay and is the bootstrap needed to let WAG
dogfood the remainder. Follow-on work should add purpose-built surfaces for:

- process list / inspect / terminate;
- interactive process sessions with bounded input/output;
- mkdir / move / delete with durable receipts;
- bounded recursive search and metadata;
- native process-tree ownership and recovery;
- machine-operation durable receipts independent of command output.

Generic local argv remains available only when explicitly granted, so purpose-built tools can reduce
authority without reducing automation.

## Mandatory dogfood gate

This milestone is not accepted until WAG itself, without Desktop Commander and without human shell
relay, can:

1. open `C:/Users/PACMAP/AppData/Local/WAG-Local`;
2. read the installed WAG launcher;
3. inspect the current A runtime/process wiring;
4. create or modify the bounded B launcher/profile;
5. start the B runtime;
6. verify the B process argv references `wag-live-b.config.json`;
7. verify the B durable stable session is
   `session_e2dad5f3-4961-4134-b5f9-3a35b58d3248`;
8. complete the live A/B multi-session Goal Lease acceptance.

Any step that asks the user to copy/paste PowerShell means the gate is not complete.
