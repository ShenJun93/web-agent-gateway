# WAG live restart-persistent tool diagnostics

Date: 2026-09-25
Status: PASS

## Runtime

```text
source commit:
fcf262403bc477380ac2e45f49ca901006522dd7
feat: persist tool usage diagnostics

runtime:
E:/WAG-Runtime/fcf262403bc4

activation:
E:/WAG-Acceptance/promotion-logs/activate-fcf262403bc4.json

state:
SUCCEEDED

previous runtime:
E:/WAG-Runtime/5b6ab4aab5ef/dist/cli.js
```

DevSpace was not restarted.

## Behavior

The existing diagnostics surface remains:

```text
diagnostics.recent
diagnostics.usage
```

The change is durability, not a new tool name.

For a stable private-stdio session, WAG now persists the bounded 512-event diagnostics ring beside
the durable mutation state:

```text
<statePath>.tool-usage.<stableSessionId>.json
```

The file contains only the already-sanitized diagnostics fields:

- sequence;
- tool name;
- UTC start time;
- duration;
- success/failure;
- error class only.

It never stores arguments, file/workspace paths, command text, output, owner/session ids inside
individual events, credential values, or exception messages.

A malformed diagnostics file is fail-open for gateway availability: WAG starts with an empty ring
and atomically replaces the malformed file on the next ordinary tool event.

## Source verification

```text
tool-usage + repository runtime batch       18/18 PASS
direct-MCP + DC surface batch               24/24 PASS
local-machine runtime + MCP batch            6/6 PASS
typecheck                                    PASS
build                                        PASS
diffcheck                                    PASS
```

Fresh direct-MCP readiness after the change:

```text
projected tools = 43
DIRECT_MCP_LOCAL_READINESS = READY
```

No Goal Lease or per-change human approval participates in this private-local path.

## Live deployed proof

The deployed runtime modules from:

```text
E:/WAG-Runtime/fcf262403bc4
```

were reconstructed three times over the same stable session and state file.

First runtime recorded:

```text
1  health          success=true
2  workspace.open  success=false  error_class=TypeError
```

The thrown TypeError deliberately contained secret-shaped text. The persisted diagnostics file did
not contain that text.

After runtime reconstruction, both events were present with the same sequence values.

A third event was then recorded:

```text
3  repo.snapshot   success=true
```

After another reconstruction, observed history was exactly:

```text
sequence = 1,2,3
total_calls = 3
successes   = 2
failures    = 1
secretPersisted = false
```

The temporary live fixture was removed after verification.

## Result

The diagnostics backlog item "persist diagnostics across runtime restart" is closed.

WAG can now retain bounded operational tool history across private-local runtime reconstruction
without storing command/file payloads or weakening the autonomous-local authority model.
