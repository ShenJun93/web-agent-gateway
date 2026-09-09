# ADR-0005: Benchmark the Safe V0 Surface Before Mutation

Status: Accepted
Date: 2026-09-09

## Context
The DC baseline scenario includes symbol search and a source patch. V0 intentionally exposes only `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`; `file.patch`, raw shell, and Git mutation are phase-gated until the architecture proves value and safety.

Reusing `verify.run` to perform a patch would disguise mutation as verification and violate ADR-0003. Adding a mutation tool merely to satisfy the benchmark would also reverse the intended gate order.

## Decision
V0 acceptance first compares the read/verify portion that both systems can perform honestly. The gateway run uses `workspace.open`, `repo.snapshot`, five bounded reads, `verify.run`, and a final `repo.snapshot`. Report both cold timing (including `workspace.open`) and warm timing (reusing the workspace ID).

The comparable DC subset is derived from the already-recorded raw baseline: initial snapshot, five reads, first test, and final status. No failed baseline data is discarded.

## Consequences
- A V0 GO means the provider-neutral read/verify architecture merits further investment; it is not a claim of full coding equivalence.
- Full mutation task completion remains unproven until a separate post-GO mutation spike is approved and benchmarked.
- Task 3 public transport acceptance may still be BLOCKED if no stable named tunnel or equivalent endpoint is configured; provisional Quick Tunnel measurements must be labeled separately.
- ChatGPT Plus deployment remains the independent BLOCKED gate from ADR-0004.
