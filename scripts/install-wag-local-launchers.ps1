param(
    [switch]$NoAutostart,
    [switch]$NoStart
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $forward = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
        if ($NoAutostart) { $forward += '-NoAutostart' }
        if ($NoStart) { $forward += '-NoStart' }
        & $pwsh @forward
        exit $LASTEXITCODE
    }

    $repo = Resolve-Path (Join-Path $PSScriptRoot '..')
    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    New-Item -ItemType Directory -Path $base -Force | Out-Null

    $files = @(
        @{ Source = Join-Path $repo 'scripts\wag-local-tunnel-launcher.ps1'; Target = Join-Path $base 'Start-WagLocalTunnel.ps1' },
        @{ Source = Join-Path $repo 'scripts\wag-local-start.ps1'; Target = Join-Path $base 'Start-WagLocal.ps1' },
        @{ Source = Join-Path $repo 'scripts\wag-local-supervisor.ps1'; Target = Join-Path $base 'Start-WagLocalSupervisor.ps1' }
    )

    foreach ($file in $files) {
        if (-not (Test-Path -LiteralPath $file.Source -PathType Leaf)) {
            throw "STOP: missing canonical launcher: $($file.Source)"
        }
        Copy-Item -LiteralPath $file.Source -Destination $file.Target -Force
        Write-Output "WAG_LOCAL_LAUNCHER_INSTALLED=$($file.Target)"
    }

    $supervisor = Join-Path $base 'Start-WagLocalSupervisor.ps1'

    if (-not $NoAutostart) {
        $startup = [Environment]::GetFolderPath('Startup')
        if (-not $startup) { throw 'STOP: Windows Startup folder is unavailable' }

        $shortcutPath = Join-Path $startup 'WAG Local.lnk'
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source

        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $pwsh
        $shortcut.Arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $supervisor + '"'
        $shortcut.WorkingDirectory = $base
        $shortcut.WindowStyle = 7
        $shortcut.Description = 'Supervise and self-heal WAG Local'
        $shortcut.Save()

        Write-Output "WAG_LOCAL_AUTOSTART_INSTALLED=$shortcutPath"
    }

    if (-not $NoStart) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $stdout = Join-Path $base 'logs\wag-local-supervisor.bootstrap.stdout.log'
        $stderr = Join-Path $base 'logs\wag-local-supervisor.bootstrap.stderr.log'
        $startArgs = @{
            FilePath = $pwsh
            ArgumentList = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$supervisor)
            WindowStyle = 'Hidden'
            RedirectStandardOutput = $stdout
            RedirectStandardError = $stderr
            PassThru = $true
        }
        $process = Start-Process @startArgs
        Write-Output "WAG_LOCAL_SUPERVISOR_BOOTSTRAP_PID=$($process.Id)"
    }
}
