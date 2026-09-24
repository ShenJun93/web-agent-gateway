& {
    $ErrorActionPreference = 'Stop'
    $base = Join-Path $env:LOCALAPPDATA 'WAG-Local'
    $secretFile = Join-Path $base 'secrets\devspace-owner.dpapi'
    $server = Join-Path $base 'WagLocalBServer.mjs'
    $stdout = Join-Path $base 'logs\wag-b-supervisor.stdout.log'
    $stderr = Join-Path $base 'logs\wag-b-supervisor.stderr.log'
    $pidFile = Join-Path $base 'logs\wag-b-supervisor.pid'
    $receipt = Join-Path $base 'logs\wag-b-runtime.json'
    $config = 'E:\AI-BROWSER\wag-acceptance\wag-live-b.config.json'

    Remove-Item -LiteralPath $receipt -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) { throw 'missing DevSpace secret' }
    if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw 'missing B server' }

    $secure = ConvertTo-SecureString (Get-Content -LiteralPath $secretFile -Raw)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $env:DEVSPACE_OAUTH_OWNER_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $p = Start-Process -FilePath $node -ArgumentList @($server, $config) -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        [IO.File]::WriteAllText($pidFile, [string]$p.Id)
    }
    finally {
        Remove-Item Env:DEVSPACE_OAUTH_OWNER_TOKEN -ErrorAction SilentlyContinue
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}
