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
    $pidFile = Join-Path $logs 'wag-local-supervisor.pid'
    $mutexName = 'Local\WAG-Local-Supervisor-v1'

    New-Item -ItemType Directory -Path $logs -Force | Out-Null

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

    [IO.File]::WriteAllText($pidFile, [string]$PID)
    Write-SupervisorLog 'WAG_SUPERVISOR_START' "pid=$PID"
    Write-Output "WAG_SUPERVISOR_PID=$PID"

    try {
        do {
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
                $output = & $pwsh @starterArgs 2>&1
                $code = $LASTEXITCODE
                foreach ($line in @($output)) {
                    Write-SupervisorLog 'WAG_STARTER_OUTPUT' ([string]$line)
                }

                if ($code -eq 0 -and (Test-WagReady)) {
                    Write-SupervisorLog 'WAG_SUPERVISOR_RECOVERY_OK' 'local stack ready'
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
