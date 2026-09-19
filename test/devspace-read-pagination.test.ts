import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DevspaceFileMutationBackend } from '../src/executor/devspace-file-mutation.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { DevspaceRepositoryInspectionBackend } from '../src/repository-inspection.js';
import { AdmittedWorkspaceService } from '../src/admitted-workspace.js';
import { createGateway } from '../src/server.js';
import { startPinnedDevspace } from './devspace-fixture.js';

/**
 * DevSpace's `read` tool emits three different continuation footers (pinned pi-coding-agent
 * 0.80.3, core/tools/read.js:214-242):
 *
 *   1 "[Line N is …, exceeds 50.0KB limit. Use bash: …]"          first line alone too large
 *   2 "[Showing lines A-B of T (50.0KB limit). Use offset=N …]"   byte truncation
 *   3 "[Showing lines A-B of T. Use offset=N to continue.]"       line truncation
 *   4 "[K more lines in file. Use offset=N to continue.]"         caller limit stopped early
 *
 * The gateway always requests limit=2000, which is also pi's line cap, so shape 4 is what a
 * file longer than 2000 lines actually produces. These tests pin every read path to complete,
 * footer-free content.
 */

const LINE_COUNT = 2_500;

function longFileContent(): string {
  const lines: string[] = [];
  for (let index = 1; index <= LINE_COUNT; index += 1) lines.push(`line ${index}`);
  return `${lines.join('\n')}\n`;
}

test('every read path returns complete content for a file longer than one executor page', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const content = longFileContent();
  await writeFile(join(fixture.workspaceRoot, 'long.txt'), content, 'utf8');

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const expected = content.replace(/\n$/, '');

  // Raw executor output proves the footer this fixture actually produces, so a future
  // upstream wording change fails loudly here instead of silently corrupting content.
  const rawPage = await executor.readFile(await executor.openWorkspace(fixture.workspaceRoot), 'long.txt', undefined, 2000);
  assert.match(rawPage, /\n\n\[[^\]]*Use offset=\d+ to continue\.\]$/,
    'the pinned executor must still signal continuation for a 2500-line file');

  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot], verifyProfiles: {} });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);
  const read = await gateway.readFile(workspaceId, 'long.txt');
  assert.equal(read.content, expected, 'file.read must return the whole file, not one page');
  assert.doesNotMatch(read.content, /Use offset=\d+ to continue/,
    'a continuation footer must never be returned as file content');

  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());
  const caller = createGatewayCallerContext({
    ownerId: 'owner_read', sessionId: 'session_read', adapterId: 'adapter_read',
  });
  const admitted = new AdmittedWorkspaceService({
    store,
    executor,
    inspection: new DevspaceRepositoryInspectionBackend(executor),
    allowedRoots: [fixture.workspaceRoot],
    now: () => Date.now(),
  });
  const opened = await admitted.open(caller, fixture.workspaceRoot);
  const admittedRead = await admitted.read(caller, opened.workspaceId, 'long.txt');
  assert.equal(admittedRead.content, expected, 'the admitted read path must paginate identically');

  const backend = new DevspaceFileMutationBackend(executor);
  const exact = await backend.readExact(fixture.workspaceRoot, 'long.txt');
  assert.equal(exact, content, 'readExact must reproduce the file byte-for-byte including the trailing newline');
  assert.equal(
    createHash('sha256').update(exact, 'utf8').digest('hex'),
    createHash('sha256').update(content, 'utf8').digest('hex'),
  );
});

test('a bounded mutation succeeds on a file longer than one executor page', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const content = longFileContent();
  await writeFile(join(fixture.workspaceRoot, 'long.txt'), content, 'utf8');

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const backend = new DevspaceFileMutationBackend(executor);
  const candidate = content.replace('line 2400', 'line 2400 patched');

  await backend.updateExisting(fixture.workspaceRoot, 'long.txt', content, candidate);

  const after = await backend.readExact(fixture.workspaceRoot, 'long.txt');
  assert.equal(after, candidate, 'the write must land exactly, past the first executor page');
});

test('oversized content is still refused rather than silently truncated', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  // ~96 KiB across 1200 lines: over the gateway's 64 KiB ceiling, under pi's line cap.
  const oversized = `${Array.from({ length: 1_200 }, () => 'x'.repeat(80)).join('\n')}\n`;
  await writeFile(join(fixture.workspaceRoot, 'oversized.txt'), oversized, 'utf8');

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot], verifyProfiles: {} });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  await assert.rejects(() => gateway.readFile(workspaceId, 'oversized.txt'), /oversized content/i);
  await assert.rejects(
    () => new DevspaceFileMutationBackend(executor).readExact(fixture.workspaceRoot, 'oversized.txt'),
    /64 KiB|oversized/i,
  );
});
