# ADR-0001: Compose DevSpace Behind a Policy Gateway

Date: 2026-09-09
Status: Accepted

## Decision
Do not fork Desktop Commander, DevSpace, or LocalAnt wholesale. Keep DevSpace as an upstream local execution backend behind a gateway we own.

## Rationale
- DevSpace already provides mature file/process/Git/worktree and modern MCP compatibility.
- Forking it would create high upstream merge debt for a solo maintainer.
- LocalAnt has useful security/approval patterns but a broader tool surface and different session assumptions than required.
- Desktop Commander remains a benchmark and donor, not the new foundation.

## Consequences
The owned surface stays small: policy, approvals, provider compatibility, semantic tool compression, telemetry, and benchmark/conformance tests.

DevSpace must bind localhost only. Public traffic terminates at the owned gateway.

## Revisit conditions
Revisit only if DevSpace becomes unmaintained, cannot satisfy benchmark/security gates, or its compatibility cost exceeds implementing a smaller local executor.
