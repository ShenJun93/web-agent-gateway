# COMMON_AI_WORKBENCH_CONTRACTS_AND_BENCHMARKS_2026-09-21

**Date:** 2026-09-21  
**Role:** COMMON SUBSTRATE + REUSE RESEARCH OWNER  
**Status:** Research/specification only — no portable-core repository, no WAG mutation, no large implementation  
**Applies to:** P1 ChatGPT WAG Access, P2 Windows Native Workbench, P3 Linux AI Workstation, COMMON, WAG interface boundary

## Research labels

- **FACT** — directly supported by a primary/upstream source or normative specification.
- **INFERENCE** — conclusion derived from facts but not directly specified upstream.
- **RECOMMENDATION** — proposed design choice for this program.
- **UNVERIFIED ASSUMPTION** — program-local premise that needs project evidence.
- **EMPIRICAL TEST NEEDED** — cannot be resolved reliably from documentation alone.

---

# 1. Executive summary

**RECOMMENDATION — leading architecture:** use a **contract-first JSON-RPC 2.0 control protocol** with one semantic schema and two local transport profiles:

1. **Spawned adapter profile:** newline-delimited UTF-8 JSON-RPC over `stdio`.
2. **Resident control-plane profile:** the same newline-delimited JSON-RPC over a **Windows named pipe** on P2 and a **pathname Unix-domain socket** on P3.

The transport is deliberately not the session, not the task, not the workspace, and not the authority boundary. Logical identity is carried explicitly on each request. This follows the same architectural separation now present in MCP 2026-07-28: protocol semantics are independent from transport; MCP standardizes newline-delimited JSON-RPC over stdio and explicitly recommends reusing that framing for custom reliable bidirectional byte streams such as Unix-domain sockets. MCP 2026-07-28 is also stateless at the protocol core: persistent state must be referenced by explicit identifiers and must not be inferred from a connection. [S02][S03]

The common substrate should standardize only the pieces that would otherwise be repeatedly and dangerously redefined:

- logical identities and their ownership rules;
- lifecycle state machines;
- request/result binding;
- opaque Goal Lease references;
- trusted authority-decision recording;
- event/audit envelopes;
- restart/reconnect semantics;
- process-tree ownership semantics;
- resource-measurement names and collection windows;
- cross-platform benchmark scenarios;
- stable error classes.

It should **not** standardize UI, browser automation, WAG internals, shell implementation, Windows/Linux process APIs, credentials, or a shared executable runtime.

**RECOMMENDATION — do not create P4 now.** A future Portable WAG Authority Core is justified only after P2 and P3 independently implement the contract and evidence shows that authority-critical logic is being duplicated in a way that causes recurring maintenance or semantic/security divergence. “An abstraction looks elegant” is explicitly not a trigger.

**RECOMMENDATION — process ownership:** use **Windows Job Objects** on P2 and **cgroup v2** on P3 as the containment primitives for task-owned process trees. PID lists are diagnostic metadata, not ownership. Windows Job Objects normally include child processes and can terminate the job as a group; Linux cgroup v2 supplies group-scoped accounting and `cgroup.kill`. [S08][S10]

**RECOMMENDATION — authority:** a request may carry an opaque `lease_id`, but it may not self-assert `HUMAN_APPROVED` or `POLICY_APPROVED`. Those are trusted outputs of an authority validator/WAG adapter and are appended to the audit event only after validation. Browser content and model output can never create, widen, refresh, or reinterpret a lease.

**RECOMMENDATION — crash semantics:** add `INTERRUPTED` to the task lifecycle. A task that was `RUNNING` when the control plane died is not automatically `FAILED`, `SUCCEEDED`, or safe to replay. On recovery, it becomes `INTERRUPTED` unless the exact attempt can be proven completed or safely reattached. A retry gets a new `attempt_id` but retains the logical `task_id`.

**RECOMMENDATION — fingerprints:** canonicalize the authority-relevant request projection using RFC 8785 JCS and hash it with SHA-256. Do not put raw credentials into the model-visible request, event log, or fingerprint input; use opaque credential handles/version references below the model boundary. [S17][S18]

**EMPIRICAL TEST NEEDED:** no candidate should be called “lightweight” until B0-B5 measurements exist on the actual P2 and P3 implementations. Structural simplicity favors JSON-RPC over a local byte stream, but real startup latency, RAM, CPU, process count, and five-session scaling must be measured.

---

# 2. Exact problem being solved

P1, P2, and P3 need to interoperate with the same security model and operational semantics without independently inventing slightly different meanings for “session”, “task”, “workspace”, “browser”, “lease”, “result”, “process owner”, “restart”, or “error”.

The common problem is **not** “how do we build another product?”. It is:

> What is the smallest cross-project contract that lets three different workbench implementations describe the same logical work, authority references, audit evidence, recovery behavior, resource use, and structured tool calls while keeping WAG a separate authority/execution backend?

The contract must make the following statements unambiguous across projects:

- which human/model/workbench interaction a request belongs to;
- which logical task and execution attempt produced a result;
- which workspace and browser context are involved;
- which authority/Goal Lease reference was validated;
- which local process tree belongs to which task attempt;
- whether a disconnected/restarted component may resume, retry, or must stop;
- whether a result belongs to the current session/request;
- how resource cost is measured comparably on Windows and Linux;
- how errors are classified without coupling every caller to transport-specific error numbers.

The desired result is a **portable semantic contract**, not a portable executable core.

---

# 3. Non-goals

The following are explicitly outside this research scope:

1. **No P4 repository yet.**
2. **No WAG mutation.** WAG remains a separate authority/execution backend.
3. No common GUI toolkit, browser shell, terminal renderer, or native-window abstraction.
4. No cross-platform process-containment implementation. P2 and P3 should use native primitives.
5. No attempt to make browser page content a trust source.
6. No model-side credential handling.
7. No auto-clicking of security controls, approval dialogs, or OS prompts to increase autonomy.
8. No distributed service discovery, consensus, service mesh, message broker, or cluster scheduler.
9. No requirement that P1/P2/P3 use the same programming language or runtime.
10. No “exactly once” guarantee for arbitrary external side effects. That guarantee cannot be created by an IPC envelope alone.
11. No unbounded event payloads or embedding of large build artifacts in the audit log.
12. No mandatory gRPC/protobuf dependency merely for stronger typing.
13. No assumption that an open pipe/socket/process is the identity of a session or conversation.
14. No benchmark claim based on synthetic microbenchmarks alone; the required suite includes recovery and cleanup behavior.

---

# 4. Current platform facts

## 4.1 JSON-RPC and MCP transport facts

**FACT — JSON-RPC 2.0** defines request/response correlation through an `id`, success through `result`, and failure through an `error` object. It does not itself require TCP, HTTP, stdio, named pipes, or Unix sockets. [S01]

**FACT — MCP 2026-07-28** requires JSON-RPC for protocol messages. Its transport specification states that protocol semantics are identical across transports. The standard stdio binding uses newline-delimited messages; custom transports are permitted. For reliable bidirectional byte streams such as Unix-domain sockets or TCP, the specification recommends reusing the stdio framing rather than inventing another framing protocol. [S02]

**FACT — MCP 2026-07-28 core is stateless.** It explicitly says that context must not be inferred from previous requests or from the same connection; persistent state must be referenced by an explicit identifier. It also states that a connection/process is not a conversation/session. [S03]

**INFERENCE:** this directly supports separating the COMMON semantic identity model from physical IPC connection identity.

## 4.2 Windows named pipes

**FACT:** Windows named pipes have security descriptors/DACLs. Microsoft documents use of a logon SID in the DACL to prevent access from remote users or users in another terminal-services session. [S06]

**FACT:** `CreateNamedPipe` supports `PIPE_REJECT_REMOTE_CLIENTS`. [S07]

**FACT:** if no explicit security descriptor is supplied, the default named-pipe ACL grants full control to LocalSystem, administrators, and creator owner, but also grants read access to Everyone and anonymous accounts. [S07]

**RECOMMENDATION:** the COMMON Windows transport profile must prohibit relying on the default ACL. P2 should create an explicit per-user/per-logon DACL and set `PIPE_REJECT_REMOTE_CLIENTS`.

## 4.3 Linux Unix-domain sockets

**FACT:** on Linux, pathname Unix-domain sockets honor directory permissions; creating the socket requires write/search permission on the containing directory, and connecting to a stream socket requires write permission on the socket. POSIX does not guarantee that socket-file permissions behave identically on all Unix systems. [S09]

