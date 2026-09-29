param(
    [int]$StartupTimeoutSeconds = 45
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        & $pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -StartupTimeoutSeconds $StartupTimeoutSeconds
        exit $LASTEXITCODE
    }

    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $launcher = Join-Path $base 'Start-WagLocalTunnel.ps1'
    $logs = Join-Path $base 'logs'
    $stdout = Join-Path $logs 'wag-local.stdout.log'
    $stderr = Join-Path $logs 'wag-local.stderr.log'
    $pidFile = Join-Path $logs 'wag-local-launcher.pid'

    function Test-HttpOk([string]$Url) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        }
        catch { return $false }
    }

    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "STOP: missing WAG tunnel launcher: $launcher" }

    if (Test-HttpOk 'http://127.0.0.1:8080') {
        Write-Output 'WAG_LOCAL_READY=True'
        Write-Output 'WAG_LOCAL_RECOVERY=NOT_NEEDED'
        return
    }

    New-Item -ItemType Directory -Path $logs -Force | Out-Null
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

    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-HttpOk 'http://127.0.0.1:8080') {
            Write-Output 'WAG_LOCAL_READY=True'
            Write-Output "WAG_LOCAL_LAUNCHER_PID=$($process.Id)"
            if (Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server') { Write-Output 'DEVSPACE_READY=True' }
            return
        }
        if ($process.HasExited) {
            Write-Output 'WAG_LOCAL_READY=False'
            Write-Output "WAG_LOCAL_EXIT_CODE=$($process.ExitCode)"
            Get-Content -LiteralPath $stderr -Tail 30 -ErrorAction SilentlyContinue
            throw 'STOP: WAG local launcher exited before tunnel became ready'
        }
        Start-Sleep -Milliseconds 500
    }

    Write-Output 'WAG_LOCAL_READY=False'
    Get-Content -LiteralPath $stderr -Tail 30 -ErrorAction SilentlyContinue
    throw "STOP: WAG local did not become ready within $StartupTimeoutSeconds seconds"
}
