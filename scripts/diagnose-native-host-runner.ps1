$ErrorActionPreference = 'Stop'
$target = Join-Path $env:WINDIR 'System32\notepad.exe'
try {
  $source = @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
public static class WagRunnerCatalogProbe {
  [DllImport("wintrust.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CryptCATAdminAcquireContext2(out IntPtr phCatAdmin, IntPtr pgSubsystem, string pwszHashAlgorithm, IntPtr pStrongHashPolicy, uint dwFlags);
  [DllImport("wintrust.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CryptCATAdminCalcHashFromFileHandle2(IntPtr hCatAdmin, IntPtr hFile, ref uint pcbHash, byte[] pbHash, uint dwFlags);
  [DllImport("wintrust.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CryptCATAdminReleaseContext(IntPtr hCatAdmin, uint dwFlags);
  public static void Probe(string path) {
    IntPtr admin;
    if (!CryptCATAdminAcquireContext2(out admin, IntPtr.Zero, "SHA256", IntPtr.Zero, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        uint size = 0;
        var handle = file.SafeFileHandle.DangerousGetHandle();
        if (!CryptCATAdminCalcHashFromFileHandle2(admin, handle, ref size, null, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (size != 32) throw new InvalidOperationException();
        var hash = new byte[size];
        if (!CryptCATAdminCalcHashFromFileHandle2(admin, handle, ref size, hash, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (size != 32) throw new InvalidOperationException();
      }
    } finally { CryptCATAdminReleaseContext(admin, 0); }
  }
}
"@
  Add-Type -TypeDefinition $source -Language CSharp
  [WagRunnerCatalogProbe]::Probe($target)
  Write-Output 'catalog_hash=PASS'
} catch {
  Write-Output 'catalog_hash=FAIL'
}
try {
  $signature = Get-AuthenticodeSignature -LiteralPath $target
  Write-Output ('authenticode_status=' + [string]$signature.Status)
  Write-Output ('authenticode_certificate=' + [string]($null -ne $signature.SignerCertificate))
} catch {
  Write-Output 'authenticode_status=ERROR'
  Write-Output 'authenticode_certificate=False'
}