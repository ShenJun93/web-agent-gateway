import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableChangeSetCoordinator } from '../src/change-set.js';
import { ChangeSetStore } from '../src/change-set-store.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { LocalMachineFileMutationBackend } from '../src/executor/local-machine-file-mutation.js';

const execFileAsync = promisify(execFile);
const caller = createGatewayCallerContext({
  ownerId: 'owner_change_set',
  sessionId: 'session_change_set',
  adapterId: 'private.stdio.v1',
});

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-change-set-'));
  const root = join(dir, 'repo');
  await execFileAsync('git', ['init', root], { windowsHide: true });
  await git(root, ['config', 'user.name', 'WAG Test']);
  await git(root, ['config', 'user.email', 'wag-test@example.invalid']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(root, 'replace.txt'), 'replace-before\n', 'utf8');
  await writeFile(join(root, 'delete.txt'), 'delete-before\n', 'utf8');
  await writeFile(join(root, 'move.txt'), 'move-before\n', 'utf8');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);

  const authority = new SqliteDurableStore(join(dir, 'authority.sqlite'));
  const changes = new ChangeSetStore(join(dir, 'changes.sqlite'));
  const workspace = authority.openWorkspaceRecord({
    ...caller,
    canonicalRoot: root,
    backendKind: 'local-machine',
    createdAt: Date.now(),
  });
  const backend = new LocalMachineFileMutationBackend();
  const coordinator = new DurableChangeSetCoordinator({
    store: changes,
    workspaceStore: authority,
    backends: [backend],
    killSwitch: () => false,
  });

  t.after(async () => {
    changes.close();
    authority.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, root, authority, changes, workspace, backend, coordinator };
}

test('immutable change set previews then atomically preflights replace/create/delete/move and verifies result', async (t) => {
  const f = await fixture(t);
  const replaceBefore = await readFile(join(f.root, 'replace.txt'), 'utf8');
  const deleteBefore = await readFile(join(f.root, 'delete.txt'), 'utf8');
  const moveBefore = await readFile(join(f.root, 'move.txt'), 'utf8');

  const preview = await f.coordinator.preview(caller, f.workspace.workspaceId, [
    {
      type: 'replace',
      path: 'replace.txt',
      baseSha256: sha256(replaceBefore),
      content: 'replace-after\n',
    },
    { type: 'create', path: 'created.txt', content: 'created\n' },
    { type: 'delete', path: 'delete.txt', baseSha256: sha256(deleteBefore) },
    { type: 'move', from: 'move.txt', to: 'moved.txt', baseSha256: sha256(moveBefore) },
  ]);

  assert.equal(preview.state, 'PREPARED');
  assert.match(preview.planSha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(f.root, 'replace.txt'), 'utf8'), replaceBefore);
  assert.equal(await exists(join(f.root, 'created.txt')), false);
  assert.equal(await exists(join(f.root, 'delete.txt')), true);
  assert.equal(await exists(join(f.root, 'moved.txt')), false);

  const applied = await f.coordinator.apply(caller, preview.changeId, preview.planSha256);
  assert.equal(applied.state, 'VERIFIED');
  assert.equal(await readFile(join(f.root, 'replace.txt'), 'utf8'), 'replace-after\n');
  assert.equal(await readFile(join(f.root, 'created.txt'), 'utf8'), 'created\n');
  assert.equal(await exists(join(f.root, 'delete.txt')), false);
  assert.equal(await exists(join(f.root, 'move.txt')), false);
  assert.equal(await readFile(join(f.root, 'moved.txt'), 'utf8'), moveBefore);

  const replay = await f.coordinator.apply(caller, preview.changeId, preview.planSha256);
  assert.equal(replay.state, 'VERIFIED');
  assert.deepEqual(replay.operations, applied.operations);
});

test('replace may intentionally produce an empty file while create stays non-empty', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, 'replace.txt'), 'utf8');
  const preview = await f.coordinator.preview(caller, f.workspace.workspaceId, [{
    type: 'replace',
    path: 'replace.txt',
    baseSha256: sha256(before),
    content: '',
  }]);
  const applied = await f.coordinator.apply(caller, preview.changeId, preview.planSha256);
  assert.equal(applied.state, 'VERIFIED');
  assert.equal(await readFile(join(f.root, 'replace.txt'), 'utf8'), '');
  await assert.rejects(
    f.coordinator.preview(caller, f.workspace.workspaceId, [{
      type: 'create', path: 'empty.txt', content: '',
    }]),
    /empty change-set content/,
  );
});

