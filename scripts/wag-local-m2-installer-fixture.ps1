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

    if (-not $IsWindows) { throw 'M2 fixture acceptance currently supports Windows only' }

    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $tmp = Join-Path $root '.tmp-wag-m2-install-fixture'
    $pack = Join-Path $tmp 'pack'
    $consumer = Join-Path $tmp 'consumer'
    $fakeLocal = Join-Path $tmp 'localappdata'
    $allowed = Join-Path $tmp 'workspace'
    $fixtureBase = Join-Path $fakeLocal 'WAG-Local'
    $fixtureProfile = '/tmp/wag-m2-fixture/profile.yaml'
    $fixtureWrapper = '/tmp/wag-m2-fixture/wag-mcp-stdio.sh'
    $tunnelClient = '/home/pacmap/tools/openai-tunnel-client/v0.0.14/tunnel-client'
    $liveBase = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $startup = [Environment]::GetFolderPath('Startup')
    $liveStartup = Join-Path $startup 'WAG Local.lnk'

    if (-not $Output) {
        $Output = Join-Path $root 'docs\benchmarks\2026-09-30-wag-local-product-m2-fixture-install.json'
    }
    $Output = [IO.Path]::GetFullPath($Output)

    function Get-HashOrEmpty([string]$Path) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    function Get-WslHash([string]$Path) {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $lines = @(& wsl.exe -e sha256sum $Path 2>$null)
            $code = $LASTEXITCODE
            $line = $lines | Select-Object -First 1
            if ($code -eq 0 -and $line) {
                return (([string]$line -split '\s+')[0]).Trim().ToLowerInvariant()
            }
            Start-Sleep -Milliseconds 500
        }
        return ''
    }

    function Test-HttpOk([string]$Url) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        }
        catch { return $false }
    }

    $before = [ordered]@{
        liveStartupHash = Get-HashOrEmpty $liveStartup
        liveStarterHash = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocal.ps1')
        liveSupervisorHash = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocalSupervisor.ps1')
        liveTunnelLauncherHash = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocalTunnel.ps1')
        liveProfileHash = Get-WslHash '/home/pacmap/.config/tunnel-client/web-agent-gateway.yaml'
        devspaceReady = Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server'
        tunnelReady = Test-HttpOk 'http://127.0.0.1:8080/readyz'
        tunnelHealth = Test-HttpOk 'http://127.0.0.1:8080/healthz'
    }

    $setupExit = 1
    $setupReceipt = $null
    $fixtureWrapperText = ''
    $errorText = ''

    try {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Recurse -Force
        }
        New-Item -ItemType Directory -Path $pack,$consumer,$fakeLocal,$allowed -Force | Out-Null

        & wsl.exe -e sh -lc 'rm -rf /tmp/wag-m2-fixture && mkdir -p /tmp/wag-m2-fixture && printf "command: /tmp/wag-m2-fixture/wag-mcp-stdio.sh\napi_key: m2-fixture-control\n" > /tmp/wag-m2-fixture/profile.yaml'
        if ($LASTEXITCODE -ne 0) { throw 'fixture profile setup failed' }

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
            try {
                $env:LOCALAPPDATA = $fakeLocal
                $env:WAG_SETUP_PROFILE_FILE = $fixtureProfile
                & node.exe '.\node_modules\web-agent-gateway\dist\cli.js' setup --no-start --no-autostart --allowed-root $allowed --tunnel-client-path $tunnelClient
                $setupExit = $LASTEXITCODE
            }
            finally {
                $env:LOCALAPPDATA = $oldLocal
                if ($null -eq $oldProfile) {
                    Remove-Item Env:WAG_SETUP_PROFILE_FILE -ErrorAction SilentlyContinue
                }
                else {
                    $env:WAG_SETUP_PROFILE_FILE = $oldProfile
                }
            }
        }
        finally {
            Pop-Location
        }

        $setupReceiptPath = Join-Path $fixtureBase 'receipts\wag-local-setup.json'
        if (Test-Path -LiteralPath $setupReceiptPath -PathType Leaf) {
            $setupReceipt = Get-Content -LiteralPath $setupReceiptPath -Raw | ConvertFrom-Json
        }

        $fixtureWrapperText = ((@(& wsl.exe -e cat $fixtureWrapper 2>$null)) -join [Environment]::NewLine)
    }
    catch {
        $errorText = $_.Exception.Message
    }

    $after = [ordered]@{
        liveStartupHash = Get-HashOrEmpty $liveStartup
        liveStarterHash = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocal.ps1')
        liveSupervisorHash = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocalSupervisor.ps1')
        liveTunnelLauncherHash = Get-HashOrEmpty (Join-Path $liveBase 'Start-WagLocalTunnel.ps1')
        liveProfileHash = Get-WslHash '/home/pacmap/.config/tunnel-client/web-agent-gateway.yaml'
        devspaceReady = Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server'
        tunnelReady = Test-HttpOk 'http://127.0.0.1:8080/readyz'
        tunnelHealth = Test-HttpOk 'http://127.0.0.1:8080/healthz'
    }

    $fixtureRuntimeTag = if ($setupReceipt) { [string]$setupReceipt.runtimeTag } else { '' }
    $fixtureRuntimeCli = if ($fixtureRuntimeTag) {
        Join-Path (Join-Path $fixtureBase ('runtime\' + $fixtureRuntimeTag)) 'dist\cli.js'
    } else { '' }
    & wsl.exe -e test -x $fixtureWrapper 2>$null
    $fixtureWrapperExecutable = $LASTEXITCODE -eq 0

    $checks = [ordered]@{
        setupExitZero = $setupExit -eq 0
        receiptPresent = $null -ne $setupReceipt
        receiptInstalled = $null -ne $setupReceipt -and [string]$setupReceipt.status -eq 'INSTALLED'
        receiptClientConnected = $null -ne $setupReceipt -and [string]$setupReceipt.client -eq 'connected'
        receiptDoctorDeferred = $null -ne $setupReceipt -and [string]$setupReceipt.doctor -eq 'DEFERRED'
        receiptAutostartFalse = $null -ne $setupReceipt -and $setupReceipt.autostart -eq $false
        runtimeCliPresent = Test-Path -LiteralPath $fixtureRuntimeCli -PathType Leaf
        gatewayConfigPresent = Test-Path -LiteralPath (Join-Path $fixtureBase 'config\wag-local.config.json') -PathType Leaf
        devspaceConfigPresent = Test-Path -LiteralPath (Join-Path $fixtureBase 'DevSpace\config.jsonc') -PathType Leaf
        starterInstalled = Test-Path -LiteralPath (Join-Path $fixtureBase 'Start-WagLocal.ps1') -PathType Leaf
        supervisorInstalled = Test-Path -LiteralPath (Join-Path $fixtureBase 'Start-WagLocalSupervisor.ps1') -PathType Leaf
        tunnelPinPresent = Test-Path -LiteralPath (Join-Path $fixtureBase 'tunnel-client-path.txt') -PathType Leaf
        fixtureWrapperExecutable = $fixtureWrapperExecutable
        fixtureWrapperUsesFixtureRuntime = $fixtureWrapperText.Contains($fixtureRuntimeCli.Replace('\','/'))
        liveStartupUnchanged = $before.liveStartupHash -eq $after.liveStartupHash
        liveStarterUnchanged = $before.liveStarterHash -eq $after.liveStarterHash
        liveSupervisorUnchanged = $before.liveSupervisorHash -eq $after.liveSupervisorHash
        liveTunnelLauncherUnchanged = $before.liveTunnelLauncherHash -eq $after.liveTunnelLauncherHash
        liveProfileUnchanged = $before.liveProfileHash -eq $after.liveProfileHash
        liveStackReadyBefore = $before.devspaceReady -and $before.tunnelReady -and $before.tunnelHealth
        liveStackReadyAfter = $after.devspaceReady -and $after.tunnelReady -and $after.tunnelHealth
    }

    $failed = @($checks.GetEnumerator() | Where-Object { -not [bool]$_.Value })
    $pass = $failed.Count -eq 0 -and -not $errorText

    $receipt = [ordered]@{
        schema = 'WAG_LOCAL_M2_FIXTURE_INSTALL_V1'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        pass = $pass
        setupExit = $setupExit
        error = if ($errorText) { $errorText } else { $null }
        setup = if ($setupReceipt) {
            [ordered]@{
                status = [string]$setupReceipt.status
                client = [string]$setupReceipt.client
                doctor = [string]$setupReceipt.doctor
                autostart = [bool]$setupReceipt.autostart
                runtimeTag = [string]$setupReceipt.runtimeTag
            }
        } else { $null }
        checks = $checks
        liveHashes = [ordered]@{
            before = [ordered]@{
                startup = $before.liveStartupHash
                starter = $before.liveStarterHash
                supervisor = $before.liveSupervisorHash
                tunnelLauncher = $before.liveTunnelLauncherHash
                profile = $before.liveProfileHash
            }
            after = [ordered]@{
                startup = $after.liveStartupHash
                starter = $after.liveStarterHash
                supervisor = $after.liveSupervisorHash
                tunnelLauncher = $after.liveTunnelLauncherHash
                profile = $after.liveProfileHash
            }
        }
    }

    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Output)) -Force | Out-Null
    [IO.File]::WriteAllText($Output, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))

    & wsl.exe -e sh -lc 'rm -rf /tmp/wag-m2-fixture' 2>$null
    if (Test-Path -LiteralPath $tmp) {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Output "M2_FIXTURE_RECEIPT=$Output"
    Write-Output "M2_FIXTURE_PASS=$pass"
    if (-not $pass) {
        $failedNames = @($failed | ForEach-Object { [string]$_.Key })
        Write-Output ("M2_FIXTURE_FAILED_CHECKS=" + ($failedNames -join ','))
        if ($errorText) { Write-Output "M2_FIXTURE_ERROR=$errorText" }
        exit 2
    }
}
