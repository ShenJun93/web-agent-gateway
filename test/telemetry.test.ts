import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway } from '../src/server.js';
import { MemoryTelemetry } from '../src/telemetry.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);

test('all semantic operations emit correlation and phase latency telemetry without path data', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), 'telemetry\n');
  await writeFile(join(fixture.workspaceRoot, 'verify.mjs'), 'console.log("verified")\n');
  await git(fixture.workspaceRoot, ['init']);
  await git(fixture.workspaceRoot, ['config', 'user.email', 'gateway@example.test']);
  await git(fixture.workspaceRoot, ['config', 'user.name', 'Gateway Test']);
  await git(fixture.workspaceRoot, ['add', '.']);
  await git(fixture.workspaceRoot, ['commit', '-m', 'fixture']);

  const telemetry = new MemoryTelemetry();
  const gateway = createGateway({ executor: new DevspaceExecutor(fixture), allowedRoots: [fixture.workspaceRoot], telemetry, verifyProfiles: { test: { argv: ['node', 'verify.mjs'] } } });
  await gateway.health();
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);
  await gateway.readFile(workspaceId, 'note.txt');
  await gateway.verifyRun(workspaceId, 'test');
  await gateway.repoSnapshot(workspaceId, { maxFiles: 10 });

  const events = telemetry.snapshot();
  assert.deepEqual(events.map((entry) => entry.tool), [
    'health', 'workspace.open', 'file.read', 'verify.run', 'repo.snapshot',
  ]);
  for (const event of events) {
    assert.match(event.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(event.success, true);
    for (const key of ['ingressMs', 'policyMs', 'executorMs', 'aggregationMs', 'totalMs'] as const) assert.ok(event[key] >= 0);
    assert.ok(event.executorMs > 0);
    assert.ok(event.totalMs >= event.executorMs);
    assert.equal(JSON.stringify(event).includes(fixture.workspaceRoot), false);
    assert.equal('path' in event, false);
  }
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}
