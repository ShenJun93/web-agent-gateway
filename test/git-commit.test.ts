import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext, type GatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DevspaceGitCommitBackend } from '../src/executor/devspace-git-commit.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';
import { PRIVATE_STDIO_ADAPTER_ID } from '../src/repository-engineering-runtime.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/**
 * Builds a repository that is hostile in every way the commit path must survive: hooks in both
 * locations, a dirty real index, unrelated dirty files, and awkward filenames.
 */
async function hostileRepository(
  root: string,
  canaryDir: string,
  objectFormat: 'sha1' | 'sha256' = 'sha1',
): Promise<void> {
  await writeFile(join(root, 'tracked.txt'), 'original\n');
  await writeFile(join(root, 'unrelated.txt'), 'unrelated original\n');
  await writeFile(join(root, 'staged.txt'), 'staged original\n');
  await git(root, ['init', '--object-format=' + objectFormat, '--initial-branch=work', '.']);
  await git(root, ['config', 'user.email', 'wag@example.invalid']);
  await git(root, ['config', 'user.name', 'WAG Test']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base']);

  // Dirty real index plus an unrelated dirty worktree file, both of which must survive.
  await writeFile(join(root, 'staged.txt'), 'staged modified\n');
  await git(root, ['add', 'staged.txt']);
  await writeFile(join(root, 'unrelated.txt'), 'unrelated modified\n');

  // Hooks are installed LAST, after the fixture's own porcelain git calls. Those calls legitimately
  // fire post-index-change, so installing earlier would arm the canary before WAG ran and make the
  // evidence meaningless. The set is every hook plumbing can reach, not just the porcelain four:
  // post-index-change fires on any index write and reference-transaction on any ref update.
  for (const location of [join(root, '.git', 'hooks'), join(canaryDir, 'evil-hooks')]) {
    await mkdir(location, { recursive: true });
    for (const hook of [
      'pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
      'post-index-change', 'reference-transaction', 'pre-applypatch', 'post-checkout',
      'post-rewrite', 'pre-auto-gc', 'push-to-checkout',
    ]) {
      const file = join(location, hook);
      await writeFile(file, `#!/bin/sh\necho FIRED-${hook} >> "${canaryDir.replace(/\\/g, '/')}/canary.txt"\nexit 0\n`);
      await chmod(file, 0o755);
    }
  }
  await git(root, ['config', 'core.hooksPath', join(canaryDir, 'evil-hooks').replace(/\\/g, '/')]);
}

function caller(sessionId = 'sid_commit'): GatewayCallerContext {
  return createGatewayCallerContext({
    ownerId: 'local.private.stdio', sessionId, adapterId: PRIVATE_STDIO_ADAPTER_ID,
  });
}

async function fixture(
  t: test.TestContext,
  options: { protectedBranches?: string[]; objectFormat?: 'sha1' | 'sha256' } = {},
) {
  const canaryDir = await mkdtemp(join(tmpdir(), 'wag-commit-canary-'));
  const devspace = await startPinnedDevspace();
  const root = devspace.workspaceRoot;
  await hostileRepository(root, canaryDir, options.objectFormat ?? 'sha1');

  const store = new SqliteDurableStore(':memory:');
  t.after(async () => {
    store.close();
    await devspace.stop();
    await rm(canaryDir, { recursive: true, force: true });
  });

  const executor = new DevspaceExecutor({ baseUrl: devspace.baseUrl, accessToken: devspace.accessToken });
  const context = caller();
  const workspace = store.openWorkspaceRecord({
    ownerId: context.ownerId, sessionId: context.sessionId, adapterId: context.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: Date.now(),
  });
  const coordinator = new DurableCommitCoordinator({
    store,
    backend: new DevspaceGitCommitBackend(executor),
    protectedBranches: options.protectedBranches ?? ['main', 'master'],
  });
  return { root, canaryDir, store, executor, context, workspaceId: workspace.workspaceId, coordinator };
}

/** Hook classes the execution backend itself triggers; never a commit hook. */
const BACKEND_HOOKS = /FIRED-(?:post-index-change|reference-transaction)\r?\n/g;

async function realIndexTree(root: string): Promise<string> {
  return git(root, ['write-tree']);
}

test('a reviewed commit lands exactly one single-parent commit and runs no hook', async (t) => {
  const { root, canaryDir, context, workspaceId, coordinator } = await fixture(t);
  const indexBefore = await realIndexTree(root);
  const oldHead = await git(root, ['rev-parse', 'HEAD']);

  await writeFile(join(root, 'tracked.txt'), 'committed by wag\n');
  const message = 'hostile $(touch "' + canaryDir.replace(/\\/g, '/') + '/injected.txt") `id` ; rm -rf /\n\nsecond line\n';

  // The harness's own porcelain git calls legitimately fire post-index-change, so the canary is
  // cleared here: everything after this line is WAG's doing and nothing else's.
  await rm(join(canaryDir, 'canary.txt'), { force: true });
  const preview = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message });

  assert.equal(preview.status, 'approval_required');
  assert.equal(preview.branch, 'work');
  assert.equal(preview.oldHead, oldHead);
  assert.deepEqual(preview.paths, ['tracked.txt']);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), oldHead, 'a proposal must not commit');

  assert.equal(await coordinator.approveLocal(preview.commitId), true);
  const view = coordinator.result(context, preview.commitId);
  assert.equal(view.state, 'SUCCEEDED');
  assert.match(view.commit!, /^[0-9a-f]{40}$/);

  assert.equal(await git(root, ['rev-parse', 'HEAD']), view.commit);
  assert.equal(await git(root, ['rev-parse', 'HEAD^']), oldHead, 'exactly one parent, the approved HEAD');
  assert.equal(await git(root, ['rev-parse', 'HEAD^{tree}']), preview.treeSha);
  assert.equal(await git(root, ['show', '-s', '--format=%B', 'HEAD']).then((value) => value.trim()), message.trim(),
    'the hostile message is stored verbatim as data');
  assert.equal(await git(root, ['show', 'HEAD:tracked.txt']), 'committed by wag');

  // Only the backend's own index/ref notifications may appear; see the attribution test below.
  // No commit hook — the class that can block, rewrite or run alongside a commit — may fire.
  const firedHooks = await readFile(join(canaryDir, 'canary.txt'), 'utf8').catch(() => '');
  assert.equal(firedHooks.replace(BACKEND_HOOKS, ''), '',
    `no commit hook may execute, saw: ${firedHooks}`);
  await assert.rejects(() => readFile(join(canaryDir, 'injected.txt'), 'utf8'),
    'the message must never be interpreted as shell syntax');
  assert.equal(await realIndexTree(root), indexBefore, 'the real index must be untouched');
  assert.equal(await git(root, ['status', '--porcelain', '--', 'unrelated.txt']), 'M unrelated.txt',
    'an unrelated dirty file must remain dirty');
});

