# Durable Verify Job Core v1 Research

Date: 2026-09-15
Purpose: fresh architecture evidence for the next WAG control-plane milestone after Trusted Caller Context v1.
Authority: Git/spec/tests/live evidence and official upstream sources override this note.

## Current repository evidence

Trusted Caller Context v1 is accepted on parent commit `b1b6dcae175b3f7c2ff704161e9d683afafbee89`; its exact implementation candidate was `969c4f22e73d2747f925e496821c1a29388c7696`.

Focused baseline on this design worktree passed 10/10 across caller-context validation, `verify.run`, MCP task compatibility, reconnect recovery, and cancellation denial.

Current `verify.run` is a configured-profile capability. Model input selects only `workspace_id` plus a trusted local profile name; argv/env are local configuration. The profile is bounded to 1-16 argv entries, timeout 100-30,000 ms, max output 100-10,000 tokens, bounded safe argument syntax, bounded env count, and secret-like env keys are rejected.

Current MCP task durability is process-local only. `NonCancellingTaskStore` subclasses SDK v1 `InMemoryTaskStore`. `test/task-recovery.test.ts` proves a second client can recover a task result after transport reconnect while the same WAG process remains alive; it does not prove WAG restart recovery or WAG-owned task identity.

Current exact-pinned DevSpace exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, and `show_changes`. `exec_command` may return `running=true` plus a backend `sessionId`; `write_stdin` can send Ctrl-C, but there is no current WAG contract that can independently inspect or reattach that session after WAG restart.
## Official MCP / TypeScript SDK evidence

Official MCP Tasks extension draft for the 2026-07-28 protocol identifies itself as `io.modelcontextprotocol/tasks`. It lets a server optionally return a server-generated asynchronous task handle for `tools/call`, with polling/status/result/cancel semantics. Task creation remains server-directed after capability negotiation.

SEP-2663 is Final on the Extensions Track. This makes Tasks a legitimate interoperability target, but not WAG's ownership or persistence authority.

The official TypeScript SDK v2 migration guide removes the v1 experimental task interception implementation: `TaskStore`, `InMemoryTaskStore`, `registerToolTask`, task manager helpers, stream helpers, and the McpServer `taskStore` constructor option are removed. The 2025 task wire vocabulary remains only as deprecated interoperability vocabulary.

The SDK roadmap records v2.0.0 as the stable line implementing the 2026-07-28 core specification and explicitly notes that the old experimental Tasks component is not served by v2 core. The current WAG repository remains exactly pinned to `@modelcontextprotocol/sdk` 1.29.0; this milestone does not upgrade it.

Official sources refreshed 2026-09-15:

- https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md
- https://ts.sdk.modelcontextprotocol.io/v2/

## Architectural consequence

WAG durable verify jobs must be WAG-owned records whose ids, ownership, state, results, and recovery decisions survive replacement of the MCP SDK task implementation. MCP Tasks can be a later compatibility projection, but an MCP task id, transport session, SDK `TaskStore`, DevSpace session id, or OS process id cannot be the WAG durable job itself.
## Smallest safe next milestone

The smallest useful slice is not a generic process manager. It is a WAG-owned durable job core specialized to the already bounded `verify.run` capability.

The core can reuse the accepted SQLite control-plane store and durable workspace ownership records. It should add verify-job rows and transition events without changing existing mutation tables or state-machine semantics.

Public/default activation must remain deferred. Trusted Caller Context v1 deliberately did not bind every current transport to WAG-owned caller identity. Therefore the first durable verify implementation should be an internal/opt-in coordinator consumed only where trusted composition supplies `GatewayCallerContext`; default MCP, Business stdio, and Browser Adapter v1 remain behaviorally unchanged.

Queued restart execution needs an explicit trusted local policy. A configured verify profile may opt into `resumeQueuedAfterRestart`; default is false. Recovery may dispatch a persisted `QUEUED` record only when the profile still exists, its effective plan hash is unchanged, workspace ownership still matches, and that flag is true.

A claimed `EXECUTING` record is different. Current DevSpace provides no accepted inspect/reattach proof after WAG restart. Recovery therefore must mark such a record `OUTCOME_UNKNOWN` rather than replay it. A same-runtime timeout may attempt Ctrl-C, but the interrupt request alone is not completion evidence; absent confirmed completion, the durable record is also `OUTCOME_UNKNOWN`.

A normally completed verification is a successful job even when its verification command exits non-zero. The exit code is the capability result, not a WAG infrastructure failure.

## Rejected directions

- Do not build generic shell/process/PTY durability in this milestone.
- Do not migrate to SDK v2 merely to obtain job semantics.
- Do not make SDK v1 `TaskStore` durable authority.
- Do not synthesize caller authority from MCP transport ids, browser protocol `sessionId`, provider conversation metadata, or DevSpace session ids.
- Do not expose `job.*`, cancellation, arbitrary argv/env, browser mutation, Git writes, or process control.
- Do not blind-replay an `EXECUTING` record after restart.

This research supports ADR-0016 and `docs/superpowers/specs/2026-09-15-durable-verify-job-core-v1-design.md`.