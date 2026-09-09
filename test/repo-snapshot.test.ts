import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createGateway } from '../src/server.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);

test('repo.snapshot aggregates git state and deterministically prunes file output', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(join(fixture.workspaceRoot, name), `${name}\n`);
  await git(fixture.workspaceRoot, ['init']);
  await git(fixture.workspaceRoot, ['config', 'user.email', 'gateway@example.test']);
  await git(fixture.workspaceRoot, ['config', 'user.name', 'Gateway Test']);
  await git(fixture.workspaceRoot, ['add', '.']);
  await git(fixture.workspaceRoot, ['commit', '-m', 'fixture']);
  await writeFile(join(fixture.workspaceRoot, 'b.txt'), 'modified\n');

  const gateway = createGateway({ executor: new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken }) });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);
  const snapshot = await gateway.repoSnapshot(workspaceId, { maxFiles: 2 });

  assert.equal(snapshot.files.length, 2);
  assert.deepEqual(snapshot.files, ['a.txt', 'b.txt']);
  assert.equal(snapshot.filesTruncated, true);
  assert.equal(snapshot.dirty, true);
  assert.match(snapshot.head, /^[a-f0-9]{40}$/);
  assert.equal(JSON.stringify(snapshot).includes(fixture.workspaceRoot), false);
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}
