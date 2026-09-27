import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import { PRIVATE_STDIO_ADAPTER_ID } from '../src/repository-engineering-runtime.js';
import { createGatewayMcpServer } from '../src/server.js';
import { ToolUsageDiagnostics } from '../src/tool-usage-diagnostics.js';

const EFFECT_ID = 'effect_00000000-0000-4000-8000-000000000901';
const ATTEMPT_ID = 'attempt_00000000-0000-4000-8000-000000000902';
const MUTATION_ID = 'mut_00000000-0000-4000-8000-000000000903';
const COMMIT_ID = 'cmt_00000000-0000-4000-8000-000000000904';

test('tool usage diagnostics is bounded, sanitized and groups outcomes by tool', () => {
  const diagnostics = new ToolUsageDiagnostics(16);

  let finish = diagnostics.begin('alpha');
  const firstRequestId = finish.requestId;
  finish(true);

  finish = diagnostics.begin('alpha');
  finish(false, new TypeError('secret-bearing message must not be retained'));

  finish = diagnostics.begin('beta');
  finish(true);

  const recent = diagnostics.recent({ limit: 10 });
  assert.equal(recent.events.length, 3);
  assert.deepEqual(recent.events.map((event) => event.tool), ['alpha', 'alpha', 'beta']);
  assert.deepEqual(recent.events.map((event) => event.success), [true, false, true]);
  assert.match(firstRequestId, /^request_[0-9a-f-]{36}$/);
  assert.equal(recent.events[0]?.request_id, firstRequestId);
  assert.equal(recent.events[1]?.error_class, 'TypeError');
  assert.deepEqual(recent.in_flight, []);
  assert.equal(JSON.stringify(recent).includes('secret-bearing'), false);

  const usage = diagnostics.usage();
  assert.equal(usage.total_calls, 3);
  assert.equal(usage.successes, 2);
  assert.equal(usage.failures, 1);
  assert.deepEqual(
    usage.tools.map((entry) => ({
      tool: entry.tool,
      calls: entry.calls,
      failures: entry.failures,
    })),
    [
      { tool: 'alpha', calls: 2, failures: 1 },
      { tool: 'beta', calls: 1, failures: 0 },
    ],
  );
});

test('diagnostics exposes in-flight request identity then durable effect correlation on completion', () => {
  let n = 1;
  const diagnostics = new ToolUsageDiagnostics({
    capacity: 16,
    randomUUID: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  });

  const finish = diagnostics.begin('browser.exec');
  const during = diagnostics.recent();
  assert.equal(during.events.length, 0);
  assert.equal(during.in_flight.length, 1);
  assert.equal(during.in_flight[0]?.request_id, finish.requestId);
  assert.equal(during.in_flight[0]?.tool, 'browser.exec');
  assert.ok((during.in_flight[0]?.elapsed_ms ?? -1) >= 0);

  finish(true, undefined, { effectId: EFFECT_ID, attemptId: ATTEMPT_ID });
  const after = diagnostics.recent();
  assert.deepEqual(after.in_flight, []);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0]?.request_id, finish.requestId);
  assert.equal(after.events[0]?.effect_id, EFFECT_ID);
  assert.equal(after.events[0]?.attempt_id, ATTEMPT_ID);
});

test('diagnostics retains only opaque mutation and commit ids from correlation', () => {
  const diagnostics = new ToolUsageDiagnostics(16);
  diagnostics.begin('mutation.preview')(true, undefined, {
    mutationId: MUTATION_ID,
    commitId: COMMIT_ID,
  });

  const [event] = diagnostics.recent().events;
  assert.equal(event?.mutation_id, MUTATION_ID);
  assert.equal(event?.commit_id, COMMIT_ID);
  assert.equal('mutationId' in (event ?? {}), false);
  assert.equal('commitId' in (event ?? {}), false);
});

