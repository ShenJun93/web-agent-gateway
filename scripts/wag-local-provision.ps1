param(
    [switch]$CheckOnly,
    [switch]$NoStart,
    [switch]$NoAutostart,
    [string]$AllowedRoot = '',
    [string]$Output = '',
    [string]$TunnelClientPath = '',
    [string]$TunnelId = '',
    [string]$RuntimeKeyRef = '',
    [switch]$ConnectorConfirmed
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
        if ($TunnelId) { $forward += @('-TunnelId',$TunnelId) }
        if ($RuntimeKeyRef) { $forward += @('-RuntimeKeyRef',$RuntimeKeyRef) }
        if ($ConnectorConfirmed) { $forward += '-ConnectorConfirmed' }
        & $pwsh @forward
        exit $LASTEXITCODE
    }

    if (-not $IsWindows) { throw 'WAG provisioning currently supports Windows only' }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required' }

    Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

    $setupScript = Join-Path $PSScriptRoot 'wag-local-setup.ps1'
    if (-not (Test-Path -LiteralPath $setupScript -PathType Leaf)) {
        throw 'Packaged WAG setup script is missing'
    }

    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $secrets = Join-Path $base 'secrets'
    $state = Join-Path $base 'state'
    $receipts = Join-Path $base 'receipts'
    $controlFile = Join-Path $secrets 'control-plane.dpapi'
    $tunnelClientPinFile = Join-Path $base 'tunnel-client-path.txt'
    $connectorMarker = Join-Path $state 'chatgpt-connector.confirmed'
    $provisionReceipt = Join-Path $receipts 'wag-local-provision.json'

    $TunnelId = $TunnelId.Trim()
    $RuntimeKeyRef = $RuntimeKeyRef.Trim()
    if ($TunnelId -and ($TunnelId.Length -ne 39 -or $TunnelId -notmatch '^tunnel_[a-z0-9]{32}')) {
        throw 'Tunnel id must match tunnel_<32 lowercase letters or digits>'
    }
    if ($RuntimeKeyRef -and $RuntimeKeyRef -ne 'env:CONTROL_PLANE_API_KEY') {
        throw 'Runtime key reference must be env:CONTROL_PLANE_API_KEY'
    }

    function Invoke-Wsl([string[]]$Arguments) {
        $value = & wsl.exe @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) { return '' }
        return (($value | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
    }

    function Test-WslFile([string]$Path) {
        if (-not $Path) { return $false }
        & wsl.exe -e test -f $Path 2>$null
        return $LASTEXITCODE -eq 0
    }

    function Test-WslExecutable([string]$Path) {
        if (-not $Path) { return $false }
        & wsl.exe -e test -x $Path 2>$null
        return $LASTEXITCODE -eq 0
    }

    function Write-ProtectedSecureString([Security.SecureString]$Value, [string]$Path) {
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Path)) -Force | Out-Null
        $protected = ConvertFrom-SecureString -SecureString $Value
        [IO.File]::WriteAllText($Path, $protected, [Text.UTF8Encoding]::new($false))
    }

    function Write-ProtectedPlainText([string]$Value, [string]$Path) {
        $secure = ConvertTo-SecureString -String $Value -AsPlainText -Force
        Write-ProtectedSecureString $secure $Path
    }

    $wslReady = $false
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        & wsl.exe -e true 2>$null
        $wslReady = $LASTEXITCODE -eq 0
    }

    $profileOverride = ([string]$env:WAG_SETUP_PROFILE_FILE).Trim()
    if ($profileOverride) {
        $segments = @($profileOverride -split '/')
        if (-not $profileOverride.StartsWith('/') -or
            $segments -contains '..' -or
            $profileOverride.Contains([char]13) -or
            $profileOverride.Contains([char]10)) {
            throw 'WAG_SETUP_PROFILE_FILE must be an absolute WSL path without traversal'
        }
        $profilePath = $profileOverride
    }
    elseif ($wslReady) {
        $profilePath = Invoke-Wsl @('-e','sh','-lc','printf "%s" "$HOME/.config/tunnel-client/web-agent-gateway.yaml"')
    }
    else {
        $profilePath = ''
    }

    $profilePresent = $wslReady -and (Test-WslFile $profilePath)
    $profileWasPresent = $profilePresent

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
    if (-not $resolvedTunnelClient -and $wslReady) {
        $resolvedTunnelClient = Invoke-Wsl @(
            '-e','sh','-lc',
            'p="$HOME/tools/openai-tunnel-client/v0.0.14/tunnel-client"; if [ -x "$p" ]; then printf "%s" "$p"; fi'
        )
    }
    $tunnelClientReady = $wslReady -and (Test-WslExecutable $resolvedTunnelClient)

    $runtimeSecretFromEnv = ([string]$env:WAG_SETUP_RUNTIME_API_KEY)
    $runtimeSecretConfigured = (Test-Path -LiteralPath $controlFile -PathType Leaf) -or
        -not [string]::IsNullOrWhiteSpace($runtimeSecretFromEnv)

    if (-not $profilePresent -and $TunnelId -and -not $RuntimeKeyRef -and $runtimeSecretConfigured) {
        $RuntimeKeyRef = 'env:CONTROL_PLANE_API_KEY'
    }

    $provisioningStatus = 'ACTION_REQUIRED_PREREQUISITES'
    if (-not $profilePresent) {
        if (-not $TunnelId) {
            $provisioningStatus = 'ACTION_REQUIRED_TUNNEL'
        }
        elseif (-not $runtimeSecretConfigured) {
            $provisioningStatus = 'ACTION_REQUIRED_RUNTIME_KEY'
        }
        elseif (-not $RuntimeKeyRef) {
            $provisioningStatus = 'ACTION_REQUIRED_RUNTIME_KEY'
        }
        elseif ($tunnelClientReady) {
            $provisioningStatus = 'ACTION_REQUIRED_CHATGPT_CONNECTOR'
        }
    }
    elseif ($profileWasPresent) {
        $provisioningStatus = 'READY'
    }

    if (-not $CheckOnly -and -not $profilePresent -and $TunnelId -and $tunnelClientReady) {
        if (-not $runtimeSecretConfigured -and -not [Console]::IsInputRedirected) {
            $secureRuntimeKey = Read-Host -Prompt 'Runtime API key (stored locally with Windows DPAPI)' -AsSecureString
            if ($secureRuntimeKey.Length -gt 0) {
                Write-ProtectedSecureString $secureRuntimeKey $controlFile
                $runtimeSecretConfigured = $true
                $RuntimeKeyRef = 'env:CONTROL_PLANE_API_KEY'
            }
        }

        if (-not [string]::IsNullOrWhiteSpace($runtimeSecretFromEnv)) {
            Write-ProtectedPlainText $runtimeSecretFromEnv $controlFile
            Remove-Item Env:WAG_SETUP_RUNTIME_API_KEY -ErrorAction SilentlyContinue
            $runtimeSecretConfigured = $true
            if (-not $RuntimeKeyRef) { $RuntimeKeyRef = 'env:CONTROL_PLANE_API_KEY' }
        }

        if ($runtimeSecretConfigured -and $RuntimeKeyRef -eq 'env:CONTROL_PLANE_API_KEY') {
            if (-not $profilePath) { throw 'Unable to resolve the WSL tunnel profile path' }
            $lastSlash = $profilePath.LastIndexOf('/')
            if ($lastSlash -lt 1 -or $lastSlash -ge ($profilePath.Length - 1)) {
                throw 'Resolved WSL tunnel profile path is invalid'
            }
            $profileDir = $profilePath.Substring(0,$lastSlash)
            $profileFile = $profilePath.Substring($lastSlash + 1)
            $profileName = if ($profileFile.EndsWith('.yaml')) {
                $profileFile.Substring(0,$profileFile.Length - 5)
            } else {
                $profileFile
            }
            if (-not $profileName -or $profileName -match '[^A-Za-z0-9._-]') {
                throw 'Resolved WSL tunnel profile name is invalid'
            }

            $wrapperPath = Invoke-Wsl @('-e','sh','-lc','printf "%s" "$HOME/.local/share/wag/wag-mcp-stdio.sh"')
            if (-not $wrapperPath.StartsWith('/')) { throw 'Unable to resolve the WAG WSL wrapper path' }

            # tunnel-client validates that the stdio executable exists before writing the profile.
            # Materialize a fail-closed placeholder; wag-local-setup replaces it with the real wrapper
            # before the daemon is ever allowed to start.
            $placeholder = [string]::Join([char]10, @(
                '#!/usr/bin/env bash',
                'echo "WAG Local setup is not complete" >&2',
                'exit 70'
            )) + [char]10
            $placeholderB64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($placeholder))
            & wsl.exe -e sh -c 'mkdir -p "$(dirname "$2")"; printf "%s" "$1" | base64 -d > "$2"; chmod 700 "$2"' sh $placeholderB64 $wrapperPath
            if ($LASTEXITCODE -ne 0) { throw 'Failed to materialize the WAG provisioning wrapper placeholder' }

            & wsl.exe -e $resolvedTunnelClient init --sample sample_mcp_stdio_local --profile $profileName --profile-dir $profileDir --tunnel-id $TunnelId --mcp-command $wrapperPath --control-plane-api-key-ref $RuntimeKeyRef --health-listen-addr 127.0.0.1:8080 --force
            if ($LASTEXITCODE -ne 0) {
                & wsl.exe -e rm -f $wrapperPath 2>$null
                throw 'tunnel-client profile provisioning failed'
            }
            $profilePresent = Test-WslFile $profilePath
            if (-not $profilePresent) { throw 'tunnel-client did not materialize the expected profile' }
        }
    }

    $setupOptions = @{}
    if ($CheckOnly) { $setupOptions.CheckOnly = $true }
    if ($NoStart) { $setupOptions.NoStart = $true }
    if ($NoAutostart) { $setupOptions.NoAutostart = $true }
    if ($AllowedRoot) { $setupOptions.AllowedRoot = $AllowedRoot }
    if ($Output) { $setupOptions.Output = $Output }
    if ($TunnelClientPath) { $setupOptions.TunnelClientPath = $TunnelClientPath }

    & $setupScript @setupOptions
    $setupExit = $LASTEXITCODE

    $profileCreated = (-not $profileWasPresent) -and $profilePresent
    if (-not $CheckOnly -and $ConnectorConfirmed -and $profilePresent -and $setupExit -eq 0) {
        New-Item -ItemType Directory -Path $state -Force | Out-Null
        $marker = [ordered]@{
            schema = 'WAG_LOCAL_CONNECTOR_CONFIRMATION_V1'
            confirmedAtUtc = [DateTime]::UtcNow.ToString('o')
            source = 'user_confirmation'
        }
        [IO.File]::WriteAllText(
            $connectorMarker,
            ($marker | ConvertTo-Json -Depth 4),
            [Text.UTF8Encoding]::new($false)
        )
    }

    $connectorConfirmedNow = Test-Path -LiteralPath $connectorMarker -PathType Leaf

    if ($profileWasPresent -and $setupExit -eq 0) {
        $provisioningStatus = 'READY'
    }
    elseif (-not $profilePresent) {
        if (-not $TunnelId) {
            $provisioningStatus = 'ACTION_REQUIRED_TUNNEL'
        }
        elseif (-not $runtimeSecretConfigured -or -not $RuntimeKeyRef) {
            $provisioningStatus = 'ACTION_REQUIRED_RUNTIME_KEY'
        }
        else {
            $provisioningStatus = 'ACTION_REQUIRED_PREREQUISITES'
        }
    }
    elseif ($setupExit -ne 0) {
        $provisioningStatus = 'ACTION_REQUIRED_PREREQUISITES'
    }
    elseif ($profileCreated -and -not $connectorConfirmedNow) {
        $provisioningStatus = 'ACTION_REQUIRED_CHATGPT_CONNECTOR'
    }
    elseif ($connectorConfirmedNow) {
        $provisioningStatus = 'READY'
    }

    $actions = @()
    if ($provisioningStatus -ne 'READY') { $actions += $provisioningStatus }

    $receipt = [ordered]@{
        schema = 'WAG_LOCAL_PROVISION_V1'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        mode = if ($CheckOnly) { 'CHECK_ONLY' } else { 'INSTALL' }
        status = $provisioningStatus
        setupExit = $setupExit
        profile = [ordered]@{
            present = $profilePresent
            existedBefore = $profileWasPresent
            created = $profileCreated
        }
        tunnel = [ordered]@{
            idProvided = [bool]$TunnelId
            clientResolved = [bool]$resolvedTunnelClient
            clientExecutable = $tunnelClientReady
        }
        runtimeKey = [ordered]@{
            configured = $runtimeSecretConfigured
            reference = if ($RuntimeKeyRef) { $RuntimeKeyRef } else { $null }
        }
        connector = [ordered]@{
            confirmed = $connectorConfirmedNow
            confirmationRequested = [bool]$ConnectorConfirmed
        }
        actions = $actions
    }

    if (-not $CheckOnly) {
        New-Item -ItemType Directory -Path $receipts -Force | Out-Null
        [IO.File]::WriteAllText(
            $provisionReceipt,
            ($receipt | ConvertTo-Json -Depth 8),
            [Text.UTF8Encoding]::new($false)
        )
    }

    Write-Output "Provisioning: $provisioningStatus"
    if ($provisioningStatus -eq 'ACTION_REQUIRED_TUNNEL') {
        Write-Output 'Next: create or select a tunnel, then rerun setup with --tunnel-id tunnel_...'
        Write-Output 'Tunnel management: https://platform.openai.com/settings/organization/tunnels'
    }
    elseif ($provisioningStatus -eq 'ACTION_REQUIRED_RUNTIME_KEY') {
        Write-Output 'Next: provide a runtime API key securely; WAG stores it with Windows DPAPI and does not accept it as a CLI argument.'
        Write-Output 'Runtime API keys: https://platform.openai.com/settings/organization/api-keys'
    }
    elseif ($provisioningStatus -eq 'ACTION_REQUIRED_CHATGPT_CONNECTOR') {
        Write-Output 'Next: create or verify the ChatGPT connector while WAG Local is running, then rerun setup with --connector-confirmed.'
        Write-Output 'ChatGPT connectors: https://chatgpt.com/#settings/Connectors'
    }
    if (-not $CheckOnly) {
        Write-Output "Provision receipt: $provisionReceipt"
    }
    Write-Output ('WAG_PROVISION_JSON=' + ($receipt | ConvertTo-Json -Depth 8 -Compress))

    if ($provisioningStatus -eq 'READY' -and $setupExit -eq 0) { exit 0 }
    if ($setupExit -eq 1) { exit 1 }
    exit 2
}