**RECOMMENDATION:** P3 should place the pathname socket in a user-private runtime directory, make the directory `0700`, make the socket accessible only to the intended user, and validate ownership before accepting/reusing a stale path.

**INFERENCE:** because P3 is specifically Linux, Linux pathname-socket permissions are a legitimate security primitive even though they are not portable to every Unix-like OS.

## 4.4 Windows process containment

**FACT:** Windows Job Objects group processes for management and resource accounting. By default, child processes created by a process already assigned to a job are also associated with the job, unless breakaway behavior is enabled. `TerminateJobObject` terminates all processes in the job. [S08]

**RECOMMENDATION:** each task execution attempt that may spawn subprocesses should have a task-owned Job Object; do not use a PID list as the authority for cleanup.

## 4.5 Linux process containment

**FACT:** cgroup v2 exposes group-level controls and metrics. The kernel documentation provides `cgroup.kill`, group memory accounting such as `memory.current`, and CPU accounting such as `cpu.stat`. [S10]

**FACT:** Linux pidfds provide file-descriptor references to processes and avoid relying solely on a numeric PID that can later be reused. [S19]

**RECOMMENDATION:** use a dedicated cgroup v2 subtree as the ownership primitive for a task attempt when the environment permits it; use pidfd for strong references to individual root/executor processes where useful. PID plus start time is a fallback diagnostic identity, not the primary ownership mechanism.

## 4.6 gRPC

**FACT:** gRPC has first-class deadlines and cancellation semantics; clients should set realistic deadlines. A deadline expiry yields a deadline error, and server handlers need to cooperate with cancellation rather than assuming cancellation reverses already-executed application side effects. [S11][S12]

**FACT:** current .NET supports gRPC over Unix-domain sockets and named pipes. On .NET, local IPC gRPC still involves an ASP.NET Core gRPC server, HTTP transport machinery, generated protobuf bindings, and configuration of the underlying connection. [S13]

**INFERENCE:** gRPC is technically viable but structurally larger than this program currently requires. Actual startup/RAM/CPU cost remains an empirical question.

## 4.7 Protobuf

**FACT:** protobuf provides compact binary encoding and explicit schema evolution rules. Field numbers become wire identifiers, should not be changed after use, and deleted fields should have their numbers reserved. Additive fields can be wire-safe. [S14]

**INFERENCE:** protobuf solves serialization/schema evolution but does not, by itself, solve request IDs, cancellation, restart semantics, result binding, audit lifecycle, or local endpoint security. A custom “protobuf IPC” would still need those contracts.

## 4.8 HTTP loopback and WebSocket

**FACT:** MCP's current Streamable HTTP security guidance requires validating `Origin`, binding local servers to localhost where appropriate, and using authentication; the stated threat includes DNS rebinding. [S04]

**FACT:** WebSocket provides full-duplex messaging over a TCP connection after an HTTP-based opening handshake and includes an origin model for browser clients. [S15]

**INFERENCE:** HTTP/WebSocket are useful when a browser-native client must connect directly, but they introduce a network/browser-origin attack surface that is unnecessary for the default P2/P3 local control plane.

## 4.9 IDs, timestamps, canonicalization and observability

**FACT:** RFC 9562 defines UUIDs and UUIDv7, whose layout includes Unix-epoch time and is suitable when sortable, locally minted identifiers are desirable. [S16]

**FACT:** RFC 8785 defines a deterministic JSON Canonicalization Scheme suitable for invariant hashing/signing inputs. [S17]

**FACT:** RFC 3339 defines a constrained Internet date/time format; UTC representation is appropriate for interoperable event timestamps. [S20]

**FACT:** W3C Trace Context standardizes `traceparent`/`tracestate`; current MCP reserves standard trace-context metadata keys. [S21][S03]

**RECOMMENDATION:** use UUIDv7 when the target runtime has a proven implementation; UUIDv4 is an acceptable fallback. Use RFC 3339 UTC for durable event time. Treat trace IDs as observability only, never as session, task, workspace, or authority identifiers.

## 4.10 Resource metrics

**FACT:** OpenTelemetry's current process semantic conventions include `process.cpu.time` and `process.memory.usage`; CPU time is recommended because it is directly measurable and aggregates more cleanly than derived utilization. [S22]

**RECOMMENDATION:** borrow stable metric names where useful, but make the benchmark's raw OS measurements authoritative. The COMMON benchmark must not depend on a specific telemetry SDK.

---

# 5. Candidate architectures

## Candidate A — JSON-RPC over stdio only

**Shape:** every server/adapter is a child process launched by the caller; one JSON object per line on stdin/stdout.

**Advantages**
- minimal endpoint setup;
- strong parent/child lifecycle;
- easy capture of stderr separately;
- current MCP framing provides a well-documented precedent.

**Weaknesses**
- poor fit for a resident control plane that must outlive a UI;
- reconnect requires process relaunch;
- multi-client access is awkward;
- control-plane recovery and discovery become process-launch concerns.

**Result:** useful transport profile, insufficient as the only profile.

## Candidate B — JSON-RPC over named pipe / Unix socket only

**Shape:** resident local service exposes one OS-native local endpoint.

**Advantages**
- reconnectable;
- suitable for multiple local clients;
- no TCP port;
- OS-native access control;
- same byte-stream framing can be used on both P2/P3.

**Weaknesses**
- slightly more endpoint lifecycle/discovery code;
- spawned one-shot adapters become more complex than necessary.

**Result:** strong resident-service profile, but unnecessary overhead for every child adapter.

## Candidate C — One JSON-RPC semantic contract, two local transport profiles

**Shape**
- `spawned_stdio`: newline-delimited UTF-8 JSON-RPC.
- `resident_local_stream`: identical framing over Windows named pipe or Linux pathname Unix socket.

**Advantages**
- one schema, one error taxonomy, one lifecycle model;
- no transport-specific business/authority semantics;
- stdio retains simple child ownership;
- pipe/socket supplies reconnect/recovery;
- aligns with current MCP's separation of semantics from transport and its recommendation to reuse stdio framing over reliable byte streams. [S02]

**Weaknesses**
- two transport adapters must be tested;
- endpoint discovery/security has platform-specific code;
- forward-compatible framing limits must be explicitly specified.

**Result:** **leading candidate**.

## Candidate D — gRPC over named pipe / Unix socket

**Shape:** protobuf service definitions, generated clients/servers, gRPC local IPC transport.

**Advantages**
- strong generated API contracts;
- built-in deadlines/cancellation/streaming patterns;
- mature multi-language ecosystems;
- current .NET explicitly supports IPC over UDS/named pipes. [S11][S12][S13]

**Weaknesses**
- introduces protobuf/codegen and an RPC runtime before they are required;
- in .NET the server integrates ASP.NET Core/gRPC/HTTP transport machinery;
- transport does not eliminate the need for the COMMON identity/authority/recovery contracts;
- real process count, startup and memory cost are not yet measured.

**Result:** reserve as escalation path if typed cross-language streaming becomes a demonstrated requirement.

## Candidate E — custom protobuf-based IPC

**Shape:** protobuf messages over a custom length-prefixed stream.

**Advantages**
- compact and typed;
- explicit schema evolution.

**Weaknesses**
- the program would need to invent method dispatch, errors, correlation, cancellation, reconnect rules and tooling;
- duplicates capabilities already available in JSON-RPC or gRPC;
- higher implementation risk with no demonstrated need.

**Result:** reject for v0.

## Candidate F — HTTP loopback JSON-RPC

**Shape:** local server bound to loopback, POST request/response API.

**Advantages**
- easy debugging and library support;
- reconnect naturally supported;
- browser clients can reach it.

**Weaknesses**
- requires network-origin/auth protections even on loopback;
- browser pages can potentially reach localhost, creating a larger attack surface;
- ports/discovery/HTTP server are unnecessary for the default desktop control plane.

**Result:** not default. Reconsider only for a justified direct browser client.

## Candidate G — WebSocket loopback

**Shape:** local WebSocket server for full-duplex messages.

**Advantages**
- browser-native duplex;
- reconnect possible;
- mature implementations.

**Weaknesses**
- HTTP handshake + TCP + origin/security concerns;
- more moving parts than a local OS byte stream;
- COMMON protocol currently needs request/response plus cancellation, not browser-native push as a hard requirement.

**Result:** reject for default local control plane.

---

## 5.1 Proposed COMMON local IPC profile v0

### 5.1.1 Wire

