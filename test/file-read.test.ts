import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway } from '../src/server.js';
import { startPinnedDevspace } from './devspace-fixture.js';

function expectedText(raw: string) {
  const withoutCrlf = raw.replace(/\r\n/g, '');
  const hasCrlf = raw.includes('\r\n');
  const hasLf = withoutCrlf.includes('\n');
  return {
    content: raw.replace(/\r\n/g, '\n').replace(/\n$/, ''),
    raw_sha256: createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex'),
    size_bytes: Buffer.byteLength(raw, 'utf8'),
    encoding: 'utf-8' as const,
    bom: raw.charCodeAt(0) === 0xfeff,
    newline_mode: hasCrlf && hasLf ? 'MIXED' as const : hasCrlf ? 'CRLF' as const : hasLf ? 'LF' as const : 'NONE' as const,
  };
}

test('file.read returns bounded text plus exact raw UTF-8 identity through an opaque workspace id', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), 'alpha\nbeta\n');
  const gateway = createGateway({ executor: new DevspaceExecutor(fixture), allowedRoots: [fixture.workspaceRoot] });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  const result = await gateway.readFile(workspaceId, 'note.txt');
  assert.deepEqual(result, expectedText('alpha\nbeta\n'));
  assert.equal(JSON.stringify(result).includes(fixture.workspaceRoot), false);
});

test('file.read raw identity distinguishes LF, CRLF and UTF-8 BOM bytes', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const lf = 'alpha\nbeta\n';
  const crlf = 'alpha\r\nbeta\r\n';
  const bom = '\ufeffalpha\r\nbeta\r\n';
  await writeFile(join(fixture.workspaceRoot, 'lf.txt'), lf, 'utf8');
  await writeFile(join(fixture.workspaceRoot, 'crlf.txt'), crlf, 'utf8');
  await writeFile(join(fixture.workspaceRoot, 'bom.txt'), bom, 'utf8');
  const gateway = createGateway({ executor: new DevspaceExecutor(fixture), allowedRoots: [fixture.workspaceRoot] });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  const lfRead = await gateway.readFile(workspaceId, 'lf.txt');
  const crlfRead = await gateway.readFile(workspaceId, 'crlf.txt');
  const bomRead = await gateway.readFile(workspaceId, 'bom.txt');
  assert.deepEqual(lfRead, expectedText(lf));
  assert.deepEqual(crlfRead, expectedText(crlf));
  assert.deepEqual(bomRead, expectedText(bom));
  assert.notEqual(lfRead.raw_sha256, crlfRead.raw_sha256);
  assert.notEqual(crlfRead.raw_sha256, bomRead.raw_sha256);
  assert.equal(lfRead.newline_mode, 'LF');
  assert.equal(crlfRead.newline_mode, 'CRLF');
  assert.equal(bomRead.bom, true);
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
  assert.deepEqual(await gateway.readFile(workspaceId, '.env.example'), expectedText('TOKEN=example\n'));
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
