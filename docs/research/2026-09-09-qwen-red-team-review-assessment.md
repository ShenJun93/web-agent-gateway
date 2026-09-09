# Qwen Red-Team Review Assessment

Date: 2026-09-09
Status: REVIEWED EXTERNAL INPUT

## Purpose
This document records which Qwen review findings are accepted, accepted with changes, deferred, or rejected. External review is not canonical authority by itself; canonical authority remains approved specs/ADRs/plans plus executable evidence.

## Accepted
- DevSpace is a policy-gated, privileged local execution backend, not a sandbox.
- DevSpace must bind localhost only and must never be the public tunnel target.
- Public MCP must require authentication; anonymous access is not acceptable.
- Windows path containment needs OS-aware tests beyond lexical resolve/relative checks, including junction/reparse/UNC/device-path cases where applicable.
- `repo.snapshot` should be a primary latency-reduction primitive and must have output/token budgets.
- Workspace operations should be bounded by a `workspace_id` rather than arbitrary raw paths on every call.
- Approval, when added, must be local, one-time, action-fingerprint-bound, and replay-resistant.
- Repository content and command output are untrusted data for policy purposes; prompt injection must not alter gateway policy or approval state.
- Read-only Git helpers should use hardened invocation settings and avoid external diff/pager/config surprises.
- Compatibility tests are required for every pinned DevSpace upgrade.

## Accepted with changes
- Remove arbitrary raw `command.run` from the V0 public tool surface. Use configured `verify.run` profiles first; arbitrary command execution is a later explicit-developer-mode feature.
- Keep strict security invariants in the spike, but do not build a full approval dashboard, secret vault, sandbox platform, or large policy engine before the value gate.
- Do not claim V0 protects against malicious repositories or malicious commands at OS-sandbox strength. V0 protects the bounded workflow through policy/containment; stronger OS isolation is a later gate if required.
- Git `status`/`diff` are not treated as universally dangerous, but wrappers must neutralize avoidable external behavior and be tested against hostile repo/config fixtures.

## Deferred
- Dedicated low-privilege Windows account, WSL2/container/Windows Sandbox execution.
- SQLite state store for persistent approvals/jobs.
- Durable job reattachment after DevSpace process restart.
- `git.commit`, `git.push`, arbitrary shell, network egress controls, multi-user policy.

These are revisited only after the V0 pipeline proves latency/reliability value or if a prerequisite requires them.

## Rejected for V0
- Importing or forking DevSpace to remove the localhost hop before measuring it.
- Expanding to a large component tree before empirical need exists.
- Treating historical successful actions as implicit privilege escalation or auto-approval.
- Adding Git mutation merely to make the prototype feel feature-complete.

## Final effect on architecture
The COMPOSE decision remains unchanged. The V0 surface becomes safer and smaller:

`Web AI -> authenticated public MCP -> owned gateway -> pinned localhost DevSpace -> disposable/trusted fixture repo`

Initial public tools: `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`.

`file.patch` is added only after the read/verify pipeline and policy boundary pass their prerequisite gate. Arbitrary shell and Git mutation are explicitly outside the initial spike.
