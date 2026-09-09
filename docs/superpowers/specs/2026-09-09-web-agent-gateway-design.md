# Web Agent Gateway Design

Status: APPROVED for V0 benchmark spike.

## Problem
Remote Desktop Commander is useful for ChatGPT Web Plus but recent remote/session latency makes many small coding tool calls expensive and hard to diagnose.

## Objective
Create a provider-neutral gateway that exposes a small MCP tool surface to Web AI clients while delegating local execution to proven upstream components.

## Architecture
Web AI -> authenticated public MCP endpoint -> thin policy/telemetry gateway -> exact-pinned localhost DevSpace -> local repo/process/Git.

DevSpace is a policy-gated, privileged local execution backend. It is not a security sandbox and is never exposed directly to the public tunnel.

## Owned responsibilities
- provider capability mapping
- authentication and request identity at the public boundary
- strict/context-aware policy classification
- workspace-ID-to-canonical-root containment
- one-time fingerprint-bound local approvals when mutation is introduced
- semantic tool aggregation and output budgets
- audit, correlation IDs, and latency telemetry
- DevSpace compatibility/conformance tests

## Reused responsibilities
- DevSpace: files, search, PTY/process sessions, Git/worktrees, optional agent adapters.
- LocalAnt: donor patterns for risk, approvals, redaction, audit, path/command guards.
- Official MCP SDK: protocol.
- Cloudflare Tunnel: V0 transport candidate, subject to empirical acceptance.

## V0 initial public tool surface
- `health`
- `workspace.open`
- `repo.snapshot`
- `file.read`
- `verify.run`

`verify.run` executes only configured workspace verification profiles. The initial spike does not expose arbitrary raw shell strings.

`file.patch` is phase-gated and may be added only after host, transport, executor, telemetry, and path-containment prerequisites pass.

## Threat model and limitations
- Public MCP must not accept anonymous callers.
- Workspace operations use opaque `workspace_id` values mapped to canonical allowed roots; drive roots are not valid workspaces.
- Repository content, project instructions, command output, and model output are data from the policy engine's perspective and cannot override policy or approval state.
- Windows path containment requires explicit hostile-path tests, not only lexical resolve/relative checks.
- V0 is not an OS sandbox against malicious repositories or intentionally executed malicious commands.
- Stronger OS isolation, persistent approval/job stores, arbitrary shell, Git mutation, and network egress controls are deferred until evidence requires them.

## V0 exclusions
No browser scraping, custom hosted relay, multi-device routing, ACP/A2A orchestration, skill marketplace, production plugin submission, arbitrary shell, or Git mutation.

## Success gate
Proceed beyond the spike only when the gateway demonstrates materially better end-to-end task performance and/or clearly fewer remote tool turns with better reliability than Remote Desktop Commander, zero silent drops in acceptance runs, full correlation-ID accounting, durable local execution across transport loss, acceptable approval/interaction friction for the tested surface, and passing strict path/auth/reconnect tests.

Architecture viability and immediate ChatGPT Plus deployment viability are reported as separate gate results.
