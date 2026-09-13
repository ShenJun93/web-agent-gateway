import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway } from '../src/server.js';
import { startPinnedDevspace } from './devspace-fixture.js';

test('file.read returns bounded text through an opaque workspace id', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), 'alpha\nbeta\n');
  const gateway = createGateway({ executor: new DevspaceExecutor(fixture), allowedRoots: [fixture.workspaceRoot] });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  const result = await gateway.readFile(workspaceId, 'note.txt');
  assert.deepEqual(result, { content: 'alpha\nbeta' });
  assert.equal(JSON.stringify(result).includes(fixture.workspaceRoot), false);
});

test('file.read rejects non-relative and sensitive workspace paths before returning data', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, '.ssh'), '').catch(() => undefined);
  await writeFile(join(fixture.workspaceRoot, '.env'), 'TOKEN=secret\n');
  await writeFile(join(fixture.workspaceRoot, '.npmrc'), '//registry.example/:_authToken=secret\n');
  await writeFile(join(fixture.workspaceRoot, '.env.example'), 'TOKEN=example\n');
  const gateway = createGateway({ executor: new DevspaceExecutor(fixture), allowedRoots: [fixture.workspaceRoot] });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  await assert.rejects(gateway.readFile(workspaceId, '../outside.txt'), /Gateway denied workspace-relative path/);
  await assert.rejects(gateway.readFile(workspaceId, 'C:\\Windows\\win.ini'), /Gateway denied workspace-relative path/);
  await assert.rejects(gateway.readFile(workspaceId, '.'), /Gateway denied workspace-relative path/);
  await assert.rejects(gateway.readFile(workspaceId, './'), /Gateway denied workspace-relative path/);
  await assert.rejects(gateway.readFile(workspaceId, '.ssh/id_rsa'), /Gateway denied sensitive path/);
  await assert.rejects(gateway.readFile(workspaceId, '.env'), /Gateway denied sensitive path/);
  await assert.rejects(gateway.readFile(workspaceId, '.env.local'), /Gateway denied sensitive path/);
  await assert.rejects(gateway.readFile(workspaceId, '.npmrc'), /Gateway denied sensitive path/);
  await assert.rejects(gateway.readFile(workspaceId, '.git/config'), /Gateway denied sensitive path/);
  assert.deepEqual(await gateway.readFile(workspaceId, '.env.example'), { content: 'TOKEN=example' });
});

test('file.read rejects binary and oversized executor output', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'binary.txt'), Buffer.from([65, 0, 66]));
  await writeFile(join(fixture.workspaceRoot, 'large.txt'), 'x'.repeat(70_000));
  const gateway = createGateway({ executor: new DevspaceExecutor(fixture), allowedRoots: [fixture.workspaceRoot] });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  await assert.rejects(gateway.readFile(workspaceId, 'binary.txt'), /Gateway rejected binary content/);
  await assert.rejects(gateway.readFile(workspaceId, 'large.txt'), /Gateway rejected oversized content/);
});
