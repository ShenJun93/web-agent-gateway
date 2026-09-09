# ADR-0006: Use MCP Tasks for transport-durable verify results

Status: Accepted
Date: 2026-09-10

## Context
V0 proved that `verify.run` local execution survives public transport loss, but the initiating MCP request loses its stdout/result. The exact pinned MCP SDK already implements the 2026-07-28 Tasks extension, including `tasks/get`, `tasks/result`, task-capable tools, and an `InMemoryTaskStore` intended to remain accessible across HTTP requests/sessions.

The current blocker is transport-loss result recovery, not gateway-restart recovery. Adding a custom `job.*` protocol, SQLite store, or mutation surface would exceed the evidence-driven scope.

## Decision
Register `verify.run` as an MCP task-capable tool with `execution.taskSupport = optional` using the SDK experimental Tasks API.

- Task-aware clients may request task augmentation, receive a task handle immediately, reconnect, then use `tasks/get` / `tasks/result`.
- Non-task clients retain synchronous `verify.run`; the SDK performs automatic polling for an optional task tool.
- A single SDK `InMemoryTaskStore` is owned by the gateway HTTP runtime and shared across per-request MCP server instances.
- Completed results use a bounded TTL; task storage survives transport/session replacement but not gateway process restart.
- Mutation, arbitrary shell, Git mutation, custom persistent job APIs, and database-backed task storage remain out of scope.
## Consequences
- This closes only the measured transport-loss result gap while the gateway process remains alive.
- `InMemoryTaskStore` is experimental and explicitly not production-durable; its SDK version remains pinned and compatibility-tested.
- Gateway restart still loses tasks/results and remains a separate future gate.
- Cancellation semantics must not falsely claim that a DevSpace process was killed unless the executor actually receives an interrupt.
- The transport interruption acceptance test must be rerun using a task-aware client and must recover the original `verify.run` result after reconnect.
- ChatGPT Plus deployment and stable named-tunnel availability remain independent blockers.