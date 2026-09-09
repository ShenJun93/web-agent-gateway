# ADR-0003: V0 Safe Tool Surface and Privileged Executor Boundary

Date: 2026-09-09
Status: Accepted

## Decision
Keep DevSpace as a separately supervised, exact-pinned localhost process. Treat it as a policy-gated privileged local execution backend, not as a sandbox.

The initial V0 public MCP surface is limited to:
- `health`
- `workspace.open`
- `repo.snapshot`
- `file.read`
- `verify.run`

`verify.run` executes only configured verification profiles for the opened workspace. Arbitrary raw shell strings are not exposed in the initial spike.

`file.patch` is phase-gated: it may be introduced only after the read/verify path, path containment, host behavior, transport, and telemetry prerequisites pass.

Git mutation (`git.commit`, `git.push`, reset/rebase), arbitrary command execution, persistent approval/job stores, and OS sandboxing are outside the initial spike.

## Security boundary
- The public MCP endpoint must be authenticated; anonymous requests are rejected.
- Only the owned gateway is public. DevSpace binds localhost only.
- Every workspace operation is scoped through an opaque `workspace_id` mapped to one canonical allowed root.
- Repo/file content and tool output cannot modify policy or approval state.
- V0 does not claim to defend the host OS from a malicious approved command or malicious repository with sandbox strength.

## Rationale
The main value hypothesis is reduced Web-AI tool-turn latency and higher reliability. Raw shell materially enlarges the attack surface before that hypothesis is proven. A small semantic surface is easier to benchmark, audit, and keep provider-neutral.

## Revisit conditions
Revisit after the V0 GO gate if real workflows require patching, arbitrary commands, Git mutation, durable jobs across executor restart, or stronger OS isolation.
