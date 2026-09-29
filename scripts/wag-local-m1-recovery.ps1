param(
    [ValidateSet('AllSafe','TunnelCrash','DevSpaceCrash','AllDestructive')]
    [string]$Case = 'AllSafe',
    [string]$Output = '',
    [int]$RecoveryTimeoutSeconds = 120,
    [int]$InitialDelaySeconds = 0
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $forward = @(
            '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
            '-File',$PSCommandPath,
            '-Case',$Case,
            '-RecoveryTimeoutSeconds',$RecoveryTimeoutSeconds,
            '-InitialDelaySeconds',$InitialDelaySeconds
        )
        if ($Output) { $forward += @('-Output',$Output) }
        & $pwsh @forward
        exit $LASTEXITCODE
    }

    $repo = Resolve-Path (Join-Path $PSScriptRoot '..')
    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $logs = Join-Path $base 'logs'
    $receipts = Join-Path $base 'receipts'
    $installer = Join-Path $repo 'scripts\install-wag-local-launchers.ps1'
    $starter = Join-Path $base 'Start-WagLocal.ps1'
    $tunnelLauncher = Join-Path $base 'Start-WagLocalTunnel.ps1'
    $supervisorPidFile = Join-Path $logs 'wag-local-supervisor.pid'
    $launcherPidFile = Join-Path $logs 'wag-local-launcher.pid'
    $devspacePidFile = Join-Path $logs 'devspace-wag-7677.pid'

    New-Item -ItemType Directory -Path $receipts -Force | Out-Null
    if (-not $Output) {
        $Output = Join-Path $receipts ('wag-local-m1-' + $Case.ToLowerInvariant() + '.json')
    }

    function Test-HttpOk([string]$Url) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            return $r.StatusCode -ge 200 -and $r.StatusCode -lt 300
        }
        catch {
            return $false
        }
    }

    function Test-StackReady {
        return (Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server') -and
            (Test-HttpOk 'http://127.0.0.1:8080/healthz') -and
            (Test-HttpOk 'http://127.0.0.1:8080/readyz')
    }

    function Wait-StackReady([int]$TimeoutSeconds) {
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-StackReady) { return $true }
            Start-Sleep -Milliseconds 500
        }
        return $false
    }

    function Assert-Supervisor {
        if (-not (Test-Path -LiteralPath $supervisorPidFile -PathType Leaf)) {
            throw 'M1_SUPERVISOR_NOT_RUNNING: pid file missing'
        }

        $pidValue = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $supervisorPidFile -Raw).Trim(), [ref]$pidValue)) {
            throw 'M1_SUPERVISOR_NOT_RUNNING: pid invalid'
        }

        $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pidValue) -ErrorAction SilentlyContinue
        if ($null -eq $proc) {
            throw 'M1_SUPERVISOR_NOT_RUNNING: process missing'
        }
        if ([string]$proc.CommandLine -notmatch 'Start-WagLocalSupervisor\.ps1') {
            throw 'M1_SUPERVISOR_NOT_RUNNING: pid is not the WAG supervisor'
        }

        return $pidValue
    }

    function Find-TunnelPid {
        $lines = @(& wsl.exe -e pgrep -f tunnel-client 2>$null)
        foreach ($line in $lines) {
            $candidate = 0
            if (-not [int]::TryParse(([string]$line).Trim(), [ref]$candidate)) {
                continue
            }
            if ($candidate -le 0) { continue }

            $argsText = ((@(& wsl.exe -e ps -p $candidate -o args= 2>$null)) -join ' ').Trim()
            if ($argsText -eq '/home/pacmap/tools/openai-tunnel-client/v0.0.14/tunnel-client run --profile web-agent-gateway') {
                return $candidate
            }
        }
        return 0
    }

    $results = New-Object System.Collections.Generic.List[object]

    function Invoke-Case([string]$Name, [scriptblock]$Body) {
        $started = [DateTime]::UtcNow
        try {
            $detail = & $Body
            $results.Add([pscustomobject]@{
                case = $Name
                pass = $true
                elapsedMs = [int](([DateTime]::UtcNow - $started).TotalMilliseconds)
                detail = @($detail)
            })
            Write-Output "M1_CASE_PASS=$Name"
        }
        catch {
            $results.Add([pscustomobject]@{
                case = $Name
                pass = $false
                elapsedMs = [int](([DateTime]::UtcNow - $started).TotalMilliseconds)
                detail = @($_.Exception.Message)
            })
            Write-Output "M1_CASE_FAIL=$Name"
            Write-Output $_.Exception.Message
        }
    }

    function Run-SafeBatch {
        Invoke-Case 'powershell5-reentry' {
            $out = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $starter 2>&1
            if ($LASTEXITCODE -ne 0) { throw "starter exit=$LASTEXITCODE" }
            if (-not (@($out) -match 'WAG_LOCAL_READY=True')) { throw 'ready sentinel missing' }
            'Windows PowerShell invocation re-entered supported PowerShell and returned Ready.'
        }

        Invoke-Case 'stale-pid-reconciliation' {
            Set-Content -LiteralPath $launcherPidFile -Value '2147483001' -NoNewline
            Set-Content -LiteralPath $devspacePidFile -Value '2147483002' -NoNewline

            & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $tunnelLauncher -EnsureDevSpaceOnly | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'DevSpace reconciliation failed' }

            & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $starter | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'starter stale-pid recovery failed' }

            $devPid = [int](Get-Content -LiteralPath $devspacePidFile -Raw)
            if (-not (Get-Process -Id $devPid -ErrorAction SilentlyContinue)) {
                throw 'DevSpace pid receipt not reconciled'
            }

            if (Test-Path -LiteralPath $launcherPidFile) {
                $launcherPid = [int](Get-Content -LiteralPath $launcherPidFile -Raw)
                if (-not (Get-Process -Id $launcherPid -ErrorAction SilentlyContinue)) {
                    throw 'stale launcher pid remained'
                }
            }

            'Stale WAG-owned PID receipts were cleared/reconciled without killing unknown processes.'
        }

        Invoke-Case 'launcher-drift-repair' {
            $installed = Join-Path $base 'Start-WagLocal.ps1'
            Add-Content -LiteralPath $installed -Value '# m1 drift fixture'
            & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer -NoAutostart -NoStart | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'installer repair failed' }

            $expected = (Get-FileHash -LiteralPath (Join-Path $repo 'scripts\wag-local-start.ps1') -Algorithm SHA256).Hash
            $actual = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
            if ($expected -ne $actual) { throw 'launcher drift not repaired' }

            'Canonical installer repaired a modified WAG-owned launcher.'
        }

        Invoke-Case 'autostart-drift-repair' {
            $startup = [Environment]::GetFolderPath('Startup')
            $shortcut = Join-Path $startup 'WAG Local.lnk'
            $backup = Join-Path $startup 'WAG Local.m1-backup.lnk'

            Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $shortcut) {
                Move-Item -LiteralPath $shortcut -Destination $backup -Force
            }

            try {
                & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer -NoStart | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'autostart repair installer failed' }
                if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf)) {
                    throw 'startup shortcut not restored'
                }

                $shell = New-Object -ComObject WScript.Shell
                $link = $shell.CreateShortcut($shortcut)
                if ($link.Arguments -notmatch 'Start-WagLocalSupervisor\.ps1') {
                    throw 'startup target is not supervisor'
                }
            }
            finally {
                Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
            }

            'Per-user autostart registration was restored to the recovery supervisor.'
        }
    }

    function Run-TunnelCrash {
        Invoke-Case 'live-tunnel-crash-recovery' {
            $supervisorPid = Assert-Supervisor
            $tunnelPid = Find-TunnelPid
            if ($tunnelPid -le 0) {
                throw 'owned tunnel-client pid not found'
            }

            & wsl.exe -e kill -TERM $tunnelPid
            if ($LASTEXITCODE -ne 0) {
                throw 'failed to terminate owned tunnel-client'
            }

            if (-not (Wait-StackReady $RecoveryTimeoutSeconds)) {
                throw 'supervisor did not restore tunnel within timeout'
            }

            "supervisorPid=$supervisorPid tunnelPid=$tunnelPid recovered=true"
        }
    }

    function Run-DevSpaceCrash {
        Invoke-Case 'live-devspace-crash-recovery' {
            $supervisorPid = Assert-Supervisor
            $listener = Get-NetTCPConnection -State Listen -LocalPort 7677 -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($null -eq $listener) {
                throw 'DevSpace listener missing before injection'
            }

            $devPid = [int]$listener.OwningProcess
            $receiptPid = 0
            if (-not (Test-Path -LiteralPath $devspacePidFile -PathType Leaf) -or
                -not [int]::TryParse((Get-Content -LiteralPath $devspacePidFile -Raw).Trim(), [ref]$receiptPid) -or
                $receiptPid -ne $devPid) {
                throw '7677 listener does not match the WAG-owned DevSpace pid receipt'
            }

            $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $devPid) -ErrorAction Stop
            $cmd = [string]$proc.CommandLine
            if ([string]$proc.Name -ne 'node.exe' -or
                $cmd -notmatch 'dist[/\\]cli\.js' -or
                $cmd -notmatch '\bserve\b') {
                throw '7677 listener is not the expected managed DevSpace process'
            }

            Stop-Process -Id $devPid -Force

            if (-not (Wait-StackReady $RecoveryTimeoutSeconds)) {
                throw 'supervisor did not restore DevSpace+tunnel within timeout'
            }

            "supervisorPid=$supervisorPid devspacePid=$devPid recovered=true"
        }
    }

    if (-not (Test-StackReady)) {
        throw 'M1_PRECONDITION_FAILED: WAG stack is not Ready before injection'
    }
    if ($InitialDelaySeconds -gt 0) {
        Start-Sleep -Seconds $InitialDelaySeconds
    }

    switch ($Case) {
        'AllSafe' { Run-SafeBatch }
        'TunnelCrash' { Run-TunnelCrash }
        'DevSpaceCrash' { Run-DevSpaceCrash }
        'AllDestructive' {
            Run-TunnelCrash
            Run-DevSpaceCrash
        }
    }

    $failedCount = ($results | Where-Object { -not $_.pass } | Measure-Object).Count
    $pass = $failedCount -eq 0

    $receipt = [ordered]@{
        schema = 'WAG_LOCAL_M1_RECOVERY_V1'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        requestedCase = $Case
        pass = $pass
        results = $results.ToArray()
    }

    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Output -Encoding utf8
    Write-Output "M1_RECEIPT=$Output"
    Write-Output "M1_PASS=$pass"

    if (-not $pass) {
        exit 2
    }
}
