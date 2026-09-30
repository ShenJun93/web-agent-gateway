param(
    [switch]$CheckOnly,
    [switch]$NoStart,
    [switch]$NoAutostart,
    [string]$AllowedRoot = '',
    [string]$Output = '',
    [string]$TunnelClientPath = ''
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $forward = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
        if ($CheckOnly) { $forward += '-CheckOnly' }
        if ($NoStart) { $forward += '-NoStart' }
        if ($NoAutostart) { $forward += '-NoAutostart' }
        if ($AllowedRoot) { $forward += @('-AllowedRoot',$AllowedRoot) }
        if ($Output) { $forward += @('-Output',$Output) }
        if ($TunnelClientPath) { $forward += @('-TunnelClientPath',$TunnelClientPath) }
        & $pwsh @forward
        exit $LASTEXITCODE
    }

    if (-not $IsWindows) { throw 'WAG setup currently supports Windows only' }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required' }

    Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

    $packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $packageJsonPath = Join-Path $packageRoot 'package.json'
    $runtimeLockPath = Join-Path $packageRoot 'packaging\runtime-package-lock.json'
    $distCli = Join-Path $packageRoot 'dist\cli.js'
    $pinSource = Join-Path $packageRoot 'docs\benchmarks\devspace-pin.json'
    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $secrets = Join-Path $base 'secrets'
    $logs = Join-Path $base 'logs'
    $receipts = Join-Path $base 'receipts'
    $configDir = Join-Path $base 'config'
    $stateDir = Join-Path $base 'state'
    $runtimeBase = Join-Path $base 'runtime'
    $devspaceConfigDir = Join-Path $base 'DevSpace'
    $tunnelClientPinFile = Join-Path $base 'tunnel-client-path.txt'
    $controlFile = Join-Path $secrets 'control-plane.dpapi'
    $devspaceOwnerFile = Join-Path $secrets 'devspace-owner.dpapi'
    $sessionFile = Join-Path $base 'session-correlation.txt'
    $privateConfig = Join-Path $configDir 'wag-local.config.json'

    $package = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
    $version = [string]$package.version
    $deviceName = [Environment]::MachineName
    if (-not $version) { throw 'Package version is unavailable' }

    if (-not $AllowedRoot) {
        $documents = [Environment]::GetFolderPath('MyDocuments')
        if (-not $documents) { $documents = $env:USERPROFILE }
        $AllowedRoot = Join-Path $documents 'WAG-Workspace'
    }
    $AllowedRoot = [IO.Path]::GetFullPath($AllowedRoot)
    if (-not [IO.Path]::IsPathRooted($AllowedRoot)) { throw 'Allowed root must be absolute' }

    function Test-Command([string]$Name) {
        return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
    }

    function Invoke-Wsl([string[]]$Arguments) {
        $value = & wsl.exe @Arguments
        if ($LASTEXITCODE -ne 0) { return $null }
        return (($value | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
    }

    function Protect-Text([string]$Value, [string]$Path) {
        $secure = ConvertTo-SecureString -String $Value -AsPlainText -Force
        $protected = ConvertFrom-SecureString -SecureString $secure
        [IO.File]::WriteAllText($Path, $protected, [Text.UTF8Encoding]::new($false))
    }

    function New-OwnerSecret {
        $bytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        return [Convert]::ToBase64String($bytes)
    }

    $requirements = [ordered]@{
        node = Test-Command 'node.exe'
        npm = Test-Command 'npm.cmd'
        git = Test-Command 'git.exe'
        pwsh7 = $PSVersionTable.PSVersion.Major -ge 7
        wsl = $false
        dist = (Test-Path -LiteralPath $distCli -PathType Leaf)
        runtimeLock = (Test-Path -LiteralPath $runtimeLockPath -PathType Leaf)
        devspacePin = (Test-Path -LiteralPath $pinSource -PathType Leaf)
    }

    if ($requirements.node) {
        $nodeVersion = (& node.exe --version).Trim()
        $nodeMatch = [regex]::Match($nodeVersion, 'v?(\d+)\.(\d+)')
        $requirements.node = $nodeMatch.Success -and
            [int]$nodeMatch.Groups[1].Value -ge 22 -and
            [int]$nodeMatch.Groups[1].Value -lt 27
    }

    if (Test-Command 'wsl.exe') {
        & wsl.exe -e true 2>$null
        $requirements.wsl = $LASTEXITCODE -eq 0
    }

    $profileFileOverride = ([string]$env:WAG_SETUP_PROFILE_FILE).Trim()
    if ($profileFileOverride) {
        $profileSegments = @($profileFileOverride -split '/')
        if (-not $profileFileOverride.StartsWith('/') -or
            $profileSegments -contains '..' -or
            $profileFileOverride.Contains("`r") -or
            $profileFileOverride.Contains("`n")) {
            throw 'WAG_SETUP_PROFILE_FILE must be an absolute WSL path without traversal'
        }
    }

    $profileText = ''
    $profilePresent = $false
    $wrapperPath = ''
    $profileApiKey = ''
    if ($requirements.wsl) {
        if ($profileFileOverride) {
            $profileText = Invoke-Wsl @('-e','cat',$profileFileOverride)
        }
        else {
            $profileText = Invoke-Wsl @('-e','sh','-lc','cat "$HOME/.config/tunnel-client/web-agent-gateway.yaml" 2>/dev/null')
        }
        $profilePresent = -not [string]::IsNullOrWhiteSpace($profileText)
        if ($profilePresent) {
            $commandLines = @($profileText -split '[\r\n]+' | Where-Object { $_ -match '^\s*command:\s*' })
            if ($commandLines.Count -eq 1) {
                $wrapperPath = ($commandLines[0] -replace '^\s*command:\s*','').Trim().Trim('"').Trim("'")
            }
            $keyLines = @($profileText -split '[\r\n]+' | Where-Object { $_ -match '^\s*api_key:\s*' })
            if ($keyLines.Count -eq 1) {
                $profileApiKey = ($keyLines[0] -replace '^\s*api_key:\s*','').Trim().Trim('"').Trim("'")
                if ($profileApiKey.StartsWith([string][char]36)) { $profileApiKey = '' }
            }
        }
    }

    $resolvedTunnelClient = ''
    foreach ($candidate in @(
        $TunnelClientPath,
        $env:WAG_TUNNEL_CLIENT_PATH,
        $(if (Test-Path -LiteralPath $tunnelClientPinFile -PathType Leaf) {
            (Get-Content -LiteralPath $tunnelClientPinFile -Raw).Trim()
        } else { '' })
    )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $resolvedTunnelClient = $candidate.Trim()
            break
        }
    }
    if (-not $resolvedTunnelClient -and $requirements.wsl) {
        $resolvedTunnelClient = Invoke-Wsl @(
            '-e','sh','-lc',
            'p="$HOME/tools/openai-tunnel-client/v0.0.14/tunnel-client"; if [ -x "$p" ]; then printf "%s" "$p"; fi'
        )
    }

    $tunnelClientReady = $false
    if ($resolvedTunnelClient -and $resolvedTunnelClient.StartsWith('/') -and $requirements.wsl) {
        & wsl.exe -e test -x $resolvedTunnelClient 2>$null
        $tunnelClientReady = $LASTEXITCODE -eq 0
    }

    $controlSecretAvailable = (Test-Path -LiteralPath $controlFile -PathType Leaf) -or
        -not [string]::IsNullOrWhiteSpace($profileApiKey)
    $wrapperReady = $wrapperPath.StartsWith('/')
    $clientReady = $profilePresent -and $wrapperReady -and $tunnelClientReady -and $controlSecretAvailable
    $prerequisitesReady = -not ($requirements.Values -contains $false)

    $actions = @()
    if (-not $profilePresent) { $actions += 'WAG_SETUP_CLIENT_PROFILE_REQUIRED' }
    elseif (-not $wrapperReady) { $actions += 'WAG_SETUP_CLIENT_WRAPPER_INVALID' }
    if (-not $tunnelClientReady) { $actions += 'WAG_SETUP_TUNNEL_CLIENT_REQUIRED' }
    if (-not $controlSecretAvailable) { $actions += 'WAG_SETUP_CONTROL_PLANE_CREDENTIAL_REQUIRED' }
    if (-not $prerequisitesReady) { $actions += 'WAG_SETUP_PREREQUISITE_FAILED' }

    if ($CheckOnly) {
        $status = if ($prerequisitesReady -and $clientReady) { 'READY_TO_INSTALL' } else { 'ACTION_REQUIRED' }
        $receipt = [ordered]@{
            schema = 'WAG_LOCAL_SETUP_V1'
            mode = 'CHECK_ONLY'
            generatedAtUtc = [DateTime]::UtcNow.ToString('o')
            version = $version
            device = $deviceName
            status = $status
            client = if ($clientReady) { 'connected' } else { 'action_required' }
            doctor = if ($prerequisitesReady) { 'PASS' } else { 'FAIL' }
            requirements = $requirements
            tunnelClient = [ordered]@{
                resolved = [bool]$resolvedTunnelClient
                executable = $tunnelClientReady
            }
            actions = $actions
        }
        Write-Output 'WAG Local'
        Write-Output "Version: $version"
        Write-Output "Device: $deviceName"
        Write-Output "Status: $status"
        Write-Output "Client: $($receipt.client)"
        Write-Output "Doctor: $($receipt.doctor)"
        Write-Output 'Receipt: not written (check-only)'
        Write-Output ('WAG_SETUP_JSON=' + ($receipt | ConvertTo-Json -Depth 8 -Compress))
        if ($status -eq 'READY_TO_INSTALL') { exit 0 } else { exit 2 }
    }

    if (-not $prerequisitesReady) {
        throw 'STOP: one or more WAG setup prerequisites are unavailable'
    }

    foreach ($dir in @($base,$secrets,$logs,$receipts,$configDir,$stateDir,$runtimeBase,$devspaceConfigDir,$AllowedRoot)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    if (-not (Test-Path -LiteralPath $devspaceOwnerFile -PathType Leaf)) {
        Protect-Text (New-OwnerSecret) $devspaceOwnerFile
    }
    if (-not (Test-Path -LiteralPath $controlFile -PathType Leaf) -and $profileApiKey) {
        Protect-Text $profileApiKey $controlFile
    }
    if ($tunnelClientReady) {
        [IO.File]::WriteAllText($tunnelClientPinFile, $resolvedTunnelClient, [Text.UTF8Encoding]::new($false))
    }

    $sessionCorrelation = ''
    if (Test-Path -LiteralPath $sessionFile -PathType Leaf) {
        $sessionCorrelation = (Get-Content -LiteralPath $sessionFile -Raw).Trim()
    }
    if (-not $sessionCorrelation.StartsWith('session_') -or $sessionCorrelation -match '[^A-Za-z0-9._:-]') {
        $sessionCorrelation = 'session_' + [Guid]::NewGuid().ToString()
        [IO.File]::WriteAllText($sessionFile, $sessionCorrelation, [Text.UTF8Encoding]::new($false))
    }

    $devspaceState = Join-Path $base 'DevSpace-State'
    $devspaceWorktrees = Join-Path $base 'DevSpace-Worktrees'
    New-Item -ItemType Directory -Path $devspaceState,$devspaceWorktrees -Force | Out-Null
    $devspaceConfig = [ordered]@{
        configVersion = 1
        server = [ordered]@{
            host = '127.0.0.1'
            port = 7677
            publicBaseUrl = $null
            allowedHosts = @()
            trustProxy = $false
        }
        workspaces = [ordered]@{
            allowedRoots = @($AllowedRoot)
            worktreeRoot = $devspaceWorktrees
        }
        storage = [ordered]@{ stateDir = $devspaceState }
        tools = [ordered]@{ mode = 'codex' }
        ui = [ordered]@{ enabled = $true }
        artifacts = [ordered]@{ enabled = $false; maxFileBytes = 104857600 }
        skills = [ordered]@{ enabled = $true; paths = @(); agentDir = '~/.codex' }
        subagents = [ordered]@{ enabled = $false; instructions = 'on-demand'; providers = @() }
        logging = [ordered]@{
            level = 'info'
            format = 'json'
            requests = $true
            assets = $false
            toolCalls = $true
            shellCommands = $false
        }
        oauth = [ordered]@{
            accessTokenTtlSeconds = 3600
            refreshTokenTtlSeconds = 2592000
            scopes = @('devspace')
            allowedResourceUrls = @()
            allowedRedirectHosts = @('chatgpt.com','localhost','127.0.0.1')
        }
    }
    [IO.File]::WriteAllText(
        (Join-Path $devspaceConfigDir 'config.jsonc'),
        ($devspaceConfig | ConvertTo-Json -Depth 12),
        [Text.UTF8Encoding]::new($false)
    )

    $mutationState = Join-Path $stateDir 'wag-local.sqlite'
    $repoEngineering = [ordered]@{
        inspect = $true
        gitCommit = [ordered]@{ protectedBranches = @('main','master') }
        mutation = [ordered]@{
            statePath = $mutationState
            ownerId = 'local.private.stdio'
            reviewTtlMs = 300000
            sessionCorrelation = $sessionCorrelation
        }
    }
    $edgeCandidates = @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
    )
    $edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($edge) {
        $browserProfile = Join-Path $base 'browser-profiles'
        New-Item -ItemType Directory -Path $browserProfile -Force | Out-Null
        $repoEngineering.browser = [ordered]@{
            edgeExecutablePath = $edge
            profileRoot = $browserProfile
        }
    }
    $gatewayConfig = [ordered]@{
        allowedRoots = @($AllowedRoot)
        devspace = [ordered]@{
            baseUrl = 'http://127.0.0.1:7677'
            resourceUrl = 'http://127.0.0.1:7677/mcp'
        }
        verifyProfiles = [ordered]@{}
        browserVerifyProfiles = @()
        repositoryEngineering = $repoEngineering
    }
    [IO.File]::WriteAllText(
        $privateConfig,
        ($gatewayConfig | ConvertTo-Json -Depth 12),
        [Text.UTF8Encoding]::new($false)
    )

    $sourceHead = ''
    try {
        $gitTop = (& git.exe -C $packageRoot rev-parse --show-toplevel 2>$null).Trim()
        $gitTopExit = $LASTEXITCODE
        if ($gitTopExit -eq 0 -and $gitTop) {
            $packageRootFull = [IO.Path]::GetFullPath($packageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
            $gitTopFull = [IO.Path]::GetFullPath($gitTop).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
            if ([string]::Equals($packageRootFull, $gitTopFull, [StringComparison]::OrdinalIgnoreCase)) {
                $sourceHead = (& git.exe -C $packageRoot rev-parse HEAD 2>$null).Trim()
                if ($LASTEXITCODE -ne 0 -or $sourceHead.Length -ne 40 -or $sourceHead -match '[^a-f0-9]') { $sourceHead = '' }
            }
        }
    } catch { $sourceHead = '' }
    $runtimeTag = if ($sourceHead) { $version + '-dev-' + $sourceHead.Substring(0,12) } else { $version }
    $runtimeRoot = Join-Path $runtimeBase $runtimeTag
    $runtimeCli = Join-Path $runtimeRoot 'dist\cli.js'

    if (-not (Test-Path -LiteralPath $runtimeCli -PathType Leaf)) {
        $staging = $runtimeRoot + '.staging-' + [Guid]::NewGuid().ToString('N')
        try {
            New-Item -ItemType Directory -Path $staging -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $packageRoot 'dist') -Destination (Join-Path $staging 'dist') -Recurse -Force
            Copy-Item -LiteralPath $packageJsonPath -Destination (Join-Path $staging 'package.json') -Force
            Copy-Item -LiteralPath $runtimeLockPath -Destination (Join-Path $staging 'package-lock.json') -Force
            foreach ($name in @(
                'install-wag-local-launchers.ps1',
                'wag-local-tunnel-launcher.ps1',
                'wag-local-start.ps1',
                'wag-local-supervisor.ps1',
                'wag-local-doctor.ps1',
                'wag-local-product-health.ps1',
                'wag-local-provision.ps1',
                'wag-local-setup.ps1'
            )) {
                $targetScripts = Join-Path $staging 'scripts'
                New-Item -ItemType Directory -Path $targetScripts -Force | Out-Null
                Copy-Item -LiteralPath (Join-Path $packageRoot ('scripts\' + $name)) -Destination (Join-Path $targetScripts $name) -Force
            }
            $targetPin = Join-Path $staging 'docs\benchmarks'
            New-Item -ItemType Directory -Path $targetPin -Force | Out-Null
            Copy-Item -LiteralPath $pinSource -Destination (Join-Path $targetPin 'devspace-pin.json') -Force
            foreach ($notice in @('LICENSE','THIRD_PARTY_NOTICES.md')) {
                $sourceNotice = Join-Path $packageRoot $notice
                if (Test-Path -LiteralPath $sourceNotice -PathType Leaf) {
                    Copy-Item -LiteralPath $sourceNotice -Destination (Join-Path $staging $notice) -Force
                }
            }

            & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix $staging
            if ($LASTEXITCODE -ne 0) { throw 'Runtime production dependency install failed' }

            $marker = [ordered]@{
                packageVersion = $version
                capability = 'autonomous-local-runtime-v1'
                installedAtUtc = [DateTime]::UtcNow.ToString('o')
            }
            if ($sourceHead) { $marker.sourceHead = $sourceHead }
            [IO.File]::WriteAllText(
                (Join-Path $staging 'RUNTIME.json'),
                ($marker | ConvertTo-Json -Depth 4),
                [Text.UTF8Encoding]::new($false)
            )
            if (Test-Path -LiteralPath $runtimeRoot) { Remove-Item -LiteralPath $runtimeRoot -Recurse -Force }
            Move-Item -LiteralPath $staging -Destination $runtimeRoot
        } finally {
            if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
        }
    }

    if ($clientReady) {
        $runtimeForward = $runtimeCli.Replace('\','/')
        $configForward = $privateConfig.Replace('\','/')
        $wrapper = [string]::Join([char]10, @(
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            '',
            'exec node.exe \',
            ('  "' + $runtimeForward + '" \'),
            '  serve-stdio \',
            ('  --config "' + $configForward + '"')
        )) + [char]10
        $wrapperB64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($wrapper))
        & wsl.exe -e sh -c 'mkdir -p "$(dirname "$2")"; printf "%s" "$1" | base64 -d > "$2"; chmod 700 "$2"' sh $wrapperB64 $wrapperPath
        if ($LASTEXITCODE -ne 0) { throw 'Failed to install the WAG stdio wrapper in WSL' }
    }

    $installer = Join-Path $runtimeRoot 'scripts\install-wag-local-launchers.ps1'
    $installOptions = @{}
    if ($NoAutostart -or -not $clientReady) { $installOptions.NoAutostart = $true }
    if ($NoStart -or -not $clientReady) { $installOptions.NoStart = $true }
    & $installer @installOptions
    if ($LASTEXITCODE -ne 0) { throw 'WAG Local launcher installation failed' }

    $doctor = 'NOT_RUN'
    $productStatus = if ($clientReady) { 'INSTALLED' } else { 'ACTION_REQUIRED' }
    if ($clientReady -and -not $NoStart) {
        $healthOutput = Join-Path $receipts 'wag-local-product-health.json'
        & node.exe (Join-Path $runtimeRoot 'dist\product-health.js') --output $healthOutput | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $health = Get-Content -LiteralPath $healthOutput -Raw | ConvertFrom-Json
            $productStatus = [string]$health.status
            $doctor = if ($productStatus -eq 'READY') { 'PASS' } else { 'FAIL' }
        } else {
            $doctor = 'FAIL'
            $productStatus = 'DEGRADED'
        }
    } elseif ($clientReady) {
        $doctor = 'DEFERRED'
    }

    $finalActions = @()
    if (-not $clientReady) {
        $finalActions = $actions
    }
    $setupReceipt = [ordered]@{
        schema = 'WAG_LOCAL_SETUP_V1'
        mode = 'INSTALL'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        version = $version
        device = $deviceName
        status = $productStatus
        client = if ($clientReady) { 'connected' } else { 'action_required' }
        doctor = $doctor
        allowedRoot = $AllowedRoot
        runtimeTag = $runtimeTag
        autostart = -not ($NoAutostart -or -not $clientReady)
        actions = $finalActions
    }
    if (-not $Output) { $Output = Join-Path $receipts 'wag-local-setup.json' }
    $Output = [IO.Path]::GetFullPath($Output)
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Output)) -Force | Out-Null
    [IO.File]::WriteAllText($Output, ($setupReceipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))

    Write-Output 'WAG Local'
    Write-Output "Version: $version"
    Write-Output "Device: $deviceName"
    Write-Output "Status: $productStatus"
    Write-Output "Client: $($setupReceipt.client)"
    Write-Output "Doctor: $doctor"
    Write-Output "Receipt: $Output"

    if ($productStatus -eq 'ACTION_REQUIRED' -or $productStatus -eq 'DEGRADED') { exit 2 }
    exit 0
}
