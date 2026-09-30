param(
    [ValidateSet('AllSafe','TunnelCrash','DevSpaceCrash','StackCrash','DevSpaceCheckoutDeleted','WslUnavailable','TunnelClientMissing','Port7677Collision','Port8080Collision','NetworkOffline','NetworkReturn','AuthExpired','AllLocalDestructive','AllExternalSynthetic')]
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
    $supervisorScript = Join-Path $base 'Start-WagLocalSupervisor.ps1'
    $supervisorPidFile = Join-Path $logs 'wag-local-supervisor.pid'
    $launcherPidFile = Join-Path $logs 'wag-local-launcher.pid'
    $devspacePidFile = Join-Path $logs 'devspace-wag-7677.pid'
    $devspacePinDir = Join-Path $base 'DevSpace-Pin-33d6d0b'
    $tunnelClientWsl = '/home/pacmap/tools/openai-tunnel-client/v0.0.14/tunnel-client'

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
            if ($argsText -eq ($tunnelClientWsl + ' run --profile web-agent-gateway')) {
                return $candidate
            }
        }
        return 0
    }

    function Get-OwnedDevSpacePid {
        $listener = Get-NetTCPConnection -State Listen -LocalPort 7677 -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -eq $listener) { return 0 }

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
        return $devPid
    }

    function Stop-OwnedTunnel {
        $tunnelPid = Find-TunnelPid
        if ($tunnelPid -le 0) { return 0 }
        & wsl.exe -e kill -TERM $tunnelPid
        if ($LASTEXITCODE -ne 0) { throw 'failed to terminate owned tunnel-client' }
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ((Find-TunnelPid) -le 0) { return $tunnelPid }
            Start-Sleep -Milliseconds 250
        }
        & wsl.exe -e kill -KILL $tunnelPid 2>$null
        return $tunnelPid
    }

    function Stop-OwnedDevSpace {
        $devPid = Get-OwnedDevSpacePid
        if ($devPid -le 0) { return 0 }
        Stop-Process -Id $devPid -Force
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline) {
            $listener = Get-NetTCPConnection -State Listen -LocalPort 7677 -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($null -eq $listener) { return $devPid }
            Start-Sleep -Milliseconds 250
        }
        throw 'DevSpace listener did not stop'
    }

    function Stop-OwnedSupervisor {
        $supervisorPid = 0
        try { $supervisorPid = Assert-Supervisor }
        catch {
            Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
            return 0
        }
        Stop-Process -Id $supervisorPid -Force
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (-not (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
        if (Test-Path -LiteralPath $supervisorPidFile -PathType Leaf) {
            $recorded = 0
            if ([int]::TryParse((Get-Content -LiteralPath $supervisorPidFile -Raw).Trim(), [ref]$recorded) -and
                $recorded -eq $supervisorPid) {
                Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
            }
        }
        return $supervisorPid
    }

    function Start-OwnedSupervisor {
        try {
            return Assert-Supervisor
        }
        catch {}

        Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $process = Start-Process -FilePath $pwsh -ArgumentList @(
            '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$supervisorScript
        ) -WindowStyle Hidden -PassThru

        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline) {
            try {
                $observed = Assert-Supervisor
                if ($observed -eq $process.Id) { return $observed }
            }
            catch {}
            if ($process.HasExited) { throw "supervisor exited early code=$($process.ExitCode)" }
            Start-Sleep -Milliseconds 250
        }
        throw 'supervisor did not start within timeout'
    }

    function Restore-ReadyStack {
        $supervisorPid = Start-OwnedSupervisor
        if (Wait-StackReady $RecoveryTimeoutSeconds) { return $supervisorPid }

        & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $starter -StartupTimeoutSeconds $RecoveryTimeoutSeconds -Attempts 2 | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Wait-StackReady $RecoveryTimeoutSeconds)) {
            throw 'failed to restore WAG stack after M1 injection'
        }
        return $supervisorPid
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

        Invoke-Case 'powershell7-direct' {
            $out = & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $starter 2>&1
            if ($LASTEXITCODE -ne 0) { throw "starter exit=$LASTEXITCODE" }
            if (-not (@($out) -match 'WAG_LOCAL_READY=True')) { throw 'ready sentinel missing' }
            'PowerShell 7 invocation returned Ready directly.'
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

        Invoke-Case 'login-startup-shortcut-execution' {
            $startup = [Environment]::GetFolderPath('Startup')
            $shortcut = Join-Path $startup 'WAG Local.lnk'
            if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf)) {
                throw 'startup shortcut missing'
            }

            $oldSupervisor = Stop-OwnedSupervisor
            $newSupervisor = 0
            try {
                Start-Process -FilePath $shortcut | Out-Null
                $deadline = [DateTime]::UtcNow.AddSeconds(15)
                while ([DateTime]::UtcNow -lt $deadline) {
                    try {
                        $newSupervisor = Assert-Supervisor
                        if ($newSupervisor -gt 0) { break }
                    }
                    catch {}
                    Start-Sleep -Milliseconds 250
                }
                if ($newSupervisor -le 0) { throw 'startup shortcut did not launch supervisor' }
                if ($newSupervisor -eq $oldSupervisor) { throw 'startup shortcut reused terminated supervisor pid' }
                if (-not (Wait-StackReady 15)) { throw 'stack not Ready after startup shortcut execution' }
            }
            finally {
                try { Assert-Supervisor | Out-Null } catch { Start-OwnedSupervisor | Out-Null }
            }

            "oldSupervisorPid=$oldSupervisor newSupervisorPid=$newSupervisor ready=true"
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
            $devPid = Stop-OwnedDevSpace
            if ($devPid -le 0) { throw 'owned DevSpace pid not found' }

            if (-not (Wait-StackReady $RecoveryTimeoutSeconds)) {
                throw 'supervisor did not restore DevSpace+tunnel within timeout'
            }

            "supervisorPid=$supervisorPid devspacePid=$devPid recovered=true"
        }
    }

    function Run-StackCrash {
        Invoke-Case 'live-devspace-and-tunnel-crash-recovery' {
            $supervisorPid = Assert-Supervisor
            $devPid = Stop-OwnedDevSpace
            if ($devPid -le 0) { throw 'owned DevSpace pid not found' }
            $tunnelPid = Stop-OwnedTunnel
            if ($tunnelPid -le 0) { throw 'owned tunnel-client pid not found' }

            if (-not (Wait-StackReady $RecoveryTimeoutSeconds)) {
                throw 'supervisor did not restore DevSpace+tunnel after both were stopped'
            }

            "supervisorPid=$supervisorPid devspacePid=$devPid tunnelPid=$tunnelPid recovered=true"
        }
    }

    function Run-DevSpaceCheckoutDeleted {
        Invoke-Case 'devspace-checkout-deleted-recovery' {
            Stop-OwnedSupervisor | Out-Null
            $devPid = Stop-OwnedDevSpace
            if ($devPid -le 0) { throw 'owned DevSpace pid not found' }

            if (-not (Test-Path -LiteralPath $devspacePinDir -PathType Container)) {
                throw 'managed DevSpace checkout missing before injection'
            }

            $backup = $devspacePinDir + '.m1-backup-' + [Guid]::NewGuid().ToString('N')
            Move-Item -LiteralPath $devspacePinDir -Destination $backup
            try {
                Start-OwnedSupervisor | Out-Null
                if (-not (Wait-StackReady $RecoveryTimeoutSeconds)) {
                    throw 'supervisor did not restore stack after DevSpace checkout deletion'
                }

                $head = (& git.exe -C $devspacePinDir rev-parse HEAD 2>$null).Trim()
                if ($LASTEXITCODE -ne 0 -or $head -ne '33d6d0bcc2256024484d2456da924af8afd814ed') {
                    throw "restored DevSpace checkout has unexpected HEAD: $head"
                }
            }
            finally {
                $cleanupBackup = $false
                if (-not (Test-Path -LiteralPath $devspacePinDir -PathType Container) -and
                    (Test-Path -LiteralPath $backup -PathType Container)) {
                    Move-Item -LiteralPath $backup -Destination $devspacePinDir
                }
                elseif (Test-Path -LiteralPath $backup -PathType Container) {
                    $cleanupBackup = $true
                }

                Restore-ReadyStack | Out-Null

                if ($cleanupBackup -and (Test-Path -LiteralPath $backup -PathType Container)) {
                    $cleanupCommand = 'rmdir /s /q "' + $backup + '"'
                    Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c',$cleanupCommand) -WindowStyle Hidden | Out-Null
                    Write-Output "M1_BACKUP_CLEANUP_SCHEDULED=$backup"
                }
            }

            'Deleted managed DevSpace checkout was restored to the exact accepted revision.'
        }
    }

    function Run-WslUnavailable {
        Invoke-Case 'wsl-temporarily-unavailable-fails-closed' {
            Stop-OwnedSupervisor | Out-Null
            Stop-OwnedTunnel | Out-Null

            $shimDir = Join-Path $base ('m1-wsl-shim-' + [Guid]::NewGuid().ToString('N'))
            $oldPath = $env:PATH
            New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\where.exe') -Destination (Join-Path $shimDir 'wsl.exe')
            try {
                $env:PATH = $shimDir + ';' + $oldPath
                $out = & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $tunnelLauncher 2>&1
                $code = $LASTEXITCODE
                if ($code -eq 0) { throw 'launcher unexpectedly succeeded with WSL shim failure' }
                if (-not (@($out) -match 'WAG_DIAGNOSTIC_CODE=WAG_WSL_UNAVAILABLE')) {
                    throw 'WAG_WSL_UNAVAILABLE diagnostic missing'
                }
            }
            finally {
                $env:PATH = $oldPath
                Remove-Item -LiteralPath $shimDir -Recurse -Force -ErrorAction SilentlyContinue
                Restore-ReadyStack | Out-Null
            }

            'WSL unavailability failed closed with a stable diagnostic and the stack recovered after restoration.'
        }
    }

    function Run-TunnelClientMissing {
        Invoke-Case 'tunnel-client-missing-fails-closed' {
            Stop-OwnedSupervisor | Out-Null
            Stop-OwnedTunnel | Out-Null

            $backup = $tunnelClientWsl + '.m1-backup-' + [Guid]::NewGuid().ToString('N')
            & wsl.exe -e mv -- $tunnelClientWsl $backup
            if ($LASTEXITCODE -ne 0) { throw 'failed to move tunnel-client for injection' }
            try {
                $out = & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $tunnelLauncher 2>&1
                $code = $LASTEXITCODE
                if ($code -eq 0) { throw 'launcher unexpectedly succeeded without tunnel-client' }
                if (-not (@($out) -match 'WAG_DIAGNOSTIC_CODE=WAG_TUNNEL_CLIENT_MISSING')) {
                    throw 'WAG_TUNNEL_CLIENT_MISSING diagnostic missing'
                }
            }
            finally {
                & wsl.exe -e mv -- $backup $tunnelClientWsl 2>$null
                if ($LASTEXITCODE -ne 0) { throw 'failed to restore tunnel-client after injection' }
                Restore-ReadyStack | Out-Null
            }

            'Missing tunnel-client failed closed and recovery succeeded after the binary was restored.'
        }
    }

    function Run-Port7677Collision {
        Invoke-Case 'port-7677-unrelated-listener-fails-closed' {
            Stop-OwnedSupervisor | Out-Null
            Stop-OwnedDevSpace | Out-Null

            $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 7677)
            $listener.Start()
            try {
                $owner = Get-NetTCPConnection -State Listen -LocalPort 7677 -ErrorAction Stop |
                    Select-Object -First 1
                if ([int]$owner.OwningProcess -ne $PID) { throw 'collision listener ownership mismatch' }

                $out = & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $tunnelLauncher -EnsureDevSpaceOnly 2>&1
                $code = $LASTEXITCODE
                if ($code -eq 0) { throw 'launcher unexpectedly adopted unrelated 7677 listener' }
                if (-not (@($out) -match 'WAG_DIAGNOSTIC_CODE=WAG_DEVSPACE_PORT_COLLISION')) {
                    throw 'WAG_DEVSPACE_PORT_COLLISION diagnostic missing'
                }

                $ownerAfter = Get-NetTCPConnection -State Listen -LocalPort 7677 -ErrorAction Stop |
                    Select-Object -First 1
                if ([int]$ownerAfter.OwningProcess -ne $PID) {
                    throw 'launcher killed or replaced unrelated 7677 listener'
                }
            }
            finally {
                $listener.Stop()
                Restore-ReadyStack | Out-Null
            }

            'Unrelated 7677 listener was preserved and WAG failed closed.'
        }
    }

    function Run-Port8080Collision {
        Invoke-Case 'port-8080-unrelated-listener-fails-closed' {
            Stop-OwnedSupervisor | Out-Null
            Stop-OwnedTunnel | Out-Null

            $portDeadline = [DateTime]::UtcNow.AddSeconds(10)
            while ([DateTime]::UtcNow -lt $portDeadline) {
                $existing = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue |
                    Select-Object -First 1
                if ($null -eq $existing) { break }
                Start-Sleep -Milliseconds 250
            }
            $existing = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($null -ne $existing) {
                throw "port 8080 did not become free after owned tunnel stop; pid=$($existing.OwningProcess)"
            }

            $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 8080)
            $listener.Start()
            try {
                $owner = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction Stop |
                    Select-Object -First 1
                if ([int]$owner.OwningProcess -ne $PID) { throw 'collision listener ownership mismatch' }

                $out = & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $tunnelLauncher 2>&1
                $code = $LASTEXITCODE
                if ($code -eq 0) { throw 'launcher unexpectedly adopted unrelated 8080 listener' }
                if (-not (@($out) -match 'WAG_DIAGNOSTIC_CODE=WAG_TUNNEL_PORT_COLLISION')) {
                    throw 'WAG_TUNNEL_PORT_COLLISION diagnostic missing'
                }

                $ownerAfter = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction Stop |
                    Select-Object -First 1
                if ([int]$ownerAfter.OwningProcess -ne $PID) {
                    throw 'launcher killed or replaced unrelated 8080 listener'
                }
            }
            finally {
                $listener.Stop()
                Restore-ReadyStack | Out-Null
            }

            'Unrelated 8080 listener was preserved and WAG failed closed.'
        }
    }

    function New-ExternalProbeFixture {
        $liveProfile = '/home/pacmap/.config/tunnel-client/web-agent-gateway.yaml'
        $probeKey = '/tmp/wag-m1-invalid-key'
        $probeProfile = '/tmp/wag-m1-probe.yaml'

        $liveText = ((@(& wsl.exe -e cat $liveProfile 2>$null)) -join "`n")
        if ($LASTEXITCODE -ne 0 -or -not $liveText) {
            throw 'failed to read live tunnel profile metadata'
        }

        $match = [regex]::Match($liveText, '(?m)^\s*tunnel_id:\s*"?([^"\r\n]+)"?')
        if (-not $match.Success) {
            throw 'live tunnel profile tunnel_id not found'
        }
        $tunnelId = $match.Groups[1].Value.Trim()

        $yaml = @(
            'config_version: 1'
            'control_plane:'
            '  base_url: "https://api.openai.com"'
            ('  tunnel_id: "' + $tunnelId + '"')
            ('  api_key: "file:' + $probeKey + '"')
            'health:'
            '  listen_addr: "127.0.0.1:0"'
            'admin_ui:'
            '  open_browser: false'
            'log:'
            '  level: info'
            '  format: json'
        ) -join "`n"
        $yaml += "`n"

        $utf8 = [Text.UTF8Encoding]::new($false)
        $yamlB64 = [Convert]::ToBase64String($utf8.GetBytes($yaml))
        $setup = "umask 077; printf 'm1-invalid-auth\n' > '$probeKey'; printf '%s' '$yamlB64' | base64 -d > '$probeProfile'"
        & wsl.exe -e bash -lc $setup
        if ($LASTEXITCODE -ne 0) {
            throw 'failed to create disposable external probe fixture'
        }

        return [pscustomobject]@{
            profile = $probeProfile
            key = $probeKey
        }
    }

    function Remove-ExternalProbeFixture([object]$Fixture) {
        if ($null -eq $Fixture) { return }
        & wsl.exe -e rm -f -- ([string]$Fixture.profile) ([string]$Fixture.key) 2>$null
    }

    function Invoke-ExternalProbe([object]$Fixture, [switch]$Offline) {
        $filter = '401|unauthor|network is unreachable|metadata fetch failed|poll failed|startup summary|failed to connect to mcp|api.openai.com'
        $command = "set -o pipefail; HOME=/home/pacmap timeout 8s '$tunnelClientWsl' run --profile-file '$($Fixture.profile)' --embedded-mcp-stub --log.level info 2>&1 | grep -Eai '$filter' | tail -n 80"

        if ($Offline) {
            $lines = @(& wsl.exe -u root --exec unshare -n -- bash -lc $command 2>&1)
        }
        else {
            $lines = @(& wsl.exe -e bash -lc $command 2>&1)
        }
        $code = $LASTEXITCODE

        return [pscustomobject]@{
            exitCode = $code
            output = (($lines | ForEach-Object { [string]$_ }) -join "`n")
        }
    }

    function Assert-BoundedProbe([object]$Probe, [string]$Label) {
        if ($Probe.exitCode -ne 124) {
            throw "$Label probe exit=$($Probe.exitCode); expected bounded timeout exit 124"
        }
    }

    function Run-NetworkOffline {
        Invoke-Case 'network-offline-during-startup-process-isolated' {
            $fixture = $null
            try {
                $fixture = New-ExternalProbeFixture
                $probe = Invoke-ExternalProbe $fixture -Offline
                Assert-BoundedProbe $probe 'offline'

                if ($probe.output -notmatch 'api\.openai\.com') {
                    throw 'offline probe did not target the OpenAI control plane'
                }
                if ($probe.output -notmatch 'network is unreachable') {
                    throw 'offline probe did not observe network-unreachable control-plane failure'
                }
                if (-not (Test-StackReady)) {
                    throw 'live WAG stack was disturbed by process-isolated offline probe'
                }

                'Process-isolated WSL network namespace produced network-unreachable control-plane startup failure while live WAG remained Ready.'
            }
            finally {
                Remove-ExternalProbeFixture $fixture
            }
        }
    }

    function Run-NetworkReturn {
        Invoke-Case 'network-returns-after-startup-failure-process-isolated' {
            $fixture = $null
            try {
                $fixture = New-ExternalProbeFixture

                $offline = Invoke-ExternalProbe $fixture -Offline
                Assert-BoundedProbe $offline 'offline-before-return'
                if ($offline.output -notmatch 'network is unreachable') {
                    throw 'pre-return probe did not observe network-unreachable failure'
                }

                $online = Invoke-ExternalProbe $fixture
                Assert-BoundedProbe $online 'online-after-return'
                if ($online.output -match 'network is unreachable') {
                    throw 'online probe still reported network-unreachable after namespace restoration'
                }
                if ($online.output -notmatch '401 Unauthorized') {
                    throw 'online probe did not reach the control plane after network restoration'
                }
                if (-not (Test-StackReady)) {
                    throw 'live WAG stack was disturbed by network-return probe'
                }

                'The same disposable probe moved from network-unreachable to control-plane reachable after leaving the isolated network namespace.'
            }
            finally {
                Remove-ExternalProbeFixture $fixture
            }
        }
    }

    function Run-AuthExpired {
        Invoke-Case 'connector-control-plane-authorization-expired-synthetic' {
            $fixture = $null
            try {
                $fixture = New-ExternalProbeFixture
                $probe = Invoke-ExternalProbe $fixture
                Assert-BoundedProbe $probe 'auth-expired'

                if ($probe.output -match 'network is unreachable') {
                    throw 'auth probe could not distinguish authorization failure from network failure'
                }
                if ($probe.output -notmatch '401 Unauthorized') {
                    throw 'invalid disposable credential did not produce 401 Unauthorized'
                }
                if (-not (Test-StackReady)) {
                    throw 'live WAG stack was disturbed by auth-expired probe'
                }

                'Disposable invalid control-plane credential produced 401 Unauthorized while the live local WAG stack remained Ready.'
            }
            finally {
                Remove-ExternalProbeFixture $fixture
            }
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
        'StackCrash' { Run-StackCrash }
        'DevSpaceCheckoutDeleted' { Run-DevSpaceCheckoutDeleted }
        'WslUnavailable' { Run-WslUnavailable }
        'TunnelClientMissing' { Run-TunnelClientMissing }
        'Port7677Collision' { Run-Port7677Collision }
        'Port8080Collision' { Run-Port8080Collision }
        'NetworkOffline' { Run-NetworkOffline }
        'NetworkReturn' { Run-NetworkReturn }
        'AuthExpired' { Run-AuthExpired }
        'AllLocalDestructive' {
            Run-TunnelCrash
            Run-DevSpaceCrash
            Run-StackCrash
            Run-DevSpaceCheckoutDeleted
            Run-WslUnavailable
            Run-TunnelClientMissing
            Run-Port7677Collision
            Run-Port8080Collision
        }
        'AllExternalSynthetic' {
            Run-NetworkOffline
            Run-NetworkReturn
            Run-AuthExpired
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
