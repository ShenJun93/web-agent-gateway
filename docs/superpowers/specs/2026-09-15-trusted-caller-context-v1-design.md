# Trusted Caller Context v1 Design

Date: 2026-09-15
Status: Proposed for written review
Decision authority: ADR-0014 and proposed ADR-0015
Research receipt: `docs/research/2026-09-15-trusted-caller-context.md`

## Goal

Create one provider-neutral, trusted caller-context contract for WAG control-plane authority without adding any new tool, side effect, browser mutation, shell, PTY, or Git-write permission.

The first implementation is deliberately narrow: define and validate the context, then migrate the existing opt-in durable-mutation caller seam to use it. It does not yet route a new identity protocol through every transport.

## Why now

ADR-0014 already defines the normative ownership tuple, and durable mutation already persists and validates that tuple. However, the implementation still names caller identity inside mutation-specific types while the generic MCP task path remains transport/library-shaped.

The next planned durable `verify.run` job plane needs a shared WAG-owned identity seam before persistence is expanded. Doing identity first prevents SDK task ids, MCP transport sessions, browser tab ids, or browser protocol session ids from accidentally becoming durable authority.

Current MCP SDK drift strengthens this separation: SDK v2 removed the v1 experimental server-side `TaskStore` interception layer and moved Tasks to an extension track. WAG therefore needs identity and durable state contracts that survive protocol-library changes.

## Design principles

- Authority is WAG-owned and provider-neutral.
- Identity provenance is separate from capability permission.
- Model-controlled arguments never choose authority identity.
- Transport/provider identifiers are correlation only.
- This milestone must not expand any host-visible tool surface.

## Caller-context contract

The shared runtime type is conceptually:

```ts
interface GatewayCallerContext {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly correlation?: {
    readonly provider?: string;
    readonly clientId?: string;
    readonly conversationRef?: string;
  };
}
```

`ownerId`, `sessionId`, and `adapterId` are authority-bearing. They are validated as bounded opaque identifiers and are immutable after context creation.

`correlation` is optional, bounded, and non-authoritative. No policy decision, durable lookup, ownership transfer, approval decision, or cleanup decision may succeed because correlation metadata matches.

The implementation should expose one validator/factory such as `createGatewayCallerContext(...)` rather than letting callers assemble unchecked objects throughout the codebase. Unknown fields are rejected and the returned value is immutable.

Authority identifiers should use a conservative ASCII-safe syntax and maximum length suitable for logs/database indexes; the implementation plan should lock exact constants in tests rather than duplicating magic limits across modules.

## Provenance and trust boundary

Only trusted runtime/adapter composition code may create the authority-bearing context. A context is dependency input to control-plane code, not a semantic tool argument.

The first implementation MUST NOT add `owner_id`, `session_id`, `adapter_id`, provider identity, or conversation identity to any MCP/browser tool input schema. It also MUST NOT derive authority from repository content, provider text, URL fragments, DOM attributes, request ids, backend handles, or caller-supplied metadata.

Existing tests/experimental runtime composition may inject explicit trusted contexts. Production transport-specific allocation/binding is a later milestone unless an existing path already has a reviewed trusted source.

The context contract does not authenticate a human by itself. Authentication/admission happens before context construction; the context records the authority that trusted composition has already admitted.

## Browser-specific rule

The committed extension service worker currently generates `sessionId` itself per tab using `crypto.randomUUID()`. Provider content cannot choose that value.

That fact does not change ADR-0014: the browser protocol id remains adapter correlation, not durable WAG `session_id` authority. This milestone does not change the extension, native-host protocol, `McpLocalAdapterLink`, discovery file, or browser runtime.

A later adapter-binding design may admit a browser session into a WAG-owned session and record the browser id as correlation. Reconnect must then rebind to the same WAG session only through trusted adapter state; absence/presence of a tab or native process can never transfer ownership.

## Durable-mutation integration

`DurableMutationCoordinator` already requires the exact authority tuple. The implementation should replace mutation-specific caller typing with the shared caller-context authority shape while preserving the existing SQLite columns, persisted values, identity checks, state machine, deadlines, and audit semantics.

No database migration is needed for this milestone because the durable mutation schema already stores `owner_id`, `session_id`, and `adapter_id`.

`MutationMcpContext` may remain as a composition wrapper for `{ callerContext, coordinator }`, but it must no longer define an independent identity contract. The semantic mutation tool schemas remain unchanged and continue to contain no authority fields.

## Default and Business surfaces

Default MCP and Business stdio remain the existing five tools: `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`.

This milestone does not make those read-only operations durable-owned resources merely by introducing a context type. It also does not change current authentication, private config, OAuth bootstrap, task behavior, or stdio framing.

Where those transports later need durable resources, their trusted runtime composition must first provide a caller context through a separately reviewed binding. No fallback may synthesize ownership from an MCP transport session or client-provided field.

## Browser surface

Browser Adapter v1 remains exactly `health`, `workspace.open`, and `file.read`. No `mutation.preview`, `mutation.result`, approval, shell, process, Git, or generic MCP forwarding is added.

Browser/native protocol schemas remain strict and should continue rejecting extra ownership-like fields. Supported-host PASS is retained as read-only evidence only; it is not reinterpreted as mutation or multi-session acceptance.

## Relationship to future durable jobs

The next durable-job design should create WAG-owned job records behind a WAG storage/manager interface and bind each record to `GatewayCallerContext` plus the relevant workspace/resource ids.

