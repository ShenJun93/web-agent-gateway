import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
async function openLane(t: AfterHost, options: { reviewTtlMs?: number; startMs?: number } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'wag-lane-'));
  const lane = await createHarnessLane({ lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled, ...options });
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
  assert.equal((await lane.pending()).length, 1);
  assert.equal(await lane.readFixture('ticket-id.js'), 'export const id = (raw) => String(raw).trim();\n',
    'proposing alone changes nothing, exactly as in production');

  // The operator-approval equivalent: the only thing that causes an effect.
  assert.equal(await lane.approve(proposed.mutationId), true);
  const after = await lane.readFixture('ticket-id.js');
  assert.equal(after, 'export const id = (raw) => String(raw).trim().toUpperCase();\n');
  assert.equal(sha256(after), proposed.resultSha256, 'reviewed bytes equal written bytes');
  assert.equal((await lane.pending()).length, 0);

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

  // The repository root is taken from this module, not from a caller, so a decoy cannot place a
  // lane inside the worktree where destroy() would recursively remove it.
  await assert.rejects(createHarnessLane({
    lane: HARNESS_LANE,
    root: join(resolve(fileURLToPath(new URL('../', import.meta.url))), '.tmp-lane'),
    env: { ...enabled, LOCALAPPDATA: localAppData },
  }), /outside the repository/i, 'it cannot mutate canonical sources');
});

test('a record id from another store is simply not there, which is what isolates the lane', async (t) => {
  // Renamed to say what it proves. It reaches the not-found arm, not the workspace comparison —
  // a review pointed out the old name claimed the latter and would have passed with that guard
  // deleted. The workspace arm is covered separately below.
  //
  // What this does show is the containment that actually holds: each lane owns its own SQLite
  // file under a filename this module controls, so a foreign record simply does not exist here.
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
  await assert.rejects(lane.reject(foreign.mutationId!), /no such record in this lane/i);

  // The foreign record is untouched, and still approvable by its own authority.
  assert.equal(foreignStore.getMutation(foreign.mutationId!)?.state, 'PENDING_APPROVAL');
  assert.equal(await readFile(join(foreignDir, 'note.txt'), 'utf8'), 'alpha\n');
});

test('the workspace guard fires when a record in this store belongs elsewhere', async (t) => {
  // The arm the previous test does not reach. A second workspace row is added to the lane's own
  // store, so the record is found and the workspace comparison is what refuses it — the defence
  // in depth, exercised rather than asserted.
  const parent = await mkdtemp(join(tmpdir(), 'wag-lane-'));
  const lane = await createHarnessLane({ lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled });
  const store = new SqliteDurableStore(join(resolve(parent), 'lane', 'harness-lane.sqlite'));
  t.after(async () => {
    store.close();
    await lane.destroy();
    await rm(parent, { recursive: true, force: true });
  });

  const otherDir = await mkdtemp(join(tmpdir(), 'wag-other-ws-'));
  t.after(() => rm(otherDir, { recursive: true, force: true }));
  await writeFile(join(otherDir, 'note.txt'), 'alpha\n');

  const backend: FileMutationBackend = {
    kind: 'harness-lane-fs',
    async readExact(root, path) { return readFile(join(root, path), 'utf8'); },
    async readExactIfPresent(root, path) {
      try { return await readFile(join(root, path), 'utf8'); } catch { return undefined; }
    },
    async createNew(root, path, candidate) { await writeFile(join(root, path), candidate, { flag: 'wx' }); },
    async updateExisting(root, path, _b, candidate) { await writeFile(join(root, path), candidate); },
  };
  const otherCaller = createGatewayCallerContext({ ownerId: 'o2', sessionId: 's2', adapterId: 'a2' });
  const otherWorkspace = store.openWorkspaceRecord({
    ...otherCaller, canonicalRoot: otherDir, backendKind: backend.kind, createdAt: Date.now(),
  });
  const coordinator = new DurableMutationCoordinator({ store, backends: [backend] });
  const record = await coordinator.preview(otherCaller, otherWorkspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256('alpha\n'), before: 'alpha', after: 'BETA',
  });
  assert.equal(record.status, 'approval_required');

  // Found in this store, but not this lane's workspace.
  await assert.rejects(lane.approve(record.mutationId!), /belongs to another workspace/i);
  assert.equal(await readFile(join(otherDir, 'note.txt'), 'utf8'), 'alpha\n', 'and nothing was written');
});

