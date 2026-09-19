import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { DevspaceRepositoryInspectionBackend } from '../src/repository-inspection.js';
import { createGateway } from '../src/server.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

/**
 * Builds a small repository with tracked, untracked, ignored and nested content so listing
 * and diffing can be pinned against known-correct expectations.
 */
async function repositoryFixture(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'lib'), { recursive: true });
  await mkdir(join(root, 'src', 'empty-ignored'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });

  await writeFile(join(root, '.gitignore'), 'ignored.txt\nsrc/empty-ignored/\n');
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await writeFile(join(root, 'src', 'index.js'), 'export const value = 1;\n');
  await writeFile(join(root, 'src', 'lib', 'helper.js'), 'export const helper = 2;\n');
  await writeFile(join(root, 'docs', 'note.md'), 'note\n');
  await writeFile(join(root, 'src', 'empty-ignored', 'skip.txt'), 'skip\n');

  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.email', 'gateway@example.test']);
  await git(root, ['config', 'user.name', 'Gateway Test']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'fixture']);

  // Post-commit working-tree state: one modification, one untracked, one ignored.
  await writeFile(join(root, 'src', 'index.js'), 'export const value = 2;\n');
  await writeFile(join(root, 'src', 'untracked.js'), 'export const fresh = 3;\n');
  await writeFile(join(root, 'ignored.txt'), 'must never be listed\n');
}

test('repo.list reports immediate entries, honours gitignore, and stays bounded', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await repositoryFixture(fixture.workspaceRoot);

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot], verifyProfiles: {} });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  const root = await gateway.repoList(workspaceId);
  assert.equal(root.path, '');
  assert.equal(root.truncated, false);
  // Directories first, then files, each alphabetical.
  assert.deepEqual(root.entries.map((entry) => `${entry.type === 'directory' ? 'd' : 'f'} ${entry.name}`), [
    'd docs', 'd src', 'f .gitignore', 'f README.md',
  ]);
  assert.equal(root.entries.some((entry) => entry.name === 'ignored.txt'), false,
    'an ignored file must never be listed');
  assert.equal(root.entries.some((entry) => entry.name === 'empty-ignored'), false,
    'an ignored directory must never be listed');

  const src = await gateway.repoList(workspaceId, { path: 'src' });
  assert.equal(src.path, 'src');
  assert.deepEqual(src.entries, [
    { name: 'lib', type: 'directory', tracked: true },
    { name: 'index.js', type: 'file', tracked: true },
    { name: 'untracked.js', type: 'file', tracked: false },
  ]);

  const bounded = await gateway.repoList(workspaceId, { maxEntries: 2 });
  assert.equal(bounded.entries.length, 2);
  assert.equal(bounded.truncated, true);

  // Trailing separators and a leading ./ address the same subtree.
  assert.deepEqual((await gateway.repoList(workspaceId, { path: 'src/' })).entries, src.entries);
  assert.deepEqual((await gateway.repoList(workspaceId, { path: './src' })).entries, src.entries);
});

test('repo.diff returns the bounded working-tree diff against HEAD', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await repositoryFixture(fixture.workspaceRoot);

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot], verifyProfiles: {} });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  const whole = await gateway.repoDiff(workspaceId);
  assert.equal(whole.path, '');
  assert.equal(whole.truncated, false);
  assert.match(whole.diff, /diff --git a\/src\/index\.js b\/src\/index\.js/);
  assert.match(whole.diff, /-export const value = 1;/);
  assert.match(whole.diff, /\+export const value = 2;/);
  assert.equal(whole.diff.includes('untracked.js'), false,
    'an untracked file is not part of a diff against HEAD');
  assert.equal(whole.diff.includes('must never be listed'), false);

  const scoped = await gateway.repoDiff(workspaceId, { path: 'docs' });
  assert.equal(scoped.path, 'docs');
  assert.equal(scoped.diff, '', 'an unchanged subtree produces an empty diff');
});

test('repo.list and repo.diff refuse to address anything outside the workspace', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await repositoryFixture(fixture.workspaceRoot);

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot], verifyProfiles: {} });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  const escapes = ['..', '../..', '../outside', 'src/../..', '/etc', 'C:\\Windows', '.git', 'src/.git'];
  for (const path of escapes) {
    await assert.rejects(() => gateway.repoList(workspaceId, { path }), `repo.list must deny ${path}`);
    await assert.rejects(() => gateway.repoDiff(workspaceId, { path }), `repo.diff must deny ${path}`);
  }

  await assert.rejects(() => gateway.repoList('ws_not_real'), /Unknown workspace_id/);
  await assert.rejects(() => gateway.repoDiff('ws_not_real'), /Unknown workspace_id/);
});

