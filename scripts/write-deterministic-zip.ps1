[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $ManifestPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

trap {
  [Console]::Error.Write('wag-native-host-release-zip: failed')
  exit 1
}

function Assert-CanonicalAbsolutePath {
  param([string] $PathValue)
  if ((-not [IO.Path]::IsPathRooted($PathValue)) -or $PathValue -cnotmatch '^[A-Za-z]:\\') {
    throw 'path must be a Windows absolute path'
  }
  $full = [IO.Path]::GetFullPath($PathValue)
  if (-not [string]::Equals($full, $PathValue, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'path must be canonical'
  }
}

function Get-StreamSha256 {
  param([IO.Stream] $Stream)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash($Stream)
    return ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())
  } finally {
    $sha.Dispose()
  }
}

Assert-CanonicalAbsolutePath $ManifestPath
Assert-CanonicalAbsolutePath $OutputPath
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'manifest missing' }
if (Test-Path -LiteralPath $OutputPath) { throw 'output already exists' }

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw 'unsupported manifest schema' }
$entries = @($manifest.entries)
if ($entries.Count -lt 1 -or $entries.Count -gt 256) { throw 'invalid entry count' }

$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
$previous = $null
foreach ($item in $entries) {
  $archivePath = [string]$item.archivePath
  $sourcePath = [string]$item.sourcePath
  $expectedSha256 = [string]$item.sha256
  $expectedSize = [Int64]$item.size
  if ($archivePath.Length -lt 1 -or $archivePath.Length -gt 512 -or $archivePath -notmatch '^[A-Za-z0-9._@+\-/]+$') { throw 'invalid archive path' }
  if ($archivePath.StartsWith('/') -or $archivePath.Contains('\\')) { throw 'invalid archive path' }
  foreach ($segment in $archivePath.Split('/')) { if ($segment -eq '' -or $segment -eq '.' -or $segment -eq '..') { throw 'invalid archive path segment' } }
  if (-not $seen.Add($archivePath)) { throw 'duplicate archive path' }
  if ($null -ne $previous -and [string]::CompareOrdinal($previous, $archivePath) -ge 0) { throw 'entries must be strictly sorted' }
  $previous = $archivePath
  Assert-CanonicalAbsolutePath $sourcePath
  $file = Get-Item -LiteralPath $sourcePath -Force
  if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid source file' }
  if ($file.Length -ne $expectedSize) { throw 'source size mismatch' }
  if ($expectedSha256 -notmatch '^[0-9a-f]{64}$') { throw 'invalid source hash' }
  $actualSha256 = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) { throw 'source hash mismatch' }
}

$parent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'output parent missing' }
$tempPath = $OutputPath + '.tmp-' + $PID
if (Test-Path -LiteralPath $tempPath) { throw 'temporary output exists' }

Add-Type -AssemblyName System.IO.Compression
$fixedTimestamp = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)

try {
  $stream = [IO.File]::Open($tempPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      foreach ($item in $entries) {
        $entry = $zip.CreateEntry([string]$item.archivePath, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $fixedTimestamp
        $input = [IO.File]::OpenRead([string]$item.sourcePath)
        try {
          $output = $entry.Open()
          try { $input.CopyTo($output) } finally { $output.Dispose() }
        } finally { $input.Dispose() }
      }
    } finally { $zip.Dispose() }
  } finally { $stream.Dispose() }

  $readStream = [IO.File]::OpenRead($tempPath)
  try {
    $readZip = New-Object IO.Compression.ZipArchive($readStream, [IO.Compression.ZipArchiveMode]::Read, $false)
    try {
      if ($readZip.Entries.Count -ne $entries.Count) { throw 'zip entry count mismatch' }
      foreach ($item in $entries) {
        $entry = $readZip.GetEntry([string]$item.archivePath)
        if ($null -eq $entry -or $entry.Length -ne [Int64]$item.size) { throw 'zip entry mismatch' }
        $entryStream = $entry.Open()
        try { $actual = Get-StreamSha256 $entryStream } finally { $entryStream.Dispose() }
        if ($actual -ne [string]$item.sha256) { throw 'zip entry hash mismatch' }
      }
    } finally { $readZip.Dispose() }
  } finally { $readStream.Dispose() }

  Move-Item -LiteralPath $tempPath -Destination $OutputPath
} finally {
  if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
}

[ordered]@{ status = 'packaged'; entryCount = $entries.Count } | ConvertTo-Json -Compress
exit 0