**RECOMMENDATION**

- Encoding: UTF-8.
- Message model: JSON-RPC 2.0.
- Framing: one compact JSON-RPC object per line (`\n` delimiter).
- Raw literal newlines are not allowed inside a frame; JSON string newlines are escaped normally.
- `stdout` is protocol-only for stdio bindings; diagnostics go to `stderr`.
- A receiver must apply a documented maximum frame size.
- Oversized results should be externalized as an artifact reference plus content hash rather than placed in the audit/event payload.

**EMPIRICAL TEST NEEDED:** set the exact default `max_frame_bytes` only after measuring representative tool outputs. The conformance suite must require a finite limit even if the initial value differs during the spike.

### 5.1.2 Transport profiles

| Profile | P2 Windows | P3 Linux | Intended use |
|---|---|---|---|
| `spawned_stdio` | stdin/stdout | stdin/stdout | caller-owned child adapter/tool |
| `resident_local_stream` | named pipe with explicit DACL + remote rejection | pathname UDS under private runtime dir | reconnectable control plane |

### 5.1.3 Connection identity

Every physical connection receives a new `connection_id`.

**Invariant:** `connection_id` is never accepted as a substitute for `session_id`, `task_id`, `workspace_id`, `browser_id`, `lease_id`, or authority.

---

## 5.2 Identity contract

### 5.2.1 Required logical identities

| Identity | Meaning | Lifetime | Minting rule |
|---|---|---|---|
| `session_id` | logical workbench interaction/session | CREATED → CLOSED | trusted local control plane |
| `task_id` | logical unit of work | QUEUED → terminal | trusted local control plane |
| `attempt_id` | one execution attempt of a task | per execution/retry | executor/control plane |
| `request_id` | one JSON-RPC invocation | until response/error | request sender; unique among outstanding calls |
| `goal_id` | stable reference to user goal/intention grouping | goal-defined | trusted orchestration layer |
| `lease_id` | opaque reference to Goal Lease/authority grant | authority backend-defined | WAG/authority layer, not model/browser |
| `workspace_id` | logical identity of an approved workspace | until explicit retirement/migration | trusted workspace registry |
| `browser_id` | logical browser context/profile | across intentional browser process restarts | trusted browser controller |
| `browser_instance_id` | one runtime browser process/context generation | process generation | browser controller |
| `process_group_id` | logical task-owned process containment group | attempt lifetime | executor |
| `connection_id` | one pipe/socket/stdio connection | connection lifetime | transport |
| `component_instance_id` | one control-plane process generation | process lifetime | component itself |
| `event_id` | one durable event record | permanent | audit writer |

**RECOMMENDATION:** locally minted IDs use UUIDv7 where implementation support is reliable; otherwise UUIDv4. Externally minted WAG IDs remain opaque and are never re-encoded to fit a local UUID convention.

### 5.2.2 Why `attempt_id` is necessary

A task may be retried after a crash. If the same `task_id` is reused without an attempt identity, process ownership, resource accounting, and side-effect reconciliation become ambiguous.

**RECOMMENDATION:** a retry preserves `task_id` and gets a new `attempt_id`. This allows the durable log to say “same logical task, different execution”.

### 5.2.3 Workspace identity

**RECOMMENDATION:** `workspace_id` is a registry identity, not a hash of a user-provided path.

The registry binds the ID to:
- canonical root path;
- platform-specific root identity where available;
- owner/user;
- creation time;
- optional repository remote/commit metadata for diagnostics.

All relative filesystem tool paths are resolved beneath the registered root.

**SECURITY INVARIANT:** cross-workspace access is denied by default.

**EMPIRICAL TEST NEEDED:** platform-specific containment tests must cover Windows reparse points/junctions and Linux symlink/path-race cases before the workspace guard is considered complete.

### 5.2.4 Browser identity

`browser_id` identifies a logical controlled browser context/profile. `browser_instance_id` identifies one runtime generation.

After a clean or recovery restart:
- `browser_id` may remain the same if the same intended logical context is recovered;
- `browser_instance_id` must change;
- browser DOM/page content does not gain authority because it is associated with either ID.

---

## 5.3 Lifecycle contract

### 5.3.1 Session lifecycle

```text
CREATED
  |
  v
ACTIVE <-------------------+
  |                        |
  | transport/process loss |
  v                        |
DISCONNECTED               |
  |                        |
  v                        |
RECOVERING ----------------+
  |
  v
CLOSED
```

Allowed semantics:

- `CREATED → ACTIVE`: session has a valid local identity and required initial bindings.
- `ACTIVE → DISCONNECTED`: transport/control component disappeared; logical session still exists.
- `DISCONNECTED → RECOVERING`: trusted control plane begins durable-state reconciliation.
- `RECOVERING → ACTIVE`: workspace identity and all required authority references are revalidated; no authority is widened.
- any non-terminal state → `CLOSED`: explicit close, expiry policy, or unrecoverable termination.
- `CLOSED` is terminal.

**Invariant:** reconnecting on a new pipe/socket produces a new `connection_id`; it does not create authority or implicitly restore a lease.

### 5.3.2 Task lifecycle

```text
QUEUED -> RUNNING -> SUCCEEDED
              |----> FAILED
              |----> CANCELLED
              |----> INTERRUPTED
```

`INTERRUPTED` means execution continuity/outcome is not safely known because the executor/control plane or containment boundary was lost.

**RECOMMENDATION:** on control-plane restart, durable tasks last seen as `RUNNING` become `INTERRUPTED` unless the exact attempt can be positively reconciled. Do not silently translate “we lost contact” into `FAILED`.

### 5.3.3 Authority lifecycle representation

Do **not** let the request specify a trusted approval enum.

Request:
- carries `lease_id`;
- may carry an expected non-secret `lease_scope_hash` if WAG exposes one.

Trusted authority evaluation produces one of:

```text
HUMAN_APPROVED
POLICY_APPROVED
DENIED
```

Lease validity is a separate state:

```text
VALID
EXPIRED
REVOKED
UNKNOWN
```

This separation prevents a caller from spoofing approval by writing an `authority_source` field.

---

## 5.4 Structured tool request/result contract

### 5.4.1 Request shape

Illustrative v0 shape:

```json
{
  "jsonrpc": "2.0",
  "id": "0199...",
  "method": "tool.invoke",
  "params": {
    "meta": {
      "protocol_version": "common-workbench/0.1",
      "session_id": "0199...",
      "task_id": "0199...",
      "attempt_id": "0199...",
      "goal_id": "0199...",
      "lease_id": "opaque-wag-lease-ref",
      "workspace_id": "0199...",
      "browser_id": null,
      "created_at": "2026-09-21T03:40:00Z",
      "deadline_at": "2026-09-21T03:40:30Z",
      "request_fingerprint": "sha256:..."
    },
    "tool": {
      "name": "workspace.read",
      "operation": "read"
    },
    "arguments": {
      "path": "docs/state.md"
    }
  }
}
```

### 5.4.2 Minimum required request fields

Always:
- `protocol_version`
- JSON-RPC `id` / `request_id`
- `session_id`
- `task_id`
- `attempt_id`
- `workspace_id` when the operation is workspace-scoped
- `created_at`
- `tool.name`
- `tool.operation`
- `arguments`
- `request_fingerprint`

Conditionally required:
- `goal_id` for goal-bound work;
- `lease_id` for operations requiring authority;
- `browser_id` for browser-bound work;
- `deadline_at` for bounded operations.

### 5.4.3 Result shape

```json
{
  "jsonrpc": "2.0",
  "id": "0199...",
  "result": {
    "meta": {
      "protocol_version": "common-workbench/0.1",
      "session_id": "0199...",
      "task_id": "0199...",
      "attempt_id": "0199...",
      "request_fingerprint": "sha256:...",
      "authority_decision_ref": "opaque-authority-event-ref",
      "completed_at": "2026-09-21T03:40:00.125Z",
      "result_hash": "sha256:..."
    },
    "status": "SUCCEEDED",
    "value": {
      "content": "..."
    }
  }
}
```

### 5.4.4 Result-consumption invariant

A caller must accept a result only when all relevant bindings match its outstanding record:

1. JSON-RPC response `id`;
2. `session_id`;
3. `task_id`;
4. `attempt_id` when consuming attempt-specific output;
5. `request_fingerprint`.

**Security invariant:** a session cannot consume another session's result merely because the tool name/arguments look identical.

---

## 5.5 Request fingerprint

### Canonical projection