/**
 * Attributes every hook invocation that survives.
 *
 * WAG pins `core.hooksPath` to an empty directory on each of its own git calls, so its commit
 * path runs none. Opening the workspace is the execution backend's operation, made through its
 * MCP tool, and it writes its own review refs — WAG cannot pass git options into it. So the only
 * hooks that can fire are the index/ref notification hooks the backend triggers, never a commit
 * hook that could block, rewrite or execute alongside the commit.
 */
test('every surviving hook invocation belongs to the backend, never to the commit path', async (t) => {
  const { root, canaryDir, executor, context, workspaceId, coordinator } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'attribution\n');

  await rm(join(canaryDir, 'canary.txt'), { force: true });
  await executor.openWorkspace(root);
  const fromOpen = await readFile(join(canaryDir, 'canary.txt'), 'utf8').catch(() => '');
  assert.match(fromOpen, /FIRED-(post-index-change|reference-transaction)/,
    'the backend workspace open is itself a source of hook invocations');

  for (const phase of ['plan', 'commit'] as const) {
    await rm(join(canaryDir, 'canary.txt'), { force: true });
    const preview = phase === 'plan'
      ? await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'attribution' })
      : undefined;
    if (preview) assert.equal(preview.status, 'approval_required');
    else {
      await writeFile(join(root, 'tracked.txt'), 'attribution two\n');
      const second = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'two' });
      await rm(join(canaryDir, 'canary.txt'), { force: true });
      assert.equal(await coordinator.approveLocal(second.commitId), true);
    }
    const fired = await readFile(join(canaryDir, 'canary.txt'), 'utf8').catch(() => '');
    assert.equal(fired.replace(BACKEND_HOOKS, ''), '',
      `${phase} must fire no hook beyond the backend's own index/ref notifications, saw: ${fired}`);
  }
});

