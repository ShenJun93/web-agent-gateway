param(
    [switch]$Repair,
    [string]$Output = ''
)

& {
    $ErrorActionPreference = 'Stop'

    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $forward = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
        if ($Repair) { $forward += '-Repair' }
        if ($Output) { $forward += @('-Output',$Output) }
        & $pwsh @forward
        exit $LASTEXITCODE
    }

    if (-not $IsWindows) { throw 'WAG doctor currently supports Windows only' }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required' }

    Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $doctorCli = Join-Path $root 'dist\product-doctor.js'
    if (-not (Test-Path -LiteralPath $doctorCli -PathType Leaf)) {
        throw "STOP: missing compiled WAG doctor: $doctorCli"
    }

    $secretFile = Join-Path $env:LOCALAPPDATA 'WAG-Local\secrets\devspace-owner.dpapi'
    if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
        throw 'STOP: missing DevSpace owner credential store'
    }

    $secure = ConvertTo-SecureString (Get-Content -LiteralPath $secretFile -Raw)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $env:DEVSPACE_OAUTH_OWNER_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if (-not $env:DEVSPACE_OAUTH_OWNER_TOKEN) {
            throw 'STOP: decrypted DevSpace owner credential is empty'
        }

        $args = @($doctorCli)
        if ($Repair) { $args += '--repair' }
        if ($Output) { $args += @('--output',$Output) }
        & node.exe @args
        $code = $LASTEXITCODE
    }
    finally {
        Remove-Item Env:DEVSPACE_OAUTH_OWNER_TOKEN -ErrorAction SilentlyContinue
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }

    exit $code
}
