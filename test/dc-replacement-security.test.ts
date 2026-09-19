import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext, type GatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { FileMutationBackend } from '../src/file-mutation-backend.js';
import type { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';
import { PRIVATE_STDIO_ADAPTER_ID } from '../src/repository-engineering-runtime.js';

const OPERATOR_SECRET = 'operator-bootstrap-token-must-never-leak';
const STATE_PATH_MARKER = 'control-plane-state-marker.sqlite';
const ORIGINAL = 'alpha\nbeta\n';

interface Recorded { path: string; candidate: string; }

/** Records writes instead of performing them, so "no write happened" is directly provable. */
function recordingBackend(writes: Recorded[]): FileMutationBackend {
  return {
    kind: 'devspace',
    readExact: async () => ORIGINAL,
    readExactIfPresent: async () => ORIGINAL,
    createNew: async (_root: string, path: string, candidate: string) => {
      writes.push({ path, candidate });
    },
    updateExisting: async (_root: string, path: string, _original: string, candidate: string) => {
      writes.push({ path, candidate });
    },
  };
}

function stubExecutor() {
  return {
    openWorkspace: async (root: string) => `devspace_${root.length}`,
    execCommand: async () => ({ output: '', exitCode: 1, running: false }),
    interruptCommand: async () => {},
  } as unknown as DevspaceExecutor;
}

async function surface(
  t: test.TestContext,
  store: SqliteDurableStore,
  coordinator: DurableMutationCoordinator,
  callerContext: GatewayCallerContext,
  root: string,
) {
  const gateway = createGateway({ executor: stubExecutor(), allowedRoots: [root], verifyProfiles: {} });
  const server = createGatewayMcpServer(gateway, { inspect: true, mutationContext: { callerContext, coordinator } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dc-replacement-security', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  void store;
  return client;
}

function callerFor(sessionId: string): GatewayCallerContext {
  return createGatewayCallerContext({
    ownerId: 'local.private.stdio', sessionId, adapterId: PRIVATE_STDIO_ADAPTER_ID,
  });
}

/**
 * Creates a workspace plus a `track` helper. Tracked SQLite handles are closed before the
 * directory is removed, because Windows refuses to unlink a database that is still open.
 */
async function workspaceFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-security-'));
  const open: SqliteDurableStore[] = [];
  t.after(async () => {
    for (const store of open) { try { store.close(); } catch { /* already closed */ } }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'note.txt'), ORIGINAL);
  await writeFile(join(root, '..', 'outside-canary.txt'), 'WAG_BENCH_OUTSIDE_CANARY_DO_NOT_DISCLOSE\n').catch(() => undefined);
  return { root, track: (store: SqliteDurableStore) => { open.push(store); return store; } };
}

function baseSha() { return createHash('sha256').update(ORIGINAL, 'utf8').digest('hex'); }

function text(response: unknown): string {
  return JSON.stringify(response);
}

// --------------------------------------------------------------------------
// Gate 6 — security
// --------------------------------------------------------------------------

test('a foreign caller tuple cannot read a durable mutation record', async (t) => {
  const { root, track } = await workspaceFixture(t);
  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());
  const writes: Recorded[] = [];
  const coordinator = new DurableMutationCoordinator({ store, backends: [recordingBackend(writes)] });
  const owner = callerFor('sid_owner');
  const workspace = store.openWorkspaceRecord({
    ownerId: owner.ownerId, sessionId: owner.sessionId, adapterId: owner.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: Date.now(),
  });
  const preview = await coordinator.preview(owner, workspace.workspaceId, {
    path: 'note.txt', baseSha256: baseSha(), before: 'beta', after: 'BETA',
  });

  for (const foreign of [
    createGatewayCallerContext({ ownerId: 'other.owner', sessionId: 'sid_owner', adapterId: PRIVATE_STDIO_ADAPTER_ID }),
    callerFor('sid_other'),
    createGatewayCallerContext({ ownerId: 'local.private.stdio', sessionId: 'sid_owner', adapterId: 'browser.chatgpt.native.verify.v3' }),
  ]) {
    assert.throws(() => coordinator.result(foreign, preview.mutationId),
      'a mismatched owner, session or adapter must fail closed');
  }
  assert.throws(() => coordinator.result(owner, 'mut_does_not_exist'), /Unknown mutation_id/);
  assert.deepEqual(writes, [], 'denied lookups must never execute a write');
});

test('a restarted gateway session cannot read a mutation proposed by the previous process', async (t) => {
  const { root, track } = await workspaceFixture(t);
  const statePath = join(root, STATE_PATH_MARKER);
  const first = track(new SqliteDurableStore(statePath));
  const writes: Recorded[] = [];
  const before = callerFor('sid_before_restart');
  const workspace = first.openWorkspaceRecord({
    ownerId: before.ownerId, sessionId: before.sessionId, adapterId: before.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: Date.now(),
  });
  const firstCoordinator = new DurableMutationCoordinator({ store: first, backends: [recordingBackend(writes)] });
  const preview = await firstCoordinator
    .preview(before, workspace.workspaceId, { path: 'note.txt', baseSha256: baseSha(), before: 'beta', after: 'BETA' });
  const originalDeadline = firstCoordinator.result(before, preview.mutationId).reviewDeadline;
  assert.equal(typeof originalDeadline, 'number');
  first.close();

  const second = track(new SqliteDurableStore(statePath));
  const restarted = new DurableMutationCoordinator({ store: second, backends: [recordingBackend(writes)] });
  await restarted.reconcile();

  assert.throws(() => restarted.result(callerFor('sid_after_restart'), preview.mutationId),
    'a new gateway session must not inherit the previous session read authority');
  assert.equal(restarted.reviewLocal(preview.mutationId)?.reviewDeadline, originalDeadline,
    'restart must not refresh the review deadline');
  assert.deepEqual(writes, [], 'restart alone must never execute a write');
});

test('an expired review deadline is terminal and can never execute', async (t) => {
  const { root, track } = await workspaceFixture(t);
  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());
  const writes: Recorded[] = [];
  let clock = 1_000_000;
  const coordinator = new DurableMutationCoordinator({
    store, backends: [recordingBackend(writes)], now: () => clock,
  });
  const caller = callerFor('sid_expiry');
  const workspace = store.openWorkspaceRecord({
    ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: clock,
  });
  const preview = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: baseSha(), before: 'beta', after: 'BETA',
  });

  clock += 60_001;
  await coordinator.reconcile();
  assert.equal(await coordinator.approveLocal(preview.mutationId), false,
    'approval after the review deadline must be refused');
  assert.deepEqual(writes, [], 'an expired proposal must never execute');
  assert.notEqual(coordinator.result(caller, preview.mutationId).state, 'SUCCEEDED');
});