test('only the selected paths are committed, even with other changes pending', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'selected change\n');
  await writeFile(join(root, 'newfile.txt'), 'new and selected\n');

  const preview = await coordinator.preview(context, workspaceId, {
    paths: ['newfile.txt'], message: 'add only the new file',
  });
  assert.equal(await coordinator.approveLocal(preview.commitId), true);

  assert.equal(await git(root, ['show', 'HEAD:newfile.txt']), 'new and selected');
  assert.equal(await git(root, ['show', 'HEAD:tracked.txt']), 'original',
    'an unselected modified file keeps its committed content');
  assert.equal(await git(root, ['show', 'HEAD:staged.txt']), 'staged original',
    'a file staged in the real index is not swept in');
  assert.match(await git(root, ['status', '--porcelain']), /tracked\.txt/);
});

test('awkward filenames reach git as literal single arguments', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  const names = ['-leading-dash.txt', 'has space.txt', 'brack[et].txt', "has'quote.txt", 'sub dir/nested.txt'];
  await mkdir(join(root, 'sub dir'), { recursive: true });
  for (const name of names) await writeFile(join(root, name), `content of ${name}\n`);

  const preview = await coordinator.preview(context, workspaceId, { paths: names, message: 'awkward names' });
  assert.deepEqual(preview.paths, [...names].sort(), 'paths are canonicalised and ordered');
  assert.equal(await coordinator.approveLocal(preview.commitId), true);

  for (const name of names) {
    assert.equal(await git(root, ['show', `HEAD:${name}`]), `content of ${name}`);
  }
});

test('drift between preview and approval fails closed without committing', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);

  // HEAD drift.
  await writeFile(join(root, 'tracked.txt'), 'first\n');
  const headDrift = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'first' });
  await writeFile(join(root, 'other.txt'), 'sideband\n');
  await git(root, ['add', 'other.txt']);
  await git(root, ['commit', '-m', 'sideband commit', '--no-verify']);
  const afterSideband = await git(root, ['rev-parse', 'HEAD']);
  assert.equal(await coordinator.approveLocal(headDrift.commitId), true);
  assert.equal(coordinator.result(context, headDrift.commitId).state, 'FAILED');
  assert.equal(coordinator.result(context, headDrift.commitId).errorClass, 'HEAD_DRIFT');
  assert.equal(await git(root, ['rev-parse', 'HEAD']), afterSideband, 'HEAD must not move');

  // Selected-content drift.
  await writeFile(join(root, 'tracked.txt'), 'planned\n');
  const contentDrift = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'planned' });
  await writeFile(join(root, 'tracked.txt'), 'changed after preview\n');
  assert.equal(await coordinator.approveLocal(contentDrift.commitId), true);
  assert.equal(coordinator.result(context, contentDrift.commitId).errorClass, 'CONTENT_DRIFT');
  assert.equal(await git(root, ['rev-parse', 'HEAD']), afterSideband, 'HEAD must still not move');
});

