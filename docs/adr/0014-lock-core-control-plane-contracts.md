# ADR-0014: Lock Core WAG Control-Plane Contracts

Date: 2026-09-13
Status: Accepted — normative architecture contract

## Decision

WAG is a provider-neutral local execution control plane, not a bridge tied to one executor, browser, transport, or model host.

This ADR locks five contracts that every current and future WAG adapter, durable workflow, resource manager, and execution backend MUST preserve:

1. identity / ownership invariants;
2. mutation state machine;
3. filesystem containment model;
4. durable job / process recovery semantics;
5. capability-port security contracts.

ADR-0010 through ADR-0013 remain valid. Where an implementation detail or older slice description is ambiguous, this ADR is the normative security and lifecycle contract. Changing any invariant below requires a new ADR and acceptance evidence; it is not an implementation refactor.

Transport sessions, provider conversation ids, backend handles, browser tabs, process ids, and executor-native ids are correlation data or replaceable handles. None of them is the source of WAG authority.
## Contract 1: Identity / ownership invariants

Every durable WAG resource MUST have WAG-owned identity independent of the host transport. At minimum, durable operations are scoped by `owner_id`, `session_id`, `adapter_id`, `workspace_id`, and their own resource or operation id.

`owner_id` is the principal on whose local authority the resource exists. `session_id` scopes one WAG interaction context. `adapter_id` identifies the trusted host-adapter binding. `workspace_id` is an opaque WAG capability reference to one locally registered workspace. Operation ids identify durable work independently from request ids.

Provider conversation ids, URLs, DOM metadata, MCP transport session ids, browser tab ids, native-host process ids, and backend workspace ids MUST NOT replace these identities or grant authority by themselves.

Host-visible tool arguments MUST NOT allow the model/page to choose or override `owner_id`, `session_id`, or `adapter_id`. Trusted adapter context supplies those fields outside model-controlled arguments. Remote callers receive opaque WAG resource ids rather than canonical local roots or backend handles except where an operation explicitly requires a user-supplied workspace path for admission.

Every lookup or state transition of an owned durable resource MUST validate the expected ownership tuple before returning data or advancing state. A valid id presented under the wrong owner, session, or adapter fails closed. Child resources inherit the ownership tuple under which they were created and MUST NOT be silently re-parented to another owner, session, or adapter.

Transport reconnect MAY create a fresh transport binding, but MUST NOT manufacture, transfer, merge, or silently widen durable ownership. Cleanup MUST be exact-owner scoped: a component may close resources it created, but MUST NOT terminate unrelated WAG runtimes, backend processes, browser sessions, jobs, workspaces, or native-host instances.

Local operator authority is a separate trust domain from Web AI adapters. Possession of a browser/native transport session or a mutation id does not confer local-review authority.
## Contract 2: Mutation state machine

A mutation is one immutable reviewed change record. Its plan fields — ownership, workspace, backend kind, relative path, base hash, bounded before/after content, result hash, fingerprint, and admission timing — MUST NOT be rewritten after creation to authorize different work.

The only normal forward transitions are:

- `PENDING_APPROVAL -> QUEUED | REJECTED | EXPIRED`;
- `QUEUED -> EXECUTING | EXPIRED`;
- `EXECUTING -> SUCCEEDED | FAILED | OUTCOME_UNKNOWN`.

`SUCCEEDED`, `FAILED`, `OUTCOME_UNKNOWN`, `REJECTED`, and `EXPIRED` are terminal. Recovery MAY perform `EXECUTING -> QUEUED` only when fresh evidence proves the target still matches the stored base state and the original execution-admission deadline remains live; this is not new authorization. No other backward or terminal-state transition is permitted.

Only the local operator trust domain may transition a still-live exact record from `PENDING_APPROVAL` to `QUEUED`. A Web AI adapter may create a preview and read status/result, but MUST NOT approve, apply, refresh, or widen a mutation.

State transitions MUST be conditional on the expected current state and relevant stored deadline so competing reviewers/workers cannot both advance the same record. Repeated approval, reconnect, retry, or recovery MUST NOT extend review or execution-admission deadlines.

A worker may claim only a live `QUEUED` record. Immediately before the side effect WAG MUST revalidate containment, sensitive-path policy, target existence/type/size, base hash, exact-match uniqueness, candidate result, and stored fingerprint from fresh local state.

`SUCCEEDED` requires independent post-write read-back matching the stored result hash. `FAILED` is permitted only when WAG can establish that the attempted operation did not leave an ambiguous side effect. Whenever WAG cannot prove either the original base state or the exact result state after an interrupted/failed execution, the record MUST become `OUTCOME_UNKNOWN` rather than be retried blindly.
## Contract 3: Filesystem containment model

A WAG workspace is a policy boundary identified by an opaque `workspace_id` and bound locally to one canonical root. The canonical root is established only after workspace admission and MUST NOT be changed in place to make an existing workspace id refer to a different root.

Allowed-root configuration is an admission filter, not a sandbox. Every filesystem capability MUST still validate the concrete target for each operation.

After workspace admission, host-facing file operations use normalized workspace-relative paths. WAG MUST reject traversal, absolute/rooted paths, unsafe platform namespaces, device paths, alternate stream/namespace syntax, and configured sensitive credential/control paths unless a future capability explicitly defines and accepts them under a new contract.

Before reading or mutating a target, WAG MUST resolve the effective target against the canonical workspace root and prove containment after filesystem resolution. Symlinks, junctions, reparse points, mount behavior, case normalization, or backend path rewriting MUST NOT allow escape from the admitted root.

