import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createHarnessLane, HARNESS_LANE } from '../src/harness-authority.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { createGatewayCallerContext } from '../src/caller-context.js';
import type { FileMutationBackend } from '../src/file-mutation-backend.js';

/**
 * The harness test-authority lane exists so iterating on WAG does not cost the operator two real
 * gestures per attempt. That is only acceptable if the lane can be shown to be unable to reach
 * anything real, so these tests are mostly about what it refuses.
 */
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const enabled = { ...process.env, WAG_HARNESS_LANE: '1' };

type AfterHost = { after(fn: () => void | Promise<void>): void };

async function laneRoot(t: AfterHost): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'wag-lane-'));
  // One hook, not two. `node:test` runs `t.after` in registration order, so a separate directory
  // cleanup registered here would run while the store handle is still open and fail EBUSY on
  // Windows — the trap `.claude/skills/wag-acceptance-gates` warns about, which this hit.
  t.after(() => rm(parent, { recursive: true, force: true }));
  return join(parent, 'lane');
}

/** Creates a lane and registers its teardown *before* anything else needs removing. */
async function openLane(t: AfterHost) {
  const parent = await mkdtemp(join(tmpdir(), 'wag-lane-'));
  const lane = await createHarnessLane({ lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled });
  t.after(async () => {
    await lane.destroy();
    await rm(parent, { recursive: true, force: true });
  });
  return lane;
}

test('the lane drives both gestures, so an iteration needs no human', async (t) => {
  const lane = await openLane(t);

  await lane.writeFixture('ticket-id.js', 'export const id = (raw) => String(raw).trim();\n');

  // The Run equivalent: a durable record, and no effect yet.
  const proposed = await lane.propose({
    path: 'ticket-id.js', before: 'String(raw).trim()', after: 'String(raw).trim().toUpperCase()',
  });
  assert.match(proposed.mutationId, /^mut_/);
  assert.equal(lane.pending().length, 1);
  assert.equal(await lane.readFixture('ticket-id.js'), 'export const id = (raw) => String(raw).trim();\n',
    'proposing alone changes nothing, exactly as in production');

  // The operator-approval equivalent: the only thing that causes an effect.
  assert.equal(await lane.approve(proposed.mutationId), true);
  const after = await lane.readFixture('ticket-id.js');
  assert.equal(after, 'export const id = (raw) => String(raw).trim().toUpperCase();\n');
  assert.equal(sha256(after), proposed.resultSha256, 'reviewed bytes equal written bytes');
  assert.equal(lane.pending().length, 0);

  // Single use, as in production.
  assert.equal(await lane.approve(proposed.mutationId), false, 'a second approval does nothing');
});

test('the lane is off unless it is deliberately turned on', async (t) => {
  const root = await laneRoot(t);
  await assert.rejects(
    createHarnessLane({ lane: HARNESS_LANE, root, env: { ...process.env, WAG_HARNESS_LANE: undefined } }),
    /disabled/i, 'absent opt-in');
  await assert.rejects(
    createHarnessLane({ lane: HARNESS_LANE, root, env: { ...process.env, WAG_HARNESS_LANE: 'true' } }),
    /disabled/i, 'a near-miss opt-in is not an opt-in');
  await assert.rejects(
    createHarnessLane({ lane: 'test' as typeof HARNESS_LANE, root, env: enabled }),
    /lane literal/i, 'the exact literal is required');
});

test('a lane is created fresh and can never adopt an existing store', async (t) => {
  // This is the property that makes production unreachable: there is no code path that opens an
  // existing lane, so no existing store — production's included — can be brought under it.
  const root = await laneRoot(t);
  await mkdir(root, { recursive: true });
  await assert.rejects(
    createHarnessLane({ lane: HARNESS_LANE, root, env: enabled }),
    /already exists/i, 'an existing directory is refused outright');

  // And marking a directory that already holds a store does not help, for the same reason.
  await writeFile(join(root, 'harness-lane.sqlite'), 'not really a store');
  await assert.rejects(createHarnessLane({ lane: HARNESS_LANE, root, env: enabled }), /already exists/i);
});