test('approval is single use and a replay commits nothing further', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'once\n');
  const preview = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'once' });

  const [first, ...rest] = await Promise.all([
    coordinator.approveLocal(preview.commitId),
    coordinator.approveLocal(preview.commitId),
    coordinator.approveLocal(preview.commitId),
  ]);
  assert.equal([first, ...rest].filter(Boolean).length, 1, 'concurrent approvals collapse to one');
  const head = await git(root, ['rev-parse', 'HEAD']);
  assert.equal(await coordinator.approveLocal(preview.commitId), false, 'a later replay is refused');
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
  assert.equal(await git(root, ['rev-list', '--count', 'HEAD']), '2', 'exactly one commit was added');
});

test('two concurrent proposals cannot both land; compare-and-swap refuses the loser', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'racer\n');
  const a = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'a' });
  await writeFile(join(root, 'newfile.txt'), 'racer b\n');
  const b = await coordinator.preview(context, workspaceId, { paths: ['newfile.txt'], message: 'b' });

  assert.equal(await coordinator.approveLocal(a.commitId), true);
  assert.equal(coordinator.result(context, a.commitId).state, 'SUCCEEDED');
  assert.equal(await coordinator.approveLocal(b.commitId), true);
  assert.equal(coordinator.result(context, b.commitId).state, 'FAILED',
    'the second proposal was bound to the old HEAD and must lose');
  assert.equal(await git(root, ['rev-list', '--count', 'HEAD']), '2');
});

test('reject and expiry are terminal and commit nothing', async (t) => {
  const { root, context, workspaceId, store, executor } = await fixture(t);
  let clock = 1_000_000;
  const coordinator = new DurableCommitCoordinator({
    store, backend: new DevspaceGitCommitBackend(executor), now: () => clock,
  });
  const head = await git(root, ['rev-parse', 'HEAD']);

  await writeFile(join(root, 'tracked.txt'), 'rejected\n');
  const rejected = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'r' });
  assert.equal(coordinator.rejectLocal(rejected.commitId), true);
  assert.equal(await coordinator.approveLocal(rejected.commitId), false);

  const expired = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'e' });
  clock += 60_001;
  assert.equal(await coordinator.approveLocal(expired.commitId), false, 'an expired proposal cannot be approved');
  assert.equal(coordinator.result(context, expired.commitId).state, 'EXPIRED');
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
});

test('a foreign caller can neither read nor influence a commit record', async (t) => {
  const { context, workspaceId, coordinator, root } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'owned\n');
  const preview = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'owned' });

  for (const foreign of [
    createGatewayCallerContext({ ownerId: 'other', sessionId: 'sid_commit', adapterId: PRIVATE_STDIO_ADAPTER_ID }),
    caller('sid_other'),
    createGatewayCallerContext({ ownerId: 'local.private.stdio', sessionId: 'sid_commit', adapterId: 'browser.chatgpt.native.verify.v3' }),
  ]) {
    assert.throws(() => coordinator.result(foreign, preview.commitId), /denied commit/);
    await assert.rejects(() => coordinator.preview(foreign, workspaceId, { paths: ['tracked.txt'], message: 'x' }));
  }
  assert.throws(() => coordinator.result(context, 'cmt_does_not_exist'), /Unknown commit_id/);
});

test('a protected branch is refused at proposal time', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t, { protectedBranches: ['work'] });
  await writeFile(join(root, 'tracked.txt'), 'protected\n');
  await assert.rejects(
    () => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'nope' }),
    /protected branch/i,
  );
  assert.equal(await git(root, ['rev-list', '--count', 'HEAD']), '1');
});

test('a detached HEAD, an in-progress merge and an empty selection are all refused', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);

  await writeFile(join(root, 'tracked.txt'), 'detached\n');
  await git(root, ['checkout', '--detach']);
  await assert.rejects(() => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'd' }),
    /DETACHED_HEAD/);
  await git(root, ['checkout', 'work']);

  await writeFile(join(root, '.git', 'MERGE_HEAD'), `${await git(root, ['rev-parse', 'HEAD'])}\n`);
  await assert.rejects(() => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'm' }),
    /OPERATION_IN_PROGRESS/);
  await rm(join(root, '.git', 'MERGE_HEAD'));

  await git(root, ['checkout', '--', 'tracked.txt']);
  await assert.rejects(() => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'empty' }),
    /NO_CHANGES_SELECTED/, 'an empty commit is impossible');
});