**RECOMMENDATION:**

```text
request_fingerprint =
  SHA-256(
    JCS({
      protocol_major,
      session_id,
      task_id,
      goal_id,
      lease_id,
      workspace_id,
      browser_id,
      tool,
      arguments_without_secrets
    })
  )
```

Do not include:
- `request_id`;
- `attempt_id`;
- connection/process IDs;
- created/deadline timestamps;
- trace IDs.

Rationale:
- a retry of the same logical task can be recognized as the same semantic request even though it has a new attempt and request ID;
- session/workspace/lease binding prevents unsafe cross-context result reuse.

### Credential rule

**SECURITY INVARIANT:** raw credentials never appear in the common arguments visible to the model or in the audit/fingerprint input.

Use:

```json
{
  "credential_ref": "cred-handle:github/default",
  "credential_version": "v7"
}
```

The privileged adapter resolves the handle below the model/audit boundary.

**INFERENCE:** hashing a raw low-entropy secret is not an acceptable substitute for keeping it out of the log because hashes can still leak information or become correlatable identifiers.

---

## 5.6 Durable event/audit envelope

### 5.6.1 Event envelope

```json
{
  "schema_version": "common-event/0.1",
  "event_id": "0199...",
  "event_seq": 1821,
  "event_type": "tool.completed",
  "created_at": "2026-09-21T03:40:00.125Z",
  "producer": {
    "component": "p2-control-plane",
    "component_instance_id": "0199..."
  },
  "session_id": "0199...",
  "task_id": "0199...",
  "attempt_id": "0199...",
  "request_id": "0199...",
  "goal_id": "0199...",
  "lease_id": "opaque-ref",
  "workspace_id": "0199...",
  "browser_id": null,
  "authority": {
    "decision": "HUMAN_APPROVED",
    "decision_ref": "opaque-authority-event-ref"
  },
  "payload": {
    "status": "SUCCEEDED"
  },
  "payload_hash": "sha256:..."
}
```

### 5.6.2 Required properties

- append-only logical record;
- stable schema version;
- unique event ID;
- persistent monotonic `event_seq` within one audit store;
- UTC timestamp;
- producer component + process generation;
- all applicable logical identity bindings;
- no raw credentials;
- payload content hash;
- large binary/output data represented by artifact reference + content hash.

### 5.6.3 Durability points

**RECOMMENDATION**

For an authority-bearing tool call:

1. validate schema and identity bindings;
2. obtain trusted authority decision;
3. append `tool.authorized` / `tool.denied`;
4. append `tool.dispatched` before handing work to the executor;
5. execute;
6. append `tool.completed` / `tool.failed` durably;
7. only then expose the final success/error to the caller.

This produces useful restart evidence.

**LIMITATION:** this still does not create general exactly-once external side effects. If a crash occurs after an external system commits a mutation but before the local completion event is durable, recovery may need tool-specific reconciliation or an idempotency key.

### 5.6.4 Tamper model

A plain content hash detects accidental corruption and supports result/request binding. It does not make the local audit store tamper-proof against an attacker who can rewrite both content and hashes.

**OPEN SECURITY QUESTION:** if hostile local administrator/disk modification is in scope later, add an authenticated append chain/signature strategy then. Do not add it to v0 without that threat-model requirement.

---

## 5.7 Error/result taxonomy

The cross-project stable interface is the string `error_class`. Numeric JSON-RPC codes remain protocol/binding details.

Recommended v0 classes:

| `error_class` | Meaning | Retry default |
|---|---|---|
| `PROTOCOL` | invalid JSON-RPC/frame/schema | no |
| `UNSUPPORTED_VERSION` | unsupported COMMON major/version | no |
| `INVALID_ARGUMENT` | valid protocol, invalid tool args | no |
| `AUTHORITY_DENIED` | trusted authority decision denied | no |
| `LEASE_INVALID` | missing/expired/revoked/unknown required lease | no until reauthorized |
| `WORKSPACE_SCOPE_VIOLATION` | attempted access outside registered workspace | no |
| `IDENTITY_MISMATCH` | response/result/binding mismatch | no; security event |
| `STALE_STATE` | request based on stale generation/version | caller may refresh |
| `DEADLINE_EXCEEDED` | deadline elapsed | policy-dependent |
| `CANCELLED` | request/task cancelled | no automatic retry |
| `DISCONNECTED` | local transport lost | reconnect; task outcome may be INTERRUPTED |
| `UNAVAILABLE` | target adapter/control service unavailable | bounded retry if safe |
| `RESOURCE_EXHAUSTED` | explicit resource/frame/concurrency limit | after backoff/remediation |
| `TOOL_FAILED` | tool returned deterministic/application failure | tool-specific |
| `PROCESS_FAILED` | owned execution process exited unsuccessfully | task-specific |
| `INTERNAL` | unexpected trusted-component failure | no blind mutation retry |

**RECOMMENDATION:** do not encode authority semantics solely into JSON-RPC numeric error codes. Store canonical `error_class` under structured `error.data`.

---

# 6. Evidence Ledger

| evidence_id | claim | source | source type / authority | date/version | confidence | applies_to | implementation consequence |
|---|---|---|---|---|---|---|---|
| JSONRPC-001 | JSON-RPC 2.0 defines request IDs, result/error correlation and is not tied to a specific transport. | [S01] | normative specification | JSON-RPC 2.0 | High | COMMON | reuse JSON-RPC message semantics instead of inventing RPC correlation |
| MCP-2026-001 | Current MCP core messages use JSON-RPC; transport semantics are separated from protocol meaning. | [S02][S03] | official protocol specification | 2026-07-28 | High | COMMON/P1/P2/P3 | keep semantic contract transport-independent |
| MCP-2026-002 | MCP stdio uses newline-delimited messages; custom reliable byte streams should reuse stdio framing. | [S02] | official protocol specification | 2026-07-28 | High | COMMON/P2/P3 | same NDJSON framing can be used over stdio, named pipe and UDS |
| MCP-2026-003 | MCP 2026-07-28 is stateless; persistent state must use explicit identifiers, not connection/process identity. | [S03] | official protocol specification | 2026-07-28 | High | COMMON/P1/P2/P3 | make session/task/workspace/lease IDs explicit per request |
| MCP-HTTP-001 | Local HTTP servers need Origin/localhost/auth protections because loopback does not remove browser/DNS-rebinding threats. | [S04] | official protocol security guidance | 2026-07-28 | High | COMMON/P2/P3 | do not select HTTP loopback as default local IPC |
| WIN-PIPE-001 | Named-pipe access is controlled by Windows ACL/security descriptors; a logon SID can isolate access. | [S06] | Microsoft Win32 docs | current doc, last updated 2021-01-07 | High | P2/COMMON | create explicit per-user/per-logon pipe ACL |
| WIN-PIPE-002 | `PIPE_REJECT_REMOTE_CLIENTS` rejects remote clients. | [S07] | Microsoft Win32 API docs | current | High | P2/COMMON | set remote-client rejection on local control endpoint |
| WIN-PIPE-003 | Default named-pipe ACL also grants read access to Everyone and anonymous accounts. | [S07] | Microsoft Win32 API docs | current | High | P2/COMMON | prohibit default pipe security descriptor |
| LINUX-UDS-001 | Linux pathname UDS honors directory/socket permissions; POSIX portability is not universal. | [S09] | Linux man-pages | current | High for Linux | P3/COMMON | use private runtime directory and pathname socket permissions |
| WIN-JOB-001 | Windows Job Objects normally contain child processes and can terminate all associated processes. | [S08] | Microsoft Win32 docs | current | High | P2/COMMON | task attempt ownership should use a Job Object |
| LINUX-CGROUP-001 | cgroup v2 supplies group containment, accounting and `cgroup.kill`. | [S10] | Linux kernel documentation | latest accessed 2026-09-21 | High | P3/COMMON | task attempt ownership should use a cgroup subtree when available |
| LINUX-PIDFD-001 | pidfds provide a stable process reference independent of numeric PID reuse. | [S19] | Linux man-pages / kernel API documentation | pidfd API, current | High | P3/COMMON | prefer pidfd for root-process references; PID alone is diagnostic |
| GRPC-001 | gRPC has deadlines/cancellation, but server application code must cooperate with cancellation. | [S11][S12] | official gRPC docs | current | High | COMMON/P2/P3 | gRPC is viable but does not solve application rollback/recovery |
| GRPC-IPC-001 | .NET supports gRPC IPC over UDS/named pipes, requiring gRPC/ASP.NET Core/protobuf infrastructure. | [S13] | Microsoft official docs | .NET 10 docs accessed 2026-09-21 | High | P2/COMMON | keep gRPC as escalation option, not default v0 dependency |
| PROTO-001 | Protobuf field numbers are wire identities; additive fields can be safe and deleted numbers should be reserved. | [S14] | upstream protobuf docs | current | High | COMMON | if protobuf is adopted later, schema evolution discipline is mandatory |
| WS-001 | WebSocket adds an HTTP opening handshake and a browser-origin-aware full-duplex protocol over TCP. | [S15] | IETF RFC | RFC 6455 | High | COMMON | use only if direct browser-native duplex becomes a hard requirement |
| UUID-001 | RFC 9562 defines UUIDv7 as a Unix-epoch time-based UUID format. | [S16] | IETF Standards Track | RFC 9562, May 2024 | High | COMMON | use UUIDv7 for locally minted sortable logical IDs when supported |
| JCS-001 | RFC 8785 defines deterministic JSON canonicalization for invariant hashing/signing inputs. | [S17] | IETF RFC | RFC 8785 | High | COMMON | use JCS before SHA-256 request/result projection hashes |
| HASH-001 | SHA-256 is a standardized secure hash algorithm. | [S18] | NIST standard | FIPS 180-4 family | High | COMMON | use SHA-256 for non-secret integrity/fingerprint hashes |
| TIME-001 | RFC 3339 provides an interoperable Internet timestamp profile. | [S20] | IETF RFC | RFC 3339 | High | COMMON | write durable event timestamps as RFC3339 UTC |
| TRACE-001 | W3C Trace Context defines trace propagation IDs; MCP reserves trace context metadata. | [S21][S03] | W3C Recommendation + official MCP spec | current | High | COMMON | trace IDs optional for observability; never use as authority/identity |
| METRIC-001 | OTel recommends OS-level `process.cpu.time`; `process.memory.usage` is a defined process metric. | [S22] | OpenTelemetry specification | accessed 2026-09-21 | High | COMMON/P2/P3 | align names where practical; raw OS collector remains benchmark authority |
| WAG-BOUNDARY-001 | WAG is an external authority/execution backend and must not be expanded by COMMON research. | program constraint | user/program authority | 2026-09-21 | High | WAG/COMMON/P1 | common contract carries opaque lease/decision refs only |
| AUTH-001 | Browser/model cannot safely self-assert approval state. | derived from program security model | program invariant | 2026-09-21 | High | COMMON/P1/P2/P3 | `authority_source` is validator output, not client-controlled request input |
| RECOVERY-001 | Lost transport does not establish task outcome; blind retry can duplicate side effects. | JSON-RPC/MCP statelessness + execution semantics | inference | 2026-09-21 | High | COMMON | add INTERRUPTED state and new attempt ID for retries |
| PERF-001 | Structural simplicity is not proof of lower CPU/RAM/startup cost. | benchmark discipline | program requirement | 2026-09-21 | High | COMMON/P2/P3 | no “lightweight” claim until B0-B5 results exist |

