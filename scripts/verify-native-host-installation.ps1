[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $ReceiptPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedRepository = 'ShenJun93/web-agent-gateway'
$expectedSourceSha = '9c7fb2881d3641354104f6a20257284d5629ef1c'
$expectedWorkflowRunId = '35027172925'
$expectedExecutableSha256 = '4f0869078357cf8b8ae00e4d27adbef0b905921bdd5202aca38ca10c1b055ebb'
$expectedApplicationName = 'com.openai.web_agent_gateway'
$expectedExtensionId = 'nnhhhppkpogkedpjnijeagcbfjaoogec'
$expectedSubkey = 'SOFTWARE\Chromium\NativeMessagingHosts\com.openai.web_agent_gateway'
$expectedOrigin = 'chrome-extension://nnhhhppkpogkedpjnijeagcbfjaoogec/'
$maxReceiptBytes = 64KB
$maxManifestBytes = 64KB

function Assert-JsonObject {
  param(
    [AllowNull()] [object] $Value,
    [Parameter(Mandatory = $true)] [string] $Label
  )
  if ($Value -isnot [System.Management.Automation.PSCustomObject]) {
    throw "$Label must be a JSON object"
  }
}

function Assert-ExactProperties {
  param(
    [Parameter(Mandatory = $true)] [object] $Value,
    [Parameter(Mandatory = $true)] [string[]] $Names,
    [Parameter(Mandatory = $true)] [string] $Label
  )
  Assert-JsonObject $Value $Label
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expected = @($Names | Sort-Object)
  if (($actual -join "`n") -cne ($expected -join "`n")) {
    throw "$Label properties are invalid"
  }
}

function Assert-ExactString {
  param(
    [AllowNull()] [object] $Actual,
    [Parameter(Mandatory = $true)] [string] $Expected,
    [Parameter(Mandatory = $true)] [string] $Label
  )
  if (($Actual -isnot [string]) -or -not [string]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) {
    throw "$Label is invalid"
  }
}

function Assert-ExactInt {
  param(
    [AllowNull()] [object] $Actual,
    [Parameter(Mandatory = $true)] [long] $Expected,
    [Parameter(Mandatory = $true)] [string] $Label
  )
  if ((($Actual -isnot [int]) -and ($Actual -isnot [long])) -or ([long]$Actual -ne $Expected)) {
    throw "$Label is invalid"
  }
}

function Assert-CanonicalTimestamp {
  param(
    [AllowNull()] [object] $Value,
    [Parameter(Mandatory = $true)] [string] $Label
  )
  if (($Value -isnot [string]) -or $Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
    throw "$Label is invalid"
  }
  $parsed = [DateTimeOffset]::MinValue
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  if (-not [DateTimeOffset]::TryParseExact(
    $Value,
    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
    [Globalization.CultureInfo]::InvariantCulture,
    $styles,
    [ref] $parsed
  )) {
    throw "$Label is invalid"
  }
}

function Assert-OwnedDirectory {
  param(
    [Parameter(Mandatory = $true)] [string] $Path,
    [Parameter(Mandatory = $true)] [string] $ExpectedPath,
    [Parameter(Mandatory = $true)] [string] $Label
  )
  if ($Path -notmatch '^[A-Za-z]:\\') {
    throw "$Label path must be absolute"
  }
  Assert-ExactString ([IO.Path]::GetFullPath($Path)) $ExpectedPath "$Label path"
  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  Assert-ExactString $resolved $ExpectedPath "$Label resolved path"
  $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
  if ((-not $item.PSIsContainer) -or ($null -ne $item.LinkType) -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be an owned regular directory"
  }
}

function Resolve-OwnedFile {
  param(
    [Parameter(Mandatory = $true)] [string] $Path,
    [Parameter(Mandatory = $true)] [string] $ExpectedPath,
    [Parameter(Mandatory = $true)] [string] $Label
  )
  if ($Path -notmatch '^[A-Za-z]:\\') {
    throw "$Label path must be absolute"
  }
  Assert-ExactString ([IO.Path]::GetFullPath($Path)) $ExpectedPath "$Label path"
  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  Assert-ExactString $resolved $ExpectedPath "$Label resolved path"
  $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($null -ne $item.LinkType) -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be a regular file"
  }
  return $item
}