Containment and sensitive-path checks MUST be repeated immediately before consequential filesystem effects; admission-time validation alone is insufficient because local filesystem state can change.

Repository content and repository-controlled configuration are untrusted inputs. They MUST NOT redefine WAG allowed roots, policy, credentials, backend selection, operator authority, or cleanup ownership. Execution backends receive sanitized environment/configuration appropriate to their capability.

A backend's reported path, patch result, or workspace handle is evidence only. WAG independently verifies target identity and postconditions. The current mutation capability is update-existing-only; create, delete, move, multi-file transaction, or broader filesystem operations require separate explicit capability contracts and acceptance tests.
## Contract 4: Durable job / process recovery semantics

A durable job is WAG state. An OS process, PTY, browser instance, backend task id, or executor session is one execution attempt or handle associated with that state; it is never the durable job itself.

Transport disconnect MUST NOT implicitly cancel durable work. Process loss MUST NOT erase the durable record. WAG restart MUST reconcile durable records before assuming their execution outcome.

Queued work may be dispatched only while its original admission/authorization constraints remain valid. A running record may be reattached only to an exact still-owned execution handle whose identity can be verified. Cleanup, interrupt, or termination MUST target exact owned handles, never broad process names, ports, workspaces, or provider sessions.

If a running handle is gone after restart, WAG MAY replay only when the capability declares replay safe or when fresh local evidence proves that no consequential effect occurred and all original admission deadlines remain valid. Otherwise the job becomes `OUTCOME_UNKNOWN` or an equally explicit capability-specific unknown terminal state.

A terminal success requires capability-specific completion evidence, not merely process exit code. A terminal failure requires enough evidence to distinguish failure from an ambiguous side effect. Cancellation is not complete until the owned execution attempt is confirmed stopped or the capability can otherwise prove its postcondition; loss of contact is not successful cancellation.

Durable deadlines, attempt ids, ownership, requested cancellation, result summaries, and recovery decisions MUST survive restart when the capability depends on them. Recovery MUST NOT refresh authorization, silently create a new job id for the same effect, or blind-retry non-idempotent work.

Mutation reconciliation in Contract 2 is the first concrete specialization of this general rule. Future command, PTY, browser, or long-running job managers MUST define equally explicit replay, cancellation, completion-evidence, and unknown-outcome rules before gaining consequential authority.
## Contract 5: Capability-port security contracts

WAG capability ports are narrow security boundaries, not convenience abstractions. Each port MUST describe the smallest operation family required by the control plane and MUST deny unknown or broader operations by default.

Policy remains above the port. Backends MUST NOT decide ownership, local approval, workspace admission, mutation authorization, or durable lifecycle. They receive already-scoped requests and return bounded evidence; WAG independently validates preconditions and postconditions.

A capability port MUST NOT contain a generic escape hatch such as arbitrary shell, raw MCP forwarding, arbitrary URL fetch, unrestricted filesystem access, opaque model-supplied patch execution, or backend-native command passthrough unless that broader authority is itself the explicitly reviewed capability.

Port inputs and outputs MUST be typed/bounded, capability-specific, and safe to audit. Secrets, local transport credentials, canonical roots, environment variables, and backend-native handles are disclosed only when strictly required for that backend operation and MUST NOT flow back to untrusted host adapters by default.

Backend replacement MUST preserve WAG durable ids, ownership checks, host-facing semantic tool contracts, local-review semantics, state transitions, audit meaning, and failure classification. A faster or more convenient backend does not inherit additional authority.

Backend errors and metadata are untrusted evidence. WAG MUST sanitize diagnostics crossing trust boundaries and MUST verify consequential results independently where verification is possible. Failure of one backend or adapter MUST NOT trigger fallback to a broader capability port.

Every new capability port requires contract tests for its allowlist, bounds, containment/ownership assumptions, lifecycle, cleanup ownership, redaction, and failure behavior before it can be projected through any host adapter. Host adapters may expose only the subset explicitly approved for that adapter surface.
## Conformance and acceptance gates

These contracts are architecture invariants, not a claim that every future-capability implementation already exists.

Current branch evidence covers durable mutation ownership/state transitions, exact local approval, restart reconciliation, workspace containment against traversal and resolved escape, capability-specific file mutation, bounded read/verify surfaces, exact-owner runtime cleanup, and browser/native transport separation.

Before authority is widened, implementation and tests MUST close any platform-specific containment gaps implied by Contract 3, including Windows namespace/device/alternate-stream forms not yet covered by the current path-policy tests.

A generic durable process/job manager is not yet implemented. Contract 4 is the required design gate for that future work; raw PTY, arbitrary command mutation, autonomous process replay, and broad process cleanup remain unauthorized until their capability-specific ADR/tests exist.

Browser Adapter v1 remains read-only for its current milestone. Passing local transport acceptance does not authorize Windows native-host registration, browser installation, mutation projection, default/Business mutation enablement, or terminal/Git authority.

Required regression evidence for changes touching these contracts includes negative tests as well as happy paths: ownership mismatch, stale/expired authorization, containment escape, ambiguous side-effect recovery, backend metadata mismatch, credential/redaction boundaries, and exact-owner cleanup.

## Consequence

WAG can replace DevSpace, browser adapters, MCP transport details, local IPC, storage libraries, and execution implementations without changing its security model. Long-term compatibility is defined by these control-plane contracts rather than by preserving a specific executor or bridge.