---

# 7. Security implications

## 7.1 Common invariants

The following are mandatory across P1/P2/P3:

1. **Browser is never authority.**
2. **Model is never authority.**
3. Browser page content is untrusted input.
4. Structured tools are preferred over UI automation; UI automation is a fallback only when deterministic structured mechanisms do not exist.
5. Security controls are not auto-clicked to increase autonomy.
6. A session cannot mint, extend, widen, or refresh its own Goal Lease.
7. Every authority-bearing request must bind to a trusted `lease_id`.
8. Request scope must be no broader than the validated lease scope.
9. A reconnect/restart revalidates authority; it never silently widens it.
10. One session cannot consume another session's result.
11. Cross-workspace access is default-deny.
12. Raw credentials never enter model-visible logs, event payloads, tool arguments or fingerprints.
13. Task processes are owned by a containment primitive and cleaned as a group.
14. Transport endpoint access is OS-restricted; a local endpoint is not assumed safe merely because it is local.
15. Self-reported component/client names are informational, not security identities.

## 7.2 Authority boundary

A safe authority flow is:

```text
model/browser/UI
      |
      | untrusted request intent
      v
trusted local control plane
      |
      | identity + workspace validation
      v
WAG authority adapter / existing WAG boundary
      |
      | trusted decision + opaque references
      v
executor
```

`HUMAN_APPROVED` and `POLICY_APPROVED` appear only after the trusted decision step.

## 7.3 WAG interface consequence

**UNVERIFIED ASSUMPTION:** the exact current WAG API surface was not provided to this COMMON research owner and must not be reconstructed from memory.

Therefore this report does **not** prescribe a WAG implementation change.

The smallest future adapter requirement, only if missing, is the ability for P1/P2/P3 to obtain or derive:

- an opaque lease/authority reference;
- a trusted allow/deny decision reference;
- binding of that decision to the action/request fingerprint or equivalent request identity;
- a result reference/hash or sufficiently strong result identity;
- expiry/revocation/unknown status when the lease model supports it.

If WAG already exposes equivalents, adapt them at the boundary. Do not add a new authority engine.

## 7.4 Local endpoint hardening

### Windows

Required profile:
- explicit security descriptor/DACL;
- current intended user/logon SID only, plus narrowly justified system principals;
- `PIPE_REJECT_REMOTE_CLIENTS`;
- no default security descriptor;
- no named-pipe impersonation unless a concrete feature requires it; client should not grant impersonation casually.

### Linux

Required profile:
- pathname UDS, not abstract namespace, for v0;
- parent runtime directory owned by the user and mode `0700`;
- socket ownership/permissions checked after creation;
- stale socket path not unlinked blindly while another live owner may exist;
- no network listener by default.

## 7.5 Workspace path security

The contract should require a platform adapter to prove that an operation remains inside the workspace after canonical resolution.

Do not trust lexical checks such as:

```text
requested_path.startsWith(workspace_path)
```

because symlinks/junctions/reparse points and races can invalidate lexical assumptions.

**EMPIRICAL TEST NEEDED:** create explicit platform attack fixtures for:
- `..` traversal;
- symlink escape;
- Windows junction/reparse escape;
- path replacement between validation and open;
- case/canonicalization differences;
- UNC/device path edge cases on Windows.

## 7.6 Restart security

On control-plane restart:

- reload durable logical IDs;
- create a new `component_instance_id`;
- create new transport `connection_id`s;
- revalidate workspace bindings;
- revalidate required leases;
- mark unreconciled `RUNNING` attempts `INTERRUPTED`;
- do not replay mutation purely because no completion record exists.

This avoids converting a crash into extra authority or duplicate side effects.

---

# 8. Performance implications

## 8.1 What can be concluded from documentation

**FACT:** JSON-RPC over stdio/byte streams requires less protocol machinery conceptually than HTTP/gRPC, but documentation alone does not establish the actual runtime RSS, CPU, process count, or startup latency of the implementations P2/P3 will use.

**FACT:** gRPC offers features that could reduce application code for deadlines, cancellation, streaming and generated types. [S11][S12][S13]

**INFERENCE:** those features are not currently required strongly enough to justify adopting their runtime/codegen stack before measurement.

## 8.2 What must be measured

Mandatory measurements:

- cold process-to-ready latency;
- recovery latency;
- process-tree CPU time;
- process-tree physical memory;
- process count;
- thread count;
- Windows handle count / Linux FD count where available;
- per-request latency p50/p95/p99 for deterministic local benchmark calls;
- orphan process count;
- task cleanup latency;
- B2-B1 five-session idle delta;
- B4-B3 active-session scaling delta;
- errors/timeouts.

## 8.3 Measurement source of truth

**RECOMMENDATION:** aggregate resources by ownership boundary rather than by a periodically rediscovered PID list.

- Windows: Job Object membership/accounting plus per-member process metrics where a metric is not directly exposed at job level.
- Linux: cgroup-level CPU/memory/process membership where available.
- Raw OS values are canonical.
- OpenTelemetry-style metric names may be used for export compatibility.

## 8.4 Reporting discipline

Every benchmark result must record:

- host ID label (non-secret);
- OS build/kernel;
- CPU model, logical CPU count;
- RAM total;
- storage type;
- power mode/governor;
- project commit;
- runtime/compiler/toolchain versions;
- benchmark harness version;
- fixture hash;
- transport profile;
- configuration hash.

Do not compare two runs as “Windows vs Linux” if the fixture/toolchain/configuration differs materially.

