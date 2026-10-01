param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedRepoHead
)

& {
    $ErrorActionPreference = 'Stop'

    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $receipts = Join-Path $base 'receipts'
    $markerPath = Join-Path $receipts 'wag-local-m1-reboot-pre.json'
    $receiptPath = Join-Path $receipts 'wag-local-m1-reboot-v1.json'
    $installedVerifier = Join-Path $base 'Verify-WagLocalM1PostReboot.ps1'
    $sourceVerifier = Join-Path $PSScriptRoot 'wag-local-m1-post-reboot.ps1'
    $startup = [Environment]::GetFolderPath('Startup')
    $wagLink = Join-Path $startup 'WAG Local.lnk'
    $probeLink = Join-Path $startup 'WAG Local M1 Post-Reboot Verify.lnk'
    $supervisorPidFile = Join-Path $base 'logs\wag-local-supervisor.pid'
    $devspacePin = Join-Path $base 'DevSpace-Pin-33d6d0b'
    $expectedDevspaceHead = '33d6d0bcc2256024484d2456da924af8afd814ed'

    function Test-HttpOk([string]$Url) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        }
        catch { return $false }
    }

    function Read-GitHead([string]$Root) {
        $head = (& git.exe -C $Root rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -ne 0) { return '' }
        return ([string]$head).Trim()
    }

    if (-not (Test-Path -LiteralPath $sourceVerifier -PathType Leaf)) {
        throw "missing post-reboot verifier: $sourceVerifier"
    }
    if (-not (Test-Path -LiteralPath $wagLink -PathType Leaf)) {
        throw "WAG login startup shortcut missing: $wagLink"
    }

    $repoHead = Read-GitHead $RepoRoot
    if ($repoHead -ne $ExpectedRepoHead) {
        throw "repo HEAD mismatch: expected $ExpectedRepoHead actual $repoHead"
    }

    $devspaceHead = Read-GitHead $devspacePin
    if ($devspaceHead -ne $expectedDevspaceHead) {
        throw "DevSpace pin mismatch: expected $expectedDevspaceHead actual $devspaceHead"
    }

    $devspaceReady = Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server'
    $tunnelReady = Test-HttpOk 'http://127.0.0.1:8080/readyz'
    $tunnelHealthy = Test-HttpOk 'http://127.0.0.1:8080/healthz'
    if (-not ($devspaceReady -and $tunnelReady -and $tunnelHealthy)) {
        throw 'WAG stack must be Ready before preparing reboot acceptance'
    }

    $supervisorPid = 0
    if (-not (Test-Path -LiteralPath $supervisorPidFile -PathType Leaf) -or
        -not [int]::TryParse((Get-Content -LiteralPath $supervisorPidFile -Raw).Trim(), [ref]$supervisorPid)) {
        throw 'valid supervisor pid receipt required before reboot'
    }
    $supervisorProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$supervisorPid" -ErrorAction SilentlyContinue
    if ($null -eq $supervisorProcess -or
        $supervisorProcess.Name -ne 'pwsh.exe' -or
        $supervisorProcess.CommandLine -notmatch 'Start-WagLocalSupervisor\.ps1') {
        throw 'supervisor process identity mismatch before reboot'
    }

    New-Item -ItemType Directory -Path $receipts -Force | Out-Null
    Copy-Item -LiteralPath $sourceVerifier -Destination $installedVerifier -Force
    Remove-Item -LiteralPath $receiptPath -Force -ErrorAction SilentlyContinue

    $verifierSha = (Get-FileHash -LiteralPath $installedVerifier -Algorithm SHA256).Hash.ToLowerInvariant()
    $preBoot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()

    $marker = [ordered]@{
        schema = 'WAG_LOCAL_M1_REBOOT_PRE_V1'
        preparedAtUtc = [DateTime]::UtcNow.ToString('o')
        preBootTimeUtc = $preBoot.ToString('o')
        repoRoot = $RepoRoot
        expectedRepoHead = $ExpectedRepoHead
        expectedDevspaceHead = $expectedDevspaceHead
        verifierPath = $installedVerifier
        verifierSha256 = $verifierSha
        preSupervisorPid = $supervisorPid
        preHealth = [ordered]@{
            devspaceDiscovery = $devspaceReady
            tunnelReady = $tunnelReady
            tunnelHealth = $tunnelHealthy
        }
    }
    $marker | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $markerPath -Encoding utf8

    $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($probeLink)
    $shortcut.TargetPath = $pwsh
    $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $installedVerifier + '" -StartupProbe'
    $shortcut.WorkingDirectory = $base
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'One-shot WAG Local M1 post-reboot acceptance verifier'
    $shortcut.Save()

    if (-not (Test-Path -LiteralPath $probeLink -PathType Leaf)) {
        throw 'failed to create post-reboot Startup shortcut'
    }

    Write-Output "M1_REBOOT_PREPARED=True"
    Write-Output "M1_REBOOT_MARKER=$markerPath"
    Write-Output "M1_REBOOT_PROBE=$probeLink"
    Write-Output "M1_REBOOT_EXPECTED_HEAD=$ExpectedRepoHead"
}
