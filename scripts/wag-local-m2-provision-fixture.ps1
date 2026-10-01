param(
    [string]$Output = ''
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $args = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
        if ($Output) { $args += @('-Output',$Output) }
        & $pwsh @args
        exit $LASTEXITCODE
    }

    if (-not $IsWindows) { throw 'M2 provisioning fixture currently supports Windows only' }

    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $tmp = Join-Path $root '.tmp-wag-m2-provision-fixture'
    $pack = Join-Path $tmp 'pack'
    $consumer = Join-Path $tmp 'consumer'
    $fakeLocal = Join-Path $tmp 'localappdata'
    $allowed = Join-Path $tmp 'workspace'
    $profilePath = '/tmp/wag-m2-provision-fixture/web-agent-gateway.yaml'
    $profileDir = '/tmp/wag-m2-provision-fixture'
    $tunnelClient = '/home/pacmap/tools/openai-tunnel-client/v0.0.14/tunnel-client'
    $tunnelId = 'tunnel_0123456789abcdef0123456789abcdef'
    $fixtureRuntimeValue = 'fixture-runtime-value-not-a-real-key'
    $fakeBase = Join-Path $fakeLocal 'WAG-Local'
    $liveBase = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $liveStartup = Join-Path ([Environment]::GetFolderPath('Startup')) 'WAG Local.lnk'

    if (-not $Output) {
        $Output = Join-Path $root 'docs\benchmarks\2026-09-30-wag-local-product-m2-first-time-provision-fixture.json'
    }
    $Output = [IO.Path]::GetFullPath($Output)

    function Get-HashOrEmpty([string]$Path) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    function Test-HttpOk([string]$Url) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        }
        catch { return $false }
    }

    $before = [ordered]@{
        startup = Get-HashOrEmpty $liveStartup
        starter = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocal.ps1')
        supervisor = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocalSupervisor.ps1')
        tunnelLauncher = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocalTunnel.ps1')
        devspaceReady = Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server'
        tunnelReady = Test-HttpOk 'http://127.0.0.1:8080/readyz'
        tunnelHealth = Test-HttpOk 'http://127.0.0.1:8080/healthz'
    }

    $firstExit = 1
    $secondExit = 1
    $firstStatus = ''
    $secondStatus = ''
    $firstOutput = ''
    $secondOutput = ''
    $errorText = ''

    try {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Recurse -Force
        }
        New-Item -ItemType Directory -Path $pack,$consumer,$fakeLocal,$allowed -Force | Out-Null
        & wsl.exe -e sh -lc 'rm -rf /tmp/wag-m2-provision-fixture && mkdir -p /tmp/wag-m2-provision-fixture'
        if ($LASTEXITCODE -ne 0) { throw 'fixture WSL directory setup failed' }

        & npm.cmd pack --pack-destination $pack | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
        $tarball = (Get-ChildItem -LiteralPath $pack -Filter '*.tgz' | Select-Object -First 1).FullName
        if (-not $tarball) { throw 'package tarball missing' }

        Push-Location $consumer
        try {
            & npm.cmd init -y | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'consumer npm init failed' }
            & npm.cmd install --ignore-scripts --no-audit --no-fund --no-save $tarball | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'consumer tarball install failed' }

            $oldLocal = $env:LOCALAPPDATA
            $oldProfile = $env:WAG_SETUP_PROFILE_FILE
            $oldRuntime = $env:WAG_SETUP_RUNTIME_API_KEY
            try {
                $env:LOCALAPPDATA = $fakeLocal
                $env:WAG_SETUP_PROFILE_FILE = $profilePath
                $env:WAG_SETUP_RUNTIME_API_KEY = $fixtureRuntimeValue

                $firstLines = @(& node.exe '.\node_modules\web-agent-gateway\dist\cli.js' setup --no-start --no-autostart --tunnel-id $tunnelId --runtime-key-ref env:CONTROL_PLANE_API_KEY --allowed-root $allowed --tunnel-client-path $tunnelClient 2>&1)
                $firstExit = $LASTEXITCODE
                $firstOutput = ($firstLines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine

                $firstReceiptPath = Join-Path $fakeBase 'receipts\wag-local-provision.json'
                if (Test-Path -LiteralPath $firstReceiptPath -PathType Leaf) {
                    $firstReceipt = Get-Content -LiteralPath $firstReceiptPath -Raw | ConvertFrom-Json
                    $firstStatus = [string]$firstReceipt.status
                }

                $secondLines = @(& node.exe '.\node_modules\web-agent-gateway\dist\cli.js' setup --no-start --no-autostart --connector-confirmed --allowed-root $allowed --tunnel-client-path $tunnelClient 2>&1)
                $secondExit = $LASTEXITCODE
                $secondOutput = ($secondLines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine

                $secondReceiptPath = Join-Path $fakeBase 'receipts\wag-local-provision.json'
                if (Test-Path -LiteralPath $secondReceiptPath -PathType Leaf) {
                    $secondReceipt = Get-Content -LiteralPath $secondReceiptPath -Raw | ConvertFrom-Json
                    $secondStatus = [string]$secondReceipt.status
                }
            }
            finally {
                $env:LOCALAPPDATA = $oldLocal
                if ($null -eq $oldProfile) { Remove-Item Env:WAG_SETUP_PROFILE_FILE -ErrorAction SilentlyContinue }
                else { $env:WAG_SETUP_PROFILE_FILE = $oldProfile }
                if ($null -eq $oldRuntime) { Remove-Item Env:WAG_SETUP_RUNTIME_API_KEY -ErrorAction SilentlyContinue }
                else { $env:WAG_SETUP_RUNTIME_API_KEY = $oldRuntime }
            }
        }
        finally {
            Pop-Location
        }
    }
    catch {
        $errorText = $_.Exception.Message
    }

    $after = [ordered]@{
        startup = Get-HashOrEmpty $liveStartup
        starter = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocal.ps1')
        supervisor = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocalSupervisor.ps1')
        tunnelLauncher = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocalTunnel.ps1')
        devspaceReady = Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server'
        tunnelReady = Test-HttpOk 'http://127.0.0.1:8080/readyz'
        tunnelHealth = Test-HttpOk 'http://127.0.0.1:8080/healthz'
    }

    & wsl.exe -e test -f $profilePath 2>$null
    $profilePresent = $LASTEXITCODE -eq 0
    $setupReceiptPath = Join-Path $fakeBase 'receipts\wag-local-setup.json'
    $installedRuntimeTag = if (Test-Path -LiteralPath $setupReceiptPath -PathType Leaf) {
        [string](Get-Content -LiteralPath $setupReceiptPath -Raw | ConvertFrom-Json).runtimeTag
    } else { '' }
    $installedRuntimeCli = if ($installedRuntimeTag) {
        Join-Path (Join-Path $fakeBase ('runtime\' + $installedRuntimeTag)) 'dist\cli.js'
    } else { '' }

    $checks = [ordered]@{
        firstExitRequestsNextAction = $firstExit -eq 2
        firstStatusConnector = $firstStatus -eq 'ACTION_REQUIRED_CHATGPT_CONNECTOR'
        secondExitReady = $secondExit -eq 0
        secondStatusReady = $secondStatus -eq 'READY'
        profileCreated = $profilePresent
        runtimeSecretProtected = Test-Path -LiteralPath (Join-Path $fakeBase 'secrets\control-plane.dpapi') -PathType Leaf
        connectorMarkerWritten = Test-Path -LiteralPath (Join-Path $fakeBase 'state\chatgpt-connector.confirmed') -PathType Leaf
        runtimeInstalled = [bool]$installedRuntimeCli -and (Test-Path -LiteralPath $installedRuntimeCli -PathType Leaf)
        secretNotPrintedFirst = -not $firstOutput.Contains($fixtureRuntimeValue)
        secretNotPrintedSecond = -not $secondOutput.Contains($fixtureRuntimeValue)
        liveStartupUnchanged = $before.startup -eq $after.startup
        liveStarterUnchanged = $before.starter -eq $after.starter
        liveSupervisorUnchanged = $before.supervisor -eq $after.supervisor
        liveTunnelLauncherUnchanged = $before.tunnelLauncher -eq $after.tunnelLauncher
        liveStackReadyBefore = $before.devspaceReady -and $before.tunnelReady -and $before.tunnelHealth
        liveStackReadyAfter = $after.devspaceReady -and $after.tunnelReady -and $after.tunnelHealth
    }

    $failed = @($checks.GetEnumerator() | Where-Object { -not [bool]$_.Value })
    $pass = $failed.Count -eq 0 -and -not $errorText

    $receipt = [ordered]@{
        schema = 'WAG_LOCAL_M2_FIRST_TIME_PROVISION_FIXTURE_V1'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        pass = $pass
        error = if ($errorText) { $errorText } else { $null }
        firstRun = [ordered]@{
            exit = $firstExit
            status = $firstStatus
        }
        secondRun = [ordered]@{
            exit = $secondExit
            status = $secondStatus
        }
        checks = $checks
    }

    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Output)) -Force | Out-Null
    [IO.File]::WriteAllText($Output, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))

    & wsl.exe -e sh -lc 'rm -rf /tmp/wag-m2-provision-fixture' 2>$null
    if (Test-Path -LiteralPath $tmp) {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Output "M2_FIRST_TIME_PROVISION_RECEIPT=$Output"
    Write-Output "M2_FIRST_TIME_PROVISION_PASS=$pass"
    if (-not $pass) {
        $failedNames = @($failed | ForEach-Object { [string]$_.Key })
        Write-Output ("M2_FIRST_TIME_PROVISION_FAILED_CHECKS=" + ($failedNames -join ','))
        if ($errorText) { Write-Output "M2_FIRST_TIME_PROVISION_ERROR=$errorText" }
        exit 2
    }
}
