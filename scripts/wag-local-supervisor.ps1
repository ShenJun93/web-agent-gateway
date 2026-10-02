param(
    [int]$PollSeconds = 10,
    [int]$RecoveryTimeoutSeconds = 90,
    [switch]$Once
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $forward = @(
            '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
            '-File',$PSCommandPath,
            '-PollSeconds',$PollSeconds,
            '-RecoveryTimeoutSeconds',$RecoveryTimeoutSeconds
        )
        if ($Once) { $forward += '-Once' }
        & $pwsh @forward
        exit $LASTEXITCODE
    }

    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $logs = Join-Path $base 'logs'
    $starter = Join-Path $base 'Start-WagLocal.ps1'
    $logFile = Join-Path $logs 'wag-local-supervisor.log'
    $starterStdout = Join-Path $logs 'wag-local-supervisor-starter.stdout.log'
    $starterStderr = Join-Path $logs 'wag-local-supervisor-starter.stderr.log'
    $pidFile = Join-Path $logs 'wag-local-supervisor.pid'
    $state = Join-Path $base 'state'
    $maintenanceLease = Join-Path $state 'maintenance-v1.json'
    $maintenanceAck = Join-Path $state 'maintenance-v1.ack.json'
    $baseBytes = [Text.Encoding]::UTF8.GetBytes($base.ToLowerInvariant())
    $baseHash = [Security.Cryptography.SHA256]::HashData($baseBytes)
    $mutexSuffix = [Convert]::ToHexString($baseHash).Substring(0, 16)
    $mutexName = 'Local\WAG-Local-Supervisor-v1-' + $mutexSuffix

    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    New-Item -ItemType Directory -Path $state -Force | Out-Null

    if (-not (Test-Path -LiteralPath $starter -PathType Leaf)) {
        throw "STOP: missing WAG starter: $starter"
    }

    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
    if (-not $createdNew) {
        Write-Output 'WAG_SUPERVISOR_ALREADY_RUNNING=True'
        $mutex.Dispose()
        return
    }

    function Write-SupervisorLog([string]$Code, [string]$Message) {
        $tab = [char]9
        $line = ([DateTime]::UtcNow.ToString('o')) + $tab + $Code + $tab + $Message
        Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
    }

    function Test-HttpOk([string]$Url) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        }
        catch { return $false }
    }

    function Test-WagReady {
        return (Test-HttpOk 'http://127.0.0.1:8080/readyz') -and
            (Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server')
    }

    function Get-MaintenanceLease {
        if (-not (Test-Path -LiteralPath $maintenanceLease -PathType Leaf)) { return $null }
        try {
            $lease = Get-Content -LiteralPath $maintenanceLease -Raw | ConvertFrom-Json
            if ([string]$lease.schema -ne 'WAG_LOCAL_MAINTENANCE_V1') { return $null }
            $leaseId = [string]$lease.leaseId
            if ($leaseId.Length -ne 42 -or $leaseId -notmatch '^maint_[0-9a-f-]{36}') { return $null }
            $rawExpires = $lease.expiresAtUtc
            if ($rawExpires -is [DateTime]) {
                $expires = $rawExpires.ToUniversalTime()
            }
            elseif ($rawExpires -is [DateTimeOffset]) {
                $expires = $rawExpires.UtcDateTime
            }
            else {
                $expires = [DateTimeOffset]::Parse([string]$rawExpires, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).UtcDateTime
            }
            if ($expires -le [DateTime]::UtcNow) {
                Remove-Item -LiteralPath $maintenanceLease, $maintenanceAck -Force -ErrorAction SilentlyContinue
                return $null
            }
            return $lease
        }
        catch {
            Write-SupervisorLog 'WAG_SUPERVISOR_MAINTENANCE_INVALID' ('reason=parse error=' + $_.Exception.Message)
            return $null
        }
    }

    function Confirm-MaintenanceLease($Lease) {
        $payload = [ordered]@{
            schema = 'WAG_LOCAL_MAINTENANCE_ACK_V1'
            leaseId = [string]$Lease.leaseId
            supervisorPid = $PID
            acknowledgedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        $temp = $maintenanceAck + '.tmp'
        [IO.File]::WriteAllText($temp, (($payload | ConvertTo-Json -Depth 4) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $maintenanceAck -Force
    }

    [IO.File]::WriteAllText($pidFile, [string]$PID)
    Write-SupervisorLog 'WAG_SUPERVISOR_START' "pid=$PID"
    Write-Output "WAG_SUPERVISOR_PID=$PID"

    $lastMaintenanceLeaseId = $null
    try {
        do {
            $lease = Get-MaintenanceLease
            if ($null -ne $lease) {
                Confirm-MaintenanceLease $lease
                if ($lastMaintenanceLeaseId -ne [string]$lease.leaseId) {
                    Write-SupervisorLog 'WAG_SUPERVISOR_MAINTENANCE_PAUSE' ('leaseId=' + [string]$lease.leaseId)
                    $lastMaintenanceLeaseId = [string]$lease.leaseId
                }
                if ($Once) {
                    Write-Output 'WAG_SUPERVISOR_MAINTENANCE=True'
                    break
                }
                Start-Sleep -Milliseconds 500
                continue
            }
            if ($null -ne $lastMaintenanceLeaseId) {
                Write-SupervisorLog 'WAG_SUPERVISOR_MAINTENANCE_RESUME' ('leaseId=' + $lastMaintenanceLeaseId)
                $lastMaintenanceLeaseId = $null
                Remove-Item -LiteralPath $maintenanceAck -Force -ErrorAction SilentlyContinue
            }

            if (Test-WagReady) {
                if ($Once) {
                    Write-Output 'WAG_SUPERVISOR_READY=True'
                    break
                }
                Start-Sleep -Seconds ([Math]::Max(2, $PollSeconds))
                continue
            }

            Write-SupervisorLog 'WAG_SUPERVISOR_RECOVERY_BEGIN' 'local stack not ready'
            try {
                $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
                $starterArgs = @(
                    '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
                    '-File',$starter,
                    '-StartupTimeoutSeconds',$RecoveryTimeoutSeconds
                )
                Remove-Item -LiteralPath $starterStdout, $starterStderr -Force -ErrorAction SilentlyContinue
                $starterProcess = Start-Process -FilePath $pwsh -ArgumentList $starterArgs `
                    -WindowStyle Hidden -RedirectStandardOutput $starterStdout `
                    -RedirectStandardError $starterStderr -PassThru
                $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(10, $RecoveryTimeoutSeconds))
                $ready = $false
                while ([DateTime]::UtcNow -lt $deadline) {
                    if (Test-WagReady) {
                        $ready = $true
                        break
                    }
                    if ($starterProcess.HasExited) {
                        $ready = Test-WagReady
                        break
                    }
                    Start-Sleep -Milliseconds 500
                }

                if ($ready -and -not $starterProcess.HasExited) {
                    Stop-Process -Id $starterProcess.Id -Force -ErrorAction SilentlyContinue
                    try { $starterProcess.WaitForExit(5000) | Out-Null } catch {}
                }
                elseif (-not $ready -and -not $starterProcess.HasExited) {
                    Stop-Process -Id $starterProcess.Id -Force -ErrorAction SilentlyContinue
                    try { $starterProcess.WaitForExit(5000) | Out-Null } catch {}
                }

                foreach ($line in @(Get-Content -LiteralPath $starterStdout -ErrorAction SilentlyContinue)) {
                    Write-SupervisorLog 'WAG_STARTER_OUTPUT' ([string]$line)
                }
                foreach ($line in @(Get-Content -LiteralPath $starterStderr -ErrorAction SilentlyContinue)) {
                    Write-SupervisorLog 'WAG_STARTER_STDERR' ([string]$line)
                }

                $code = if ($starterProcess.HasExited) { $starterProcess.ExitCode } else { 124 }
                if ($ready) {
                    Write-SupervisorLog 'WAG_SUPERVISOR_RECOVERY_OK' "local stack ready starterExit=$code"
                    Write-Output 'WAG_SUPERVISOR_RECOVERY=SUCCEEDED'
                }
                else {
                    Write-SupervisorLog 'WAG_SUPERVISOR_RECOVERY_FAILED' "starterExit=$code"
                    Write-Output "WAG_SUPERVISOR_RECOVERY=FAILED:$code"
                }
            }
            catch {
                Write-SupervisorLog 'WAG_SUPERVISOR_RECOVERY_EXCEPTION' $_.Exception.Message
                Write-Output 'WAG_SUPERVISOR_RECOVERY=EXCEPTION'
            }

            if ($Once) { break }
            Start-Sleep -Seconds ([Math]::Max(2, $PollSeconds))
        } while ($true)
    }
    finally {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Write-SupervisorLog 'WAG_SUPERVISOR_STOP' "pid=$PID"
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
}
