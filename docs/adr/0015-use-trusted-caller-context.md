# ADR-0015: Use a Trusted Caller Context for WAG Authority

Date: 2026-09-15
Status: Proposed

## Decision

WAG will use one shared trusted caller-context contract for control-plane authority instead of defining caller identity separately inside each capability.

The required authority tuple is `owner_id`, `session_id`, and `adapter_id`. `workspace_id` and operation ids remain capability/resource references governed by ADR-0014.

Trusted runtime or adapter composition code supplies the authority tuple outside model-controlled tool arguments. Tool schemas MUST NOT accept fields that let a Web AI page/model choose or override `owner_id`, `session_id`, or `adapter_id`.

Optional `provider`, `client_id`, `conversation_ref`, transport-session, request, tab, process, or backend identifiers are correlation metadata only. They cannot grant authority, transfer ownership, or substitute for any required WAG-owned identity field.

The shared context is immutable after creation. Child durable resources inherit the authority tuple under which they are created and remain subject to exact tuple checks.

## Browser boundary

The current MV3 service worker generates its browser protocol `sessionId` in trusted extension code rather than from provider text. Even so, that id remains adapter/transport correlation under ADR-0014 and is not automatically promoted into WAG `session_id` authority.

A later adapter-binding milestone may map trusted adapter state to a WAG-owned session through an explicit control-plane admission contract. That mapping is outside this first implementation.

## First implementation boundary

The first implementation introduces the reusable caller-context type/validation seam and migrates the opt-in durable-mutation caller seam to consume it. Existing read-only default, Business stdio, and Browser Adapter v1 tool surfaces remain unchanged.

This ADR does not require caller contexts to be projected through every existing transport in the first patch. A transport may remain on its current read-only behavior until a separately reviewed binding supplies trusted context without exposing authority fields to the model.

## Relationship to durable jobs

Future durable `verify.run` or process/job records MUST use this caller context for ownership. Their durable state must remain WAG-owned and independent of MCP SDK task-store internals.

MCP task methods may be used as a compatibility projection when supported, but an SDK `TaskStore`, transport session, or protocol task id cannot become WAG's durable source of authority or recovery state.

## Consequences

- Durable mutation and future durable jobs share one identity contract.
- Provider/browser/MCP identifiers remain replaceable correlation data.
- A future MCP SDK migration does not redefine WAG ownership.
- The milestone grants no new capability or side-effect authority.

Changing these provenance rules requires a new ADR and acceptance evidence because doing so changes the trust boundary, not merely implementation structure.