---

# 9. Architecture decision matrix

Scale: **Strong / Good / Mixed / Weak / Unknown**. This is architectural fit, not a synthetic performance score.

| Candidate | Minimal local complexity | Reconnect | Child-process ownership | OS endpoint ACL | Browser attack surface | Typed codegen | Semantic reuse P2/P3 | Measured footprint |
|---|---|---|---|---|---|---|---|---|
| A. JSON-RPC stdio only | Strong | Weak | Strong | N/A/process boundary | Low | No | Strong | Unknown |
| B. JSON-RPC pipe/UDS only | Good | Strong | Mixed | Strong | Low | No | Strong | Unknown |
| **C. JSON-RPC + two transport profiles** | **Strong** | **Strong** | **Strong** | **Strong** | **Low** | No | **Strong** | **Unknown — benchmark required** |
| D. gRPC pipe/UDS | Mixed | Strong | Mixed | Strong | Low | Strong | Strong | Unknown — benchmark required |
| E. custom protobuf IPC | Weak | Depends on custom work | Depends | Can be strong | Low | Strong | Mixed | Unknown |
| F. HTTP loopback JSON-RPC | Good | Strong | Mixed | Network/auth model | Higher | No | Strong | Unknown |
| G. WebSocket loopback | Mixed | Strong | Mixed | Network/origin model | Higher | No | Strong | Unknown |

### Decision

**RECOMMENDATION:** Candidate C leads because it satisfies the required lifecycle modes with the smallest semantic surface:

- stdio for caller-owned child adapters;
- named pipe/UDS for reconnectable resident control plane;
- identical JSON-RPC envelope and lifecycle semantics.

The decision is reversible because the semantic contract is transport-independent. A later gRPC binding can be added without redefining session/task/workspace/lease semantics.

---

# 10. Unknowns requiring empirical spikes

1. **Frame-size distribution.** Representative tool outputs are needed before fixing the default maximum JSON-RPC frame size.
2. **P2 endpoint ACL implementation.** Verify exact DACL/logon-SID behavior in the chosen Windows language/runtime.
3. **P3 cgroup availability.** Desktop distributions, containers and user-session managers may constrain direct cgroup subtree creation; determine the supported ownership path for P3.
4. **Linux pidfd integration.** Confirm target language/runtime exposes pidfd cleanly or whether a small native wrapper is needed.
5. **Windows process accounting.** Determine the lowest-overhead way to collect job-tree memory/thread/handle metrics without polling excessively.
6. **Workspace containment.** Test symlink/reparse/path-race defenses using real filesystem APIs.
7. **Browser recovery semantics.** Confirm which browser profile/context state can be safely reattached after process death without treating the page as authority.
8. **WAG boundary metadata.** Verify whether current WAG already exposes the lease/decision/result references needed by the common envelope.
9. **Durable audit store.** Measure fsync/commit cost and crash recovery for the chosen P2/P3 local persistence implementation.
10. **JSON serialization/JCS cost.** Measure request fingerprint overhead on representative payload sizes.
11. **B5 build fixture.** Freeze one small offline immutable build/test fixture that both P2/P3 can run with identical toolchain semantics.
12. **Five-session behavior.** Actual CPU/RAM/process scaling cannot be inferred from design.
13. **Deadline clock behavior.** Verify monotonic timeout implementation while storing RFC3339 wall-clock deadlines for audit.
14. **Schema evolution policy.** Confirm whether additive unknown fields should be preserved end-to-end or ignored by each implementation.
15. **Crash-during-mutation reconciliation.** Identify which concrete structured tools support idempotency keys or post-crash state verification.

---

# 11. Minimal benchmark/spike plan

## 11.1 Benchmark harness contract v0

The same scenario definitions and output JSON schema must be implemented by P2 and P3.

### Environment rules

- no public-network dependency in B0-B8;
- test fixture preinstalled/cached;
- no OS reboot/cache purge between normal repetitions;
- first-ever/first-after-install result is reported separately;
- use monotonic clocks for durations;
- use RFC3339 UTC only for event labels;
- sample steady-state resources at **1 Hz** unless a platform collector provides lossless cumulative values;
- wait **15 s settle time** before steady-state windows;
- steady-state window is **60 s** for B1-B5;
- record every failed iteration; do not discard outliers silently.

### Common metrics

```text
startup_ready_ms
recovery_ready_msrequest_latency_ms_p50
request_latency_ms_p95
request_latency_ms_p99
cpu_time_user_s
cpu_time_system_s
memory_bytes_median
memory_bytes_p95
memory_bytes_max
process_count_max
thread_count_max
handle_or_fd_count_max
cleanup_latency_ms
orphans_at_5s
orphans_at_30s
error_count
```

Optional:
- bytes read/written;
- context switches;
- page faults;
- browser-specific process/resource split.

### Benchmark output record

```json
{
  "benchmark_version": "common-bench/0.1",
  "scenario": "B3",
  "run_id": "uuid",
  "host": {
    "os": "...",
    "os_version": "...",
    "cpu": "...",
    "logical_cpu_count": 16,
    "ram_bytes": 34359738368,
    "storage": "...",
    "power_mode": "..."
  },
  "implementation": {
    "project": "P2",
    "commit": "...",
    "runtime": "...",
    "transport": "resident_local_stream",
    "config_hash": "sha256:..."
  },
  "fixture": {
    "id": "common-read-v1",
    "sha256": "sha256:..."
  },
  "window": {
    "settle_seconds": 15,
    "measure_seconds": 60
  },
  "metrics": {}
}
```

---

## 11.2 Exact scenarios

### B0 — cold start

**Goal:** measure process-to-ready cost.

Procedure:
1. control plane fully stopped;
2. no benchmark session exists in memory;
3. record `t0` immediately before process creation;
4. start control plane;
5. connect using resident local stream;
6. issue deterministic `system.ready`/health request;
7. record `t_ready` on valid response;
8. shut down cleanly and verify no owned processes remain;
9. wait 5 s;
10. repeat **20 times**.

Report:
- run 1 separately;
- distribution for runs 2-20;
- startup CPU/memory/process peaks.

### B1 — one session idle

Procedure:
1. start control plane;
2. create one ACTIVE session and bind one benchmark workspace;
3. no browser, shell or task process is started;
4. settle 15 s;
5. measure 60 s at 1 Hz.

Purpose: base per-session idle cost.

### B2 — five sessions idle

Same as B1, but create five distinct ACTIVE sessions bound to the benchmark workspace.

Report:
- total;
- `B2 - B1` delta;
- incremental idle cost per additional four sessions.

### B3 — one active / four idle

Start five sessions.

Session 1:
- every 2 s for 60 s invokes `bench.read_hash`;
- operation reads the same **64 KiB deterministic local fixture** and returns byte count + SHA-256.

Sessions 2-5:
- no requests after setup.

Total expected calls: 30.

Report:
- latency distribution;
- CPU/RAM/process delta vs B2.

### B4 — five read-only active

Five sessions invoke the B3 operation every 2 s for 60 s.

Starts are staggered by 400 ms to avoid creating an artificial single synchronized burst.

Expected total calls: 150.

Report:
- overall and per-session p50/p95/p99;
- resource peaks;
- errors;
- `B4 - B3` delta.

### B5 — one build/test workload

A benchmark manifest defines:
- immutable local fixture ID;
- fixture SHA-256;
- exact toolchain ID/version;
- clean command;
- build command;
- test command;
- expected test count/result hash.

Procedure:
1. start one ACTIVE session;
2. create one task/attempt containment group;
3. run clean → build → test with network disabled;
4. capture containment-level CPU/memory/process metrics;
5. capture total elapsed time;
6. clean task processes and verify zero orphans.

**Comparability rule:** P2/P3 B5 results are not directly comparable unless `fixture_sha256`, benchmark manifest version, and relevant toolchain versions match.

**EMPIRICAL TEST NEEDED:** create/freeze the initial fixture as the first benchmark artifact; do not invent a production-language dependency merely to fill this slot.

### B6 — browser restart recovery

Use a local static benchmark page only.

Procedure:
1. ACTIVE session with logical `browser_id`;
2. start a browser generation and record `browser_instance_id`;
3. verify structured local browser control works;
4. forcibly terminate that owned browser instance;
5. start timer when termination is detected;
6. recover the same intended logical browser context;
7. require a new `browser_instance_id`;
8. revalidate session/workspace/lease references;
9. stop timer when structured browser control is healthy;
10. verify no orphaned old instance at +5 s and +30 s.

