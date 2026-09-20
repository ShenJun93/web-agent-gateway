import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { AdmittedWorkspaceService } from '../src/admitted-workspace.js';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';

const callerA = createGatewayCallerContext({ ownerId: 'owner_a', sessionId: 'session_a', adapterId: 'browser.chatgpt.native.v1' });
const callerB = createGatewayCallerContext({ ownerId: 'owner_b', sessionId: 'session_b', adapterId: 'browser.chatgpt.native.v1' });

class FakeWorkspaceExecutor {
  opens: string[] = [];
  reads: Array<{ workspaceId: string; path: string }> = [];
  content = 'alpha\r\nbeta\r\n';

  async openWorkspace(path: string): Promise<string> {
    this.opens.push(path);
    return `backend_${this.opens.length}`;
  }

  async readFile(workspaceId: string, path: string): Promise<string> {
    this.reads.push({ workspaceId, path });
    return this.content;
  }
}

class FakeInspectionBackend {
  searches: Array<{ devspaceWorkspaceId: string; canonicalRoot: string; query: string; ignoreCase: boolean; maxResults: number; contextLines: number }> = [];
  snapshots: Array<{ devspaceWorkspaceId: string; options?: { maxFiles?: number } }> = [];

  async search(input: { devspaceWorkspaceId: string; canonicalRoot: string; query: string; ignoreCase: boolean; maxResults: number; contextLines: number }) {
    this.searches.push(input);
    return { matches: [], truncated: false };
  }

  async snapshot(devspaceWorkspaceId: string, _canonicalRoot: string, options?: { maxFiles?: number }) {
    this.snapshots.push({ devspaceWorkspaceId, options });
    return { branch: 'main', head: 'abc', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false };
  }

  // The admitted browser surface does not project list/diff; these satisfy the backend
  // contract and fail loudly if that ever changes without a reviewed decision.
  async list(): Promise<never> { throw new Error('repo.list is not projected to the admitted browser surface'); }
  async diff(): Promise<never> { throw new Error('repo.diff is not projected to the admitted browser surface'); }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wag-admitted-workspace-'));
  const root = join(dir, 'workspace');
  const otherRoot = join(dir, 'other');
  await mkdir(root);
  await mkdir(otherRoot);
  await writeFile(join(root, 'note.txt'), 'alpha\nbeta\n', 'utf8');
  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  const executor = new FakeWorkspaceExecutor();
  const inspection = new FakeInspectionBackend();
  const service = new AdmittedWorkspaceService({
    store,
    executor,
    inspection,
    allowedRoots: [root],
    now: () => 1_000,
  });
  return { dir, root, otherRoot, store, executor, inspection, service };
}

test('separate admitted callers opening the same root receive isolated workspace ids', async (t) => {
  const f = await fixture();
  t.after(async () => { f.store.close(); await rm(f.dir, { recursive: true, force: true }); });

  const a = await f.service.open(callerA, f.root);
  const b = await f.service.open(callerB, f.root);
  assert.notEqual(a.workspaceId, b.workspaceId);
  assert.equal(f.store.getWorkspace(a.workspaceId)?.ownerId, callerA.ownerId);
  assert.equal(f.store.getWorkspace(b.workspaceId)?.ownerId, callerB.ownerId);
});

test('unknown and wrong caller tuples fail identically before backend read', async (t) => {
  const f = await fixture();
  t.after(async () => { f.store.close(); await rm(f.dir, { recursive: true, force: true }); });
  const opened = await f.service.open(callerA, f.root);

  const wrongOwner = createGatewayCallerContext({ ...callerA, ownerId: 'owner_wrong' });
  const wrongSession = createGatewayCallerContext({ ...callerA, sessionId: 'session_wrong' });
  const wrongAdapter = createGatewayCallerContext({ ...callerA, adapterId: 'adapter_wrong' });

  for (const [caller, workspaceId] of [
    [wrongOwner, opened.workspaceId],
    [wrongSession, opened.workspaceId],
    [wrongAdapter, opened.workspaceId],
    [callerA, 'ws_unknown'],
  ] as const) {
    await assert.rejects(
      f.service.read(caller, workspaceId, 'note.txt'),
      (error: unknown) => error instanceof Error && error.message === 'Gateway denied workspace',
    );
    await assert.rejects(
      f.service.search(caller, workspaceId, 'needle', {}),
      (error: unknown) => error instanceof Error && error.message === 'Gateway denied workspace',
    );
    await assert.rejects(
      f.service.snapshot(caller, workspaceId, {}),
      (error: unknown) => error instanceof Error && error.message === 'Gateway denied workspace',
    );
  }
  assert.equal(f.executor.reads.length, 0);
  assert.equal(f.inspection.searches.length, 0);
  assert.equal(f.inspection.snapshots.length, 0);

  // Assert owner can search/snapshot
  await f.service.search(callerA, opened.workspaceId, 'needle', {});
  await f.service.snapshot(callerA, opened.workspaceId, {});
  assert.equal(f.inspection.searches.length, 1);
  assert.equal(f.inspection.snapshots.length, 1);
  assert.equal(f.inspection.searches[0].query, 'needle');
  assert.equal(f.inspection.searches[0].canonicalRoot, f.root);
  assert.equal(typeof f.inspection.searches[0].devspaceWorkspaceId, 'string');
});

