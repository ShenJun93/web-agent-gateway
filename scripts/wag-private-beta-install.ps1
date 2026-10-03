param(
    [switch]$VerifyOnly,
    [string]$TunnelId = '',
    [string]$TunnelClientPath = '',
    [string]$AllowedRoot = ''
)

& {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        throw 'WAG private beta installer requires PowerShell 7 or newer'
    }
    if (-not $IsWindows) { throw 'WAG private beta currently supports Windows only' }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required' }

    function Get-ExtensionTreeSha256 {
        param(
            [string]$Root,
            [string[]]$RelativePaths
        )
        $sha = [Security.Cryptography.SHA256]::Create()
        $zero = [byte[]]@(0)
        try {
            $ordered = @($RelativePaths)
            [Array]::Sort($ordered, [StringComparer]::Ordinal)
            foreach ($relative in $ordered) {
                $pathBytes = [Text.Encoding]::UTF8.GetBytes($relative)
                if ($pathBytes.Length -gt 0) {
                    [void]$sha.TransformBlock($pathBytes, 0, $pathBytes.Length, $pathBytes, 0)
                }
                [void]$sha.TransformBlock($zero, 0, 1, $zero, 0)
                $absolute = Join-Path $Root ($relative.Replace('/','\'))
                $fileBytes = [IO.File]::ReadAllBytes($absolute)
                if ($fileBytes.Length -gt 0) {
                    [void]$sha.TransformBlock($fileBytes, 0, $fileBytes.Length, $fileBytes, 0)
                }
                [void]$sha.TransformBlock($zero, 0, 1, $zero, 0)
            }
            [void]$sha.TransformFinalBlock([byte[]]::new(0), 0, 0)
            return ([BitConverter]::ToString($sha.Hash).Replace('-', '').ToLowerInvariant())
        } finally {
            $sha.Dispose()
        }
    }

    $bundleRoot = $PSScriptRoot
    $manifestPath = Join-Path $bundleRoot 'PRIVATE_BETA_BUNDLE.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'PRIVATE_BETA_BUNDLE.json is missing'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if ([string]$manifest.schema -ne 'WAG_PRIVATE_BETA_BUNDLE_V1' -or
        [string]$manifest.channel -ne 'beta' -or
        [string]$manifest.signing.state -ne 'UNSIGNED_PRIVATE_BETA' -or
        [bool]$manifest.signing.authenticodeTrusted) {
        throw 'Private beta bundle manifest is invalid'
    }
    $sourceSha = [string]$manifest.sourceSha
    $releaseId = [string]$manifest.releaseId
    if ($sourceSha.Length -ne 40 -or $sourceSha -match '[^a-f0-9]' -or
        $releaseId.Length -lt 1 -or $releaseId.Length -gt 128 -or
        $releaseId -match '[^A-Za-z0-9._-]') {
        throw 'Private beta release identity is invalid'
    }

    $packageRelative = [string]$manifest.package.path
    $packageSegments = @($packageRelative -split '/')
    if ($packageSegments.Count -ne 2 -or
        $packageSegments[0] -ne 'package' -or
        -not $packageSegments[1].EndsWith('.tgz') -or
        $packageSegments[1] -match '[^A-Za-z0-9._-]') {
        throw 'Private beta package path is invalid'
    }
    $packagePath = Join-Path $bundleRoot ($packageRelative.Replace('/','\'))
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw 'Private beta package tarball is missing'
    }
    $packageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($packageHash -ne [string]$manifest.package.sha256) {
        throw 'Private beta package SHA-256 mismatch'
    }
    if ((Get-Item -LiteralPath $packagePath).Length -ne [Int64]$manifest.package.sizeBytes) {
        throw 'Private beta package size mismatch'
    }

    $extensionRoot = Join-Path $bundleRoot 'browser-extension'
    if (-not (Test-Path -LiteralPath $extensionRoot -PathType Container)) {
        throw 'Private beta browser extension is missing'
    }
    $expectedFiles = @($manifest.extension.files)
    if ($expectedFiles.Count -lt 1 -or $expectedFiles.Count -gt 128) {
        throw 'Private beta extension manifest is invalid'
    }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($entry in $expectedFiles) {
        $relative = [string]$entry.path
        if ([string]::IsNullOrWhiteSpace($relative) -or
            $relative.Length -gt 512 -or
            $relative -match '[^A-Za-z0-9._@+/-]' -or
            $relative.StartsWith('/') -or $relative.Contains('\') -or
            @($relative.Split('/')) -contains '..') {
            throw 'Private beta extension path is invalid'
        }
        if (-not $seen.Add($relative)) { throw 'Duplicate private beta extension path' }
        $path = Join-Path $extensionRoot ($relative.Replace('/','\'))
        $item = Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Private beta extension file is invalid'
        }
        if ($item.Length -ne [Int64]$entry.sizeBytes) { throw 'Private beta extension size mismatch' }
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne [string]$entry.sha256) { throw 'Private beta extension SHA-256 mismatch' }
    }
    $actualExtensionFiles = @(Get-ChildItem -LiteralPath $extensionRoot -Recurse -File -Force |
        ForEach-Object {
            $_.FullName.Substring($extensionRoot.Length).TrimStart('\').Replace('\','/')
        } |
        Sort-Object)
    if ($actualExtensionFiles.Count -ne $expectedFiles.Count) {
        throw 'Private beta extension contains unexpected files'
    }
    foreach ($relative in $actualExtensionFiles) {
        if (-not $seen.Contains($relative)) { throw 'Private beta extension contains unexpected files' }
    }
    $actualExtensionTreeSha256 = Get-ExtensionTreeSha256 $extensionRoot $actualExtensionFiles
    if ($actualExtensionTreeSha256 -ne [string]$manifest.extension.treeSha256) {
        throw 'Private beta extension tree SHA-256 mismatch'
    }

    if ($VerifyOnly) {
        Write-Output 'WAG_BETA_VERIFY=PASS'
        Write-Output ('WAG_BETA_RELEASE_ID=' + $releaseId)
        Write-Output ('WAG_BETA_SOURCE_SHA=' + $sourceSha)
        Write-Output ('WAG_BETA_PACKAGE_SHA256=' + $packageHash)
        Write-Output ('WAG_BETA_EXTENSION_SHA256=' + $actualExtensionTreeSha256)
        exit 0
    }

    if ($TunnelId.Length -ne 39 -or $TunnelId -notmatch '^tunnel_[a-z0-9]{32}') {
        throw 'TunnelId must match tunnel_<32 lowercase letters or digits>'
    }
    if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
        throw 'TunnelClientPath is required'
    }
    foreach ($command in @('node.exe','npm.cmd','wsl.exe')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Required command is missing: $command"
        }
    }

    & wsl.exe -e true 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'WSL is not ready' }

    $TunnelClientPath = $TunnelClientPath.Trim()
    $segments = @($TunnelClientPath -split '/')
    if (-not $TunnelClientPath.StartsWith('/') -or
        $segments -contains '..' -or
        $TunnelClientPath.Contains([char]13) -or
        $TunnelClientPath.Contains([char]10)) {
        throw 'TunnelClientPath must be an absolute WSL path without traversal'
    }
    & wsl.exe -e test -x $TunnelClientPath
    if ($LASTEXITCODE -ne 0) { throw 'The supplied tunnel-client path is not executable in WSL' }

    if (-not $AllowedRoot) {
        $documents = [Environment]::GetFolderPath('MyDocuments')
        if (-not $documents) { $documents = $env:USERPROFILE }
        $AllowedRoot = Join-Path $documents 'WAG-Workspace'
    }
    $AllowedRoot = [IO.Path]::GetFullPath($AllowedRoot)

    $betaRoot = Join-Path $env:LOCALAPPDATA ('WAG-Private-Beta\' + $releaseId)
    $appRoot = Join-Path $betaRoot 'app'
    $markerPath = Join-Path $betaRoot 'bundle-install.json'
    New-Item -ItemType Directory -Path $betaRoot -Force | Out-Null

    $reuse = $false
    if (Test-Path -LiteralPath $appRoot -PathType Container) {
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
            throw 'Existing private beta bootstrap has no integrity marker'
        }
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        if ([string]$marker.releaseId -ne $releaseId -or
            [string]$marker.packageSha256 -ne $packageHash -or
            [string]$marker.sourceSha -ne $sourceSha) {
            throw 'Existing private beta bootstrap does not match this bundle'
        }
        $cliPath = Join-Path $appRoot 'node_modules\web-agent-gateway\dist\cli.js'
        if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
            throw 'Existing private beta bootstrap is incomplete'
        }
        $reuse = $true
    } else {
        $staging = $appRoot + '.staging-' + [Guid]::NewGuid().ToString('N')
        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        try {
            Push-Location $staging
            try {
                & npm.cmd init -y | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'npm init failed' }
                & npm.cmd install --ignore-scripts --no-audit --no-fund --no-save $packagePath | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Private beta package install failed' }
            } finally {
                Pop-Location
            }
            $cliPath = Join-Path $staging 'node_modules\web-agent-gateway\dist\cli.js'
            if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
                throw 'Installed private beta CLI is missing'
            }
            Move-Item -LiteralPath $staging -Destination $appRoot
        } finally {
            if (Test-Path -LiteralPath $staging) {
                Remove-Item -LiteralPath $staging -Recurse -Force
            }
        }
        [IO.File]::WriteAllText(
            $markerPath,
            (([ordered]@{
                schema = 'WAG_PRIVATE_BETA_BOOTSTRAP_V1'
                releaseId = $releaseId
                sourceSha = $sourceSha
                packageSha256 = $packageHash
            } | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
    }

    $cliPath = Join-Path $appRoot 'node_modules\web-agent-gateway\dist\cli.js'

    & node.exe $cliPath clean-install-acceptance --stage baseline --allowed-root $AllowedRoot
    if ($LASTEXITCODE -ne 0) {
        throw 'Clean-install baseline did not pass. Use a clean Windows user/install state for this beta run.'
    }

    $installArgs = @(
        $cliPath,
        'clean-install-acceptance',
        '--stage','install',
        '--allowed-root',$AllowedRoot,
        '--tunnel-client-path',$TunnelClientPath,
        '--tunnel-id',$TunnelId,
        '--runtime-key-ref','env:CONTROL_PLANE_API_KEY'
    )
    & node.exe @installArgs
    $installExit = $LASTEXITCODE

    $wagBase = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    if (-not (Test-Path -LiteralPath $wagBase -PathType Container)) {
        throw 'WAG Local state was not created by the install stage'
    }

    $installedExtension = Join-Path $wagBase 'browser-extension-v2'
    if (Test-Path -LiteralPath $installedExtension) {
        throw 'Browser extension destination already exists after a clean-install baseline'
    }
    Copy-Item -LiteralPath $extensionRoot -Destination $installedExtension -Recurse

    $runtimeRoot = Join-Path $wagBase ('runtime\' + $releaseId)
    $runtimeMarkerPath = Join-Path $runtimeRoot 'RUNTIME.json'
    if (-not (Test-Path -LiteralPath $runtimeMarkerPath -PathType Leaf)) {
        throw 'Installed WAG runtime marker is missing'
    }
    $runtimeMarker = Get-Content -LiteralPath $runtimeMarkerPath -Raw | ConvertFrom-Json
    if ([string]$runtimeMarker.sourceHead -ne $sourceSha -or
        [string]$runtimeMarker.releaseId -ne $releaseId) {
        throw 'Installed WAG runtime identity does not match the beta bundle'
    }
    $runtimeMarker | Add-Member -NotePropertyName extensionSourceHead -NotePropertyValue $sourceSha -Force
    $runtimeMarker | Add-Member -NotePropertyName extensionSha256 -NotePropertyValue $actualExtensionTreeSha256 -Force
    [IO.File]::WriteAllText(
        $runtimeMarkerPath,
        ($runtimeMarker | ConvertTo-Json -Depth 8),
        [Text.UTF8Encoding]::new($false)
    )

    $receiptPath = Join-Path $env:LOCALAPPDATA 'WAG-Acceptance\clean-install-install.json'
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        throw 'Clean-install install receipt is missing'
    }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json

    Write-Output ('WAG_BETA_RELEASE_ID=' + $releaseId)
    Write-Output ('WAG_BETA_SOURCE_SHA=' + $sourceSha)
    Write-Output ('WAG_BETA_EXTENSION_PATH=' + $installedExtension)
    Write-Output ('WAG_BETA_BOOTSTRAP_REUSED=' + $reuse)
    Write-Output ('WAG_BETA_INSTALL_STATUS=' + [string]$receipt.status)

    if ([string]$receipt.status -eq 'ACTION_REQUIRED_CHATGPT_CONNECTOR') {
        Write-Output 'WAG_BETA_NEXT=Load the unpacked Edge extension, then complete the connector challenge shown in the clean-install install receipt.'
        exit 0
    }
    if ($installExit -eq 0 -and [string]$receipt.status -eq 'READY') {
        Write-Output 'WAG_BETA_NEXT=Run post-reboot acceptance after one Windows reboot.'
        exit 0
    }
    throw ('Unexpected WAG private beta install status: ' + [string]$receipt.status)
}
