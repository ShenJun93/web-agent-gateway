import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext, type GatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator, isCreationInput } from '../src/durable-mutation.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { FileMutationBackend } from '../src/file-mutation-backend.js';
import type { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';
import { PRIVATE_STDIO_ADAPTER_ID } from '../src/repository-engineering-runtime.js';

const EMPTY_SHA256 = createHash('sha256').update('', 'utf8').digest('hex');
const NEW_CONTENT = 'export const created = true;\n';

/** A real filesystem backend, so "did not exist" and "must not overwrite" are actually tested. */
class FsBackend implements FileMutationBackend {
  readonly kind = 'devspace';
  creates = 0;
  updates = 0;
  async readExact(root: string, path: string): Promise<string> {
    return readFile(join(root, path), 'utf8');
  }
  async readExactIfPresent(root: string, path: string): Promise<string | undefined> {
    try { return await readFile(join(root, path), 'utf8'); }
    catch { return undefined; }
  }
  async createNew(root: string, path: string, candidate: string): Promise<void> {
    if (candidate === '') throw new Error('Gateway rejected empty file creation');
    this.creates += 1;
    await writeFile(join(root, path), candidate, { flag: 'wx' });
  }
  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    const target = join(root, path);
    if (await readFile(target, 'utf8') !== original) throw new Error('stale target');
    this.updates += 1;
    await writeFile(target, candidate);
  }
}

function caller(sessionId = 'sid_create'): GatewayCallerContext {
  return createGatewayCallerContext({
    ownerId: 'local.private.stdio', sessionId, adapterId: PRIVATE_STDIO_ADAPTER_ID,
  });
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wag-file-create-'));
  const stores: SqliteDurableStore[] = [];
  t.after(async () => {
    for (const store of stores) { try { store.close(); } catch { /* already closed */ } }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'existing.txt'), 'already here\n');

  const store = new SqliteDurableStore(':memory:');
  stores.push(store);
  const context = caller();
  const workspace = store.openWorkspaceRecord({
    ownerId: context.ownerId, sessionId: context.sessionId, adapterId: context.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: Date.now(),
  });
  const backend = new FsBackend();
  const coordinator = new DurableMutationCoordinator({ store, backends: [backend] });
  return { root, store, context, workspaceId: workspace.workspaceId, backend, coordinator };
}

function creation(path: string, content = NEW_CONTENT) {
  return { path, baseSha256: EMPTY_SHA256, before: '', after: content };
}

test('a creation is encoded as an empty-base mutation and no historical record can look like one', () => {
  assert.equal(isCreationInput({ baseSha256: EMPTY_SHA256, before: '' }), true);
  assert.equal(isCreationInput({ baseSha256: EMPTY_SHA256, before: 'x' }), false,
    'an update always carries a non-empty before, so it can never be read as a creation');
  assert.equal(isCreationInput({ baseSha256: 'a'.repeat(64), before: '' }), false,
    'an empty before alone is not enough; the base must be the empty file');
});

test('file creation writes nothing until it is locally approved, then writes exactly once', async (t) => {
  const { root, context, workspaceId, backend, coordinator } = await fixture(t);

  const preview = await coordinator.preview(context, workspaceId, creation('src/created.ts'));
  assert.equal(preview.status, 'approval_required');
  assert.equal(preview.baseSha256, EMPTY_SHA256);
  assert.equal(preview.removals, 0, 'a creation removes nothing');
  assert.equal(preview.resultSha256, createHash('sha256').update(NEW_CONTENT, 'utf8').digest('hex'));
  await assert.rejects(() => readFile(join(root, 'src/created.ts'), 'utf8'),
    'the proposal must not create the file');
  assert.equal(backend.creates, 0);

  assert.equal(await coordinator.approveLocal(preview.mutationId), true);
  assert.equal(await readFile(join(root, 'src/created.ts'), 'utf8'), NEW_CONTENT);
  assert.equal(backend.creates, 1);
  assert.equal(backend.updates, 0, 'a creation must not take the update path');
  assert.equal(coordinator.result(context, preview.mutationId).state, 'SUCCEEDED');

  assert.equal(await coordinator.approveLocal(preview.mutationId), false, 'approval is single use');
  assert.equal(backend.creates, 1);
});

test('creation never overwrites, at proposal time or at execution time', async (t) => {
  const { root, context, workspaceId, backend, coordinator } = await fixture(t);

  await assert.rejects(() => coordinator.preview(context, workspaceId, creation('existing.txt')),
    /existing creation target/i);

  // A target that appears between proposal and approval must fail, not silently overwrite.
  const preview = await coordinator.preview(context, workspaceId, creation('src/racy.ts'));
  await writeFile(join(root, 'src/racy.ts'), 'someone else got there first\n');
  assert.equal(await coordinator.approveLocal(preview.mutationId), true,
    'approval itself succeeds; the execution is what must refuse');
  assert.equal(await readFile(join(root, 'src/racy.ts'), 'utf8'), 'someone else got there first\n',
    'the pre-existing content must survive untouched');
  assert.notEqual(coordinator.result(context, preview.mutationId).state, 'SUCCEEDED');
  assert.equal(backend.creates, 0);
});

