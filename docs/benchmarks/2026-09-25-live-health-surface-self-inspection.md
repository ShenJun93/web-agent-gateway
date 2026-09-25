# WAG live health surface self-inspection

Date: 2026-09-25
Status: PASS

## Runtime

```text
source commit:
91817b796d8cc4544ed08b94950bb90da9ac1a26
feat: expose live MCP surface through health

runtime:
E:/WAG-Runtime/91817b796d8c

activation:
E:/WAG-Acceptance/promotion-logs/activate-91817b796d8c.json

state:
SUCCEEDED

previous runtime:
E:/WAG-Runtime/fcf262403bc4/dist/cli.js
```

DevSpace was not restarted.

## Problem closed

A ChatGPT conversation can retain an older connector catalog even after WAG publishes more tools.
Before this change, the frozen `health` tool only returned the underlying DevSpace executor count:

```text
toolCount = 6
```

That number was correct for DevSpace but misleading when the production private-stdio MCP assembly
actually exposed dozens of WAG tools.

## Behavior

The existing `health` tool now returns both layers:

- `toolCount`: underlying DevSpace contract count;
- `mcpToolCount`: full live private-stdio MCP surface count;
- `mcpTools`: exact live published tool names in registration order;
- `authorityMode`: `AUTONOMOUS_LOCAL` when the local-machine plane is present;
- a bounded diagnostics summary when diagnostics are enabled.

No new tool name is required, so a frozen connector can inspect the current runtime immediately.

The diagnostics summary is read before the in-flight health call completes. Therefore a health call
never recursively counts itself before producing its own response.

## Verification

```text
direct-MCP + diagnostics focused batch = 15/15 PASS
surface profile                        = 25/25 PASS
bootstrap profile                      = 14/14 PASS
typecheck                              = PASS
build                                  = PASS
diffcheck                              = PASS
```

The regression test also pins that:

- `toolCount` remains the DevSpace count;
- `mcpToolCount` equals the real full surface;
- `mcpTools` exactly matches the registered direct surface;
- `authorityMode` is visible through frozen `health`;
- a second health call can observe the first call in diagnostics without needing
  `diagnostics.*` catalog discovery.

## Live proof

The current ChatGPT conversation still exposes the older cached 16-tool connector catalog, but the
existing `health` call returned:

```text
status          = ok
executor        = devspace
protocolVersion = 2026-07-28
toolCount       = 6
mcpToolCount    = 43
authorityMode   = AUTONOMOUS_LOCAL
```

The live `mcpTools` list contains all 43 production tools, including:

```text
machine.image.read
machine.pdf.extract
machine.process.*
machine.terminal.*
file.edit_block
file.append
diagnostics.recent
diagnostics.usage
```

Live diagnostics summary at acceptance time:

```text
retained_events = 255
capacity        = 512
total_calls     = 255
successes       = 243
failures        = 12
```

## Result

Provider-side connector catalog lag no longer hides WAG's actual production surface from an existing
conversation. The frozen `health` name is now the authoritative runtime self-inspection bridge.
