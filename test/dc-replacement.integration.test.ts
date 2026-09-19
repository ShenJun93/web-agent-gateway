import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DevspaceFileMutationBackend } from '../src/executor/devspace-file-mutation.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';
import { PRIVATE_STDIO_ADAPTER_ID } from '../src/repository-engineering-runtime.js';
import {
  DC_FIXTURE_BASELINE_HEAD,
  DC_FIXTURE_BASELINE_TREE,
  DC_FIXTURE_FIXED_IMPLEMENTATION,
  DC_FIXTURE_IMPLEMENTATION,
  DC_FIXTURE_SENTINEL,
  DC_FIXTURE_TEST,
  fixtureStatus,
  materializeDcReplacementFixture,
} from './dc-replacement-fixture.js';
import { startPinnedDevspace } from './devspace-fixture.js';

interface ToolText { content: { text: string }[] }

function parse<T>(response: unknown): T {
  return JSON.parse((response as ToolText).content[0]!.text) as T;
}

/**
 * Exercises every DC Replacement Workflow Benchmark v1 repository-engineering scenario
 * (R0, R1, R2, V1, C1, D1) through the private stdio capability profile, against the real
 * pinned DevSpace and a fresh copy of the committed benchmark fixture.
 */
test('the extended private stdio profile completes the DC repository-engineering loop', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-dc-integration-'));
  const fixture = await materializeDcReplacementFixture(temp);
  assert.equal(fixture.head, DC_FIXTURE_BASELINE_HEAD, 'fixture must start at the deterministic baseline');
  assert.equal(fixture.tree, DC_FIXTURE_BASELINE_TREE);

  const devspace = await startPinnedDevspace({ workspaceRoot: fixture.workspaceRoot });
  const store = new SqliteDurableStore(join(temp, 'control-plane.sqlite'));
  t.after(async () => {
    store.close();
    await devspace.stop();
    await rm(temp, { recursive: true, force: true });
  });

  const callerContext = createGatewayCallerContext({
    ownerId: 'local.private.stdio', sessionId: 'sid_integration', adapterId: PRIVATE_STDIO_ADAPTER_ID,
  });
  const executor = new DevspaceExecutor({ baseUrl: devspace.baseUrl, accessToken: devspace.accessToken });
  const gateway = createGateway({
    executor,
    allowedRoots: [fixture.workspaceRoot],
    verifyProfiles: { unit: { argv: ['npm', 'test'], timeoutMs: 30_000, maxOutputTokens: 4_000 } },
    openWorkspaceId: (canonicalRoot) => store.openWorkspaceRecord({
      ownerId: callerContext.ownerId, sessionId: callerContext.sessionId, adapterId: callerContext.adapterId,
      canonicalRoot, backendKind: 'devspace', createdAt: Date.now(),
    }).workspaceId,
  });
  const coordinator = new DurableMutationCoordinator({
    store, backends: [new DevspaceFileMutationBackend(executor)],
  });
  await coordinator.reconcile();

  const server = createGatewayMcpServer(gateway, { inspect: true, mutationContext: { callerContext, coordinator } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dc-replacement-integration', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.list', 'repo.search', 'repo.snapshot', 'repo.diff',
    'file.read', 'verify.run',
    'mutation.preview', 'file.create', 'mutation.result',
  ]);

  const { workspaceId } = parse<{ workspaceId: string }>(
    await client.callTool({ name: 'workspace.open', arguments: { path: fixture.workspaceRoot } }));

  // R0 — bounded read of the exact sentinel.
  const sentinel = parse<{ content: string }>(
    await client.callTool({ name: 'file.read', arguments: { workspace_id: workspaceId, path: 'docs/sentinel.txt' } }));
  assert.equal(sentinel.content, DC_FIXTURE_SENTINEL);

  // R1 — discovery. The implementation path is not supplied; it must be found.
  const search = parse<{ matches: { path: string }[]; truncated: boolean }>(
    await client.callTool({ name: 'repo.search', arguments: { workspace_id: workspaceId, query: 'canonicalizeTicketId' } }));
  const found = new Set(search.matches.map((match) => match.path));
  assert.ok(found.has(DC_FIXTURE_IMPLEMENTATION), `R1 must locate ${DC_FIXTURE_IMPLEMENTATION}, saw ${[...found].join(', ')}`);
  assert.ok(found.has(DC_FIXTURE_TEST), `R1 must locate ${DC_FIXTURE_TEST}, saw ${[...found].join(', ')}`);

  // R2 — repository state.
  const snapshot = parse<{ branch: string; head: string; dirty: boolean; files: string[] }>(
    await client.callTool({ name: 'repo.snapshot', arguments: { workspace_id: workspaceId } }));
  assert.equal(snapshot.branch, 'main');
  assert.equal(snapshot.head, DC_FIXTURE_BASELINE_HEAD);
  assert.equal(snapshot.dirty, false);
  assert.ok(snapshot.files.includes(DC_FIXTURE_IMPLEMENTATION));

  // V1 — named verification reproduces the documented baseline oracle.
  const baseline = parse<{ profile: string; exitCode: number; output: string }>(
    await client.callTool({ name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'unit' } }));
  assert.equal(baseline.profile, 'unit');
  assert.equal(baseline.exitCode, 1, 'the baseline fixture must fail exactly one test');
  assert.match(baseline.output, /tests 2/);
  assert.match(baseline.output, /pass 1/);
  assert.match(baseline.output, /fail 1/);

  // C1 — reviewed change. The preview alone must not touch the repository.
  const original = await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8');
  const preview = parse<{ status: string; mutationId: string }>(await client.callTool({
    name: 'mutation.preview',
    arguments: {
      workspace_id: workspaceId,
      path: DC_FIXTURE_IMPLEMENTATION,
      base_sha256: createHash('sha256').update(original, 'utf8').digest('hex'),
      before: 'return value.toLowerCase();',
      after: 'return value.trim().toLowerCase();',
    },
  }));
  assert.equal(preview.status, 'approval_required');
  assert.equal(await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8'), original,
    'a proposal must never write before local approval');
  assert.deepEqual(await fixtureStatus(fixture.workspaceRoot), [],
    'a proposal must leave the repository clean');

  assert.equal(await coordinator.approveLocal(preview.mutationId), true);
  assert.equal(parse<{ state: string }>(
    await client.callTool({ name: 'mutation.result', arguments: { mutation_id: preview.mutationId } })).state, 'SUCCEEDED');
  assert.equal(await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8'),
    DC_FIXTURE_FIXED_IMPLEMENTATION);

  // D1 — the loop closes: re-verify and re-inspect through the same surface.
  const afterFix = parse<{ exitCode: number; output: string }>(
    await client.callTool({ name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'unit' } }));
  assert.equal(afterFix.exitCode, 0, 'the approved change must make verification pass');
  assert.match(afterFix.output, /pass 2/);
  assert.match(afterFix.output, /fail 0/);

  const finalSnapshot = parse<{ branch: string; head: string; dirty: boolean }>(
    await client.callTool({ name: 'repo.snapshot', arguments: { workspace_id: workspaceId } }));
  assert.equal(finalSnapshot.branch, 'main');
  assert.equal(finalSnapshot.head, DC_FIXTURE_BASELINE_HEAD, 'no commit may be created');
  assert.equal(finalSnapshot.dirty, true);

  assert.deepEqual(await fixtureStatus(fixture.workspaceRoot), [`M ${DC_FIXTURE_IMPLEMENTATION}`],
    'exactly one tracked file may change and no untracked residue may remain');
});