test('deletion, missing paths and filter attributes are refused in v1', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);

  await rm(join(root, 'tracked.txt'));
  await assert.rejects(
    () => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'delete' }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /denied missing path/i, 'a deletion request must be refused, not silently staged');
      assert.equal(message.includes(root), false, 'the refusal must not disclose the canonical root');
      return true;
    },
  );
  await git(root, ['checkout', '--', 'tracked.txt']);

  await assert.rejects(() => coordinator.preview(context, workspaceId, { paths: ['never-existed.txt'], message: 'x' }));

  await writeFile(join(root, '.gitattributes'), 'filtered.bin filter=evil\n');
  await git(root, ['config', 'filter.evil.clean', 'sh -c "exit 1"']);
  await writeFile(join(root, 'filtered.bin'), 'payload\n');
  await assert.rejects(
    () => coordinator.preview(context, workspaceId, { paths: ['filtered.bin'], message: 'f' }),
    /PATH_HAS_FILTER_ATTRIBUTE/,
  );
});

test('a directory replaced by a file cannot delete the subtree it shadows', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  await mkdir(join(root, 'lib'), { recursive: true });
  await writeFile(join(root, 'lib', 'a.js'), 'a\n');
  await writeFile(join(root, 'lib', 'b.js'), 'b\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'add lib', '--no-verify']);
  const head = await git(root, ['rev-parse', 'HEAD']);

  // `git add -- :(literal)lib` on a file named `lib` resolves the conflict by dropping lib/**.
  // Per-path guards all pass; only the resulting tree delta reveals it.
  await rm(join(root, 'lib'), { recursive: true, force: true });
  await writeFile(join(root, 'lib'), 'i am a file now\n');

  await assert.rejects(
    () => coordinator.preview(context, workspaceId, { paths: ['lib'], message: 'swap' }),
    /UNSUPPORTED_CHANGE/,
    'a change set containing a deletion must be refused',
  );
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
  assert.match(await git(root, ['ls-tree', '--name-only', '-r', 'HEAD']), /lib\/a\.js/);
});

test('the preview binds the resulting change set, not merely the requested paths', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'modified\n');
  await writeFile(join(root, 'brand-new.txt'), 'added\n');

  const preview = await coordinator.preview(context, workspaceId, {
    paths: ['tracked.txt', 'brand-new.txt'], message: 'both',
  });
  assert.deepEqual([...preview.changes].sort((a, b) => a.path.localeCompare(b.path)), [
    { status: 'A', path: 'brand-new.txt' },
    { status: 'M', path: 'tracked.txt' },
  ]);
});

test('a case-variant of a protected branch is still protected', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t, { protectedBranches: ['WORK'] });
  await writeFile(join(root, 'tracked.txt'), 'case\n');
  await assert.rejects(
    () => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'case' }),
    /protected branch/i,
    'protection must be case-folded, because a case-insensitive filesystem shares the ref',
  );
});

test('commit paths and messages are bound by the shared policy', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'policy\n');

  for (const path of ['../escape.txt', '/etc/passwd', 'C:\\Windows\\x.txt', '.git/config', '.env', 'src/../../out.txt']) {
    await assert.rejects(() => coordinator.preview(context, workspaceId, { paths: [path], message: 'p' }),
      `path ${path} must be denied`);
  }
  // Control characters are refused on every platform, because the helper parses line-oriented
  // git output and the shared path policy only screens them on Windows.
  for (const path of ['new\nline.txt', 'tab\there.txt', 'nul\u0000.txt', 'del\u007f.txt']) {
    await assert.rejects(() => coordinator.preview(context, workspaceId, { paths: [path], message: 'p' }),
      /control character|workspace-relative|unsafe/i, `path ${JSON.stringify(path)} must be denied`);
  }
  for (const message of ['', '   ', 'x'.repeat(8 * 1024 + 1), 'has\u0000nul']) {
    await assert.rejects(() => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message }),
      `message ${JSON.stringify(message.slice(0, 12))} must be denied`);
  }
  await assert.rejects(() => coordinator.preview(context, workspaceId, { paths: [], message: 'none' }));
  assert.equal(await git(root, ['rev-list', '--count', 'HEAD']), '1');
});