test('owned workspace reopens after service restart and preserves its WAG id', async (t) => {
  const f = await fixture();
  t.after(async () => { f.store.close(); await rm(f.dir, { recursive: true, force: true }); });
  const opened = await f.service.open(callerA, f.root);
  assert.equal(f.executor.opens.length, 1);

  const restarted = new AdmittedWorkspaceService({
    store: f.store,
    executor: f.executor,
    inspection: f.inspection,
    allowedRoots: [f.root],
    now: () => 2_000,
  });
  const result = await restarted.read(callerA, opened.workspaceId, 'note.txt');
  const searchResult = await restarted.search(callerA, opened.workspaceId, 'needle');
  const snapshotResult = await restarted.snapshot(callerA, opened.workspaceId);

  assert.deepEqual(result, { content: 'alpha\nbeta' });
  assert.deepEqual(searchResult.truncated, false);
  assert.deepEqual(snapshotResult.branch, 'main');
  assert.equal(f.executor.opens.length, 2, 'restart path must reopen backend binding once for all operations');
  assert.equal(f.executor.reads.length, 1);
  assert.equal(f.inspection.searches.length, 1);
  assert.equal(f.inspection.snapshots.length, 1);
  assert.equal(f.store.getWorkspace(opened.workspaceId)?.workspaceId, opened.workspaceId);
});

test('allowed-root drift blocks restart reopen without changing durable record', async (t) => {
  const f = await fixture();
  t.after(async () => { f.store.close(); await rm(f.dir, { recursive: true, force: true }); });
  const opened = await f.service.open(callerA, f.root);
  const before = f.store.getWorkspace(opened.workspaceId);
  const opensBefore = f.executor.opens.length;

  const drifted = new AdmittedWorkspaceService({
    store: f.store,
    executor: f.executor,
    inspection: f.inspection,
    allowedRoots: [f.otherRoot],
    now: () => 2_000,
  });
  await assert.rejects(drifted.read(callerA, opened.workspaceId, 'note.txt'));

  assert.equal(f.executor.opens.length, opensBefore);
  assert.equal(f.executor.reads.length, 0);
  assert.deepEqual(f.store.getWorkspace(opened.workspaceId), before);
});

test('unsupported backend and canonical-root drift fail before backend access', async (t) => {
  const f = await fixture();
  t.after(async () => { f.store.close(); await rm(f.dir, { recursive: true, force: true }); });
  const unsupported = f.store.openWorkspaceRecord({
    ...callerA, canonicalRoot: f.root, backendKind: 'other', createdAt: 1,
  });
  const drifted = f.store.openWorkspaceRecord({
    ...callerA, canonicalRoot: `${f.root}${sep}.`, backendKind: 'devspace', createdAt: 2,
  });
  const unsupportedBefore = f.store.getWorkspace(unsupported.workspaceId);
  const driftedBefore = f.store.getWorkspace(drifted.workspaceId);

  await assert.rejects(f.service.read(callerA, unsupported.workspaceId, 'note.txt'));
  await assert.rejects(f.service.read(callerA, drifted.workspaceId, 'note.txt'));

  assert.equal(f.executor.reads.length, 0);
  assert.equal(f.executor.opens.length, 0);
  assert.deepEqual(f.store.getWorkspace(unsupported.workspaceId), unsupportedBefore);
  assert.deepEqual(f.store.getWorkspace(drifted.workspaceId), driftedBefore);
});

test('search and snapshot options are clamped before backend delegation', async (t) => {
  const f = await fixture();
  t.after(async () => { f.store.close(); await rm(f.dir, { recursive: true, force: true }); });
  const opened = await f.service.open(callerA, f.root);

  await f.service.search(callerA, opened.workspaceId, 'needle', { maxResults: 999, contextLines: 99 });
  await f.service.snapshot(callerA, opened.workspaceId, { maxFiles: 999 });

  assert.equal(f.inspection.searches.length, 1);
  assert.equal(f.inspection.searches[0].maxResults, 50);
  assert.equal(f.inspection.searches[0].contextLines, 2);

  assert.equal(f.inspection.snapshots.length, 1);
  assert.equal(f.inspection.snapshots[0].options?.maxFiles, 200);
});
