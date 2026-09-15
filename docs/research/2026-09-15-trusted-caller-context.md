# Trusted Caller Context v1 Research — 2026-09-15

Status: advisory research receipt for design promotion
Scope: WAG-owned caller identity, MCP task-library drift, and the smallest safe post-Task-10 milestone

## Trigger

The read-only ChatGPT browser path has passed supported-host acceptance and merged to `main`. The next milestone must improve WAG control-plane ownership without widening browser mutation, shell, PTY, Git-write, or default/Business tool authority.

The research question is whether WAG should first make caller identity a shared trusted control-plane contract, or move directly to durable generic task persistence.

## Canonical project facts

- Canonical `main` at research time is `18d0fa640ae9eb39423e6f3a0748ed7ca007e90c`.
- ADR-0014 requires durable resources to use WAG-owned `owner_id`, `session_id`, `adapter_id`, and `workspace_id`; provider/transport ids are correlation only.
- Durable mutation already persists and validates the ownership tuple and reconciles restart state through SQLite.
- `verify.run` still uses `NonCancellingTaskStore`, which subclasses the MCP SDK's in-memory experimental task store.
- The repository currently pins `@modelcontextprotocol/sdk` `1.29.0`.
- Browser Adapter v1 remains read-only with `health`, `workspace.open`, and `file.read` only.

## Current MCP TypeScript SDK findings

The official TypeScript SDK has changed materially since WAG adopted the v1 task API:

- `@modelcontextprotocol/sdk` v1 continues on the `v1.x` maintenance line; the current release list includes `1.30.0`.
- SDK v2 is now the stable line and implements the 2026-07-28 MCP revision.
- The v2 migration guide explicitly removes the prior experimental task interception layer, including `TaskStore`, `InMemoryTaskStore`, task-manager helpers, and server constructor task-store options.
- The 2025-era task wire vocabulary remains only for compatibility and is deprecated in v2.
- The SDK roadmap lists Tasks as the `io.modelcontextprotocol/tasks` extension track rather than a core v2 server feature.

Sources:

- https://github.com/modelcontextprotocol/typescript-sdk/releases
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md
- https://ts.sdk.modelcontextprotocol.io/v2/

These upstream changes do not require an immediate SDK upgrade, but they make the persistence boundary clear: durable WAG job state must not use an MCP SDK task-store implementation as its source of truth.

## Browser identity provenance finding

The committed MV3 service worker generates its browser `sessionId` itself with `crypto.randomUUID()` and never accepts that value from provider text. This is stronger than page-controlled identity, but ADR-0014 still classifies browser/native transport ids as correlation data rather than WAG durable authority.

`McpLocalAdapterLink` currently forwards only semantic tool name and arguments. It does not carry a WAG-owned caller tuple, and `startBrowserAdapterRuntime` creates one authenticated loopback MCP endpoint without a per-adapter caller-context seam.

Therefore promoting the extension-generated browser session id directly into `session_id` would couple durable authority to one adapter protocol and would contradict ADR-0014's transport-independence rule.

## Options considered

1. **Persist generic `verify.run` jobs immediately.** Rejected as the next step because the current task plane has no shared WAG-owned caller-context contract and would risk baking transport identity into durable state.
2. **Treat the browser `sessionId` as WAG `session_id`.** Rejected because it makes a replaceable adapter identifier authoritative.
3. **Introduce a trusted caller-context contract first.** Recommended. It is the smallest milestone that normalizes identity provenance without adding tools or side-effect authority.

## Recommendation

Create `Trusted Caller Context v1` as an internal control-plane contract. Required authority fields are `ownerId`, `sessionId`, and `adapterId`; optional provider/client/conversation fields are bounded correlation metadata only. Context is created only by trusted runtime or adapter composition code and is never accepted from model-controlled tool arguments.

The first implementation should unify the existing durable-mutation caller seam with this shared contract and add provenance/override regression tests. It should not change browser extension code, private config, default/Business tool counts, or browser tool counts.

After that contract passes, design a separate WAG-owned durable `verify.run` job plane. MCP Tasks may remain a compatibility projection while WAG stays on SDK v1, but the durable job record and recovery semantics must live behind WAG-owned storage/interfaces so an eventual v2 migration does not rewrite the control plane.

## Authority conclusion

This milestone changes a trust-boundary contract and therefore warrants a new ADR plus a reviewed design spec before implementation.

It does **not** authorize:

- browser mutation projection;
- default or Business mutation enablement;
- arbitrary command, PTY, or Git-write authority;
- a generic durable scheduler;
- MCP SDK v2 migration;
- browser/profile/process ownership managers;
- treating any transport session id as durable WAG authority.