test('a rejected proposal leaves the benchmark fixture byte-identical', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-dc-integration-reject-'));
  const fixture = await materializeDcReplacementFixture(temp);
  const devspace = await startPinnedDevspace({ workspaceRoot: fixture.workspaceRoot });
  const store = new SqliteDurableStore(join(temp, 'control-plane.sqlite'));
  t.after(async () => {
    store.close();
    await devspace.stop();
    await rm(temp, { recursive: true, force: true });
  });

  const callerContext = createGatewayCallerContext({
    ownerId: 'local.private.stdio', sessionId: 'sid_reject', adapterId: PRIVATE_STDIO_ADAPTER_ID,
  });
  const executor = new DevspaceExecutor({ baseUrl: devspace.baseUrl, accessToken: devspace.accessToken });
  const workspace = store.openWorkspaceRecord({
    ownerId: callerContext.ownerId, sessionId: callerContext.sessionId, adapterId: callerContext.adapterId,
    canonicalRoot: fixture.workspaceRoot, backendKind: 'devspace', createdAt: Date.now(),
  });
  const coordinator = new DurableMutationCoordinator({
    store, backends: [new DevspaceFileMutationBackend(executor)],
  });

  const original = await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8');
  const preview = await coordinator.preview(callerContext, workspace.workspaceId, {
    path: DC_FIXTURE_IMPLEMENTATION,
    baseSha256: createHash('sha256').update(original, 'utf8').digest('hex'),
    before: 'return value.toLowerCase();',
    after: 'return value.trim().toLowerCase();',
  });

  assert.equal(coordinator.rejectLocal(preview.mutationId), true);
  assert.equal(await coordinator.approveLocal(preview.mutationId), false);
  assert.equal(await readFile(join(fixture.workspaceRoot, DC_FIXTURE_IMPLEMENTATION), 'utf8'), original);
  assert.deepEqual(await fixtureStatus(fixture.workspaceRoot), []);
});