test('each defence-in-depth guard is exercised, not merely present', async (t) => {
  // Three reviews in a row found guards on this branch that no test reached, so deleting them
  // would have failed nothing. These are the ones that were still in that state.

  // 1. The marker check. Tamper with it and every durable-state operation must stop.
  const parent = await mkdtemp(join(tmpdir(), 'wag-lane-'));
  const lane = await createHarnessLane({ lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled });
  t.after(async () => {
    await lane.destroy().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });
  await lane.writeFixture('a.txt', 'one\n');
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });

  const markerPath = join(resolve(parent), 'lane', 'harness-lane.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { laneId: string };
  await writeFile(markerPath, JSON.stringify({ ...marker, laneId: 'lane_someone_else' }));

  await assert.rejects(lane.approve(proposed.mutationId), /marker no longer describes this lane/i);
  await assert.rejects(lane.reject(proposed.mutationId), /marker no longer describes this lane/i);
  await assert.rejects(lane.pending(), /marker no longer describes this lane/i,
    'listing writes durable state through the overdue sweep, so it is checked too');
  await assert.rejects(lane.propose({ path: 'a.txt', before: 'one', after: 'three' }),
    /marker no longer describes this lane/i);
  // The two call-sites that arrived with the loop capabilities. Both shipped uncovered, in the
  // very commit whose message said the new guards had been mutation-tested; a review caught it.
  await assert.rejects(lane.reopen(), /marker no longer describes this lane/i);
  await assert.rejects(lane.serveOperator(), /marker no longer describes this lane/i);
  assert.equal(await lane.readFixture('a.txt'), 'one\n', 'and nothing was written while it was refused');

  // The workspace id is part of the comparison. It was persisted and read by nothing, which is
  // the same "written and never read" defect this branch has now produced three times — and it
  // is the field a future `openHarnessLane()` would most want to be able to trust.
  await writeFile(markerPath, JSON.stringify({ ...marker, workspaceId: 'ws_somewhere_else' }));
  await assert.rejects(lane.approve(proposed.mutationId), /marker no longer describes this lane/i);
  await assert.rejects(lane.pending(), /marker no longer describes this lane/i);

  // Put it back so the lane can be torn down cleanly.
  await writeFile(markerPath, JSON.stringify(marker));

  // 2. LOCALAPPDATA fail-closed. The suite inherits a real one, so no other test omits it.
  const bare = { WAG_HARNESS_LANE: '1' } as NodeJS.ProcessEnv;
  await assert.rejects(
    createHarnessLane({ lane: HARNESS_LANE, root: join(parent, 'lane-2'), env: bare }),
    /LOCALAPPDATA/i, 'an absent LOCALAPPDATA refuses rather than dropping the check');
  await assert.rejects(
    createHarnessLane({ lane: HARNESS_LANE, root: join(parent, 'lane-3'), env: { ...bare, LOCALAPPDATA: 'relative' } }),
    /LOCALAPPDATA/i, 'and so does a relative one');

  // 3. A UNC root is refused before anything is created.
  await assert.rejects(
    createHarnessLane({ lane: HARNESS_LANE, root: '\\\\localhost\\C$\\wag-lane', env: enabled }),
    /UNC or device-namespace/i);
  await assert.rejects(
    createHarnessLane({ lane: HARNESS_LANE, root: '//localhost/C$/wag-lane', env: enabled }),
    /UNC or device-namespace/i);
});

test('the fixture backend rethrows a read failure that is not absence', async (t) => {
  // The backend contract requires absence to be distinguishable from every other read failure,
  // because a creation that read a permission error as "absent" would become an overwrite. The
  // previous version swallowed everything, including its own containment refusal, and no test
  // noticed. A directory where a file is expected produces EISDIR on read.
  const lane = await openLane(t);
  await mkdir(join(lane.fixtureRoot, 'adir'), { recursive: true });

  await assert.rejects(
    lane.propose({ path: 'adir', before: 'x', after: 'y' }),
    (error: Error) => !/no such file|ENOENT/i.test(error.message),
    'a directory read must surface as a failure, never as absence',
  );
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
  const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

  // Every production source file, walked — not a hand-written list. A review pointed out the old
  // version checked six files out of fifty, so anything added later was exempt by default.
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await walk(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  };
  // Everything that ships: src/, the scripts that assemble runtimes, and the extension itself —
  // a review pointed out the shipped v4 service worker was outside the previous walk.
  const extensionRoot = fileURLToPath(new URL('../browser/extension/', import.meta.url));
  const scriptsRoot = fileURLToPath(new URL('../scripts/', import.meta.url));
  const production = [
    ...await walk(srcRoot), ...await walk(extensionRoot), ...await walk(scriptsRoot),
  ].filter((f) => !f.endsWith('harness-authority.ts') && !f.endsWith('harness-authority.js'));
  assert.ok(production.length >= 60, `expected to walk everything shipped, saw ${production.length} files`);

  // Spellings, not one spelling. `testMode` and `approveAll` passed the previous four-token list.
  const bypass = /TEST_MODE|testMode|autoApprove|auto_approve|approveAll|bypassApproval|forceApprove|skipApproval|skip_approval/i;
  for (const file of production) {
    const source = await readFile(file, 'utf8');
    const name = relative(fileURLToPath(new URL('../', import.meta.url)), file);
    assert.equal(source.includes('harness-authority'), false, `${name} must not import the lane`);
    assert.equal(/HARNESS_LANE|WAG_HARNESS_LANE/.test(source), false, `${name} must not know the lane exists`);
    assert.equal(bypass.test(source), false, `${name} must carry no approval bypass`);
  }

  // The lane reaches approval through the ordinary coordinator, not a private door into it.
  const lane = await read('src/harness-authority.ts');
  assert.match(lane, /coordinator\.approveLocal/, 'the lane uses the same approval the operator uses');
  const imports = [...lane.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(
    imports.filter((m) => m?.startsWith('./')).sort(),
    // `operator-server.js` is here deliberately. The lane hosts a real review server over its own
    // store so the CSRF, Origin and single-use loops run against production's checks rather than a
    // stub. The direction is what matters and is asserted above: the lane may reach into
    // production, production may never reach into the lane.
    ['./caller-context.js', './durable-mutation.js', './durable-store.js', './file-mutation-backend.js', './operator-server.js', './path-policy.js'],
    'the lane reaches only the coordinator, the store, the caller context, the path policy and the review server',
  );
  // A static import list is blind to a dynamic one, and this file used to contain one. Matching
  // only the awaited form would still miss `import(x).then(...)`, `void import(x)` and
  // `createRequire`, so match the call in any form.
  assert.equal(/(^|[^.\w])import\s*\(/m.test(lane), false,
    'the lane uses no dynamic import, so the list above is the whole of its reach');
  assert.equal(/createRequire/.test(lane), false, 'nor does it reach for require');
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