MCP Tasks may project job creation/status/result while WAG remains on SDK v1, but protocol task ids and SDK task stores are compatibility handles. They must not be the durable source of truth, must not define owner identity, and must be replaceable when WAG eventually evaluates SDK v2.

This design does not implement that job manager. It only establishes the identity prerequisite.

## Error handling

Invalid trusted-context construction fails closed before capability execution. No partial/default identity is substituted.

Ownership mismatch on an existing durable resource continues to fail closed without disclosing whether another owner/session/adapter has a valid record. Diagnostics crossing remote boundaries must remain bounded and must not expose local roots, tokens, operator credentials, or unrelated identity values.

Correlation metadata is never required for authorization. Missing or malformed optional correlation metadata may be rejected at context construction, but it cannot cause the authority tuple to be rewritten or inferred from another source.

## Expected implementation footprint

Create:

- `src/caller-context.ts`
- `test/caller-context.test.ts`

Modify only as needed:

- `src/durable-store.ts` for shared authority typing without schema changes;
- `src/durable-mutation.ts` to consume the shared authority contract;
- `src/server.ts` to rename/use the shared caller-context seam in opt-in mutation composition;
- durable mutation, MCP-surface, and HTTP transport tests that construct trusted mutation context.

Do not modify browser extension/runtime/native-host code, private config, OAuth, `task-store.ts`, default tool registration, Business stdio behavior, or installation/distribution code in this milestone unless a RED test proves a direct type-level dependency that cannot be resolved more narrowly.

## Verification strategy

Caller-context unit tests must cover valid construction, each missing/invalid authority field, unknown keys, size/bounds, optional correlation validation, and immutability.

Mutation tests must prove owner, session, and adapter mismatch independently fail while an exact matching context preserves all existing preview/result/reconciliation behavior.

Schema regression tests must prove model-visible tool inputs do not gain `owner_id`, `session_id`, `adapter_id`, `provider`, `client_id`, or `conversation_ref` fields.

Surface regression tests must retain:

- default MCP: five tools;
- Business stdio: five tools;
- Browser Adapter v1: three tools;
- opt-in durable mutation: only the existing `mutation.preview` and `mutation.result` additions, with no remote approval/apply authority.

Full candidate verification remains `npm test`, `npm run typecheck`, `npm run build`, `npm run test:business`, relevant exact-pinned backend checks, and `git diff --check`.

## Acceptance gate

`TRUSTED_CALLER_CONTEXT_V1 = PASS` requires all of the following on one exact candidate:

1. one shared validated immutable caller-context implementation exists;
2. durable mutation uses that contract instead of a mutation-specific identity definition;
3. exact owner/session/adapter mismatch tests fail closed;
4. no model-visible tool schema can choose or override authority identity;
5. default, Business, and browser tool surfaces remain unchanged;
6. no durable-store schema migration or persisted mutation semantic changes occur;
7. full repository verification passes with no new authority or cleanup behavior.

Passing this gate authorizes only use of the shared caller-context contract by later reviewed milestones. It does not authorize durable generic jobs by itself.

## Approaches rejected

**Direct generic-job persistence first:** rejected because durable jobs would need an identity source before their storage semantics can be trusted.

**Use MCP task/session identity as authority:** rejected because it couples WAG ownership to transport/library semantics and is especially fragile given the SDK v2 task API changes.

**Promote the browser protocol `sessionId`:** rejected because trusted generation inside the extension does not make a replaceable adapter id the source of durable WAG authority.

## Migration and compatibility

There is no database migration and no remote API migration in v1. Existing durable mutation records retain their stored tuple and remain readable under the shared authority type.

The historical `MutationCaller` type may be removed or retained as a deprecated type alias only if doing so reduces churn; there must be one normative authority contract after the change.

No compatibility promise is made for internal test helper names. Host-visible tool names, argument schemas, results, error redaction, and existing durable mutation lifecycle are compatibility constraints.

## Non-goals

This milestone does not implement:

- a persistent owner registry or account system;
- per-tab WAG session admission;
- multi-session browser ownership management;
- durable generic `verify.run` jobs;
- task cancellation or executor interruption;
- browser mutation projection;
- production Business mutation;
- arbitrary shell, persistent PTY, Git writes, or generic process management;
- an MCP SDK upgrade;
- a second Web AI provider adapter;
- Remote Desktop Commander replacement.

## Follow-up sequence

After this design is implemented and accepted, the preferred next design is a WAG-owned durable `verify.run` job plane with restart reconciliation and exact caller-context fencing. Adapter-session admission and browser/process ownership managers follow only when their concrete resource lifecycle is ready to meet ADR-0014.

## Validation constants

The implementation plan must use these exact v1 bounds:

- `ownerId`, `sessionId`, `adapterId`: 1-128 ASCII characters matching `^[A-Za-z0-9._:-]+$`;
- `correlation.provider`: optional, 1-64 characters matching the same ASCII-safe character set;
- `correlation.clientId`: optional, 1-128 characters matching the same ASCII-safe character set;
- `correlation.conversationRef`: optional, at most 512 UTF-8 bytes and no C0 control characters or NUL;
- both the outer context and nested `correlation` object are strict: unknown keys are rejected.

The factory returns a deeply immutable value. Durable-store records persist only the required authority tuple in this milestone; optional correlation metadata does not trigger a schema migration and is not persisted as authority.

No new environment variable, private-config field, browser discovery field, or model-facing parameter is introduced by Trusted Caller Context v1.
