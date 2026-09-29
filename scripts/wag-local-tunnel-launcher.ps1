param(
    [switch]$EnsureDevSpaceOnly,
    [switch]$SkipTunnelExistingCheck
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $forward = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
        if ($EnsureDevSpaceOnly) { $forward += '-EnsureDevSpaceOnly' }
        if ($SkipTunnelExistingCheck) { $forward += '-SkipTunnelExistingCheck' }
        & $pwsh @forward
        exit $LASTEXITCODE
    }

    Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $store = Join-Path $base 'secrets'
    $logs = Join-Path $base 'logs'
    $controlFile = Join-Path $store 'control-plane.dpapi'
    $devspaceFile = Join-Path $store 'devspace-owner.dpapi'
    $devspaceConfig = Join-Path $base 'DevSpace'
    $devspacePinDir = Join-Path $base 'DevSpace-Pin-33d6d0b'
    $devspacePidFile = Join-Path $logs 'devspace-wag-7677.pid'
    $devspaceStdout = Join-Path $logs 'devspace-recovery.stdout.log'
    $devspaceStderr = Join-Path $logs 'devspace-recovery.stderr.log'
    $devspaceExpected = '33d6d0bcc2256024484d2456da924af8afd814ed'
    $devspaceRepo = 'https://github.com/Waishnav/devspace.git'
    $pnpmVersion = '11.25.0'
    $devspaceDiscovery = 'http://127.0.0.1:7677/.well-known/oauth-authorization-server'
    $tunnelHealth = 'http://127.0.0.1:8080/readyz'

    New-Item -ItemType Directory -Path $logs -Force | Out-Null

    foreach ($p in @($controlFile, $devspaceFile)) {
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "STOP: missing secret file: $p" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $devspaceConfig 'config.jsonc') -PathType Leaf)) {
        throw "STOP: missing DevSpace config: $devspaceConfig"
    }

    function Write-Diagnostic([string]$Code, [string]$Message) {
        Write-Output "WAG_DIAGNOSTIC_CODE=$Code"
        Write-Output "WAG_DIAGNOSTIC_MESSAGE=$Message"
    }

    function Reveal-SecureString([Security.SecureString]$Secure) {
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
        try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }

    function Test-HttpOk([string]$Url) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        }
        catch { return $false }
    }

    function Get-ListeningPid([int]$Port) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $listener) { return $null }
        return [int]$listener.OwningProcess
    }

    function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = '') {
        if ($WorkingDirectory) { Push-Location $WorkingDirectory }
        try {
            & $File @Arguments
            if ($LASTEXITCODE -ne 0) { throw "STOP: command failed with exit code $($LASTEXITCODE): $File" }
        }
        finally {
            if ($WorkingDirectory) { Pop-Location }
        }
    }

    function Ensure-DevSpacePin {
        $git = (Get-Command git.exe -ErrorAction Stop).Source

        if (-not (Test-Path -LiteralPath (Join-Path $devspacePinDir '.git'))) {
            if (Test-Path -LiteralPath $devspacePinDir) { Remove-Item -LiteralPath $devspacePinDir -Recurse -Force }
            Write-Output 'DEVSPACE_RESTORE=CLONE'
            Invoke-Checked $git @('clone', $devspaceRepo, $devspacePinDir)
        }

        $head = (& $git -C $devspacePinDir rev-parse HEAD 2>$null).Trim()
        if ($LASTEXITCODE -ne 0 -or $head -ne $devspaceExpected) {
            Write-Output 'DEVSPACE_RESTORE=PIN'
            Invoke-Checked $git @('-C', $devspacePinDir, 'fetch', 'origin', $devspaceExpected)
            Invoke-Checked $git @('-C', $devspacePinDir, 'checkout', '--detach', $devspaceExpected)
            $head = (& $git -C $devspacePinDir rev-parse HEAD).Trim()
        }

        if ($head -ne $devspaceExpected) { throw "STOP: DevSpace pin mismatch: expected $devspaceExpected, got $head" }

        $cli = Join-Path $devspacePinDir 'dist\cli.js'
        if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
            Write-Output 'DEVSPACE_RESTORE=BUILD'
            $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
            Invoke-Checked $npx @('-y', "pnpm@$pnpmVersion", 'install', '--frozen-lockfile') $devspacePinDir
            Invoke-Checked $npx @('-y', "pnpm@$pnpmVersion", 'build') $devspacePinDir
        }

        if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw "STOP: DevSpace build did not produce $cli" }
    }

    function Ensure-DevSpace {
        if (Test-HttpOk $devspaceDiscovery) {
            $observedPid = Get-ListeningPid 7677
            if ($observedPid) { [IO.File]::WriteAllText($devspacePidFile, [string]$observedPid) }
            Write-Output 'DEVSPACE_READY=True'
            Write-Output 'DEVSPACE_RECOVERY=NOT_NEEDED'
            return
        }

        $existingPid = Get-ListeningPid 7677
        if ($existingPid) {
            Write-Diagnostic 'WAG_DEVSPACE_PORT_COLLISION' "Port 7677 is occupied by PID $existingPid while DevSpace discovery is unhealthy."
            throw "STOP: port 7677 is already owned by PID $existingPid but DevSpace OAuth discovery is unhealthy"
        }

        Ensure-DevSpacePin

        $devspaceSecure = ConvertTo-SecureString (Get-Content -LiteralPath $devspaceFile -Raw)
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($devspaceSecure)
        try {
            $env:DEVSPACE_OAUTH_OWNER_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
            $env:DEVSPACE_CONFIG_DIR = $devspaceConfig
            if (-not $env:DEVSPACE_OAUTH_OWNER_TOKEN) { throw 'STOP: decrypted DEVSPACE_OAUTH_OWNER_TOKEN is empty' }

            Remove-Item -LiteralPath $devspaceStdout, $devspaceStderr -Force -ErrorAction SilentlyContinue
            $node = (Get-Command node.exe -ErrorAction Stop).Source
            $startArgs = @{
                FilePath = $node
                ArgumentList = @('dist/cli.js','serve')
                WorkingDirectory = $devspacePinDir
                WindowStyle = 'Hidden'
                RedirectStandardOutput = $devspaceStdout
                RedirectStandardError = $devspaceStderr
                PassThru = $true
            }
            $process = Start-Process @startArgs
            [IO.File]::WriteAllText($devspacePidFile, [string]$process.Id)
        }
        finally {
            Remove-Item Env:DEVSPACE_OAUTH_OWNER_TOKEN -ErrorAction SilentlyContinue
            Remove-Item Env:DEVSPACE_CONFIG_DIR -ErrorAction SilentlyContinue
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        }

        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-HttpOk $devspaceDiscovery) {
                Write-Output 'DEVSPACE_READY=True'
                Write-Output 'DEVSPACE_RECOVERY=STARTED'
                return
            }
            if ($process.HasExited) {
                $tail = Get-Content -LiteralPath $devspaceStderr -Tail 20 -ErrorAction SilentlyContinue
                if ($tail) { $tail | Write-Error }
                throw "STOP: DevSpace exited early with code $($process.ExitCode)"
            }
            Start-Sleep -Milliseconds 500
        }
        throw "STOP: DevSpace did not become ready within 30 seconds; stderr=$devspaceStderr"
    }

    Ensure-DevSpace
    if ($EnsureDevSpaceOnly) { return }

    if (-not $SkipTunnelExistingCheck) {
        if (Test-HttpOk $tunnelHealth) {
            Write-Output 'WAG_TUNNEL_READY=True'
            Write-Output 'WAG_TUNNEL_RECOVERY=NOT_NEEDED'
            return
        }
        $existingTunnelPid = Get-ListeningPid 8080
        if ($existingTunnelPid) {
            Write-Diagnostic 'WAG_TUNNEL_PORT_COLLISION' "Port 8080 is occupied by PID $existingTunnelPid while tunnel readiness is unavailable."
            throw "STOP: port 8080 is already owned by PID $existingTunnelPid but WAG tunnel health is unavailable"
        }
    }

    & wsl.exe -e true
    if ($LASTEXITCODE -ne 0) {
        Write-Diagnostic 'WAG_WSL_UNAVAILABLE' 'WSL could not execute the WAG tunnel preflight.'
        throw 'STOP: WSL unavailable'
    }

    & wsl.exe -e bash -lc 'test -x /home/pacmap/tools/openai-tunnel-client/v0.0.14/tunnel-client'
    if ($LASTEXITCODE -ne 0) {
        Write-Diagnostic 'WAG_TUNNEL_CLIENT_MISSING' 'The pinned tunnel-client binary is missing or not executable.'
        throw 'STOP: tunnel-client missing or not executable'
    }

    $controlSecure = ConvertTo-SecureString (Get-Content -LiteralPath $controlFile -Raw)
    $devspaceSecure = ConvertTo-SecureString (Get-Content -LiteralPath $devspaceFile -Raw)
    $oldWslenv = $env:WSLENV

    try {
        $env:CONTROL_PLANE_API_KEY = Reveal-SecureString $controlSecure
        $env:DEVSPACE_OAUTH_OWNER_TOKEN = Reveal-SecureString $devspaceSecure
        if (-not $env:CONTROL_PLANE_API_KEY) { throw 'STOP: decrypted CONTROL_PLANE_API_KEY is empty' }
        if (-not $env:DEVSPACE_OAUTH_OWNER_TOKEN) { throw 'STOP: decrypted DEVSPACE_OAUTH_OWNER_TOKEN is empty' }

        $parts = @()
        if ($oldWslenv) { $parts = @($oldWslenv -split ':' | Where-Object { $_ }) }

        foreach ($name in @('CONTROL_PLANE_API_KEY','DEVSPACE_OAUTH_OWNER_TOKEN')) {
            $parts = @($parts | Where-Object { (($_ -split '/')[0]) -ne $name })
            $parts += $name
        }
        $env:WSLENV = $parts -join ':'

        $bash = @(
            'set -euo pipefail'
            'set +x'
            'exe="/home/pacmap/tools/openai-tunnel-client/v0.0.14/tunnel-client"'
            'profile="web-agent-gateway"'
            '[ -n "${CONTROL_PLANE_API_KEY:-}" ] || { echo "STOP: CONTROL_PLANE_API_KEY missing in WSL"; exit 1; }'
            '[ -n "${DEVSPACE_OAUTH_OWNER_TOKEN:-}" ] || { echo "STOP: DEVSPACE_OAUTH_OWNER_TOKEN missing in WSL"; exit 1; }'
            'clean=""'
            'while IFS= read -r entry; do'
            '  [ -n "$entry" ] || continue'
            '  base="${entry%%/*}"'
            '  [ "$base" = "CONTROL_PLANE_API_KEY" ] && continue'
            '  [ "$base" = "DEVSPACE_OAUTH_OWNER_TOKEN" ] && continue'
            '  if [ -z "$clean" ]; then clean="$entry"; else clean="${clean}:$entry"; fi'
            'done < <(printf "%s" "${WSLENV:-}" | tr ":" "\n")'
            'if [ -n "$clean" ]; then'
            '  export WSLENV="${clean}:DEVSPACE_OAUTH_OWNER_TOKEN"'
            'else'
            '  export WSLENV="DEVSPACE_OAUTH_OWNER_TOKEN"'
            'fi'
            'echo "STARTING_WAG_TUNNEL_FOREGROUND=True"'
            'exec "$exe" run --profile "$profile"'
        ) -join [Environment]::NewLine

        $bash | wsl.exe bash -s
        if ($LASTEXITCODE -ne 0) { throw "STOP: tunnel-client exited with code $LASTEXITCODE" }
    }
    finally {
        Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:DEVSPACE_OAUTH_OWNER_TOKEN -ErrorAction SilentlyContinue
        if ($null -eq $oldWslenv) { Remove-Item Env:WSLENV -ErrorAction SilentlyContinue }
        else { $env:WSLENV = $oldWslenv }
    }
}