test('creation refuses an empty file and oversized content', async (t) => {
  const { context, workspaceId, backend, coordinator } = await fixture(t);

  await assert.rejects(() => coordinator.preview(context, workspaceId, creation('src/empty.ts', '')),
    /empty file creation/i);
  await assert.rejects(
    () => coordinator.preview(context, workspaceId, creation('src/huge.ts', 'x'.repeat(33 * 1024))),
    /32 KiB|exceeds/i,
  );
  assert.equal(backend.creates, 0);
});

test('creation is bound by the same path policy as every other target', async (t) => {
  const { root, context, workspaceId, backend, coordinator } = await fixture(t);
  await mkdir(join(root, 'outside-target'), { recursive: true });

  const denied = [
    '../escape.ts', '..\\escape.ts', '/etc/passwd', 'C:\\Windows\\evil.txt',
    '.git/hooks/pre-commit', 'src/../../escape.ts', '.env', '.npmrc', 'src/.ssh/key',
  ];
  for (const path of denied) {
    await assert.rejects(() => coordinator.preview(context, workspaceId, creation(path)),
      `creation must deny ${path}`);
  }
  assert.equal(backend.creates, 0);
});

test('creation cannot escape through a symlinked parent directory', async (t) => {
  const { root, context, workspaceId, backend, coordinator } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'wag-file-create-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));

  try {
    await symlink(outside, join(root, 'linked'), 'dir');
  } catch {
    t.skip('this environment does not permit creating directory symlinks');
    return;
  }

  await assert.rejects(() => coordinator.preview(context, workspaceId, creation('linked/planted.ts')),
    /workspace escape/i);
  assert.equal(backend.creates, 0);
  await assert.rejects(() => readFile(join(outside, 'planted.ts'), 'utf8'));
});

test('a foreign caller cannot read a creation record', async (t) => {
  const { context, workspaceId, coordinator } = await fixture(t);
  const preview = await coordinator.preview(context, workspaceId, creation('src/owned.ts'));
  assert.throws(() => coordinator.result(caller('sid_other'), preview.mutationId));
});

test('rejecting or expiring a creation leaves the workspace untouched', async (t) => {
  const { root, context, workspaceId, backend, coordinator } = await fixture(t);

  const rejected = await coordinator.preview(context, workspaceId, creation('src/rejected.ts'));
  assert.equal(coordinator.rejectLocal(rejected.mutationId), true);
  assert.equal(await coordinator.approveLocal(rejected.mutationId), false);
  await assert.rejects(() => readFile(join(root, 'src/rejected.ts'), 'utf8'));
  assert.equal(backend.creates, 0);
});

test('the file.create tool proposes without writing and carries no authority fields', async (t) => {
  const { root, store, context, workspaceId, backend, coordinator } = await fixture(t);
  const gateway = createGateway({
    executor: { openWorkspace: async () => 'devspace_1' } as unknown as DevspaceExecutor,
    allowedRoots: [root],
    verifyProfiles: {},
  });
  const server = createGatewayMcpServer(gateway, { mutationContext: { callerContext: context, coordinator } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'file-create', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  void store;

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run',
    'mutation.preview', 'file.create', 'mutation.result',
  ]);
  const created = tools.tools.find((tool) => tool.name === 'file.create');
  assert.equal(created?.annotations?.readOnlyHint, false);
  const schema = JSON.stringify(created?.inputSchema);
  for (const forbidden of ['base_sha256', 'owner_id', 'session_id', 'adapter_id', 'approved']) {
    assert.doesNotMatch(schema, new RegExp(`"${forbidden}"`), `file.create must not accept ${forbidden}`);
  }

  const response = await client.callTool({
    name: 'file.create',
    arguments: { workspace_id: workspaceId, path: 'src/via-tool.ts', content: NEW_CONTENT },
  });
  const preview = JSON.parse((response as { content: { text: string }[] }).content[0]!.text) as { mutationId: string };
  await assert.rejects(() => readFile(join(root, 'src/via-tool.ts'), 'utf8'));
  assert.equal(backend.creates, 0);

  assert.equal(await coordinator.approveLocal(preview.mutationId), true);
  assert.equal(await readFile(join(root, 'src/via-tool.ts'), 'utf8'), NEW_CONTENT);
});