Pass invariants:
- `browser_id` may remain stable;
- `browser_instance_id` changes;
- no authority widening;
- no security dialog auto-clicking;
- no old process residue.

### B7 — control-plane restart recovery

Procedure:
1. create one ACTIVE session;
2. queue a deterministic read-only synthetic task lasting ~10 s;
3. after 2 s, forcibly terminate the control-plane process;
4. restart control plane;
5. load durable state;
6. session goes `DISCONNECTED → RECOVERING`;
7. create a new `component_instance_id` and connection ID;
8. reconcile workspace and lease references;
9. any unreconciled prior `RUNNING` attempt becomes `INTERRUPTED`;
10. session returns ACTIVE only after validation.

Pass invariants:
- same logical `session_id`;
- no lease widening;
- no mutation replay;
- prior completed results cannot cross session boundaries;
- durable state survives restart.

### B8 — task process cleanup

Fixture:
- one task root process;
- root starts three child processes;
- each child starts one grandchild;
- total process tree = **7 processes**;
- all would otherwise sleep for 60 s.

Procedure:
1. create a task attempt containment group;
2. start tree;
3. verify all seven belong to the ownership primitive;
4. after 2 s, cancel/terminate the task;
5. measure cleanup latency;
6. check owned group at +5 s and +30 s.

Pass invariants:
- zero live descendants at +5 s;
- zero live descendants at +30 s;
- no process is adopted as an unowned survivor;
- audit contains cancellation/cleanup completion;
- task ends `CANCELLED`, not `SUCCEEDED`.

---

## 11.3 Conformance tests before performance tests

Implement the following protocol tests first:

1. duplicate outstanding `request_id` rejected;
2. missing/unsupported `protocol_version` rejected;
3. response with wrong `session_id` rejected;
4. response with wrong request fingerprint rejected;
5. request cannot self-set trusted approval state;
6. expired/revoked/unknown required lease denied;
7. workspace mismatch denied;
8. reconnect does not change `session_id`;
9. reconnect does change `connection_id`;
10. retry keeps `task_id` and changes `attempt_id`;
11. stale RUNNING task becomes INTERRUPTED after unreconciled restart;
12. closed session cannot reactivate by reconnect alone;
13. credentials/secret patterns never enter audit event payloads;
14. oversized frame fails deterministically;
15. B8 leaves no owned descendants.

---

# 12. Recommended architecture / current leading candidate

## COMMON Contract v0

### Semantic layer
- JSON-RPC 2.0.
- COMMON metadata carried per request.
- JSON Schema 2020-12 recommended for validation.
- explicit logical IDs.
- canonical error classes.
- explicit deadline.
- explicit opaque lease reference.
- request/result binding via fingerprint/hash.
- durable event envelope.

### Transport layer
- `spawned_stdio`.
- `resident_local_stream`.
- same newline framing on both.
- no default TCP listener.

### P2 binding
- named pipe;
- explicit DACL/logon isolation;
- reject remote clients;
- Windows Job Objects for task process ownership.

### P3 binding
- pathname Unix-domain socket under private runtime directory;
- cgroup v2 for task process ownership when available;
- pidfd for strong references to individual executor processes where useful.

### P1/WAG boundary
- P1 consumes the same logical contract;
- WAG remains external authority/executor;
- common layer passes opaque lease/decision/result references;
- no COMMON component mints WAG authority.

### Persistence
- durable event log/store is implementation-local;
- the **event schema and durability semantics**, not the database product, are common.

### Versioning
- initial protocol string: `common-workbench/0.1`;
- unsupported major versions fail closed;
- additive fields must not alter existing authority meaning;
- unknown authority-critical fields must not be silently interpreted permissively.

---

# 13. Reasons alternatives lost

## gRPC lost v0

It did **not** lose because it is technically weak. It lost because the current requirements do not need enough of its extra machinery to justify early coupling.

What gRPC provides:
- generated service contracts;
- mature streaming;
- deadlines/cancellation;
- strong multi-language ecosystem.

What COMMON would still have to design:
- session/task/workspace/browser identity;
- Goal Lease binding;
- authority trust rules;
- result fingerprinting;
- audit lifecycle;
- restart/recovery semantics;
- Windows/Linux process ownership;
- benchmark definitions.

Therefore adopting gRPC now would not remove the difficult program-specific work.

**Reconsider when:** two or more independent language implementations are repeatedly breaking the JSON schema contract, or streaming/backpressure requirements become central and cannot be handled cleanly with the simple request model.

## custom protobuf IPC lost

It combines the maintenance cost of a schema/codegen system with the burden of inventing RPC lifecycle semantics. No current requirement justifies that.

## HTTP loopback lost

It is operationally convenient, but local HTTP still requires origin/auth/DNS-rebinding defense. The desktop control plane does not need a browser-reachable network endpoint by default. [S04]

## WebSocket lost

It solves full-duplex browser connectivity that is not currently a hard requirement and introduces the same network/origin concerns as a local web server.

## single transport only lost

- stdio-only does not fit resident restart/reconnect well;
- pipe/UDS-only makes simple child adapters harder than necessary.

Two bindings over one semantic contract preserve simplicity without semantic duplication.

---

# 14. Near-term implementation consequences

These are small, reviewable consequences, not a large implementation program.

## For P1

- map P1 structured calls onto the common identity/request envelope;
- verify actual WAG metadata before inventing adapter fields;
- treat all WAG lease/decision IDs as opaque;
- never infer approval from ChatGPT/browser state;
- record WAG-facing result identity/hash in the COMMON audit envelope if WAG exposes it.

## For P2

- implement a minimal JSON-RPC codec once;
- implement stdio and named-pipe bindings with identical frames;
- create explicit named-pipe security descriptor;
- set remote-client rejection;
- create task Job Objects before launching executor trees;
- collect B0-B8 using job-aware measurements.

## For P3

- reuse the same JSON-RPC schemas and framing;
- implement pathname UDS endpoint in a private runtime directory;
- implement cgroup-v2 ownership or document the constrained fallback;
- use pidfd where practical for individual root process references;
- run identical B0-B8 definitions.

## For all three

Before feature work, freeze:
1. ID semantics;
2. lifecycle enums;
3. request/result meta schema;
4. event envelope;
5. error classes;
6. benchmark output schema.

Do **not** freeze:
- implementation language;
- GUI/runtime;
- persistent database product;
- P4 extraction;
- gRPC/protobuf dependency.

---

# 15. Reusable findings for the other projects

## P1 reusable findings

- connection/process identity is not session identity;
- WAG authority must stay external and opaque;
- request/result binding should survive browser/control-plane reconnect;
- browser page content must never populate trusted approval fields.

## P2 reusable findings

- Windows named pipes can be strongly local only if explicit ACL and remote rejection are configured; defaults are too permissive for this authority boundary;
- Job Objects are the correct task-process ownership primitive;
- reconnectable resident service and caller-owned child adapters can share one wire schema.

## P3 reusable findings

- Linux pathname UDS provides filesystem permission-based local endpoint control;
- cgroup v2 provides a stronger task-tree ownership/accounting primitive than PID discovery;
- pidfd is preferable to numeric PID alone for individual process references.

## COMMON reusable findings

- semantic identity must be explicit and transport-independent;
- `task_id` and `attempt_id` solve different problems and both are required;
- result binding needs session + request fingerprint, not only tool name/args;
- `INTERRUPTED` is needed for truthful crash recovery;
- timestamps and trace IDs are observability, not authority;
- content hashes are useful but are not tamper-proof audit signatures.

## WAG reusable findings

- COMMON should request the smallest metadata surface needed for binding and audit;
- it should not move authority decisions into the workbench;
- an adapter mismatch later should be solved with the smallest interface mapping, not a WAG redesign.

---

# 16. Open questions

1. What exact fields and lifecycle does the current WAG Goal Lease expose?
2. Can WAG return a stable decision/receipt/result reference without backend changes?
3. Which P2 runtime will own the named-pipe server and Job Object handles?
4. Which P3 deployment model will own cgroup subtrees: direct user cgroup, systemd user scope, or another bounded mechanism?
5. What maximum JSON frame size covers normal results without encouraging large inline blobs?
6. What audit-store technology gives the desired durability with acceptable fsync cost on the actual workstation hardware?
7. Does browser recovery require preserving a profile directory, an automation context, or both?
8. Which tool operations are safe to retry automatically, and which have external side effects requiring reconciliation?
9. What should the first immutable B5 build/test fixture be?
10. How strict should forward compatibility be for unknown non-authority fields?
11. Is local hostile-user/admin tampering in the audit threat model, or only accidental corruption/process failure?
12. Which platform-specific path-opening APIs can best enforce “beneath workspace” semantics against symlink/reparse races?
13. Should sessions be explicitly time-limited independently of Goal Lease expiry?
14. Does any P1/P2/P3 caller genuinely need server-initiated streaming before v1?
15. What resource-regression threshold should become a CI gate after the first stable baseline is collected?