test('an interrupted turn recovers mutation_id and commit_id from diagnostics and reads durable state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-diagnostics-recovery-'));
  const original = 'alpha\n';
  await writeFile(join(root, 'note.txt'), original);
  const store = new SqliteDurableStore(':memory:');
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const callerContext = createGatewayCallerContext({
    ownerId: 'local.private.stdio',
    sessionId: 'session_diagnostics_recovery',
    adapterId: PRIVATE_STDIO_ADAPTER_ID,
  });
  const workspace = store.openWorkspaceRecord({
    ownerId: callerContext.ownerId,
    sessionId: callerContext.sessionId,
    adapterId: callerContext.adapterId,
    canonicalRoot: root,
    backendKind: 'fake',
    createdAt: Date.now(),
  });

  const mutationCoordinator = new DurableMutationCoordinator({
    store,
    backends: [{
      kind: 'fake',
      readExact: async () => original,
      readExactIfPresent: async () => original,
      createNew: async () => undefined,
      updateExisting: async () => undefined,
    }],
  });
  const commitCoordinator = new DurableCommitCoordinator({
    store,
    backend: {
      kind: 'fake',
      plan: async () => ({
        branch: 'work',
        ref: 'refs/heads/work',
        head: '1'.repeat(40),
        tree: '2'.repeat(40),
        changes: [{ status: 'M' as const, path: 'note.txt' }],
        author: 'WAG Test <wag@example.invalid>',
        committer: 'WAG Test <wag@example.invalid>',
        gitDir: join(root, '.git'),
        commonDir: join(root, '.git'),
        eolNormalized: [],
      }),
      commit: async () => { throw new Error('not exercised'); },
    },
  });
  const diagnostics = new ToolUsageDiagnostics();
  const gateway = {
    async health() { return { status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 6 }; },
    async openWorkspace() { throw new Error('not used'); },
    async readFile() { throw new Error('not used'); },
    async verifyRun() { throw new Error('not used'); },
    async commandRun() { throw new Error('not used'); },
    async repoSnapshot() { throw new Error('not used'); },
    async repoList() { throw new Error('not used'); },
    async repoDiff() { throw new Error('not used'); },
    async repoSearch() { throw new Error('not used'); },
  } as never;

  const server = createGatewayMcpServer(gateway, {
    mutationContext: { callerContext, coordinator: mutationCoordinator },
    gitCommitContext: { callerContext, coordinator: commitCoordinator },
    diagnosticsContext: diagnostics,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'diagnostics-recovery', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const baseSha256 = createHash('sha256').update(original, 'utf8').digest('hex');

  // The caller deliberately discards the proposal response, simulating a response-stream interruption.
  void await client.callTool({
    name: 'mutation.preview',
    arguments: {
      workspace_id: workspace.workspaceId,
      path: 'note.txt',
      base_sha256: baseSha256,
      before: 'alpha',
      after: 'beta',
    },
  });

  const mutationRecent = await client.callTool({ name: 'diagnostics.recent', arguments: { limit: 20 } });
  const mutationEvents = (mutationRecent.structuredContent as {
    events: Array<{ tool: string; mutation_id?: string }>;
  }).events;
  const mutationId = mutationEvents.find((event) => event.tool === 'mutation.preview')?.mutation_id;
  assert.match(mutationId ?? '', /^mut_[A-Za-z0-9-]+$/);

  const mutationState = await client.callTool({
    name: 'mutation.result',
    arguments: { mutation_id: mutationId },
  });
  assert.equal((mutationState.structuredContent as { state?: string }).state, 'PENDING_APPROVAL');

  void await client.callTool({
    name: 'git.commit',
    arguments: {
      workspace_id: workspace.workspaceId,
      paths: ['note.txt'],
      message: 'test: diagnostics recovery',
    },
  });

  const commitRecent = await client.callTool({ name: 'diagnostics.recent', arguments: { limit: 20 } });
  const recentContent = commitRecent.structuredContent as {
    events: Array<{ tool: string; mutation_id?: string; commit_id?: string }>;
  };
  const commitId = recentContent.events.find((event) => event.tool === 'git.commit')?.commit_id;
  assert.match(commitId ?? '', /^cmt_[A-Za-z0-9-]+$/);

  const commitState = await client.callTool({
    name: 'git.commit.result',
    arguments: { commit_id: commitId },
  });
  assert.equal((commitState.structuredContent as { state?: string }).state, 'PENDING_APPROVAL');

  const serialized = JSON.stringify(recentContent);
  for (const forbidden of ['note.txt', 'alpha', 'beta', 'diagnostics recovery']) {
    assert.equal(serialized.includes(forbidden), false, `diagnostics must not retain ${forbidden}`);
  }
});

test('tool usage diagnostics retains only the configured rolling window', () => {
  const diagnostics = new ToolUsageDiagnostics(16);
  for (let index = 0; index < 20; index += 1) {
    diagnostics.begin('tool-' + String(index % 2))(true);
  }
  const recent = diagnostics.recent({ limit: 100 });
  assert.equal(recent.events.length, 16);
  assert.equal(recent.events[0]?.sequence, 5);
  assert.equal(recent.events.at(-1)?.sequence, 20);
  assert.equal(recent.capacity, 16);
  assert.equal(recent.retained_events, 16);
});

