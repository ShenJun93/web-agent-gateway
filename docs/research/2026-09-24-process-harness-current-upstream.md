# Process Harness upstream evidence — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE RECHECK / SOURCE DESIGN INPUT

## Node child_process

Current Node documentation keeps child_process.spawn as the direct asynchronous argv primitive.
The spawn options support explicit cwd, env, detached and stdio. On Windows, detached=true allows
a child to continue independently of the parent. Pipes remain available when stdio is configured
as pipe, which lets WAG own bounded stdin/stdout/stderr while the request that created the process
has already returned.

Official source:
- https://nodejs.org/api/child_process.html

Disposition:
- ProcessPort backend uses spawn(file, argv, { shell:false });
- environment is constructed through WAG's existing sanitizeLocalMachineEnvironment;
- process identity is an opaque ProcessPort handle plus exact authority tuple, never just a PID;
- BrowserPort uses ProcessPort rather than spawning Edge from arbitrary shell text.

## Windows exact process-tree cleanup

Current Microsoft taskkill documentation supports selecting an exact /PID and /T to include child
processes; /F forces termination. The repository already has measured evidence for the same
exact-PID tree-cleanup pattern in ADR-0025.

Official source:
- https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill

Disposition:
- Windows ProcessPort cleanup is rooted at the exact PID WAG spawned;
- no image-name, wildcard or broad process kill is used;
- cleanup remains available after the effect/kill switch closes so an already-owned process cannot
  become an orphan merely because new effects are denied;
- no native Job Object dependency is introduced in this source slice.

## Non-decision

This receipt does not claim durable process recovery after a WAG runtime crash. The current
ProcessPort registry is in-memory. A later resource-recovery slice must persist enough immutable
identity to inspect/recover exact-owned residue without adopting arbitrary same-user processes.
