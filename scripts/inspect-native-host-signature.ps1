param(
  [string]$ExecutablePath,
  [string]$ExpectedState
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

trap {
  [System.Console]::Error.Write('wag-native-host-signature-inspect: failed')
  exit 1
}

if (-not $ExecutablePath) { throw 'invalid executable path' }
if ($ExpectedState -ne 'Unsigned' -and $ExpectedState -ne 'Valid') { throw 'invalid expected state' }

$fullPath = [System.IO.Path]::GetFullPath($ExecutablePath)
if (-not [string]::Equals($fullPath, $ExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'executable path must be canonical and absolute'
}

$resolved = Resolve-Path -LiteralPath $fullPath -ErrorAction Stop
$item = Get-Item -LiteralPath $resolved.Path -Force -ErrorAction Stop
if ($item.PSIsContainer) { throw 'executable path must be a file' }
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'reparse points are not accepted'
}
$appLocker = Get-AppLockerFileInformation -Path $resolved.Path
if ($null -eq $appLocker) { throw 'missing AppLocker file information' }
$hashText = [string]$appLocker.Hash
if ($hashText -notmatch '^SHA256 0x([0-9A-Fa-f]{64})$') {
  throw 'unexpected Authenticode hash representation'
}
$authenticodeSha256 = $Matches[1].ToLowerInvariant()

$signature = Get-AuthenticodeSignature -LiteralPath $resolved.Path
if ($ExpectedState -eq 'Unsigned') {
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
    throw 'signature state mismatch'
  }
  [ordered]@{
    status = 'NotSigned'
    authenticodeSha256 = $authenticodeSha256
  } | ConvertTo-Json -Compress
  exit 0
}

if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw 'signature state mismatch'
}
$certificate = $signature.SignerCertificate
if ($null -eq $certificate) { throw 'missing signer certificate' }

$signerSubject = [string]$certificate.Subject
if ($signerSubject.Length -lt 1 -or $signerSubject.Length -gt 256 -or $signerSubject -match '[\x00-\x1F\x7F]') {
  throw 'invalid signer subject'
}
$signerThumbprintRaw = [string]$certificate.Thumbprint
if ($signerThumbprintRaw -notmatch '^[0-9A-Fa-f]{40}$') { throw 'invalid signer thumbprint' }
$signerThumbprint = $signerThumbprintRaw.ToLowerInvariant()

$publicKeyAlgorithmOid = [string]$certificate.PublicKey.Oid.Value
if ($publicKeyAlgorithmOid -ne '1.2.840.113549.1.1.1') { throw 'signer must use RSA' }

$hasCodeSigningEku = $false
foreach ($extension in $certificate.Extensions) {
  if ($extension.Oid.Value -eq '2.5.29.37') {
    $ekuExtension = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$extension
    foreach ($oid in $ekuExtension.EnhancedKeyUsages) {
      if ($oid.Value -eq '1.3.6.1.5.5.7.3.3') { $hasCodeSigningEku = $true }
    }
  }
}
if (-not $hasCodeSigningEku) { throw 'code signing EKU is required' }

$certificateSignatureAlgorithmOid = [string]$certificate.SignatureAlgorithm.Value
if (
  $certificateSignatureAlgorithmOid.Length -lt 1 -or
  $certificateSignatureAlgorithmOid.Length -gt 256 -or
  $certificateSignatureAlgorithmOid -notmatch '^[0-9]+(?:\.[0-9]+)+$'
) {
  throw 'invalid certificate signature algorithm OID'
}

$timestamp = $null
if ($null -ne $signature.TimeStamperCertificate) {
  $timestampCertificate = $signature.TimeStamperCertificate
  $timestampSubject = [string]$timestampCertificate.Subject
  if ($timestampSubject.Length -lt 1 -or $timestampSubject.Length -gt 256 -or $timestampSubject -match '[\x00-\x1F\x7F]') {
    throw 'invalid timestamp subject'
  }
  $timestampThumbprintRaw = [string]$timestampCertificate.Thumbprint
  if ($timestampThumbprintRaw -notmatch '^[0-9A-Fa-f]{40}$') { throw 'invalid timestamp thumbprint' }
  $timestamp = [ordered]@{
    signerSubject = $timestampSubject
    signerThumbprint = $timestampThumbprintRaw.ToLowerInvariant()
  }
}

[ordered]@{
  status = 'Valid'
  signerSubject = $signerSubject
  signerThumbprint = $signerThumbprint
  publicKeyAlgorithmOid = $publicKeyAlgorithmOid
  codeSigningEkuOid = '1.3.6.1.5.5.7.3.3'
  certificateSignatureAlgorithmOid = $certificateSignatureAlgorithmOid
  timestamp = $timestamp
  authenticodeSha256 = $authenticodeSha256
} | ConvertTo-Json -Compress -Depth 4
exit 0
