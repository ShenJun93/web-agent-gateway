param()

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        & $pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
        exit $LASTEXITCODE
    }

    $repo = Resolve-Path (Join-Path $PSScriptRoot '..')
    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    New-Item -ItemType Directory -Path $base -Force | Out-Null

    $files = @(
        @{ Source = Join-Path $repo 'scripts\wag-local-tunnel-launcher.ps1'; Target = Join-Path $base 'Start-WagLocalTunnel.ps1' },
        @{ Source = Join-Path $repo 'scripts\wag-local-start.ps1'; Target = Join-Path $base 'Start-WagLocal.ps1' }
    )

    foreach ($file in $files) {
        if (-not (Test-Path -LiteralPath $file.Source -PathType Leaf)) { throw "STOP: missing canonical launcher: $($file.Source)" }
        Copy-Item -LiteralPath $file.Source -Destination $file.Target -Force
        Write-Output "WAG_LOCAL_LAUNCHER_INSTALLED=$($file.Target)"
    }
}
