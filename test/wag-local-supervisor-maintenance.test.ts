import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

const SCRIPT = resolve('scripts/wag-local-supervisor.ps1');

test('WAG local supervisor acknowledges maintenance lease and skips recovery', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows supervisor acceptance');
    return;
  }

  const localAppData = await mkdtemp(join(tmpdir(), 'wag-supervisor-maintenance-'));
  t.after(() => rm(localAppData, { recursive: true, force: true }));

  const base = join(localAppData, 'WAG-Local');
  const state = join(base, 'state');
  const logs = join(base, 'logs');
  await mkdir(state, { recursive: true });
  await mkdir(logs, { recursive: true });
  await writeFile(join(base, 'Start-WagLocal.ps1'), "throw 'starter must not run during maintenance'\n", 'utf8');

  const leaseId = 'maint_00000000-0000-4000-8000-000000000001';
  await writeFile(join(state, 'maintenance-v1.json'), JSON.stringify({
    schema: 'WAG_LOCAL_MAINTENANCE_V1',
    leaseId,
    sourceHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    issuedAtUtc: new Date().toISOString(),
    expiresAtUtc: new Date(Date.now() + 60_000).toISOString(),
  }, null, 2) + '\n', 'utf8');

  const run = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-PollSeconds', '1',
    '-RecoveryTimeoutSeconds', '5',
    '-Once',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /WAG_SUPERVISOR_MAINTENANCE=True/);
  assert.doesNotMatch(run.stdout, /WAG_SUPERVISOR_RECOVERY=/);

  const ack = JSON.parse(await readFile(join(state, 'maintenance-v1.ack.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(ack.schema, 'WAG_LOCAL_MAINTENANCE_ACK_V1');
  assert.equal(ack.leaseId, leaseId);
  assert.ok(Number.isSafeInteger(ack.supervisorPid));
});
