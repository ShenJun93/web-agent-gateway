import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { FilePatchController } from '../src/file-patch.js';
import { PatchApprovalStore } from '../src/patch-approval.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

async function setup(t: test.TestContext, content = 'alpha\nbeta\ngamma\n', approvals = new PatchApprovalStore()) {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), content);
  const executor = new DevspaceExecutor(fixture);
  const devspaceWorkspaceId = await executor.openWorkspace(fixture.workspaceRoot);
  const controller = new FilePatchController({ executor, approvals });
  const binding = { workspaceId: 'ws_public_fixture', canonicalRoot: fixture.workspaceRoot, devspaceWorkspaceId };
  return { fixture, executor, approvals, controller, binding };
}

test('file patch preview returns approval metadata without modifying the target', async (t) => {
  const { fixture, controller, binding } = await setup(t);
  const original = await readFile(join(fixture.workspaceRoot, 'note.txt'), 'utf8');
  const preview = await controller.preview(binding, {
    path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  });
  assert.equal(preview.status, 'approval_required');
  assert.equal(preview.path, 'note.txt');
  assert.equal(preview.baseSha256, sha256(original));
  assert.equal(preview.resultSha256, sha256(original.replace('beta', 'BETA')));
  assert.match(preview.approvalId, /^pa_/);
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(fixture.workspaceRoot, 'note.txt'), 'utf8'), original);
});