test('an interrupted commit is recorded as unknown rather than replayed', async (t) => {
  const { root, context, workspaceId, store, executor } = await fixture(t);
  const coordinator = new DurableCommitCoordinator({ store, backend: new DevspaceGitCommitBackend(executor) });
  await writeFile(join(root, 'tracked.txt'), 'interrupted\n');
  const preview = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'i' });

  // Simulate a process that claimed the record and then died before finishing.
  assert.ok(store.claimCommit(preview.commitId, Date.now()));
  const head = await git(root, ['rev-parse', 'HEAD']);

  const restarted = new DurableCommitCoordinator({ store, backend: new DevspaceGitCommitBackend(executor) });
  await restarted.reconcile();
  assert.equal(restarted.result(context, preview.commitId).state, 'OUTCOME_UNKNOWN');
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head, 'recovery must never replay a commit');
});

test('a sha-256 repository commits normally rather than failing on object-id length', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t, { objectFormat: 'sha256' });
  const oldHead = await git(root, ['rev-parse', 'HEAD']);
  assert.equal(oldHead.length, 64, 'the fixture must really be a sha-256 repository');

  await writeFile(join(root, 'tracked.txt'), 'sha256 change\n');
  const preview = await coordinator.preview(context, workspaceId, {
    paths: ['tracked.txt'], message: 'chore: commit in a sha-256 repository\n',
  });
  assert.equal(preview.status, 'approval_required');
  assert.equal(preview.oldHead, oldHead);

  assert.equal(await coordinator.approveLocal(preview.commitId), true);
  const view = coordinator.result(context, preview.commitId);
  assert.equal(view.state, 'SUCCEEDED');
  assert.match(view.commit!, /^[0-9a-f]{64}$/);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), view.commit);
  assert.equal(await git(root, ['rev-parse', 'HEAD^']), oldHead, 'exactly one parent');
  assert.equal(await git(root, ['show', 'HEAD:tracked.txt']), 'sha256 change');
});

/**
 * The repository owns .git/config, and core.worktree redirects every `git add` to a directory of the
 * attacker's choosing. Reproduced before this guard existed: with a decoy file in the workspace,
 * `add -- :(literal)id_rsa` staged the OUTSIDE file's bytes while statSync, check-attr and
 * diff-tree all described the innocent decoy, and the operator was shown a plain `M id_rsa`.
 */
test('a hostile core.worktree cannot redirect the commit at another directory', async (t) => {
  const { root, context, workspaceId, coordinator, canaryDir } = await fixture(t);
  const outside = join(canaryDir, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'tracked.txt'), 'SUPER SECRET KEY\n');

  const head = await git(root, ['rev-parse', 'HEAD']);
  await writeFile(join(root, 'tracked.txt'), 'harmless placeholder\n');
  await git(root, ['config', 'core.worktree', outside.replace(/\\/g, '/')]);

  await assert.rejects(
    () => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'chore: notes\n' }),
    /WORKTREE_MISMATCH/,
    'a redirected worktree must be refused, not committed from',
  );
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head, 'nothing may be committed');
});

/**
 * A workspace nested inside a larger repository: no .git write is needed, and without a
 * repository-identity assertion the commit lands on the OUTER repository's branch, carrying the
 * outer tree and bypassing the admitted authority boundary entirely.
 */
