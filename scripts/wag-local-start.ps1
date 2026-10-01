param(
    [int]$StartupTimeoutSeconds = 60,
    [int]$Attempts = 4
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        & $pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -StartupTimeoutSeconds $StartupTimeoutSeconds -Attempts $Attempts
        exit $LASTEXITCODE
    }

    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $launcher = Join-Path $base 'Start-WagLocalTunnel.ps1'
    $logs = Join-Path $base 'logs'
    $stdout = Join-Path $logs 'wag-local.stdout.log'
    $stderr = Join-Path $logs 'wag-local.stderr.log'
    $repairStdout = Join-Path $logs 'wag-local-devspace-repair.stdout.log'
    $repairStderr = Join-Path $logs 'wag-local-devspace-repair.stderr.log'
    $pidFile = Join-Path $logs 'wag-local-launcher.pid'

    New-Item -ItemType Directory -Path $logs -Force | Out-Null

    function Write-Diagnostic([string]$Code, [string]$Message) {
        Write-Output "WAG_DIAGNOSTIC_CODE=$Code"
        Write-Output "WAG_DIAGNOSTIC_MESSAGE=$Message"
    }

    function Test-HttpOk([string]$Url) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        }
        catch { return $false }
    }

    function Test-TunnelReady {
        return Test-HttpOk 'http://127.0.0.1:8080/readyz'
    }

    function Test-Ready {
        return (Test-TunnelReady) -and
            (Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server')
    }

    function Read-LivePid([string]$Path) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        $value = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $Path -Raw).Trim(), [ref]$value)) {
            Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            Write-Host 'WAG_STALE_PID_CLEARED=launcher-invalid'
            return $null
        }
        if (Get-Process -Id $value -ErrorAction SilentlyContinue) { return $value }
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        Write-Host "WAG_STALE_PID_CLEARED=launcher-$value"
        return $null
    }

    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        Write-Diagnostic 'WAG_LAUNCHER_MISSING' 'The canonical local tunnel launcher is missing.'
        throw "STOP: missing WAG tunnel launcher: $launcher"
    }

    $existingPid = Read-LivePid $pidFile

    if (Test-Ready) {
        Write-Output 'WAG_LOCAL_READY=True'
        Write-Output 'WAG_LOCAL_RECOVERY=NOT_NEEDED'
        return
    }

    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(10, $StartupTimeoutSeconds))

    if ($existingPid -and (Test-TunnelReady)) {
        Write-Output "WAG_LOCAL_DEVSPACE_REPAIR_WITH_EXISTING_TUNNEL=$existingPid"
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        Remove-Item -LiteralPath $repairStdout, $repairStderr -Force -ErrorAction SilentlyContinue
        $repair = Start-Process -FilePath $pwsh -ArgumentList @(
            '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$launcher,'-EnsureDevSpaceOnly'
        ) -WindowStyle Hidden -RedirectStandardOutput $repairStdout -RedirectStandardError $repairStderr -PassThru

        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Ready) {
                if (-not $repair.HasExited) {
                    Stop-Process -Id $repair.Id -Force -ErrorAction SilentlyContinue
                    try { $repair.WaitForExit(5000) | Out-Null } catch {}
                }
                Write-Output 'WAG_LOCAL_READY=True'
                Write-Output 'WAG_LOCAL_RECOVERY=DEVSPACE_REPAIRED'
                return
            }
            if ($repair.HasExited) {
                $repairExit = $repair.ExitCode
                Write-Diagnostic 'WAG_DEVSPACE_REPAIR_FAILED' "Existing tunnel stayed ready but DevSpace repair exited $repairExit."
                Get-Content -LiteralPath $repairStderr -Tail 30 -ErrorAction SilentlyContinue
                break
            }
            Start-Sleep -Milliseconds 500
        }

        if (-not $repair.HasExited) {
            Stop-Process -Id $repair.Id -Force -ErrorAction SilentlyContinue
            try { $repair.WaitForExit(5000) | Out-Null } catch {}
            Write-Diagnostic 'WAG_DEVSPACE_REPAIR_TIMEOUT' 'Existing tunnel stayed ready but bounded DevSpace repair did not complete before the startup deadline.'
        }
    }

    if ($existingPid) {
        Write-Output "WAG_LOCAL_EXISTING_LAUNCHER_PID=$existingPid"
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Ready) {
                Write-Output 'WAG_LOCAL_READY=True'
                Write-Output 'WAG_LOCAL_RECOVERY=EXISTING_LAUNCHER'
                return
            }
            if (-not (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
                Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
                break
            }
            Start-Sleep -Milliseconds 500
        }
    }

    $attemptCount = [Math]::Max(1, $Attempts)
    for ($attempt = 1; $attempt -le $attemptCount; $attempt++) {
        if ([DateTime]::UtcNow -ge $deadline) { break }

        Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $startArgs = @{
            FilePath = $pwsh
            ArgumentList = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$launcher)
            WindowStyle = 'Hidden'
            RedirectStandardOutput = $stdout
            RedirectStandardError = $stderr
            PassThru = $true
        }
        $process = Start-Process @startArgs
        [IO.File]::WriteAllText($pidFile, [string]$process.Id)
        Write-Output "WAG_LOCAL_START_ATTEMPT=$attempt"
        Write-Output "WAG_LOCAL_LAUNCHER_PID=$($process.Id)"

        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Ready) {
                Write-Output 'WAG_LOCAL_READY=True'
                Write-Output "WAG_LOCAL_RECOVERY=STARTED_ATTEMPT_$attempt"
                return
            }
            if ($process.HasExited) { break }
            Start-Sleep -Milliseconds 500
        }

        if (-not $process.HasExited) {
            Write-Diagnostic 'WAG_START_TIMEOUT' 'The local launcher stayed alive but WAG did not become executable before the deadline.'
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            try { $process.WaitForExit(5000) | Out-Null } catch {}
            if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
                $recordedPid = 0
                if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$recordedPid) -and
                    $recordedPid -eq $process.Id) {
                    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
                }
            }
            Write-Output "WAG_LOCAL_LAUNCHER_TIMEOUT_CLEANUP=$($process.Id)"
            break
        }

        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Write-Output "WAG_LOCAL_EXIT_CODE=$($process.ExitCode)"
        Get-Content -LiteralPath $stderr -Tail 30 -ErrorAction SilentlyContinue

        if ($attempt -lt $attemptCount -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Seconds ([Math]::Min(8, 1 + ($attempt * 2)))
        }
    }

    Write-Output 'WAG_LOCAL_READY=False'
    Write-Diagnostic 'WAG_TUNNEL_START_FAILED' 'WAG Local could not restore an executable DevSpace+tunnel path within the bounded retry window.'
    Get-Content -LiteralPath $stderr -Tail 30 -ErrorAction SilentlyContinue
    throw "STOP: WAG local did not become ready within $StartupTimeoutSeconds seconds"
}
