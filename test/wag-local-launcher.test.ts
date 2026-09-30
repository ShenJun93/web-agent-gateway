import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tunnelPath = join(root, 'scripts', 'wag-local-tunnel-launcher.ps1');
const starterPath = join(root, 'scripts', 'wag-local-start.ps1');
const installerPath = join(root, 'scripts', 'install-wag-local-launchers.ps1');
const supervisorPath = join(root, 'scripts', 'wag-local-supervisor.ps1');
const recoveryPath = join(root, 'scripts', 'wag-local-m1-recovery.ps1');
const rebootPreparePath = join(root, 'scripts', 'prepare-wag-local-m1-reboot.ps1');
const rebootVerifyPath = join(root, 'scripts', 'wag-local-m1-post-reboot.ps1');
const setupPath = join(root, 'scripts', 'wag-local-setup.ps1');
const m2FixturePath = join(root, 'scripts', 'wag-local-m2-installer-fixture.ps1');
const pin = JSON.parse(readFileSync(join(root, 'docs', 'benchmarks', 'devspace-pin.json'), 'utf8')) as {
  revision: string;
};
const tunnel = readFileSync(tunnelPath, 'utf8');
const starter = readFileSync(starterPath, 'utf8');
const installer = readFileSync(installerPath, 'utf8');
const supervisor = readFileSync(supervisorPath, 'utf8');

test('local tunnel launcher is self-healing and exact-pinned', () => {
  assert.match(tunnel, /Get-Command pwsh\.exe/);
  assert.match(tunnel, /Ensure-DevSpace/);
  assert.match(tunnel, /\.well-known\/oauth-authorization-server/);
  assert.match(tunnel, /DEVSPACE_RESTORE=CLONE/);
  assert.match(tunnel, /pnpm@\$pnpmVersion/);
  assert.ok(tunnel.includes(pin.revision), 'launcher DevSpace revision must match devspace-pin.json');
  assert.match(tunnel, /port 7677 is already owned/);
  assert.match(tunnel, /WAG_TUNNEL_RECOVERY=NOT_NEEDED/);
  assert.match(tunnel, /tunnel-client-path\.txt/);
  assert.match(tunnel, /WAG_TUNNEL_CLIENT_PIN_MISSING/);
  assert.match(tunnel, /WAG_TUNNEL_CLIENT_PATH/);
  assert.doesNotMatch(tunnel, /\/home\/pacmap\/tools\/openai-tunnel-client/);
  assert.match(tunnel, /ToBase64String/);
  assert.match(tunnel, /base64 -d \| bash/);
  assert.doesNotMatch(tunnel, /wslpath/);
  assert.doesNotMatch(tunnel, /\$bash \| wsl\.exe bash -s/);
});

test('one-click starter re-enters PowerShell 7 and waits for tunnel health', () => {
  assert.match(starter, /Get-Command pwsh\.exe/);
  assert.match(starter, /Start-WagLocalTunnel\.ps1/);
  assert.match(starter, /http:\/\/127\.0\.0\.1:8080/);
  assert.match(starter, /WAG_LOCAL_READY=True/);
  assert.match(starter, /Write-Host 'WAG_STALE_PID_CLEARED=launcher-invalid'/);
  assert.ok(starter.includes('Write-Host "WAG_STALE_PID_CLEARED=launcher-$value"'));
  assert.doesNotMatch(starter, /Write-Output ['\"]WAG_STALE_PID_CLEARED=/);
  assert.match(starter, /-EnsureDevSpaceOnly/);
  assert.match(starter, /WAG_LOCAL_RECOVERY=DEVSPACE_REPAIRED/);
  assert.match(starter, /WAG_DEVSPACE_REPAIR_TIMEOUT/);
  assert.match(starter, /RedirectStandardOutput \$repairStdout/);
  assert.match(starter, /WAG_START_TIMEOUT/);
  assert.match(starter, /Stop-Process -Id \$process\.Id -Force/);
  assert.match(starter, /WAG_LOCAL_LAUNCHER_TIMEOUT_CLEANUP/);
});

test('installer wires user-login autostart to the recovery supervisor', () => {
  assert.match(installer, /GetFolderPath\('Startup'\)/);
  assert.match(installer, /WAG Local\.lnk/);
  assert.match(installer, /Start-WagLocalSupervisor\.ps1/);
  assert.match(installer, /WScript\.Shell/);
});

test('supervisor is single-instance and invokes the idempotent starter', () => {
  assert.match(supervisor, /WAG-Local-Supervisor-v1/);
  assert.match(supervisor, /Start-WagLocal\.ps1/);
  assert.match(supervisor, /WAG_SUPERVISOR_RECOVERY_OK/);
  assert.match(supervisor, /127\.0\.0\.1:8080\/readyz/);
  assert.match(supervisor, /127\.0\.0\.1:7677\/\.well-known\/oauth-authorization-server/);
});

test('PowerShell launchers parse', { skip: process.platform !== 'win32' }, () => {
  for (const path of [tunnelPath, starterPath, installerPath, supervisorPath, recoveryPath, rebootPreparePath, rebootVerifyPath, setupPath, m2FixturePath]) {
    const script = "$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('" +
      path.replaceAll("'", "''") +
      "',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{$_.Message};exit 1}";
    execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', script], { stdio: 'pipe' });
  }
});