test('a path that would be a shell metacharacter reaches git as one argument', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await repositoryFixture(fixture.workspaceRoot);
  // A directory whose name would break naive shell interpolation on cmd.exe. The injected
  // command writes a uniquely named marker file, so a successful injection is observable.
  // Legal on NTFS (no reserved character, no trailing space) yet full of cmd.exe syntax.
  const hostile = 'a & copy nul injected-marker.txt & rem x';
  await mkdir(join(fixture.workspaceRoot, hostile), { recursive: true });
  await writeFile(join(fixture.workspaceRoot, hostile, 'inside.txt'), 'inside\n');

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot], verifyProfiles: {} });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  const listed = await gateway.repoList(workspaceId, { path: hostile });
  assert.deepEqual(listed.entries, [{ name: 'inside.txt', type: 'file', tracked: false }],
    'the hostile name must be one argv element, so the subtree lists normally');
  assert.equal(listed.path, hostile);

  const root = await gateway.repoList(workspaceId);
  assert.equal(root.entries.some((entry) => entry.name === 'injected-marker.txt'), false,
    'no shell interpolation may have executed the embedded command');
  await assert.rejects(
    () => gateway.readFile(workspaceId, 'injected-marker.txt'),
    'the injected command must not have created a file',
  );
});

test('a file name that mimics executor framing cannot suppress listing output', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await repositoryFixture(fixture.workspaceRoot);
  // The list payload is NUL-separated with no newlines, so an unanchored status-line strip
  // would delete this record and every record sorted after it.
  await writeFile(join(fixture.workspaceRoot, 'Process exited with code 0.txt'), 'decoy\n');
  await git(fixture.workspaceRoot, ['add', 'Process exited with code 0.txt']);

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot], verifyProfiles: {} });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  const listed = await gateway.repoList(workspaceId);
  const names = listed.entries.map((entry) => entry.name);
  assert.ok(names.includes('Process exited with code 0.txt'), 'the decoy itself must be listed');
  for (const expected of ['docs', 'src', '.gitignore', 'README.md']) {
    assert.ok(names.includes(expected), `${expected} must survive a decoy file name`);
  }
  assert.equal(listed.truncated, false);
});

test('repo.diff withholds the bodies of files the path policy protects', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await repositoryFixture(fixture.workspaceRoot);
  await writeFile(join(fixture.workspaceRoot, '.env'), 'AWS_SECRET=placeholder-one\n');
  await writeFile(join(fixture.workspaceRoot, '.npmrc'), '//registry.example/:_authToken=placeholder-two\n');
  await git(fixture.workspaceRoot, ['add', '-f', '.env', '.npmrc']);
  await git(fixture.workspaceRoot, ['commit', '-m', 'sensitive']);
  await writeFile(join(fixture.workspaceRoot, '.env'), 'AWS_SECRET=placeholder-three\n');
  await writeFile(join(fixture.workspaceRoot, '.npmrc'), '//registry.example/:_authToken=placeholder-four\n');

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot], verifyProfiles: {} });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  const whole = await gateway.repoDiff(workspaceId);
  for (const secret of ['placeholder-one', 'placeholder-two', 'placeholder-three', 'placeholder-four']) {
    assert.equal(whole.diff.includes(secret), false, `repo.diff must not return ${secret}`);
  }
  assert.equal(whole.diff.includes('diff --git a/.env'), false);
  assert.equal(whole.diff.includes('diff --git a/.npmrc'), false);
  assert.equal(whole.truncated, true, 'withholding a section must be reported, not silent');
  assert.match(whole.diff, /diff --git a\/src\/index\.js/, 'ordinary files are still returned');

  // Addressing a sensitive path directly is denied outright.
  await assert.rejects(() => gateway.repoDiff(workspaceId, { path: '.env' }), /sensitive|denied/i);
});

test('a prefix that looks absolute fails closed instead of widening to the whole workspace', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await repositoryFixture(fixture.workspaceRoot);

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const gateway = createGateway({ executor, allowedRoots: [fixture.workspaceRoot], verifyProfiles: {} });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);

  for (const path of ['/', '//', '\\', './/', '\\\\']) {
    await assert.rejects(() => gateway.repoList(workspaceId, { path }),
      `repo.list must deny ${JSON.stringify(path)} rather than list everything`);
    await assert.rejects(() => gateway.repoDiff(workspaceId, { path }),
      `repo.diff must deny ${JSON.stringify(path)} rather than diff everything`);
  }
});

test('inspection failures surface as bounded tool errors', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  // No git repository here at all, so both helpers must fail closed rather than hang.
  await writeFile(join(fixture.workspaceRoot, 'loose.txt'), 'loose\n');

  const executor = new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken });
  const backend = new DevspaceRepositoryInspectionBackend(executor);
  const devspaceWorkspaceId = await executor.openWorkspace(fixture.workspaceRoot);

  await assert.rejects(() => backend.list(devspaceWorkspaceId), /repo\.list command failed/);
  await assert.rejects(() => backend.diff(devspaceWorkspaceId), /repo\.diff command failed/);
});
