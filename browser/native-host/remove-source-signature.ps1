param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

trap {
  [System.Console]::Error.Write('wag-native-host-source-signature-remove: failed')
  exit 1
}

if (-not [System.IO.Path]::IsPathRooted($ExecutablePath)) { throw 'absolute path required' }
$fullPath = [System.IO.Path]::GetFullPath($ExecutablePath)
if (-not [string]::Equals($fullPath, $ExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'canonical path required'
}
$resolved = Resolve-Path -LiteralPath $fullPath -ErrorAction Stop
$item = Get-Item -LiteralPath $resolved.Path -Force -ErrorAction Stop
if ($item.PSIsContainer) { throw 'file required' }
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point rejected' }

$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class WagImageCertificate {
  [DllImport("imagehlp.dll", SetLastError = true)]
  private static extern bool ImageEnumerateCertificates(
    IntPtr fileHandle, ushort typeFilter, out uint certificateCount,
    [Out] uint[] indices, uint indexCount);

  [DllImport("imagehlp.dll", SetLastError = true)]
  private static extern bool ImageRemoveCertificate(IntPtr fileHandle, uint index);

  private static uint Count(IntPtr handle) {
    uint count;
    if (!ImageEnumerateCertificates(handle, 255, out count, null, 0)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    return count;
  }

  public static void RemoveAll(string path) {
    using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
      IntPtr handle = file.SafeFileHandle.DangerousGetHandle();
      uint count = Count(handle);
      if (count == 0) return;
      uint[] indices = new uint[count];
      uint observed;
      if (!ImageEnumerateCertificates(handle, 255, out observed, indices, count)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      if (observed != count) throw new InvalidOperationException("certificate count changed");
      Array.Sort(indices);
      Array.Reverse(indices);
      foreach (uint index in indices) {
        if (!ImageRemoveCertificate(handle, index)) {
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
      }
      if (Count(handle) != 0) throw new InvalidOperationException("certificate removal incomplete");
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[WagImageCertificate]::RemoveAll($resolved.Path)
exit 0
