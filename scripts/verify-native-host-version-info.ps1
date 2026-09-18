[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $ExecutablePath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $PackageJsonPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ExactString {
  param(
    [AllowNull()] [object] $Actual,
    [Parameter(Mandatory = $true)] [string] $Expected,
    [Parameter(Mandatory = $true)] [string] $Label
  )
  if (($Actual -isnot [string]) -or -not [string]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) {
    throw "$Label mismatch"
  }
}

if ((-not [IO.Path]::IsPathRooted($ExecutablePath)) -or $ExecutablePath -cnotmatch '^[A-Za-z]:\\') { throw 'ExecutablePath must be a Windows absolute path' }
if ((-not [IO.Path]::IsPathRooted($PackageJsonPath)) -or $PackageJsonPath -cnotmatch '^[A-Za-z]:\\') { throw 'PackageJsonPath must be a Windows absolute path' }
if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) { throw 'Executable not found' }
if (-not (Test-Path -LiteralPath $PackageJsonPath -PathType Leaf)) { throw 'package.json not found' }

$package = Get-Content -LiteralPath $PackageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (($package.version -isnot [string]) -or $package.version -cnotmatch '^(\d+)\.(\d+)\.(\d+)$') {
  throw 'package.json version must be numeric SemVer X.Y.Z'
}
$expectedVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
$versionInfo = (Get-Item -LiteralPath $ExecutablePath).VersionInfo

Assert-ExactString $versionInfo.FileDescription 'Web Agent Gateway Native Host' 'FileDescription'
Assert-ExactString $versionInfo.ProductName 'Web Agent Gateway' 'ProductName'
Assert-ExactString $versionInfo.FileVersion $expectedVersion 'FileVersion'
Assert-ExactString $versionInfo.ProductVersion $expectedVersion 'ProductVersion'
Assert-ExactString $versionInfo.OriginalFilename 'wag-native-host.exe' 'OriginalFilename'
Assert-ExactString $versionInfo.InternalName 'wag-native-host' 'InternalName'

if (-not [string]::IsNullOrEmpty($versionInfo.CompanyName)) { throw 'Inherited CompanyName must be removed' }
if (-not [string]::IsNullOrEmpty($versionInfo.LegalCopyright)) { throw 'Inherited LegalCopyright must be removed' }

[ordered]@{
  status = 'pass'
  productName = $versionInfo.ProductName
  fileDescription = $versionInfo.FileDescription
  version = $expectedVersion
  originalFilename = $versionInfo.OriginalFilename
} | ConvertTo-Json -Compress
