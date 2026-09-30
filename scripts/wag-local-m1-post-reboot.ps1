param(
    [switch]$StartupProbe
)

& {
    $ErrorActionPreference = 'Stop'

    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $receipts = Join-Path $base 'receipts'
    $logs = Join-Path $base 'logs'
    $markerPath = Join-Path $receipts 'wag-local-m1-reboot-pre.json'
    $receiptPath = Join-Path $receipts 'wag-local-m1-reboot-v1.json'
    $probeLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'WAG Local M1 Post-Reboot Verify.lnk'
    $wagLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'WAG Local.lnk'
    $supervisorPidFile = Join-Path $logs 'wag-local-supervisor.pid'
    $devspacePin = Join-Path $base 'DevSpace-Pin-33d6d0b'
    $expectedDevspaceHead = '33d6d0bcc2256024484d2456da924af8afd814ed'

    New-Item -ItemType Directory -Path $receipts -Force | Out-Null

    function Test-HttpOk([string]$Url) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        }
        catch { return $false }
    }

    function Get-SupervisorEvidence {
        if (-not (Test-Path -LiteralPath $supervisorPidFile -PathType Leaf)) {
            return [pscustomobject]@{ valid = $false; pid = 0; detail = 'pid file missing' }
        }

        $supervisorPid = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $supervisorPidFile -Raw).Trim(), [ref]$supervisorPid)) {
            return [pscustomobject]@{ valid = $false; pid = 0; detail = 'pid file invalid' }
        }

        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$supervisorPid" -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            return [pscustomobject]@{ valid = $false; pid = $supervisorPid; detail = 'process missing' }
        }

        $matches = $process.Name -eq 'pwsh.exe' -and
            $process.CommandLine -match 'Start-WagLocalSupervisor\.ps1'
        return [pscustomobject]@{
            valid = [bool]$matches
            pid = $supervisorPid
            detail = if ($matches) { 'exact WAG supervisor command line matched' } else { 'process identity mismatch' }
        }
    }

    function Read-GitHead([string]$Root) {
        try {
            $head = (& git.exe -C $Root rev-parse HEAD 2>$null)
            if ($LASTEXITCODE -ne 0) { return '' }
            return ([string]$head).Trim()
        }
        catch { return '' }
    }

    $startedAt = [DateTime]::UtcNow
    $results = [Collections.Generic.List[object]]::new()
    $pass = $false

    try {
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
            throw "missing pre-reboot marker: $markerPath"
        }

        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        $preBoot = [DateTime]::Parse([string]$marker.preBootTimeUtc).ToUniversalTime()
        $postBoot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
        $rebootObserved = $postBoot -gt $preBoot.AddSeconds(5)

        $results.Add([ordered]@{
            check = 'startup-probe-invocation'
            pass = [bool]$StartupProbe
            detail = if ($StartupProbe) { 'verifier launched with StartupProbe marker' } else { 'StartupProbe switch missing' }
        })

        $results.Add([ordered]@{
            check = 'new-windows-boot-observed'
            pass = $rebootObserved
            detail = "preBoot=$($preBoot.ToString('o')) postBoot=$($postBoot.ToString('o'))"
        })

        $results.Add([ordered]@{
            check = 'wag-login-startup-shortcut-present'
            pass = (Test-Path -LiteralPath $wagLink -PathType Leaf)
            detail = $wagLink
        })

        $deadline = [DateTime]::UtcNow.AddSeconds(300)
        $devspaceReady = $false
        $tunnelReady = $false
        $tunnelHealthy = $false
        $supervisor = $null

        do {
            $devspaceReady = Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server'
            $tunnelReady = Test-HttpOk 'http://127.0.0.1:8080/readyz'
            $tunnelHealthy = Test-HttpOk 'http://127.0.0.1:8080/healthz'
            $supervisor = Get-SupervisorEvidence

            if ($devspaceReady -and $tunnelReady -and $tunnelHealthy -and $supervisor.valid) {
                break
            }
            Start-Sleep -Seconds 2
        } while ([DateTime]::UtcNow -lt $deadline)

        $results.Add([ordered]@{
            check = 'devspace-discovery-ready'
            pass = $devspaceReady
            detail = 'http://127.0.0.1:7677/.well-known/oauth-authorization-server'
        })
        $results.Add([ordered]@{
            check = 'tunnel-ready'
            pass = $tunnelReady
            detail = 'http://127.0.0.1:8080/readyz'
        })
        $results.Add([ordered]@{
            check = 'tunnel-health'
            pass = $tunnelHealthy
            detail = 'http://127.0.0.1:8080/healthz'
        })
        $results.Add([ordered]@{
            check = 'supervisor-exact-process'
            pass = [bool]$supervisor.valid
            detail = "pid=$($supervisor.pid) $($supervisor.detail)"
        })

        $devspaceHead = Read-GitHead $devspacePin
        $results.Add([ordered]@{
            check = 'devspace-exact-pin'
            pass = $devspaceHead -eq $expectedDevspaceHead
            detail = "expected=$expectedDevspaceHead actual=$devspaceHead"
        })

        $repoHead = Read-GitHead ([string]$marker.repoRoot)
        $results.Add([ordered]@{
            check = 'acceptance-repo-head'
            pass = $repoHead -eq [string]$marker.expectedRepoHead
            detail = "expected=$($marker.expectedRepoHead) actual=$repoHead"
        })

        $backupCount = @(
            Get-ChildItem -LiteralPath $base -Directory -Filter 'DevSpace-Pin-33d6d0b.m1-backup-*' -ErrorAction SilentlyContinue
        ).Count
        $results.Add([ordered]@{
            check = 'no-devspace-backup-leftover'
            pass = $backupCount -eq 0
            detail = "backupCount=$backupCount"
        })

        $failed = @($results | Where-Object { -not $_.pass })
        $pass = $failed.Count -eq 0

        $receipt = [ordered]@{
            schema = 'WAG_LOCAL_M1_REBOOT_V1'
            generatedAtUtc = [DateTime]::UtcNow.ToString('o')
            preparedAtUtc = [string]$marker.preparedAtUtc
            preBootTimeUtc = $preBoot.ToString('o')
            postBootTimeUtc = $postBoot.ToString('o')
            elapsedFromVerifierStartMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
            expectedRepoHead = [string]$marker.expectedRepoHead
            pass = $pass
            results = $results.ToArray()
        }

        $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
    }
    catch {
        $results.Add([ordered]@{
            check = 'verifier-exception'
            pass = $false
            detail = $_.Exception.Message
        })
        $receipt = [ordered]@{
            schema = 'WAG_LOCAL_M1_REBOOT_V1'
            generatedAtUtc = [DateTime]::UtcNow.ToString('o')
            pass = $false
            results = $results.ToArray()
        }
        $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
        $pass = $false
    }

    if ($pass) {
        Remove-Item -LiteralPath $probeLink -Force -ErrorAction SilentlyContinue
        exit 0
    }

    exit 2
}
