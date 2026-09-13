# ADR-0012: Use Capability-Specific Backends

Date: 2026-09-13
Status: Proposed

WAG will not treat one local executor as the permanent implementation for every capability.

The control plane defines narrow backend contracts for file changes, command/verification work and browser work. DevSpace may remain the first adapter for capabilities already proven by the spike, but it is replaceable behind those contracts.

Backend choice must not change durable ids, host-facing semantics, local review semantics or audit records.

Future replacements are selected by measured Windows compatibility, latency, restart behavior and security tests rather than by sunk implementation cost.
