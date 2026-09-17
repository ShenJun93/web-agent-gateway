import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DevspaceRepositoryInspectionBackend } from '../src/repository-inspection.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

test('repo.search - contract tests', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());

  await mkdir(join(fixture.workspaceRoot, 'src', 'lib'), { recursive: true });
  await mkdir(join(fixture.workspaceRoot, 'test'), { recursive: true });

  await writeFile(join(fixture.workspaceRoot, 'src', 'lib', 'ticket-id.js'), 'export function canonicalizeTicketId() {}\n');
  await writeFile(join(fixture.workspaceRoot, 'test', 'ticket-id.test.js'), 'import { canonicalizeTicketId } from "../src/lib/ticket-id.js";\n');
  await writeFile(join(fixture.workspaceRoot, 'test', 'untracked.js'), 'canonicalizeTicketId();\n');
  // Binary file simulation
  const binaryContent = Buffer.from('binary content \x00 canonicalizeTicketId', 'utf-8');
  await writeFile(join(fixture.workspaceRoot, 'test', 'binary.bin'), binaryContent);

  // Other tracked files for ordering test
  await writeFile(join(fixture.workspaceRoot, 'a.txt'), 'find_me\n');
  await writeFile(join(fixture.workspaceRoot, 'b.txt'), 'find_me\nfind_me again\n');

  await git(fixture.workspaceRoot, ['init']);
  await git(fixture.workspaceRoot, ['config', 'user.email', 'gateway@example.test']);
  await git(fixture.workspaceRoot, ['config', 'user.name', 'Gateway Test']);
  await git(fixture.workspaceRoot, ['add', 'src/lib/ticket-id.js', 'test/ticket-id.test.js', 'test/binary.bin', 'a.txt', 'b.txt']);
  await git(fixture.workspaceRoot, ['commit', '-m', 'fixture']);

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const inspection = new DevspaceRepositoryInspectionBackend(executor);
  const devspaceWorkspaceId = await executor.openWorkspace(fixture.workspaceRoot);

  await t.test('basic search match', async () => {
    const result = await inspection.search({
      devspaceWorkspaceId,
      canonicalRoot: fixture.workspaceRoot,
      query: 'canonicalizeTicketId',
      ignoreCase: false,
      maxResults: 20,
      contextLines: 1,
    });
    assert.deepEqual(result.matches.map((m) => m.path), [
      'src/lib/ticket-id.js',
      'test/ticket-id.test.js',
    ]);
    assert.equal(result.truncated, false);
  });

  await t.test('no-match success', async () => {
    const result = await inspection.search({
      devspaceWorkspaceId,
      canonicalRoot: fixture.workspaceRoot,
      query: 'does_not_exist_in_repo',
      ignoreCase: false,
      maxResults: 20,
      contextLines: 1,
    });
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncated, false);
  });

  await t.test('deterministic ordering', async () => {
    const result = await inspection.search({
      devspaceWorkspaceId,
      canonicalRoot: fixture.workspaceRoot,
      query: 'find_me',
      ignoreCase: false,
      maxResults: 20,
      contextLines: 0,
    });
    assert.deepEqual(result.matches.map(m => `${m.path}:${m.line}`), [
      'a.txt:1',
      'b.txt:1',
      'b.txt:2',
    ]);
  });

  await t.test('maxResults=1 truncation', async () => {
    const result = await inspection.search({
      devspaceWorkspaceId,
      canonicalRoot: fixture.workspaceRoot,
      query: 'find_me',
      ignoreCase: false,
      maxResults: 1,
      contextLines: 0,
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.truncated, true);
  });

  await t.test('total output size bounding', async () => {
    await writeFile(join(fixture.workspaceRoot, 'large.txt'), Array(100).fill('large_match_pattern ' + 'x'.repeat(1000)).join('\n'));
    await git(fixture.workspaceRoot, ['add', 'large.txt']);
    await git(fixture.workspaceRoot, ['commit', '-m', 'add large file']);
    const result = await inspection.search({
      devspaceWorkspaceId,
      canonicalRoot: fixture.workspaceRoot,
      query: 'large_match_pattern',
      ignoreCase: false,
      maxResults: 50,
      contextLines: 1,
    });
    const size = Buffer.byteLength(JSON.stringify(result), 'utf-8');
    assert.ok(size <= 65536, `Output size ${size} exceeds 64KiB bound`);
  });
});

test('repo.search - security tests', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());

  const siblingMarkerPath = join(fixture.workspaceRoot, '..', 'marker.txt');
  await writeFile(siblingMarkerPath, 'marker\n');

  await writeFile(join(fixture.workspaceRoot, '.env.local'), 'SECRET=find_me_if_you_can\n');
  await mkdir(join(fixture.workspaceRoot, '.git-adjacent'), { recursive: true });
  await writeFile(join(fixture.workspaceRoot, '.git-adjacent', 'secret.txt'), 'find_me_if_you_can\n');

  await git(fixture.workspaceRoot, ['init']);
  await git(fixture.workspaceRoot, ['config', 'user.email', 'gateway@example.test']);
  await git(fixture.workspaceRoot, ['config', 'user.name', 'Gateway Test']);
  await git(fixture.workspaceRoot, ['add', '.env.local', '.git-adjacent/secret.txt']);
  await git(fixture.workspaceRoot, ['commit', '-m', 'secrets']);

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const inspection = new DevspaceRepositoryInspectionBackend(executor);
  const devspaceWorkspaceId = await executor.openWorkspace(fixture.workspaceRoot);

  await t.test('literal-query execution injection resistance', async () => {
    const maliciousQueries = [
      `'; touch ../marker.txt; echo '`,
      `" && echo foo > ../marker.txt && echo "`,
      `| echo > ../marker.txt`,
      `$(touch ../marker.txt)`,
      `\`touch ../marker.txt\``,
      `& touch ../marker.txt`,
    ];

    for (const query of maliciousQueries) {
      await inspection.search({
        devspaceWorkspaceId,
        canonicalRoot: fixture.workspaceRoot,
        query,
        ignoreCase: false,
        maxResults: 20,
        contextLines: 1,
      });
      // Assert marker file was not modified
      const content = await readFile(siblingMarkerPath, 'utf-8');
      assert.equal(content, 'marker\n', `Marker file was modified by query: ${query}`);
    }
  });

  await t.test('sensitive path exclusion', async () => {
    const result = await inspection.search({
      devspaceWorkspaceId,
      canonicalRoot: fixture.workspaceRoot,
      query: 'find_me_if_you_can',
      ignoreCase: false,
      maxResults: 20,
      contextLines: 1,
    });
    // .env.local should be blocked by validateReadPath.
    // What about .git-adjacent? The policy might not block it, but .env.local is definitely blocked.
    assert.deepEqual(result.matches.filter(m => m.path === '.env.local'), []);
  });
});
