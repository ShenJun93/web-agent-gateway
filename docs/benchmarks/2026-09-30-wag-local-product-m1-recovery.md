# WAG Local Productization M1 Recovery Acceptance

Date: 2026-09-30  
Result: **PASS** for destructive service-crash recovery  
Base source HEAD: `27e62d5ed959ac5686cef7d37246234170f479d5`

## Scope

This receipt records the M1 recovery harness that was actually executed on the live WAG Local stack:

- safe lifecycle/reconciliation checks;
- destructive tunnel-client termination and autonomous recovery;
- destructive managed DevSpace termination and autonomous recovery.

It does **not** claim a Windows reboot or power-loss test. Those remain unmeasured.

Machine-readable committed evidence:

```text
docs/benchmarks/2026-09-30-wag-local-product-m1-recovery.json
```

The original runtime receipts remain under:

```text
%LOCALAPPDATA%\WAG-Local\receipts\
```

## Final receipts

| Case | Result | Elapsed | Receipt SHA-256 |
| --- | --- | ---: | --- |
| PowerShell 5 re-entry | PASS | 2418 ms | `63286b93...` safe batch |
| stale PID reconciliation | PASS | 1839 ms | `63286b93...` safe batch |
| launcher drift repair | PASS | 533 ms | `63286b93...` safe batch |
| autostart drift repair | PASS | 718 ms | `63286b93...` safe batch |
| live tunnel crash recovery | PASS | 22865 ms | `cff45482af0b3b193f42f356e56e0b8ae2066dc6b36c6ec9fbaee6b1e6845df1` |
| live DevSpace crash recovery | PASS | 18987 ms | `55b4ee995854f977cec3b7ea7c9ab93a56eb22da932980b85312b719e2ab243c` |

Safe batch receipt SHA-256:

```text
63286b93e544f861934358358509116db7275763e9c30618a4c85d22bb25b6f7
```

## Defects found and closed

### 1. Stale PID diagnostic polluted the success pipeline

`Read-LivePid` emitted `WAG_STALE_PID_CLEARED=...` with `Write-Output`. PowerShell therefore
captured the diagnostic into `$existingPid`, and a later `Get-Process -Id` attempted to parse the
diagnostic string as an integer.

The diagnostic now uses the host stream, preserving the function return contract. Regression checks
prevent `WAG_STALE_PID_CLEARED` from returning through the success pipeline.

### 2. DevSpace death while the tunnel launcher stayed alive

The foreground launcher remained alive inside tunnel-client after its managed DevSpace child was
terminated. The starter saw a live launcher PID and waited instead of repairing DevSpace.

The starter now distinguishes tunnel readiness from full-stack readiness. When the tunnel is ready
but DevSpace discovery is down, it invokes the canonical launcher with `-EnsureDevSpaceOnly`.
This repairs DevSpace without unnecessarily replacing the healthy tunnel.

The destructive rerun passed after this repair.

## Final verification

```text
git diff --check
PASS

npm run typecheck
PASS

npm run test:wag-product
8 tests
8 pass
0 fail

npm run wag:health
status                  READY
launchers canonical     true
startupTargetsSupervisor true
supervisorRunning       true
DevSpace exact pin      true
DevSpace discovery      HTTP 200
tunnel healthz          HTTP 200
tunnel readyz           HTTP 200
fresh MCP roundtrip     PASS
MCP tool count          53
authority               AUTONOMOUS_LOCAL
```

The pre-commit health receipt reports the worktree as dirty and the development HEAD as different
from the deployed runtime HEAD. Those diagnostics are expected while this acceptance fix is being
committed; neither made the executable product path unavailable.

## Decision

```text
M1_SERVICE_CRASH_RECOVERY = PASS
TunnelCrash               = PASS
DevSpaceCrash              = PASS
FULL_WINDOWS_REBOOT        = NOT_MEASURED
POWER_LOSS_RECOVERY        = NOT_MEASURED
```

No public push is part of this acceptance.