test('a workspace nested in an outer repository cannot commit to that outer repository', async (t) => {
  const { root, context, store, executor } = await fixture(t);
  const inner = join(root, 'sub', 'ws');
  await mkdir(inner, { recursive: true });
  await writeFile(join(inner, 'a.txt'), 'inner\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'add nested workspace']);
  const head = await git(root, ['rev-parse', 'HEAD']);

  // Admit only the nested directory; the enclosing repository is outside the admitted root.
  const nested = store.openWorkspaceRecord({
    ownerId: context.ownerId, sessionId: context.sessionId, adapterId: context.adapterId,
    canonicalRoot: inner, backendKind: 'devspace', createdAt: Date.now(),
  });
  const coordinator = new DurableCommitCoordinator({ store, backend: new DevspaceGitCommitBackend(executor) });

  await writeFile(join(inner, 'a.txt'), 'inner changed\n');
  await assert.rejects(
    () => coordinator.preview(context, nested.workspaceId, { paths: ['a.txt'], message: 'chore: nested\n' }),
    /WORKTREE_MISMATCH/,
    'the outer repository is not the admitted workspace',
  );
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
});

/**
 * The executor takes one bounded command string and cmd.exe refuses — rather than truncates —
 * anything over 8191 characters. An input that can never execute must be refused while proposing,
 * not after a human has approved it.
 */
test('an input too large to ever execute is refused while proposing', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'large message\n');

  // Incompressible, so neither the payload gzip nor anything else can bring it under the limit.
  const incompressible = randomBytes(6 * 1024).toString('base64');
  await assert.rejects(
    () => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: incompressible }),
    /INPUT_TOO_LARGE/,
    'the refusal must name the reason, not surface as UNKNOWN',
  );

  // The same content well under the limit still works, so the guard is a bound and not a ban.
  const preview = await coordinator.preview(context, workspaceId, {
    paths: ['tracked.txt'], message: randomBytes(512).toString('base64'),
  });
  assert.equal(preview.status, 'approval_required');
});

/**
 * user.name / user.email come from the untrusted repository. commit-tree refuses without them,
 * which would be a failure after approval, and a hostile value silently attributes the commit to
 * someone else. Both are handled at proposal time, and the author is bound and shown.
 */
test('author identity is required, bound to the preview and revalidated at approval', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'identity\n');

  // Unsetting the repository identity falls back to the operator's global one, which is
  // legitimate. An empty name is the reachable "git cannot stamp this commit" state, and
  // without this check it would surface only as a failure after approval.
  await git(root, ['config', 'user.name', '']);
  await assert.rejects(
    () => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'm\n' }),
    /IDENTITY_UNSET/,
  );

  await git(root, ['config', 'user.email', 'wag@example.invalid']);
  await git(root, ['config', 'user.name', 'WAG Test']);
  const preview = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'm\n' });
  assert.equal(preview.author, 'WAG Test <wag@example.invalid>');

  // Re-attributing the commit after the operator saw the preview is drift like any other.
  await git(root, ['config', 'user.name', 'Somebody Else']);
  assert.equal(await coordinator.approveLocal(preview.commitId), true);
  const view = coordinator.result(context, preview.commitId);
  assert.equal(view.state, 'FAILED');
  assert.equal(view.errorClass, 'AUTHOR_DRIFT');
});

/**
 * Losing sight of the helper is not the same as a refusal. The durable record is the audit
 * record, so it must not claim a clean failure for a commit that may have landed.
 */
test('an outcome the gateway cannot observe is recorded as unknown, not as failed', async (t) => {
  const { root, store, context, workspaceId, executor } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'ambiguous\n');
  const real = new DevspaceGitCommitBackend(executor);

  for (const [reason, expected] of [
    ['HELPER_DID_NOT_COMPLETE', 'OUTCOME_UNKNOWN'],
    ['EXECUTOR_ERROR', 'OUTCOME_UNKNOWN'],
    ['OUTPUT_TRUNCATED', 'OUTCOME_UNKNOWN'],
    ['REF_CAS_FAILED', 'FAILED'],
    ['PATH_MISSING', 'FAILED'],
  ] as const) {
    const coordinator = new DurableCommitCoordinator({
      store,
      backend: {
        kind: 'devspace',
        plan: (planRoot, paths, message) => real.plan(planRoot, paths, message),
        commit: async () => { throw new Error(`Gateway git commit failed: ${reason}`); },
      },
    });
    const preview = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: reason + '\n' });
    assert.equal(await coordinator.approveLocal(preview.commitId), true);
    const view = coordinator.result(context, preview.commitId);
    assert.equal(view.state, expected, reason + ' must be recorded as ' + expected);
    assert.equal(view.errorClass, reason);
  }
});