---

# 17. Handoff capsule

## 17.1 Ten most important confirmed facts

1. **MCP 2026-07-28 is JSON-RPC-based and transport semantics are separated from protocol semantics.** [S02][S03]
2. **MCP 2026-07-28 explicitly recommends reusing newline stdio framing on reliable custom byte streams such as Unix-domain sockets.** [S02]
3. **A connection/process is not a session; state spanning requests needs explicit identifiers.** [S03]
4. **Windows named pipes support explicit ACL isolation and remote-client rejection; the default ACL is too permissive for this boundary.** [S06][S07]
5. **Linux pathname Unix sockets can use directory/socket permissions as a Linux-local access-control layer.** [S09]
6. **Windows Job Objects provide task-process grouping, child association and group termination.** [S08]
7. **Linux cgroup v2 provides group-level containment/accounting/kill semantics.** [S10]
8. **gRPC is viable over local IPC and supplies deadlines/cancellation, but it does not replace the program-specific identity/authority/recovery contracts.** [S11][S12][S13]
9. **RFC 8785 JCS + SHA-256 provides a standard basis for deterministic non-secret request/result hashing.** [S17][S18]
10. **Actual “lightweight” performance remains unverified until the common B0-B8 benchmark is run.**

## 17.2 Five remaining uncertainties

1. Exact current WAG lease/decision/result metadata.
2. P3 cgroup-v2 ownership mechanism under the chosen desktop/runtime environment.
3. P2/P3 real startup/RAM/CPU/process scaling under B0-B5.
4. Correct initial max frame size and durable-event-store cost.
5. Safe recovery/idempotency behavior for real mutating tools after crash.

## 17.3 Recommended next action

**Do not create P4 and do not modify WAG.**

The next action is a **small conformance + benchmark spike in P2 and P3**:

1. independently implement the same v0 identity/envelope/lifecycle schema;
2. implement `spawned_stdio` plus platform-native `resident_local_stream`;
3. implement only a deterministic read/hash benchmark tool and B8 process-tree fixture;
4. run conformance tests;
5. run B0-B4 and B8 first;
6. then add B5-B7 after persistence/browser recovery hooks exist;
7. compare semantic divergence and measured resource cost before freezing v1.

## 17.4 Exact artifacts another session should consume

Primary artifact:
- `COMMON_AI_WORKBENCH_CONTRACTS_AND_BENCHMARKS_2026-09-21.md` — this file; treat it as the COMMON research authority until superseded.

Embedded reusable artifacts inside this report:
- Section 5.2 — Identity Contract.
- Section 5.3 — Lifecycle Contract.
- Section 5.4 — Tool Request/Result Contract.
- Section 5.6 — Durable Event/Audit Envelope.
- Section 5.7 — Error/Result Taxonomy.
- Section 6 — Evidence Ledger and stable evidence IDs.
- Section 11 — Benchmark Contract v0 and B0-B8.
- Section 12 — Leading Architecture.
- Section 17.5 — research not to repeat.

No portable-core repository or implementation artifact is authorized by this report.

## 17.5 Research that SHOULD NOT be repeated

Unless upstream versions change or a concrete implementation contradiction appears, do not repeat:

- whether JSON-RPC can be transport-independent;
- whether newline JSON-RPC can be reused over a reliable local byte stream;
- whether an IPC connection should be treated as a session;
- whether Windows named pipes have ACLs / remote-client rejection;
- whether Linux pathname UDS has Linux filesystem permission semantics;
- whether Windows Job Objects can own/terminate process groups;
- whether Linux cgroup v2 provides group process/resource control;
- whether gRPC can run over named pipes/UDS;
- whether protobuf supports forward-compatible additive fields;
- whether RFC 8785 provides deterministic JSON canonicalization;
- whether UUIDv7 is standardized;
- whether HTTP loopback needs local-origin/auth hardening.

Research again only when:
- a cited upstream specification changes;
- a platform implementation contradicts the documented semantics;
- a benchmark exposes a material cost/behavior not explained by the current model;
- a real WAG interface constraint invalidates the assumed adapter mapping.

---

# Source register

**[S01]** JSON-RPC 2.0 Specification — jsonrpc.org/specification — version 2.0.  
https://www.jsonrpc.org/specification

**[S02]** Model Context Protocol — Transports Overview — official MCP specification, 2026-07-28.  
https://modelcontextprotocol.io/specification/2026-07-28/basic/transports

**[S03]** Model Context Protocol — Base Protocol Overview — official MCP specification, 2026-07-28.  
https://modelcontextprotocol.io/specification/2026-07-28/basic/index

**[S04]** Model Context Protocol — Streamable HTTP transport — official MCP specification, 2026-07-28.  
https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http

**[S05]** Model Context Protocol — stdio transport — official MCP specification, 2026-07-28.  
https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio

**[S06]** Microsoft Learn — Named Pipe Security and Access Rights.  
https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights

**[S07]** Microsoft Learn — CreateNamedPipe function, including `PIPE_REJECT_REMOTE_CLIENTS` and default security descriptor behavior.  
https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea

**[S08]** Microsoft Learn — Job Objects.  
https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects

**[S09]** Linux man-pages — `unix(7)` pathname socket ownership and permissions.  
https://man7.org/linux/man-pages/man7/unix.7.html

**[S10]** Linux Kernel Documentation — Control Group v2.  
https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html

**[S11]** gRPC official docs — Deadlines.  
https://grpc.io/docs/guides/deadlines/

**[S12]** gRPC official docs — Cancellation.  
https://grpc.io/docs/guides/cancellation/

**[S13]** Microsoft Learn — Inter-process communication with gRPC, .NET/ASP.NET Core.  
https://learn.microsoft.com/en-us/aspnet/core/grpc/interprocess?view=aspnetcore-10.0

**[S14]** Protocol Buffers upstream docs — proto3 Language Guide / updating message types.  
https://protobuf.dev/programming-guides/proto3/

**[S15]** IETF RFC 6455 — The WebSocket Protocol.  
https://www.rfc-editor.org/rfc/rfc6455

**[S16]** IETF RFC 9562 — Universally Unique IDentifiers (UUIDs), May 2024.  
https://www.rfc-editor.org/rfc/rfc9562.html

**[S17]** IETF RFC 8785 — JSON Canonicalization Scheme (JCS).  
https://www.rfc-editor.org/rfc/rfc8785.html

**[S18]** NIST FIPS 180-4 — Secure Hash Standard, SHA-2 family.  
https://csrc.nist.gov/pubs/fips/180-4/upd1/final

**[S19]** Linux man-pages — `pidfd_open(2)`.  
https://man7.org/linux/man-pages/man2/pidfd_open.2.html

**[S20]** IETF RFC 3339 — Date and Time on the Internet: Timestamps.  
https://www.rfc-editor.org/rfc/rfc3339.html

**[S21]** W3C Recommendation — Trace Context.  
https://www.w3.org/TR/trace-context/

**[S22]** OpenTelemetry Semantic Conventions — OS process metrics.  
https://opentelemetry.io/docs/specs/semconv/system/process-metrics/

---

# Final decision statement

**RECOMMENDATION:** freeze the semantic contract before implementation proliferation, but keep the runtime decentralized.

The minimum shared substrate is:

```text
COMMON semantics
  = IDs
  + lifecycle
  + lease/result binding
  + request/result/event schema
  + error taxonomy
  + benchmark contract

P2 transport/runtime
  = stdio + Windows named pipe + Job Objects

P3 transport/runtime
  = stdio + Unix-domain socket + cgroup v2/pidfd

P1/WAG boundary
  = common references/adapters only
  != new authority engine

P4
  = NOT YET
```

P4 becomes a justified engineering project only after evidence shows that duplicated **authority-critical** logic is causing recurring defects, divergence, or measurable maintenance cost. Until then, a shared specification and conformance/benchmark contract provide the needed reuse with less coupling and lower extraction risk.