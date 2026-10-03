param(
    [string]$Output = ''
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $forward = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
        if ($Output) { $forward += @('-Output',$Output) }
        & $pwsh @forward
        exit $LASTEXITCODE
    }

    if (-not $IsWindows) { throw 'M15 clean-install fixture currently supports Windows only' }

    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $runner = Join-Path $root 'scripts\wag-local-clean-install-acceptance.ps1'
    $tmp = Join-Path $root '.tmp-wag-m15-clean-install-fixture'
    $fakeLocal = Join-Path $tmp 'localappdata'
    $allowed = Join-Path $tmp 'workspace'
    $profilePath = '/tmp/wag-m15-clean-install-fixture/web-agent-gateway.yaml'
    $tunnelClient = '/home/pacmap/tools/openai-tunnel-client/v0.0.14/tunnel-client'
    $tunnelId = 'tunnel_0123456789abcdef0123456789abcdef'
    $fixtureRuntimeValue = 'm15-fixture-runtime-value'
    $fakeBase = Join-Path $fakeLocal 'WAG-Local'
    $liveBase = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $liveStartup = Join-Path ([Environment]::GetFolderPath('Startup')) 'WAG Local.lnk'

    if (-not $Output) {
        $Output = Join-Path $root 'docs\benchmarks\2026-10-03-wag-m15-clean-install-fixture.json'
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
        } catch { return $false }
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

    $oldLocal = $env:LOCALAPPDATA
    $oldProfile = $env:WAG_SETUP_PROFILE_FILE
    $oldRuntime = $env:WAG_SETUP_RUNTIME_API_KEY
    $oldFixture = $env:WAG_CLEAN_ACCEPTANCE_FIXTURE
    $baselineExit = 1
    $installExit = 1
    $proofExit = 1
    $postRebootExit = 1
    $baselineStatus = ''
    $installStatus = ''
    $proofStatus = ''
    $postRebootStatus = ''
    $errorText = ''

    try {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
        New-Item -ItemType Directory -Path $fakeLocal,$allowed -Force | Out-Null
        & wsl.exe -e sh -lc 'rm -rf /tmp/wag-m15-clean-install-fixture && mkdir -p /tmp/wag-m15-clean-install-fixture'
        if ($LASTEXITCODE -ne 0) { throw 'fixture WSL directory setup failed' }

        $env:LOCALAPPDATA = $fakeLocal
        $env:WAG_SETUP_PROFILE_FILE = $profilePath
        $env:WAG_SETUP_RUNTIME_API_KEY = $fixtureRuntimeValue
        $env:WAG_CLEAN_ACCEPTANCE_FIXTURE = '1'

        & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner -Stage Baseline -AllowedRoot $allowed | Out-Null
        $baselineExit = $LASTEXITCODE
        $baselineReceiptPath = Join-Path $fakeLocal 'WAG-Acceptance\clean-install-baseline.json'
        if (Test-Path -LiteralPath $baselineReceiptPath -PathType Leaf) {
            $baselineStatus = [string](Get-Content -LiteralPath $baselineReceiptPath -Raw | ConvertFrom-Json).status
        }

        & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner -Stage Install -AllowedRoot $allowed -TunnelId $tunnelId -RuntimeKeyRef env:CONTROL_PLANE_API_KEY -TunnelClientPath $tunnelClient | Out-Null
        $installExit = $LASTEXITCODE
        $installReceiptPath = Join-Path $fakeLocal 'WAG-Acceptance\clean-install-install.json'
        if (Test-Path -LiteralPath $installReceiptPath -PathType Leaf) {
            $installStatus = [string](Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json).status
        }

        $challengePath = Join-Path $allowed '.wag-acceptance\initial-challenge.txt'
        $responsePath = Join-Path $allowed '.wag-acceptance\initial-response.txt'
        if (-not (Test-Path -LiteralPath $challengePath -PathType Leaf)) {
            throw 'fixture initial connector challenge missing'
        }
        $challenge = (Get-Content -LiteralPath $challengePath -Raw).Trim()
        $prefix = 'WAG_ACCEPTANCE_CHALLENGE_V1:'
        if (-not $challenge.StartsWith($prefix)) { throw 'fixture initial connector challenge prefix invalid' }
        $nonce = $challenge.Substring($prefix.Length)
        if ($nonce.Length -ne 48 -or $nonce -match '[^a-f0-9]') { throw 'fixture initial connector challenge nonce invalid' }
        $response = 'WAG_ACCEPTANCE_RESPONSE_V1:' + $nonce
        [IO.File]::WriteAllText($responsePath, $response + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

        & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner -Stage ConnectorProof -AllowedRoot $allowed -TunnelClientPath $tunnelClient | Out-Null
        $proofExit = $LASTEXITCODE
        $proofReceiptPath = Join-Path $fakeLocal 'WAG-Acceptance\clean-install-connectorproof.json'
        if (Test-Path -LiteralPath $proofReceiptPath -PathType Leaf) {
            $proofStatus = [string](Get-Content -LiteralPath $proofReceiptPath -Raw | ConvertFrom-Json).status
        }

        & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner -Stage PostReboot -AllowedRoot $allowed | Out-Null
        $postRebootExit = $LASTEXITCODE
        $postRebootReceiptPath = Join-Path $fakeLocal 'WAG-Acceptance\clean-install-postreboot.json'
        if (Test-Path -LiteralPath $postRebootReceiptPath -PathType Leaf) {
            $postRebootStatus = [string](Get-Content -LiteralPath $postRebootReceiptPath -Raw | ConvertFrom-Json).status
        }
    }
    catch {
        $errorText = $_.Exception.Message
    }
    finally {
        $env:LOCALAPPDATA = $oldLocal
        if ($null -eq $oldProfile) { Remove-Item Env:WAG_SETUP_PROFILE_FILE -ErrorAction SilentlyContinue }
        else { $env:WAG_SETUP_PROFILE_FILE = $oldProfile }
        if ($null -eq $oldRuntime) { Remove-Item Env:WAG_SETUP_RUNTIME_API_KEY -ErrorAction SilentlyContinue }
        else { $env:WAG_SETUP_RUNTIME_API_KEY = $oldRuntime }
        if ($null -eq $oldFixture) { Remove-Item Env:WAG_CLEAN_ACCEPTANCE_FIXTURE -ErrorAction SilentlyContinue }
        else { $env:WAG_CLEAN_ACCEPTANCE_FIXTURE = $oldFixture }
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

    $statePath = Join-Path $fakeLocal 'WAG-Acceptance\clean-install-v1.json'
    $state = if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    } else { $null }
    $stateText = if ($null -ne $state) { Get-Content -LiteralPath $statePath -Raw } else { '' }

    $checks = [ordered]@{
        baselinePass = $baselineExit -eq 0 -and $baselineStatus -eq 'PASS'
        installStopsAtConnector = $installExit -eq 2 -and $installStatus -eq 'ACTION_REQUIRED_CHATGPT_CONNECTOR'
        connectorProofPass = $proofExit -eq 0 -and $proofStatus -eq 'PASS'
        postRebootFailsWithoutRealReboot = $postRebootExit -eq 2 -and $postRebootStatus -eq 'FAIL'
        postRebootChallengeNotIssued = -not (Test-Path -LiteralPath (Join-Path $allowed '.wag-acceptance\post-reboot-challenge.txt') -PathType Leaf)
        fixtureNeverExternalEligible = $null -ne $state -and -not [bool]$state.eligibleForExternalAcceptance
        connectorResponseVerified = $null -ne $state -and [bool]$state.connectorProof.responseVerified
        connectorMarkerWritten = Test-Path -LiteralPath (Join-Path $fakeBase 'state\chatgpt-connector.confirmed') -PathType Leaf
        runtimeSecretProtected = Test-Path -LiteralPath (Join-Path $fakeBase 'secrets\control-plane.dpapi') -PathType Leaf
        runtimeSecretNotInState = $null -ne $state -and -not $stateText.Contains($fixtureRuntimeValue)
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
        schema = 'WAG_M15_CLEAN_INSTALL_FIXTURE_V1'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        pass = $pass
        error = if ($errorText) { $errorText } else { $null }
        stages = [ordered]@{
            baseline = [ordered]@{ exit = $baselineExit; status = $baselineStatus }
            install = [ordered]@{ exit = $installExit; status = $installStatus }
            connectorProof = [ordered]@{ exit = $proofExit; status = $proofStatus }
            postRebootWithoutReboot = [ordered]@{ exit = $postRebootExit; status = $postRebootStatus }
        }
        checks = $checks
    }

    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Output)) -Force | Out-Null
    [IO.File]::WriteAllText($Output, ($receipt | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))

    & wsl.exe -e sh -lc 'rm -rf /tmp/wag-m15-clean-install-fixture' 2>$null
    if (Test-Path -LiteralPath $tmp) {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Output "M15_CLEAN_INSTALL_FIXTURE_RECEIPT=$Output"
    Write-Output "M15_CLEAN_INSTALL_FIXTURE_PASS=$pass"
    if (-not $pass) {
        Write-Output ('M15_CLEAN_INSTALL_FIXTURE_FAILED_CHECKS=' + (($failed | ForEach-Object { [string]$_.Key }) -join ','))
        if ($errorText) { Write-Output "M15_CLEAN_INSTALL_FIXTURE_ERROR=$errorText" }
        exit 2
    }
}
