import { spawnSync } from 'node:child_process';

const command = [
  "$ErrorActionPreference='Stop'",
  "$systemModules=Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\Modules'",
  "Write-Output ('language_mode=' + [string]$ExecutionContext.SessionState.LanguageMode)",
  "Write-Output ('system_module_path_present=' + [string](($env:PSModulePath -split ';') -contains $systemModules))",
  "try { Get-Command Get-AuthenticodeSignature -ErrorAction Stop | Out-Null; Write-Output 'autoload=PASS' } catch { Write-Output 'autoload=FAIL' }",
  "try {",
  "  Import-Module Microsoft.PowerShell.Security -ErrorAction Stop",
  "  $commandInfo=Get-Command Get-AuthenticodeSignature -ErrorAction Stop",
  "  Write-Output ('command_type=' + [string]$commandInfo.CommandType)",
  "  Write-Output ('module_name=' + [string]$commandInfo.ModuleName)",
  "  $target=Join-Path $env:WINDIR 'System32\\notepad.exe'",
  "  $signature=Get-AuthenticodeSignature -LiteralPath $target",
  "  Write-Output ('signature_status=' + [string]$signature.Status)",
  "  Write-Output 'explicit_import=PASS'",
  "} catch {",
  "  Write-Output ('error_type=' + $_.Exception.GetType().FullName)",
  "  Write-Output ('error_id=' + [string]$_.FullyQualifiedErrorId)",
  "  exit 7",
  "}",
].join('; ');

const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;