test('file patch preview rejects stale hash, duplicate before, sensitive path, and missing target', async (t) => {
  const { controller, binding } = await setup(t, 'beta\nbeta\n');
  const original = 'beta\nbeta\n';
  await assert.rejects(controller.preview(binding, {
    path: 'note.txt', baseSha256: '0'.repeat(64), before: 'beta', after: 'BETA',
  }), /base SHA-256 mismatch/);
  await assert.rejects(controller.preview(binding, {
    path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  }), /before text must occur exactly once/);
  await assert.rejects(controller.preview(binding, {
    path: '.env', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  }), /Gateway denied sensitive path/);
  await assert.rejects(controller.preview(binding, {
    path: 'missing.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  }));
});

test('file patch preview rejects overlapping before occurrences', async (t) => {
  const original = 'aaa';
  const { controller, binding } = await setup(t, original);
  await assert.rejects(controller.preview(binding, {
    path: 'note.txt', baseSha256: sha256(original), before: 'aa', after: 'AA',
  }), /before text must occur exactly once/);
});
test('file patch preview rejects escape, binary text, and size bounds', async (t) => {
  const { fixture, controller, binding } = await setup(t);
  const outsideDir = join(dirname(fixture.workspaceRoot), 'patch-outside');
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'outside.txt'), 'alpha\nbeta\n');
  try {
    await symlink(outsideDir, join(fixture.workspaceRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(controller.preview(binding, {
      path: 'escape/outside.txt', baseSha256: sha256('alpha\nbeta\n'), before: 'beta', after: 'BETA',
    }), /Gateway denied workspace escape/);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES') throw error;
  }

  await writeFile(join(fixture.workspaceRoot, 'binary.txt'), Buffer.from([65, 0, 66]));
  await assert.rejects(controller.preview(binding, {
    path: 'binary.txt', baseSha256: sha256('A\0B'), before: 'A', after: 'B',
  }), /binary content/);
  await assert.rejects(controller.preview(binding, {
    path: 'note.txt', baseSha256: sha256('alpha\nbeta\ngamma\n'), before: 'x'.repeat(32 * 1024 + 1), after: 'BETA',
  }), /before exceeds 32 KiB/);
  await assert.rejects(controller.preview(binding, {
    path: 'note.txt', baseSha256: sha256('alpha\nbeta\ngamma\n'), before: 'beta', after: 'x'.repeat(32 * 1024 + 1),
  }), /after exceeds 32 KiB/);
});
test('file patch preview rejects oversized target and candidate', async (t) => {
  const { fixture, controller, binding } = await setup(t);
  const large = `beta\n${'x'.repeat(70 * 1024)}`;
  await writeFile(join(fixture.workspaceRoot, 'large.txt'), large);
  await assert.rejects(controller.preview(binding, {
    path: 'large.txt', baseSha256: sha256(large), before: 'beta', after: 'BETA',
  }), /target exceeds (?:64 KiB|executor read limit)/);

  const nearLimit = `${'x'.repeat(40 * 1024)}beta`;
  await writeFile(join(fixture.workspaceRoot, 'candidate.txt'), nearLimit);
  await assert.rejects(controller.preview(binding, {
    path: 'candidate.txt', baseSha256: sha256(nearLimit), before: 'beta', after: 'y'.repeat(30 * 1024),
  }), /candidate exceeds 64 KiB/);
});
test('file patch apply requires exact local approval and rejects expiry', async (t) => {
  let now = 1_000;
  const approvals = new PatchApprovalStore({ ttlMs: 10, now: () => now });
  const { controller, binding } = await setup(t, 'alpha\nbeta\ngamma\n', approvals);
  const original = 'alpha\nbeta\ngamma\n';
  const input = { path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA' };
  const preview = await controller.preview(binding, input);

  await assert.rejects(controller.apply(binding, { ...input, approvalId: preview.approvalId }), /approval/i);
  assert.equal(approvals.approveLocal(preview.approvalId, 'f'.repeat(64)), false);
  assert.equal(approvals.approveLocal(preview.approvalId, preview.fingerprint), true);
  now = 1_011;
  await assert.rejects(controller.apply(binding, { ...input, approvalId: preview.approvalId }), /approval/i);
});

test('file patch apply revokes approval when request fingerprint changes', async (t) => {
  const { controller, approvals, binding } = await setup(t);
  const original = 'alpha\nbeta\ngamma\n';
  const input = { path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA' };
  const preview = await controller.preview(binding, input);
  assert.equal(approvals.approveLocal(preview.approvalId, preview.fingerprint), true);
  await assert.rejects(controller.apply(binding, { ...input, after: 'Beta', approvalId: preview.approvalId }), /approval/i);
  await assert.rejects(controller.apply(binding, { ...input, approvalId: preview.approvalId }), /approval/i);
});
test('file patch apply revokes stale target approval and prevents replay', async (t) => {
  const { fixture, controller, approvals, binding } = await setup(t);
  const original = 'alpha\nbeta\ngamma\n';
  const input = { path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA' };
  const preview = await controller.preview(binding, input);
  assert.equal(approvals.approveLocal(preview.approvalId, preview.fingerprint), true);

  await writeFile(join(fixture.workspaceRoot, 'note.txt'), `${original}changed\n`);
  await assert.rejects(controller.apply(binding, { ...input, approvalId: preview.approvalId }), /base SHA-256 mismatch/);
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), original);
  await assert.rejects(controller.apply(binding, { ...input, approvalId: preview.approvalId }), /approval/i);

  const second = await controller.preview(binding, input);
  assert.equal(approvals.approveLocal(second.approvalId, second.fingerprint), true);
  await controller.apply(binding, { ...input, approvalId: second.approvalId });
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), original);
  await assert.rejects(controller.apply(binding, { ...input, approvalId: second.approvalId }), /approval/i);
});

test('file patch apply updates one LF file and verifies final hash', async (t) => {
  const { fixture, controller, approvals, binding } = await setup(t);
  const original = 'alpha\nbeta\ngamma\n';
  const candidate = 'alpha\nBETA\ngamma\n';
  const input = { path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA' };
  const preview = await controller.preview(binding, input);
  approvals.approveLocal(preview.approvalId, preview.fingerprint);
  const result = await controller.apply(binding, { ...input, approvalId: preview.approvalId });
  assert.equal(result.status, 'applied');
  assert.equal(result.path, 'note.txt');
  assert.equal(result.resultSha256, sha256(candidate));
  assert.equal(await readFile(join(fixture.workspaceRoot, 'note.txt'), 'utf8'), candidate);
});

test('file patch apply preserves CRLF and verifies final hash', async (t) => {
  const original = 'alpha\r\nbeta\r\ngamma\r\n';
  const candidate = 'alpha\r\nBETA\r\ngamma\r\n';
  const { fixture, controller, approvals, binding } = await setup(t, original);
  const input = { path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA' };
  const preview = await controller.preview(binding, input);
  approvals.approveLocal(preview.approvalId, preview.fingerprint);
  const result = await controller.apply(binding, { ...input, approvalId: preview.approvalId });
  assert.equal(result.resultSha256, sha256(candidate));
  assert.equal(await readFile(join(fixture.workspaceRoot, 'note.txt'), 'utf8'), candidate);
});

async function fakeControllerFixture(t: test.TestContext, patchResult: object, postRead?: string) {
  const { fixture } = await setup(t);
  const original = 'alpha\nbeta\ngamma\n';
  const approvals = new PatchApprovalStore();
  let reads = 0;
  const executor = {
    readFile: async () => { reads += 1; return reads >= 3 && postRead !== undefined ? postRead : original; },
    applyPatch: async () => patchResult,
  } as unknown as DevspaceExecutor;
  const controller = new FilePatchController({ executor, approvals });
  const binding = { workspaceId: 'ws_fake', canonicalRoot: fixture.workspaceRoot, devspaceWorkspaceId: 'dws_fake' };
  const input = { path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA' };
  const preview = await controller.preview(binding, input);
  approvals.approveLocal(preview.approvalId, preview.fingerprint);
  return { controller, binding, input, preview };
}

test('file patch apply rejects non-update and wrong-target donor metadata', async (t) => {
  const badFiles = [
    [{ path: 'note.txt', operation: 'add' }],
    [{ path: 'note.txt', operation: 'delete' }],
    [{ path: 'note.txt', operation: 'move' }],
    [{ path: 'other.txt', operation: 'update' }],
    [{ path: 'note.txt', previousPath: 'old-note.txt', operation: 'update' }],
  ];
  for (const files of badFiles) {
    const result = { result: 'bad', additions: 1, removals: 1, files };
    const { controller, binding, input, preview } = await fakeControllerFixture(t, result);
    await assert.rejects(controller.apply(binding, { ...input, approvalId: preview.approvalId }), /DevSpace patch result/);
  }
});

test('file patch apply rejects post-write hash mismatch', async (t) => {
  const patchResult = {
    result: 'ok', additions: 1, removals: 1,
    files: [{ path: 'note.txt', operation: 'update' }],
  };
  const { controller, binding, input, preview } = await fakeControllerFixture(t, patchResult, 'alpha\nWRONG\ngamma\n');
  await assert.rejects(controller.apply(binding, { ...input, approvalId: preview.approvalId }), /post-write SHA-256 mismatch/);
});
