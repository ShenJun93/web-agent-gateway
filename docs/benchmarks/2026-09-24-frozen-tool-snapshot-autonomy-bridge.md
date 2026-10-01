# Frozen tool snapshot autonomy bridge

Date: 2026-09-24
Status: SOURCE VERIFIED; LIVE PROMOTION PENDING

## Problem

The deployed WAG MCP assembly exposes 22 tools, including six `machine.*` tools, while the current
ChatGPT WAG Local surface in this conversation still exposes the older 16-tool catalog.

Waiting for a connector metadata refresh would reintroduce a manual operational dependency into the
Desktop Commander replacement path.

## Compatibility design

The current source keeps the 22-tool native surface and also makes the older tool names backend
aware:

- `workspace.open` tries the normal DevSpace workspace path first. When that path cannot admit the
  root and the autonomous machine context exists, it opens the root as a caller-owned
  `local-machine` workspace and returns the same existing `workspaceId` shape.
- `repo.list` detects caller-owned local-machine workspace ids and routes to the bounded machine
  directory listing.
- `file.read` detects those ids and routes to bounded UTF-8 machine read with secret redaction.
- `command.run` keeps the existing bounded argv schema and authority preflight, then routes
  local-machine workspace ids to the machine argv runner.
- DevSpace workspaces retain their existing behavior.

The routing decision never trusts a client-provided backend label. It asks the machine context to
describe the opaque workspace id; that path revalidates the caller authority tuple and live local
workspace identity.

## Goal Lease status

Goal Lease is not part of this path.

Private-local execution authority is:

```text
mode        = AUTONOMOUS_LOCAL
kill switch = immediate/revalidated
identity    = caller-owned durable workspace + live workspace observation
```

The private config schema no longer accepts `goalLeaseId`. The browser operator production
assembly no longer installs a Goal Lease budget guard, resolver, admission timer, or lease selector.
Browser filesystem and Git effects remain operator-reviewed. Goal UI Delegation remains Run-only.

## Verification

Fresh source verification after the bridge:

```text
typecheck                         PASS
build                             PASS
diffcheck                         PASS
bootstrap                         14/14 PASS
surface                           55/55 PASS
dc-replacement-surface focused    15/15 PASS
goal-lease-commit focused         11/11 PASS
browser-operator-runtime focused   4/4 PASS
direct-mcp-readiness focused      40/40 PASS
```

The dedicated compatibility test is:

```text
frozen 16-tool snapshots reach local-machine work through existing tool names
```

It proves `workspace.open -> repo.list -> file.read -> command.run` reaches a local-machine stub
through the old schemas and makes zero DevSpace exec calls.

## Live acceptance after promotion

After committing and promoting this source, acceptance is complete when the actual 16-tool ChatGPT
surface can:

1. `workspace.open` on `C:/Users/PACMAP/AppData/Local/WAG-Local`;
2. `repo.list` the returned workspace;
3. `file.read` a safe local text file;
4. `command.run` a benign bounded argv command;

without connector refresh, Desktop Commander, a Goal Lease, or a human shell relay.
