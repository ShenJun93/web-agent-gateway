import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { FileMutationBackend } from '../src/file-mutation-backend.js';
import { startDurableMutationMcpFixture } from './durable-mutation-mcp-fixture.js';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const caller = createGatewayCallerContext({
  ownerId: 'owner_accept',
  sessionId: 'session_accept',
  adapterId: 'browser_accept',
});

function cookiePair(value: string | null): string {
  assert.ok(value);
  return value.split(';', 1)[0]!;
}
test('fresh Git fixture completes preview -> local review -> result -> read-back -> snapshot', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const temp = await mkdtemp(join(tmpdir(), 'wag-durable-acceptance-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'private.json');
  const statePath = join(temp, 'state.sqlite');
  const original = 'alpha\nbeta\ngamma\n';
  const candidate = 'alpha\nbeta-browser\ngamma\n';
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), original);
  await execFileAsync('git', ['init'], { cwd: fixture.workspaceRoot });
  await execFileAsync('git', ['config', 'user.email', 'wag@example.invalid'], { cwd: fixture.workspaceRoot });
  await execFileAsync('git', ['config', 'user.name', 'WAG Test'], { cwd: fixture.workspaceRoot });
  await execFileAsync('git', ['add', 'note.txt'], { cwd: fixture.workspaceRoot });
  await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: fixture.workspaceRoot });
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [fixture.workspaceRoot],
    devspace: { baseUrl: fixture.baseUrl, resourceUrl: fixture.resourceUrl },
    verifyProfiles: {},
  }));

  const runtime = await startDurableMutationMcpFixture({
    configPath, statePath, caller,
    env: { DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
  });
  t.after(() => runtime.close());
  const client = runtime.client;

  const opened = await client.callTool({ name: 'workspace.open', arguments: { path: fixture.workspaceRoot } });
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.match(workspaceId ?? '', /^ws_/);
  const preview = await client.callTool({ name: 'mutation.preview', arguments: {
    workspace_id: workspaceId,
    path: 'note.txt',
    base_sha256: sha256(original),
    before: 'beta',
    after: 'beta-browser',
  } });
  const mutationId = (preview.structuredContent as { mutationId?: string } | undefined)?.mutationId;
  assert.match(mutationId ?? '', /^mut_/);

  const boot = await fetch(runtime.operatorBootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const page = await fetch(runtime.operatorOrigin, { headers: { cookie } });
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  assert.match(html, new RegExp(mutationId!));
  const approved = await fetch(`${runtime.operatorOrigin}/mutations/${encodeURIComponent(mutationId!)}/approve`, {
    method: 'POST',
    headers: { cookie, origin: runtime.operatorOrigin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
    redirect: 'manual',
  });
  assert.equal(approved.status, 303);

  const result = await client.callTool({ name: 'mutation.result', arguments: { mutation_id: mutationId } });
  assert.equal((result.structuredContent as { state?: string } | undefined)?.state, 'SUCCEEDED');
  assert.equal((result.structuredContent as { resultSha256?: string } | undefined)?.resultSha256, sha256(candidate));

  const readBack = await client.callTool({ name: 'file.read', arguments: { workspace_id: workspaceId, path: 'note.txt' } });
  assert.equal((readBack.structuredContent as { content?: string } | undefined)?.content, candidate.trimEnd());
  assert.equal(sha256(await readFile(join(fixture.workspaceRoot, 'note.txt'), 'utf8')), sha256(candidate));

  const snapshot = await client.callTool({ name: 'repo.snapshot', arguments: { workspace_id: workspaceId } });
  const snap = snapshot.structuredContent as { dirty?: boolean; status?: string[]; diffStat?: string } | undefined;
  assert.equal(snap?.dirty, true);
  assert.match((snap?.status ?? []).join('\n'), /note\.txt/);
  assert.match(snap?.diffStat ?? '', /1 file changed/);
  const { stdout: changed } = await execFileAsync('git', ['diff', '--name-only'], { cwd: fixture.workspaceRoot });
  assert.deepEqual(changed.trim().split(/\r?\n/).filter(Boolean), ['note.txt']);
  await client.close();
  await runtime.close();
});
test('file-backed restart recovery replays only safe queued work and never rewrites divergent content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-durable-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'state.sqlite');
  const target = join(root, 'note.txt');
  const original = 'alpha\nbeta\n';
  const candidate = 'alpha\nBETA\n';
  const backend = new AcceptanceFsBackend();
  let store = new SqliteDurableStore(statePath);
  const workspace = store.openWorkspaceRecord({ ...caller, canonicalRoot: root, backendKind: backend.kind, createdAt: 1_000 });
  let coordinator = new DurableMutationCoordinator({ store, backends: [backend], now: () => 1_000 });

  await writeFile(target, original);
  const queued = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  });
  store.approveMutation(queued.mutationId, 1_000, 60_000);
  store.close();
  store = new SqliteDurableStore(statePath);
  coordinator = new DurableMutationCoordinator({ store, backends: [backend], now: () => 1_001 });
  await coordinator.reconcile();
  assert.equal(store.getMutation(queued.mutationId)?.state, 'SUCCEEDED');
  assert.equal(await readFile(target, 'utf8'), candidate);
  assert.equal(backend.writes, 1);
  await writeFile(target, original);
  const completed = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  });
  store.approveMutation(completed.mutationId, 1_001, 60_000);
  store.claimMutation(completed.mutationId, 1_001);
  await writeFile(target, candidate);
  store.close();
  store = new SqliteDurableStore(statePath);
  coordinator = new DurableMutationCoordinator({ store, backends: [backend], now: () => 1_002 });
  await coordinator.reconcile();
  assert.equal(store.getMutation(completed.mutationId)?.state, 'SUCCEEDED');
  assert.equal(backend.writes, 1, 'result-hash recovery must not write again');

  await writeFile(target, original);
  const unknown = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(original), before: 'beta', after: 'BETA',
  });
  store.approveMutation(unknown.mutationId, 1_002, 60_000);
  store.claimMutation(unknown.mutationId, 1_002);
  await writeFile(target, 'alpha\nOTHER\n');
  store.close();
  store = new SqliteDurableStore(statePath);
  coordinator = new DurableMutationCoordinator({ store, backends: [backend], now: () => 1_003 });
  await coordinator.reconcile();
  assert.equal(store.getMutation(unknown.mutationId)?.state, 'OUTCOME_UNKNOWN');
  assert.equal(await readFile(target, 'utf8'), 'alpha\nOTHER\n');
  assert.equal(backend.writes, 1, 'divergent recovery must not write');
  store.close();
});

class AcceptanceFsBackend implements FileMutationBackend {
  readonly kind = 'acceptance-fs';
  writes = 0;
  async readExact(root: string, path: string): Promise<string> {
    return readFile(join(root, path), 'utf8');
  }
  async readExactIfPresent(root: string, path: string): Promise<string | undefined> {
    try { return await readFile(join(root, path), 'utf8'); }
    catch { return undefined; }
  }
  async createNew(root: string, path: string, candidate: string): Promise<void> {
    this.writes += 1;
    await writeFile(join(root, path), candidate, { flag: 'wx' });
  }
  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    const target = join(root, path);
    if (await readFile(target, 'utf8') !== original) throw new Error('stale target');
    this.writes += 1;
    await writeFile(target, candidate);
  }
}