test('the lane refuses to live in the production state directory or in the repository', async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), 'wag-appdata-'));
  const repoRoot = await mkdtemp(join(tmpdir(), 'wag-repo-'));
  t.after(async () => {
    await rm(localAppData, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  await assert.rejects(createHarnessLane({
    lane: HARNESS_LANE,
    root: join(localAppData, 'WebAgentGateway', 'lane'),
    env: { ...enabled, LOCALAPPDATA: localAppData },
  }), /production state directory/i, 'it cannot sit beside the production store');

  await assert.rejects(createHarnessLane({
    lane: HARNESS_LANE,
    root: join(repoRoot, 'lane'),
    env: { ...enabled, LOCALAPPDATA: localAppData },
    repositoryRoot: repoRoot,
  }), /outside the repository/i, 'it cannot mutate canonical sources');
});

test('the lane refuses a record that belongs to any other workspace', async (t) => {
  // The decisive isolation test: a record id from a *different* store, handed over directly.
  // An id is only a string; the lane resolves where a record would actually write.
  const lane = await openLane(t);

  const foreignDir = await mkdtemp(join(tmpdir(), 'wag-foreign-'));
  const foreignStore = new SqliteDurableStore(join(foreignDir, 'other.sqlite'));
  // Close, then remove, in one hook — two hooks run in registration order and the directory would
  // go first, while the handle is still open.
  t.after(async () => {
    foreignStore.close();
    await rm(foreignDir, { recursive: true, force: true });
  });
  await writeFile(join(foreignDir, 'note.txt'), 'alpha\n');

  const backend: FileMutationBackend = {
    kind: 'foreign-fs',
    async readExact(root, path) { return readFile(join(root, path), 'utf8'); },
    async readExactIfPresent(root, path) {
      try { return await readFile(join(root, path), 'utf8'); } catch { return undefined; }
    },
    async createNew(root, path, candidate) { await writeFile(join(root, path), candidate, { flag: 'wx' }); },
    async updateExisting(root, path, _before, candidate) { await writeFile(join(root, path), candidate); },
  };
  const foreignCaller = createGatewayCallerContext({ ownerId: 'o', sessionId: 's', adapterId: 'a' });
  const foreignWorkspace = foreignStore.openWorkspaceRecord({
    ...foreignCaller, canonicalRoot: foreignDir, backendKind: backend.kind, createdAt: Date.now(),
  });
  const foreignCoordinator = new DurableMutationCoordinator({ store: foreignStore, backends: [backend] });
  const foreign = await foreignCoordinator.preview(foreignCaller, foreignWorkspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256('alpha\n'), before: 'alpha', after: 'BETA',
  });
  assert.equal(foreign.status, 'approval_required');

  await assert.rejects(lane.approve(foreign.mutationId!), /no such record in this lane/i);
  assert.rejects(Promise.resolve().then(() => lane.reject(foreign.mutationId!)), /no such record in this lane/i);

  // The foreign record is untouched, and still approvable by its own authority.
  assert.equal(foreignStore.getMutation(foreign.mutationId!)?.state, 'PENDING_APPROVAL');
  assert.equal(await readFile(join(foreignDir, 'note.txt'), 'utf8'), 'alpha\n');
});

test('the lane cannot write outside its own fixture', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('in.txt', 'x\n');

  for (const path of ['../escape.txt', '..\\escape.txt', join('..', '..', 'escape.txt')]) {
    await assert.rejects(lane.readFixture(path), /escapes the fixture/i, path);
    await assert.rejects(lane.writeFixture(path, 'x'), /escapes the fixture/i, path);
  }
});

test('production carries no auto-approve bypass and does not know this lane exists', async () => {
  // A lane is only safe while it stays a separate client. If production ever imports it, or grows
  // a mode of its own, that separation is gone and these tests would be measuring nothing.
  const read = async (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

  for (const path of [
    'src/operator-server.ts', 'src/durable-mutation.ts', 'src/git-commit.ts',
    'src/browser-operator-runtime.ts', 'src/repository-engineering-runtime.ts', 'src/cli.ts',
  ]) {
    const source = await read(path);
    assert.equal(source.includes('harness-authority'), false, `${path} must not import the lane`);
    assert.equal(/HARNESS_LANE|WAG_HARNESS_LANE/.test(source), false, `${path} must not know the lane exists`);
    assert.equal(/TEST_MODE|autoApprove|auto_approve|skipApproval/i.test(source), false,
      `${path} must carry no approval bypass`);
  }

  // The lane reaches approval through the ordinary coordinator, not a private door into it.
  const lane = await read('src/harness-authority.ts');
  assert.match(lane, /coordinator\.approveLocal/, 'the lane uses the same approval the operator uses');
  const imports = [...lane.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]);
  assert.equal(imports.some((m) => m?.includes('operator-server')), false,
    'the lane does not import the operator server');
  assert.deepEqual(
    imports.filter((m) => m?.startsWith('./')).sort(),
    ['./caller-context.js', './durable-mutation.js', './durable-store.js', './file-mutation-backend.js'],
    'the lane reaches only the coordinator, the store and the caller context',
  );
});

test('the lane is disposable and leaves nothing behind', async (t) => {
  const root = await laneRoot(t);
  const lane = await createHarnessLane({ lane: HARNESS_LANE, root, env: enabled });
  await lane.writeFixture('a.txt', 'x\n');
  assert.equal(await readFile(join(resolve(root), 'fixture', 'a.txt'), 'utf8'), 'x\n');
  await lane.destroy();
  assert.equal(await readFile(join(resolve(root), 'fixture', 'a.txt'), 'utf8').then(() => true, () => false),
    false, 'destroy removes the whole lane');
});