test('diagnostics MCP tools observe ordinary calls but do not recursively count themselves', async (t) => {
  const diagnostics = new ToolUsageDiagnostics();
  const gateway = {
    async health() {
      return { status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 6 };
    },
    async openWorkspace() { throw new Error('not used'); },
    async readFile() { throw new Error('not used'); },
    async verifyRun() { throw new Error('not used'); },
    async commandRun() { throw new Error('not used'); },
    async repoSnapshot() { throw new Error('not used'); },
    async repoList() { throw new Error('not used'); },
    async repoDiff() { throw new Error('not used'); },
    async repoSearch() { throw new Error('not used'); },
  } as never;

  const server = createGatewayMcpServer(gateway, { diagnosticsContext: diagnostics });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'diagnostics-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const health = await client.callTool({ name: 'health', arguments: {} });
  assert.equal(health.isError, undefined);

  const recentResponse = await client.callTool({
    name: 'diagnostics.recent',
    arguments: { limit: 10 },
  });
  assert.equal(recentResponse.isError, undefined);
  const recent = recentResponse.structuredContent as {
    events: Array<{ request_id?: string; tool: string; success: boolean }>;
    in_flight: unknown[];
  };
  assert.deepEqual(recent.events.map((event) => event.tool), ['health']);
  assert.equal(recent.events[0]?.success, true);
  assert.match(recent.events[0]?.request_id ?? '', /^request_[0-9a-f-]{36}$/);
  assert.deepEqual(recent.in_flight, []);

  const usageResponse = await client.callTool({ name: 'diagnostics.usage', arguments: {} });
  assert.equal(usageResponse.isError, undefined);
  const usage = usageResponse.structuredContent as {
    total_calls: number;
    tools: Array<{ tool: string; calls: number }>;
  };
  assert.equal(usage.total_calls, 1);
  assert.deepEqual(usage.tools.map((entry) => [entry.tool, entry.calls]), [['health', 1]]);
});

test('durable diagnostics survives runtime reconstruction with monotonic sequence and correlation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-tool-usage-'));
  const statePath = join(dir, 'tool-usage.json');
  t.after(() => rm(dir, { recursive: true, force: true }));

  let diagnostics = new ToolUsageDiagnostics({ capacity: 16, statePath });
  diagnostics.begin('alpha')(true, undefined, { effectId: EFFECT_ID, attemptId: ATTEMPT_ID });
  diagnostics.begin('beta')(false, new Error('secret-bearing failure text'));

  const onDisk = await readFile(statePath, 'utf8');
  assert.equal(onDisk.includes('secret-bearing'), false);
  assert.equal(onDisk.includes('alpha'), true);
  assert.equal(onDisk.includes('beta'), true);
  assert.equal(onDisk.includes(EFFECT_ID), true);
  assert.equal(onDisk.includes(ATTEMPT_ID), true);

  diagnostics = new ToolUsageDiagnostics({ capacity: 16, statePath });
  assert.deepEqual(
    diagnostics.recent({ limit: 10 }).events.map((event) => [
      event.sequence, event.tool, event.success, event.effect_id, event.attempt_id,
    ]),
    [
      [1, 'alpha', true, EFFECT_ID, ATTEMPT_ID],
      [2, 'beta', false, undefined, undefined],
    ],
  );

  diagnostics.begin('gamma')(true);
  diagnostics = new ToolUsageDiagnostics({ capacity: 16, statePath });
  assert.deepEqual(
    diagnostics.recent({ limit: 10 }).events.map((event) => [event.sequence, event.tool]),
    [[1, 'alpha'], [2, 'beta'], [3, 'gamma']],
  );
  assert.equal(diagnostics.usage().total_calls, 3);
});

test('pre-upgrade durable diagnostics without request ids remains readable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-tool-usage-legacy-'));
  const statePath = join(dir, 'tool-usage.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(statePath, JSON.stringify({
    version: 1,
    next_sequence: 2,
    events: [{
      sequence: 1,
      tool: 'health',
      started_at_utc: '2026-09-25T00:00:00.000Z',
      duration_ms: 1,
      success: true,
    }],
  }), 'utf8');

  const diagnostics = new ToolUsageDiagnostics({ capacity: 16, statePath });
  const recent = diagnostics.recent();
  assert.equal(recent.events.length, 1);
  assert.equal(recent.events[0]?.request_id, undefined);
  assert.equal(recent.events[0]?.tool, 'health');
});

test('malformed durable diagnostics never blocks startup and is replaced by the next event', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-tool-usage-corrupt-'));
  const statePath = join(dir, 'tool-usage.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(statePath, '{not-json', 'utf8');

  const diagnostics = new ToolUsageDiagnostics({ capacity: 16, statePath });
  assert.equal(diagnostics.recent().events.length, 0);
  diagnostics.begin('health')(true);

  const parsed = JSON.parse(await readFile(statePath, 'utf8')) as {
    version: number;
    next_sequence: number;
    events: Array<{ sequence: number; tool: string; request_id?: string }>;
  };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.next_sequence, 2);
  assert.deepEqual(parsed.events.map((event) => [event.sequence, event.tool]), [[1, 'health']]);
  assert.match(parsed.events[0]?.request_id ?? '', /^request_[0-9a-f-]{36}$/);
});