test('operator reject is terminal and executes nothing', async (t) => {
  const { root, track } = await workspaceFixture(t);
  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());
  const writes: Recorded[] = [];
  const coordinator = new DurableMutationCoordinator({ store, backends: [recordingBackend(writes)] });
  const caller = callerFor('sid_reject');
  const workspace = store.openWorkspaceRecord({
    ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: Date.now(),
  });
  const preview = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: baseSha(), before: 'beta', after: 'BETA',
  });

  assert.equal(coordinator.rejectLocal(preview.mutationId), true);
  assert.deepEqual(writes, []);
  assert.equal(await coordinator.approveLocal(preview.mutationId), false,
    'a rejected proposal must not be approvable afterwards');
  assert.deepEqual(writes, [], 'reject must remain terminal');
});

test('local approval is single use and a replay cannot produce a second write', async (t) => {
  const { root, track } = await workspaceFixture(t);
  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());
  const writes: Recorded[] = [];
  const coordinator = new DurableMutationCoordinator({ store, backends: [recordingBackend(writes)] });
  const caller = callerFor('sid_replay');
  const workspace = store.openWorkspaceRecord({
    ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: Date.now(),
  });
  const preview = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: baseSha(), before: 'beta', after: 'BETA',
  });

  const [first, ...rest] = await Promise.all([
    coordinator.approveLocal(preview.mutationId),
    coordinator.approveLocal(preview.mutationId),
    coordinator.approveLocal(preview.mutationId),
  ]);
  assert.equal([first, ...rest].filter(Boolean).length, 1, 'concurrent approvals must collapse to one');
  assert.equal(await coordinator.approveLocal(preview.mutationId), false, 'a later replay must be refused');
  assert.equal(writes.length, 1, 'one approval must produce exactly one write');
  assert.equal(writes[0]!.path, 'note.txt');
});