test('change apply refuses HEAD drift before any file effect', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, 'replace.txt'), 'utf8');
  const preview = await f.coordinator.preview(caller, f.workspace.workspaceId, [{
    type: 'replace',
    path: 'replace.txt',
    baseSha256: sha256(before),
    content: 'candidate\n',
  }]);

  await writeFile(join(f.root, 'side.txt'), 'side\n', 'utf8');
  await git(f.root, ['add', 'side.txt']);
  await git(f.root, ['commit', '-m', 'head drift']);

  await assert.rejects(
    f.coordinator.apply(caller, preview.changeId, preview.planSha256),
    /HEAD drift/,
  );
  const result = f.coordinator.result(caller, preview.changeId);
  assert.equal(result.state, 'PREPARED');
  assert.equal(result.errorClass, 'HEAD_DRIFT');
  assert.equal(await readFile(join(f.root, 'replace.txt'), 'utf8'), before);
});

test('change apply preflights every path before any effect', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, 'replace.txt'), 'utf8');
  const preview = await f.coordinator.preview(caller, f.workspace.workspaceId, [
    {
      type: 'replace',
      path: 'replace.txt',
      baseSha256: sha256(before),
      content: 'candidate\n',
    },
    { type: 'create', path: 'must-not-appear.txt', content: 'new\n' },
  ]);

  await writeFile(join(f.root, 'replace.txt'), 'external drift\n', 'utf8');
  await assert.rejects(
    f.coordinator.apply(caller, preview.changeId, preview.planSha256),
    /path precondition drift/,
  );
  const result = f.coordinator.result(caller, preview.changeId);
  assert.equal(result.state, 'PREPARED');
  assert.equal(result.errorClass, 'PATH_PRECONDITION_DRIFT');
  assert.equal(await exists(join(f.root, 'must-not-appear.txt')), false);
});

test('move failure after destination creation is durably marked PARTIAL_EFFECT_DETECTED', async (t) => {
  const f = await fixture(t);
  class FailDeleteBackend extends LocalMachineFileMutationBackend {
    override async deleteExisting(): Promise<void> {
      throw new Error('fixture delete failure');
    }
  }
  const coordinator = new DurableChangeSetCoordinator({
    store: f.changes,
    workspaceStore: f.authority,
    backends: [new FailDeleteBackend()],
    killSwitch: () => false,
  });
  const before = await readFile(join(f.root, 'move.txt'), 'utf8');
  const preview = await coordinator.preview(caller, f.workspace.workspaceId, [{
    type: 'move',
    from: 'move.txt',
    to: 'partial-move.txt',
    baseSha256: sha256(before),
  }]);

  await assert.rejects(
    coordinator.apply(caller, preview.changeId, preview.planSha256),
    /fixture delete failure/,
  );
  const result = coordinator.result(caller, preview.changeId);
  assert.equal(result.state, 'PARTIAL_EFFECT_DETECTED');
  assert.equal(result.errorClass, 'EFFECT_ERROR');
  assert.equal(await readFile(join(f.root, 'move.txt'), 'utf8'), before);
  assert.equal(await readFile(join(f.root, 'partial-move.txt'), 'utf8'), before);
});

test('restart reconciliation never blindly replays APPLYING plans', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, 'replace.txt'), 'utf8');
  const preview = await f.coordinator.preview(caller, f.workspace.workspaceId, [{
    type: 'replace',
    path: 'replace.txt',
    baseSha256: sha256(before),
    content: 'after-crash\n',
  }]);

  assert.equal(f.changes.claimPrepared(preview.changeId, Date.now()), true);
  await writeFile(join(f.root, 'replace.txt'), 'after-crash\n', 'utf8');
  await f.coordinator.reconcile();
  assert.equal(f.coordinator.result(caller, preview.changeId).state, 'VERIFIED');

  const secondBefore = await readFile(join(f.root, 'delete.txt'), 'utf8');
  const untouched = await f.coordinator.preview(caller, f.workspace.workspaceId, [{
    type: 'delete',
    path: 'delete.txt',
    baseSha256: sha256(secondBefore),
  }]);
  assert.equal(f.changes.claimPrepared(untouched.changeId, Date.now()), true);
  await f.coordinator.reconcile();
  const reset = f.coordinator.result(caller, untouched.changeId);
  assert.equal(reset.state, 'PREPARED');
  assert.equal(reset.errorClass, 'RECOVERED_BEFORE_EFFECT');
  assert.equal(await readFile(join(f.root, 'delete.txt'), 'utf8'), secondBefore);
});