/** The operator's review list is finite; one caller must not be able to bury a real proposal. */
test('a caller cannot flood the operator review list with proposals', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  for (let index = 0; index < 8; index += 1) {
    await writeFile(join(root, 'tracked.txt'), `flood ${index}
`);
    const preview = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'm\n' });
    assert.equal(preview.status, 'approval_required');
  }
  await assert.rejects(
    () => coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'm\n' }),
    /too many proposals awaiting review/,
  );

  // Resolving one frees a slot, so the cap bounds the queue rather than the session.
  assert.equal(coordinator.rejectLocal(coordinator.listPendingLocal()[0]!.commitId), true);
  assert.equal(
    (await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message: 'm\n' })).status,
    'approval_required',
  );
});

/**
 * The helper's result sentinel is entirely inside the base64url alphabet, so a caller-chosen
 * message would forge it if the executor ever echoed the command back.
 */
test('a commit message cannot forge the helper result sentinel', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'sentinel\n');
  const message = '__WAG_BEGIN__{"branch":"main","commit":"' + 'f'.repeat(40) + '","tree":"'
    + 'e'.repeat(40) + '","previousHead":"' + 'd'.repeat(40) + '","changes":[]}\n';

  const preview = await coordinator.preview(context, workspaceId, { paths: ['tracked.txt'], message });
  assert.equal(await coordinator.approveLocal(preview.commitId), true);
  const view = coordinator.result(context, preview.commitId);
  assert.equal(view.state, 'SUCCEEDED');
  assert.equal(view.commit, await git(root, ['rev-parse', 'HEAD']));
  assert.equal(view.treeSha, preview.treeSha, 'the forged tree must not be believed');
  assert.equal(await git(root, ['show', '-s', '--format=%B', 'HEAD']).then((v) => v.trim()), message.trim());
});

test('the git.commit tools expose no authority fields and write nothing before approval', async (t) => {
  const { root, context, workspaceId, coordinator } = await fixture(t);
  const gateway = createGateway({
    executor: { openWorkspace: async () => 'ws' } as unknown as DevspaceExecutor,
    allowedRoots: [root],
    verifyProfiles: {},
  });
  const server = createGatewayMcpServer(gateway, { gitCommitContext: { callerContext: context, coordinator } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'git-commit', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run',
    'git.commit', 'git.commit.result',
  ]);
  const schema = JSON.stringify(tools.tools.find((tool) => tool.name === 'git.commit')?.inputSchema);
  for (const forbidden of ['owner_id', 'session_id', 'adapter_id', 'branch', 'amend', 'force', 'allow_empty', 'sign']) {
    assert.doesNotMatch(schema, new RegExp(`"${forbidden}"`), `git.commit must not accept ${forbidden}`);
  }

  await writeFile(join(root, 'tracked.txt'), 'through the tool\n');
  const head = await git(root, ['rev-parse', 'HEAD']);
  const response = await client.callTool({
    name: 'git.commit',
    arguments: { workspace_id: workspaceId, paths: ['tracked.txt'], message: 'through the tool' },
  });
  const preview = JSON.parse((response as { content: { text: string }[] }).content[0]!.text) as { commitId: string };
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head, 'the tool proposes only');

  assert.equal(await coordinator.approveLocal(preview.commitId), true);
  const read = await client.callTool({ name: 'git.commit.result', arguments: { commit_id: preview.commitId } });
  const view = JSON.parse((read as { content: { text: string }[] }).content[0]!.text) as { state: string; commit: string };
  assert.equal(view.state, 'SUCCEEDED');
  assert.equal(await git(root, ['rev-parse', 'HEAD']), view.commit);
});