function Get-LowercaseSha256 {
  param([Parameter(Mandatory = $true)] [string] $Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

try {
  if (-not [Environment]::Is64BitProcess) {
    throw 'Native host installation verification requires a 64-bit process'
  }
  if (($env:LOCALAPPDATA -isnot [string]) -or $env:LOCALAPPDATA -notmatch '^[A-Za-z]:\\') {
    throw 'LOCALAPPDATA must be an absolute Windows path'
  }
  $localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
  $expectedApplicationRoot = [IO.Path]::Combine($localAppData, 'WebAgentGateway')
  $expectedNativeHostRoot = [IO.Path]::Combine($expectedApplicationRoot, 'native-host')
  $expectedInstallationRoot = [IO.Path]::Combine($expectedNativeHostRoot, $expectedSourceSha)
  $expectedReceiptPath = [IO.Path]::Combine($expectedInstallationRoot, 'install-receipt.json')
  $expectedExecutablePath = [IO.Path]::Combine($expectedInstallationRoot, 'wag-native-host.exe')
  $expectedManifestPath = [IO.Path]::Combine($expectedInstallationRoot, 'com.openai.web_agent_gateway.json')

  if ($ReceiptPath -notmatch '^[A-Za-z]:\\') {
    throw 'Receipt path must be absolute'
  }
  $receiptFullPath = [IO.Path]::GetFullPath($ReceiptPath)
  Assert-ExactString $receiptFullPath $expectedReceiptPath 'Receipt path'

  Assert-OwnedDirectory $localAppData $localAppData 'Local app data'
  Assert-OwnedDirectory $expectedApplicationRoot $expectedApplicationRoot 'Installation application directory'
  Assert-OwnedDirectory $expectedNativeHostRoot $expectedNativeHostRoot 'Installation parent directory'
  Assert-OwnedDirectory $expectedInstallationRoot $expectedInstallationRoot 'Installation source directory'

  $receiptItem = Resolve-OwnedFile $receiptFullPath $expectedReceiptPath 'Receipt'
  if ($receiptItem.Length -gt $maxReceiptBytes) {
    throw 'Receipt must be bounded'
  }
  $receipt = [IO.File]::ReadAllText($receiptItem.FullName) | ConvertFrom-Json -ErrorAction Stop
  Assert-ExactProperties $receipt @(
    'schemaVersion', 'repository', 'sourceSha', 'workflowRunId', 'runAttempt',
    'executableSha256', 'nativeApplicationName', 'extensionId', 'executablePath',
    'manifestPath', 'manifestSha256', 'registration', 'preparedAt'
  ) 'Receipt'
  Assert-ExactInt $receipt.schemaVersion 1 'Receipt schema version'
  Assert-ExactInt $receipt.runAttempt 1 'Receipt run attempt'
  Assert-ExactString $receipt.repository $expectedRepository 'Receipt repository'
  Assert-ExactString $receipt.sourceSha $expectedSourceSha 'Receipt source SHA'
  Assert-ExactString $receipt.workflowRunId $expectedWorkflowRunId 'Receipt workflow run'
  Assert-ExactString $receipt.executableSha256 $expectedExecutableSha256 'Receipt executable hash'
  Assert-ExactString $receipt.nativeApplicationName $expectedApplicationName 'Receipt application'
  Assert-ExactString $receipt.extensionId $expectedExtensionId 'Receipt extension'
  if (($receipt.manifestSha256 -isnot [string]) -or $receipt.manifestSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Receipt manifest hash is invalid'
  }
  Assert-CanonicalTimestamp $receipt.preparedAt 'Receipt preparation time'
  Assert-ExactString $receipt.executablePath $expectedExecutablePath 'Receipt executable path'
  Assert-ExactString $receipt.manifestPath $expectedManifestPath 'Receipt manifest path'

  Assert-ExactProperties $receipt.registration @('hive', 'view', 'subkey', 'defaultValue') 'Registration descriptor'
  Assert-ExactString $receipt.registration.hive 'HKCU' 'Registration hive'
  Assert-ExactString $receipt.registration.view '64-bit' 'Registration view'
  Assert-ExactString $receipt.registration.subkey $expectedSubkey 'Registration subkey'
  Assert-ExactString $receipt.registration.defaultValue $expectedManifestPath 'Registration value'

  $registryPath = "Registry::HKEY_CURRENT_USER\$expectedSubkey"
  $observedValue = $null
  try {
    $observedValue = Get-ItemPropertyValue -LiteralPath $registryPath -Name '(default)' -ErrorAction Stop
  }
  catch [System.Management.Automation.ItemNotFoundException] {
    $observedValue = $null
  }
  catch [System.Management.Automation.PSArgumentException] {
    $observedValue = $null
  }
  $registration = if ($null -eq $observedValue) {
    'ABSENT'
  }
  elseif (($observedValue -is [string]) -and [string]::Equals($observedValue, $expectedManifestPath, [StringComparison]::Ordinal)) {
    'MATCH'
  }
  else {
    'DRIFT'
  }

  $executableItem = Resolve-OwnedFile $receipt.executablePath $expectedExecutablePath 'Executable'
  $manifestItem = Resolve-OwnedFile $receipt.manifestPath $expectedManifestPath 'Manifest'
  if ($manifestItem.Length -gt $maxManifestBytes) {
    throw 'Manifest must be bounded'
  }
  $executableSha256 = Get-LowercaseSha256 $executableItem.FullName
  $manifestSha256 = Get-LowercaseSha256 $manifestItem.FullName
  Assert-ExactString $executableSha256 $receipt.executableSha256 'Executable hash'
  Assert-ExactString $manifestSha256 $receipt.manifestSha256 'Manifest hash'

  $manifest = [IO.File]::ReadAllText($manifestItem.FullName) | ConvertFrom-Json -ErrorAction Stop
  Assert-ExactProperties $manifest @('name', 'description', 'path', 'type', 'allowed_origins') 'Manifest'
  Assert-ExactString $manifest.name $expectedApplicationName 'Manifest application'
  Assert-ExactString $manifest.description 'Web Agent Gateway browser adapter' 'Manifest description'
  Assert-ExactString $manifest.path $expectedExecutablePath 'Manifest executable path'
  Assert-ExactString $manifest.type 'stdio' 'Manifest type'
  if (($manifest.allowed_origins -isnot [System.Array]) -or $manifest.allowed_origins.Count -ne 1) {
    throw 'Manifest origins are invalid'
  }
  Assert-ExactString $manifest.allowed_origins[0] $expectedOrigin 'Manifest origin'

  [ordered]@{
    sourceSha = $expectedSourceSha
    executableSha256 = $executableSha256
    manifestSha256 = $manifestSha256
    registration = $registration
  } | ConvertTo-Json -Compress
}
catch {
  [Console]::Error.WriteLine('wag-native-host-installation-verify: failed')
  exit 1
}
