# WAG live runtime identity through frozen health

Date: 2026-09-25
Status: PASS

## Runtime

```text
source commit:
603f1be08a4af9a9d93059364639abafea90339d
feat: expose runtime identity through health

runtime:
E:/WAG-Runtime/603f1be08a4a

activation:
E:/WAG-Acceptance/promotion-logs/activate-603f1be08a4a.json

state:
SUCCEEDED

previous runtime:
E:/WAG-Runtime/91817b796d8c/dist/cli.js
```

DevSpace was not restarted.

## Objective

Make the existing frozen `health` tool sufficient to identify the exact WAG runtime process and
committed source without shell/process-tree relay.

## Behavior

Private-stdio health now includes:

```text
runtime.pid
runtime.parent_pid
runtime.cli_path
runtime.runtime_root
runtime.source_head
runtime.capability
runtime.deployed
```

A promoted runtime reads these values from its own process identity plus the bounded
`RUNTIME.json` marker beside `dist/cli.js`.

Source/test execution without a runtime marker reports `deployed=false`.
A malformed marker never blocks gateway startup.

The browser-admitted MCP servers are unchanged; this is private-local self-inspection only.

## Verification

```text
runtime identity + direct-MCP focused batch = 12/12 PASS
typecheck                                   = PASS
build                                       = PASS
diffcheck                                   = PASS
```

The dedicated helper tests prove both exact promoted metadata and fail-open source/malformed-marker
behavior.

## Live proof

The current cached ChatGPT connector still uses the older tool catalog, but the existing `health`
call returned the live runtime identity directly:

```text
mcpToolCount = 43
authorityMode = AUTONOMOUS_LOCAL

runtime.pid         = 16352
runtime.parent_pid  = 15252
runtime.cli_path    = E:\WAG-Runtime\603f1be08a4a\dist\cli.js
runtime.runtime_root= E:\WAG-Runtime\603f1be08a4a
runtime.source_head = 603f1be08a4af9a9d93059364639abafea90339d
runtime.capability  = autonomous-local-runtime-v1
runtime.deployed    = true
```

The same response also exposed the 43 live MCP names and bounded persistent diagnostics summary.

## Result

WAG can identify its own active runtime/source/process through a frozen connector without Desktop
Commander, manual PowerShell, process-tree inspection, or promotion-log lookup.
