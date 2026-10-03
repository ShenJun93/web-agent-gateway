param(
    [ValidateSet('Baseline','Install','ConnectorProof','PostReboot','PostRebootProof')]
    [string]$Stage = 'Baseline',
    [string]$AllowedRoot = '',
    [string]$TunnelClientPath = '',
    [string]$TunnelId = '',
    [string]$RuntimeKeyRef = '',
    [string]$Output = ''
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $forward = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Stage',$Stage)
        if ($AllowedRoot) { $forward += @('-AllowedRoot',$AllowedRoot) }
        if ($TunnelClientPath) { $forward += @('-TunnelClientPath',$TunnelClientPath) }
        if ($TunnelId) { $forward += @('-TunnelId',$TunnelId) }
        if ($RuntimeKeyRef) { $forward += @('-RuntimeKeyRef',$RuntimeKeyRef) }
        if ($Output) { $forward += @('-Output',$Output) }
        & $pwsh @forward
        exit $LASTEXITCODE
    }

    if (-not $IsWindows) { throw 'WAG clean-install acceptance currently supports Windows only' }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required' }

    $packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $provisionScript = Join-Path $PSScriptRoot 'wag-local-provision.ps1'
    $healthScript = Join-Path $PSScriptRoot 'wag-local-product-health.ps1'
    if (-not (Test-Path -LiteralPath $provisionScript -PathType Leaf)) { throw 'Packaged WAG provision script is missing' }
    if (-not (Test-Path -LiteralPath $healthScript -PathType Leaf)) { throw 'Packaged WAG product-health script is missing' }

    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $acceptanceRoot = Join-Path $env:LOCALAPPDATA 'WAG-Acceptance'
    $stateFile = Join-Path $acceptanceRoot 'clean-install-v1.json'
    $fixtureMode = ([string]$env:WAG_CLEAN_ACCEPTANCE_FIXTURE).Trim() -eq '1'

    if (-not $AllowedRoot) {
        $documents = [Environment]::GetFolderPath('MyDocuments')
        if (-not $documents) { $documents = $env:USERPROFILE }
        $AllowedRoot = Join-Path $documents 'WAG-Workspace'
    }
    $AllowedRoot = [IO.Path]::GetFullPath($AllowedRoot)
    if (-not [IO.Path]::IsPathRooted($AllowedRoot)) { throw 'Allowed root must be absolute' }

    if (-not $Output) {
        $Output = Join-Path $acceptanceRoot ('clean-install-' + $Stage.ToLowerInvariant() + '.json')
    }
    $Output = [IO.Path]::GetFullPath($Output)

    function Get-Sha256Text([string]$Value) {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
        $hash = [Security.Cryptography.SHA256]::HashData($bytes)
        return [Convert]::ToHexString($hash).ToLowerInvariant()
    }

    function Get-BootId {
        try {
            $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
            return $boot.ToUniversalTime().ToString('o')
        } catch {
            throw 'Unable to read Windows boot identity'
        }
    }

    function Get-Identity {
        $machine = [Environment]::MachineName.ToLowerInvariant()
        $profile = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\\').ToLowerInvariant()
        return [ordered]@{
            machineHash = Get-Sha256Text $machine
            userProfileHash = Get-Sha256Text $profile
        }
    }

    function Resolve-WslProfilePath {
        $override = ([string]$env:WAG_SETUP_PROFILE_FILE).Trim()
        if ($override) {
            $segments = @($override -split '/')
            if (-not $override.StartsWith('/') -or $segments -contains '..' -or $override.Contains([char]13) -or $override.Contains([char]10)) {
                throw 'WAG_SETUP_PROFILE_FILE must be an absolute WSL path without traversal'
            }
            return $override
        }
        $value = & wsl.exe -e sh -lc 'printf "%s" "$HOME/.config/tunnel-client/web-agent-gateway.yaml"' 2>$null
        if ($LASTEXITCODE -ne 0) { return '' }
        return (($value | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
    }

    function Test-WslFile([string]$Path) {
        if (-not $Path) { return $false }
        & wsl.exe -e test -f $Path 2>$null
        return $LASTEXITCODE -eq 0
    }

    function Test-HttpOk([string]$Url) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        } catch { return $false }
    }

    function Read-State {
        if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
            throw 'Clean-install acceptance state is missing; run Baseline first'
        }
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json -AsHashtable
        if ([string]$state.schema -ne 'WAG_CLEAN_INSTALL_ACCEPTANCE_V1') {
            throw 'Clean-install acceptance state schema is invalid'
        }
        $identity = Get-Identity
        if ([string]$state.identity.machineHash -ne [string]$identity.machineHash -or
            [string]$state.identity.userProfileHash -ne [string]$identity.userProfileHash) {
            throw 'Clean-install acceptance state belongs to another machine or user profile'
        }
        return $state
    }

    function Write-State([System.Collections.IDictionary]$State) {
        New-Item -ItemType Directory -Path $acceptanceRoot -Force | Out-Null
        $State.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
        $tmp = $stateFile + '.tmp'
        [IO.File]::WriteAllText($tmp, ($State | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tmp -Destination $stateFile -Force
    }

    function Write-Receipt([System.Collections.IDictionary]$Receipt) {
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Output)) -Force | Out-Null
        [IO.File]::WriteAllText($Output, ($Receipt | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        Write-Output ('WAG_CLEAN_ACCEPTANCE_JSON=' + ($Receipt | ConvertTo-Json -Depth 12 -Compress))
        Write-Output "Receipt: $Output"
    }

    function New-Challenge([System.Collections.IDictionary]$State, [string]$Kind) {
        $challengeDir = Join-Path $AllowedRoot '.wag-acceptance'
        New-Item -ItemType Directory -Path $challengeDir -Force | Out-Null
        $nonceBytes = New-Object byte[] 24
        [Security.Cryptography.RandomNumberGenerator]::Fill($nonceBytes)
        $nonce = [Convert]::ToHexString($nonceBytes).ToLowerInvariant()
        $challengeText = 'WAG_ACCEPTANCE_CHALLENGE_V1:' + $nonce
        $challengePath = Join-Path $challengeDir ($Kind + '-challenge.txt')
        $responsePath = Join-Path $challengeDir ($Kind + '-response.txt')
        if (Test-Path -LiteralPath $responsePath) { Remove-Item -LiteralPath $responsePath -Force }
        [IO.File]::WriteAllText($challengePath, $challengeText + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        $State.challenges[$Kind] = [ordered]@{
            challengeRelativePath = '.wag-acceptance/' + $Kind + '-challenge.txt'
            responseRelativePath = '.wag-acceptance/' + $Kind + '-response.txt'
            expectedResponseSha256 = Get-Sha256Text ('WAG_ACCEPTANCE_RESPONSE_V1:' + $nonce)
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            verifiedAtUtc = $null
        }
        Write-State $State
        return $State.challenges[$Kind]
    }

    function Verify-Challenge([System.Collections.IDictionary]$State, [string]$Kind) {
        if (-not $State.challenges.ContainsKey($Kind)) { throw "Missing $Kind connector challenge" }
        $challenge = $State.challenges[$Kind]
        $responsePath = Join-Path $AllowedRoot ([string]$challenge.responseRelativePath)
        if (-not (Test-Path -LiteralPath $responsePath -PathType Leaf)) {
            return $false
        }
        $response = (Get-Content -LiteralPath $responsePath -Raw).Trim()
        if ((Get-Sha256Text $response) -ne [string]$challenge.expectedResponseSha256) {
            return $false
        }
        $challenge.verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
        Write-State $State
        return $true
    }

    function Connector-Prompt([System.Collections.IDictionary]$Challenge) {
        return ('Using WAG only, read "' + [string]$Challenge.challengeRelativePath +
            '" inside the configured WAG workspace. Create "' + [string]$Challenge.responseRelativePath +
            '" containing exactly WAG_ACCEPTANCE_RESPONSE_V1:<nonce>, where <nonce> is the value after the colon in the challenge file. Do not use shell or another connector.')
    }

    if ($Stage -eq 'Baseline') {
        if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
            throw 'Clean-install acceptance state already exists; preserve the existing run or remove it explicitly before starting over'
        }
        $profilePath = Resolve-WslProfilePath
        $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'WAG Local.lnk'
        $checks = [ordered]@{
            wagLocalAbsent = -not (Test-Path -LiteralPath $base)
            startupAbsent = if ($fixtureMode) { $true } else { -not (Test-Path -LiteralPath $startup) }
            tunnelProfileAbsent = -not (Test-WslFile $profilePath)
            devspacePortUnused = if ($fixtureMode) { $true } else { -not (Test-HttpOk 'http://127.0.0.1:7677/.well-known/oauth-authorization-server') }
            tunnelPortUnused = if ($fixtureMode) { $true } else { -not (Test-HttpOk 'http://127.0.0.1:8080/readyz') }
        }
        $failed = @($checks.GetEnumerator() | Where-Object { -not [bool]$_.Value })
        $pass = $failed.Count -eq 0
        $state = [ordered]@{
            schema = 'WAG_CLEAN_INSTALL_ACCEPTANCE_V1'
            runId = 'clean_' + [Guid]::NewGuid().ToString()
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            updatedAtUtc = [DateTime]::UtcNow.ToString('o')
            identity = Get-Identity
            environment = if ($fixtureMode) { 'FIXTURE' } else { 'EXTERNAL_CLEAN_WINDOWS' }
            eligibleForExternalAcceptance = -not $fixtureMode
            allowedRoot = $AllowedRoot
            baselineBootId = Get-BootId
            installBootId = $null
            baseline = [ordered]@{ pass = $pass; checks = $checks }
            install = $null
            connectorProof = $null
            postReboot = $null
            postRebootProof = $null
            challenges = @{}
        }
        Write-State $state
        $receipt = [ordered]@{
            schema = 'WAG_CLEAN_INSTALL_ACCEPTANCE_RECEIPT_V1'
            stage = 'Baseline'
            runId = $state.runId
            status = if ($pass) { 'PASS' } else { 'FAIL_NOT_CLEAN' }
            eligibleForExternalAcceptance = $state.eligibleForExternalAcceptance
            checks = $checks
            failedChecks = @($failed | ForEach-Object { [string]$_.Key })
        }
        Write-Receipt $receipt
        if ($pass) { exit 0 } else { exit 2 }
    }

    $state = Read-State
    if ([string]$state.allowedRoot -ne $AllowedRoot) {
        throw 'Allowed root changed after baseline'
    }
    if (-not [bool]$state.baseline.pass) {
        throw 'Baseline was not clean; this run cannot claim fresh-install acceptance'
    }

    if ($Stage -eq 'Install') {
        if ($null -ne $state.install) { throw 'Install stage has already been recorded for this run' }
        if (Test-Path -LiteralPath $base) { throw 'WAG local state appeared after baseline; start a new clean-install run' }

        $args = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$provisionScript,'-AllowedRoot',$AllowedRoot)
        if ($TunnelClientPath) { $args += @('-TunnelClientPath',$TunnelClientPath) }
        if ($TunnelId) { $args += @('-TunnelId',$TunnelId) }
        if ($RuntimeKeyRef) { $args += @('-RuntimeKeyRef',$RuntimeKeyRef) }
        if ($fixtureMode) { $args += @('-NoStart','-NoAutostart') }

        $lines = @(& pwsh.exe @args 2>&1)
        $exitCode = $LASTEXITCODE
        $provisionReceipt = Join-Path $base 'receipts\wag-local-provision.json'
        $status = ''
        if (Test-Path -LiteralPath $provisionReceipt -PathType Leaf) {
            $provision = Get-Content -LiteralPath $provisionReceipt -Raw | ConvertFrom-Json
            $status = [string]$provision.status
        } else {
            foreach ($line in $lines) {
                $text = [string]$line
                if ($text.StartsWith('WAG_PROVISION_JSON=')) {
                    $provision = $text.Substring('WAG_PROVISION_JSON='.Length) | ConvertFrom-Json
                    $status = [string]$provision.status
                    break
                }
            }
        }

        $state.installBootId = Get-BootId
        $state.install = [ordered]@{
            recordedAtUtc = [DateTime]::UtcNow.ToString('o')
            exit = $exitCode
            status = $status
            tunnelIdProvided = [bool]$TunnelId
            runtimeKeyReferenceProvided = [bool]$RuntimeKeyRef
        }

        $challenge = $null
        if ($status -eq 'ACTION_REQUIRED_CHATGPT_CONNECTOR') {
            $challenge = New-Challenge $state 'initial'
        } else {
            Write-State $state
        }

        $receipt = [ordered]@{
            schema = 'WAG_CLEAN_INSTALL_ACCEPTANCE_RECEIPT_V1'
            stage = 'Install'
            runId = $state.runId
            status = $status
            provisionExit = $exitCode
            connectorChallenge = if ($null -eq $challenge) { $null } else { [ordered]@{
                challengePath = $challenge.challengeRelativePath
                responsePath = $challenge.responseRelativePath
                prompt = Connector-Prompt $challenge
            }}
        }
        Write-Receipt $receipt

        if ($status -eq 'ACTION_REQUIRED_CHATGPT_CONNECTOR') { exit 2 }
        if ($status -eq 'READY' -and $exitCode -eq 0) { exit 0 }
        exit $(if ($exitCode -eq 1) { 1 } else { 2 })
    }

    if ($Stage -eq 'ConnectorProof') {
        if ($null -eq $state.install -or [string]$state.install.status -ne 'ACTION_REQUIRED_CHATGPT_CONNECTOR') {
            throw 'ConnectorProof requires an Install stage at ACTION_REQUIRED_CHATGPT_CONNECTOR'
        }
        $proof = Verify-Challenge $state 'initial'
        if (-not $proof) {
            $receipt = [ordered]@{
                schema = 'WAG_CLEAN_INSTALL_ACCEPTANCE_RECEIPT_V1'
                stage = 'ConnectorProof'
                runId = $state.runId
                status = 'ACTION_REQUIRED_CONNECTOR_PROOF'
            }
            Write-Receipt $receipt
            exit 2
        }

        $args = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$provisionScript,'-ConnectorConfirmed','-AllowedRoot',$AllowedRoot)
        if ($TunnelClientPath) { $args += @('-TunnelClientPath',$TunnelClientPath) }
        if ($fixtureMode) { $args += @('-NoStart','-NoAutostart') }
        $lines = @(& pwsh.exe @args 2>&1)
        $exitCode = $LASTEXITCODE
        $provisionReceipt = Join-Path $base 'receipts\wag-local-provision.json'
        $status = if (Test-Path -LiteralPath $provisionReceipt -PathType Leaf) {
            [string](Get-Content -LiteralPath $provisionReceipt -Raw | ConvertFrom-Json).status
        } else { '' }

        $state.connectorProof = [ordered]@{
            recordedAtUtc = [DateTime]::UtcNow.ToString('o')
            responseVerified = $true
            provisionStatus = $status
            provisionExit = $exitCode
        }
        Write-State $state
        $receipt = [ordered]@{
            schema = 'WAG_CLEAN_INSTALL_ACCEPTANCE_RECEIPT_V1'
            stage = 'ConnectorProof'
            runId = $state.runId
            status = if ($status -eq 'READY' -and $exitCode -eq 0) { 'PASS' } else { 'FAIL' }
            responseVerified = $true
            provisioningStatus = $status
        }
        Write-Receipt $receipt
        if ($receipt.status -eq 'PASS') { exit 0 } else { exit 2 }
    }

    if ($Stage -eq 'PostReboot') {
        if ($null -eq $state.connectorProof -or -not [bool]$state.connectorProof.responseVerified) {
            throw 'PostReboot requires a successful ConnectorProof stage'
        }
        $bootId = Get-BootId
        $rebootObserved = [string]$bootId -ne [string]$state.installBootId
        $healthOutput = Join-Path $acceptanceRoot 'post-reboot-product-health.json'
        $healthLines = @(& pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $healthScript -Output $healthOutput 2>&1)
        $healthExit = $LASTEXITCODE
        $healthStatus = ''
        if (Test-Path -LiteralPath $healthOutput -PathType Leaf) {
            $health = Get-Content -LiteralPath $healthOutput -Raw | ConvertFrom-Json
            $healthStatus = [string]$health.status
        }
        $state.postReboot = [ordered]@{
            recordedAtUtc = [DateTime]::UtcNow.ToString('o')
            bootId = $bootId
            rebootObserved = $rebootObserved
            healthExit = $healthExit
            healthStatus = $healthStatus
        }
        $readyForProof = $rebootObserved -and $healthExit -eq 0 -and $healthStatus -eq 'READY'
        $challenge = if ($readyForProof) { New-Challenge $state 'post-reboot' } else { $null }
        if (-not $readyForProof) { Write-State $state }
        $receipt = [ordered]@{
            schema = 'WAG_CLEAN_INSTALL_ACCEPTANCE_RECEIPT_V1'
            stage = 'PostReboot'
            runId = $state.runId
            status = if ($readyForProof) { 'ACTION_REQUIRED_POST_REBOOT_CONNECTOR_PROOF' } else { 'FAIL' }
            rebootObserved = $rebootObserved
            health = $healthStatus
            connectorChallenge = if ($null -eq $challenge) { $null } else { [ordered]@{
                challengePath = $challenge.challengeRelativePath
                responsePath = $challenge.responseRelativePath
                prompt = Connector-Prompt $challenge
            }}
        }
        Write-Receipt $receipt
        exit 2
    }

    if ($Stage -eq 'PostRebootProof') {
        if ($null -eq $state.postReboot -or -not [bool]$state.postReboot.rebootObserved -or [string]$state.postReboot.healthStatus -ne 'READY') {
            throw 'PostRebootProof requires a healthy observed reboot'
        }
        $proof = Verify-Challenge $state 'post-reboot'
        $pass = $proof -and (-not $fixtureMode)
        $state.postRebootProof = [ordered]@{
            recordedAtUtc = [DateTime]::UtcNow.ToString('o')
            responseVerified = $proof
            eligibleForExternalAcceptance = -not $fixtureMode
            pass = $pass
        }
        Write-State $state
        $receipt = [ordered]@{
            schema = 'WAG_CLEAN_INSTALL_ACCEPTANCE_RECEIPT_V1'
            stage = 'PostRebootProof'
            runId = $state.runId
            status = if ($pass) { 'PASS' } elseif ($proof -and $fixtureMode) { 'FIXTURE_PASS_NOT_EXTERNAL_ACCEPTANCE' } else { 'ACTION_REQUIRED_POST_REBOOT_CONNECTOR_PROOF' }
            connectorRoundTripVerified = $proof
            rebootObserved = [bool]$state.postReboot.rebootObserved
            health = [string]$state.postReboot.healthStatus
            eligibleForExternalAcceptance = -not $fixtureMode
        }
        Write-Receipt $receipt
        if ($pass) { exit 0 }
        if ($proof -and $fixtureMode) { exit 0 }
        exit 2
    }

    throw 'Unsupported clean-install acceptance stage'
}
