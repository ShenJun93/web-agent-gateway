# WAG Local self-healing startup recovery

Date: 2026-09-29

## Incident

A live WAG Local reconnect repeatedly failed with `Session terminated`.

Measured sequence:

1. neither `127.0.0.1:7677` nor `:8080` was listening;
2. the tunnel client could start, but its WAG stdio child emitted `DEVSPACE_AUTH_FAILED`;
3. the stdio child exited, so the tunnel client shut down;
4. the exact-pinned DevSpace checkout required by the local stack was no longer present;
5. after restoring DevSpace at exact revision
   `33d6d0bcc2256024484d2456da924af8afd814ed`, DevSpace returned HTTP 200;
6. launching the historical tunnel script through `powershell.exe` still failed because
   Windows PowerShell 5.1 could see but could not load the PowerShell 7
   `Microsoft.PowerShell.Security` module;
7. launching the same script through `pwsh.exe` 7.6.6 succeeded and restored the live WAG MCP
   surface.

No credential value was printed or persisted in repository files during recovery.

## Fix

The local launch path is now repository-owned instead of an unversioned machine-only script.

- `scripts/wag-local-tunnel-launcher.ps1`
  - re-enters PowerShell 7 when invoked from Windows PowerShell;
  - explicitly imports `Microsoft.PowerShell.Security`;
  - health-checks DevSpace OAuth discovery before starting the tunnel;
  - restores the exact DevSpace pin when the managed checkout is absent;
  - installs/builds the exact pin only when needed;
  - starts DevSpace separately on the existing localhost boundary;
  - waits for DevSpace readiness before starting tunnel-client;
  - refuses an unexpected listener on ports 7677 or 8080;
  - keeps DPAPI secret material out of argv and clears decrypted environment variables.

- `scripts/wag-local-start.ps1`
  - is the idempotent one-command entry point;
  - re-enters PowerShell 7;
  - returns immediately when WAG is already healthy;
  - otherwise starts the tunnel launcher and waits for `:8080` health.

- `scripts/install-wag-local-launchers.ps1`
  - installs the canonical scripts into `%LOCALAPPDATA%\WAG-Local`.

- runtime promotion scripts now refresh the local launcher copies before starting a promoted
  runtime, preventing machine-local launcher drift.

This preserves ADR-0002: DevSpace remains a separate localhost-only process. The launcher is only
an orchestrator; the Gateway does not import or own DevSpace internals.

## Acceptance

Observed on the affected Windows host:

```text
DEVSPACE_READY=True
DEVSPACE_RECOVERY=NOT_NEEDED
WAG_LOCAL_READY=True
WAG_LOCAL_RECOVERY=NOT_NEEDED
```

Repository checks:

```text
npm run typecheck
PASS

npx tsx --test test/wag-local-launcher.test.ts
3 tests
3 pass
0 fail
```

The production copies were installed to:

```text
%LOCALAPPDATA%\WAG-Local\Start-WagLocalTunnel.ps1
%LOCALAPPDATA%\WAG-Local\Start-WagLocal.ps1
```

The live WAG surface remained healthy after installation.

## Remaining boundary

A fully destructive cold-start acceptance that intentionally terminates the currently active
tunnel is not performed from the same live MCP session because doing so would deliberately sever
the control channel running the test. The recovery path is instead covered by exact-pin checks,
PowerShell parse tests, the live DevSpace health path, and the idempotent live startup path.