test('mutation preview performs no write and never echoes local operator or state secrets', async (t) => {
  const { root, track } = await workspaceFixture(t);
  const store = track(new SqliteDurableStore(join(root, STATE_PATH_MARKER)));
  const writes: Recorded[] = [];
  const coordinator = new DurableMutationCoordinator({ store, backends: [recordingBackend(writes)] });
  const caller = callerFor('sid_leak');
  const client = await surface(t, store, coordinator, caller, root);

  const opened = await client.callTool({ name: 'workspace.open', arguments: { path: root } });
  const workspaceId = (JSON.parse((opened as { content: { text: string }[] }).content[0]!.text) as { workspaceId: string }).workspaceId;
  // The MCP-opened workspace is not a durable record, so bind one for the coordinator.
  const durable = store.openWorkspaceRecord({
    ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: Date.now(),
  });

  const preview = await client.callTool({
    name: 'mutation.preview',
    arguments: { workspace_id: durable.workspaceId, path: 'note.txt', base_sha256: baseSha(), before: 'beta', after: 'BETA' },
  });
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), ORIGINAL, 'preview must not touch the file');
  assert.deepEqual(writes, []);

  const mutationId = (JSON.parse((preview as { content: { text: string }[] }).content[0]!.text) as { mutationId: string }).mutationId;
  const result = await client.callTool({ name: 'mutation.result', arguments: { mutation_id: mutationId } });

  for (const response of [opened, preview, result]) {
    for (const secret of [OPERATOR_SECRET, STATE_PATH_MARKER, 'bootstrap', 'csrf', 'wag_operator_session', root]) {
      assert.equal(text(response).toLowerCase().includes(secret.toLowerCase()), false,
        `MCP responses must never carry ${secret}`);
    }
  }
  void workspaceId;
});

test('untrusted repository instructions cannot reach outside the admitted workspace', async (t) => {
  const { root, track } = await workspaceFixture(t);
  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());
  const writes: Recorded[] = [];
  const coordinator = new DurableMutationCoordinator({ store, backends: [recordingBackend(writes)] });
  const caller = callerFor('sid_escape');
  const client = await surface(t, store, coordinator, caller, root);
  const opened = await client.callTool({ name: 'workspace.open', arguments: { path: root } });
  const workspaceId = (JSON.parse((opened as { content: { text: string }[] }).content[0]!.text) as { workspaceId: string }).workspaceId;

  const escapes = ['../outside-canary.txt', '..\\outside-canary.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'note.txt/../../outside-canary.txt'];
  for (const path of escapes) {
    const read = await client.callTool({ name: 'file.read', arguments: { workspace_id: workspaceId, path } });
    assert.equal((read as { isError?: boolean }).isError, true, `file.read must deny ${path}`);
    assert.equal(text(read).includes('DO_NOT_DISCLOSE'), false);

    const search = await client.callTool({ name: 'repo.search', arguments: { workspace_id: workspaceId, query: 'WAG_BENCH_OUTSIDE_CANARY' } });
    assert.equal(text(search).includes('DO_NOT_DISCLOSE'), false,
      'bounded tracked-file search must never surface outside-workspace content');
  }

  const durable = store.openWorkspaceRecord({
    ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: Date.now(),
  });
  for (const path of escapes) {
    const attempt = await client.callTool({
      name: 'mutation.preview',
      arguments: { workspace_id: durable.workspaceId, path, base_sha256: baseSha(), before: 'a', after: 'b' },
    });
    assert.equal((attempt as { isError?: boolean }).isError, true, `mutation.preview must deny ${path}`);
  }
  assert.deepEqual(writes, [], 'no escape attempt may produce a write');
});

test('a mutation proposal cannot select its own caller authority', async (t) => {
  const { root, track } = await workspaceFixture(t);
  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());
  const writes: Recorded[] = [];
  const coordinator = new DurableMutationCoordinator({ store, backends: [recordingBackend(writes)] });
  const caller = callerFor('sid_authority');
  const client = await surface(t, store, coordinator, caller, root);
  const durable = store.openWorkspaceRecord({
    ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId,
    canonicalRoot: root, backendKind: 'devspace', createdAt: Date.now(),
  });

  const injected = await client.callTool({
    name: 'mutation.preview',
    arguments: {
      workspace_id: durable.workspaceId, path: 'note.txt', base_sha256: baseSha(),
      before: 'beta', after: 'BETA', owner_id: 'attacker', approved: true,
    },
  });
  assert.equal((injected as { isError?: boolean }).isError, true,
    'the strict schema must reject any client-supplied authority field');
  assert.deepEqual(writes, []);
});
