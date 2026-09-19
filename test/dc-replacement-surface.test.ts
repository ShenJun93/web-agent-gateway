import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { DevspaceExecutor, ExecResult } from '../src/executor/devspace.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';
import type { GatewayTelemetryEvent } from '../src/telemetry.js';

const DEFAULT_TOOLS = ['health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run'];
const INSPECT_TOOLS = ['health', 'workspace.open', 'repo.list', 'repo.search', 'repo.snapshot', 'repo.diff', 'file.read', 'verify.run'];
const MUTATION_TOOLS = [...DEFAULT_TOOLS, 'mutation.preview', 'mutation.result'];
const FULL_TOOLS = [...INSPECT_TOOLS, 'mutation.preview', 'mutation.result'];

/** Every capability DC exposes that WAG must keep unavailable on every stdio profile. */
const FORBIDDEN_TOOL_FRAGMENTS = [
  'verify.preview', 'verify.result', 'job.', 'shell', 'process', 'terminal', 'pty', 'exec',
  'git.', 'commit', 'push', 'file.write', 'file.patch', 'file.move', 'file.delete',
  'directory', 'config.set', 'set_config', 'forward',
];

interface StubCall { workspaceId: string; command: string; }

function stubExecutor(result: ExecResult, calls: StubCall[] = []) {
  const executor = {
    openWorkspace: async (root: string) => `devspace_${root.length}`,
    execCommand: async (workspaceId: string, command: string) => {
      calls.push({ workspaceId, command });
      return result;
    },
    interruptCommand: async () => {},
  } as unknown as DevspaceExecutor;
  return { executor, calls };
}

/** The search helper encodes `<helper64> <query64> <ignoreCase> <contextLines>`. */
function decodeSearchCommand(command: string) {
  const parts = command.trim().split(' ');
  return {
    query: Buffer.from(parts[parts.length - 3]!, 'base64url').toString('utf8'),
    ignoreCase: parts[parts.length - 2],
    contextLines: parts[parts.length - 1],
  };
}

async function connect(t: test.TestContext, server: ReturnType<typeof createGatewayMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dc-replacement-surface', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

function gatewayWith(executor: DevspaceExecutor, telemetry?: { record(event: GatewayTelemetryEvent): void }) {
  return createGateway({
    executor,
    allowedRoots: [process.cwd()],
    verifyProfiles: { unit: { argv: ['node', '--version'] } },
    telemetry,
  });
}

// --------------------------------------------------------------------------
// Gate 2 — gateway repoSearch
// --------------------------------------------------------------------------

test('gateway repo.search delegates through the shared inspection backend with accepted defaults', async () => {
  const { executor, calls } = stubExecutor({ output: '', exitCode: 1, running: false });
  const gateway = gatewayWith(executor);
  const { workspaceId } = await gateway.openWorkspace(process.cwd());

  const result = await gateway.repoSearch(workspaceId, 'canonicalizeTicketId');

  assert.deepEqual(result, { matches: [], truncated: false });
  assert.equal(calls.length, 1);
  const decoded = decodeSearchCommand(calls[0]!.command);
  assert.equal(decoded.query, 'canonicalizeTicketId');
  assert.equal(decoded.ignoreCase, '0', 'ignoreCase must default to false');
  assert.equal(decoded.contextLines, '1', 'contextLines must default to 1');
  assert.equal(calls[0]!.workspaceId, `devspace_${process.cwd().length}`,
    'search must use the same workspace binding as file.read and repo.snapshot');
});

test('gateway repo.search clamps caller options to the accepted browser bounds', async () => {
  for (const [requested, expected] of [[0, '0'], [5, '2'], [2, '2']] as const) {
    const { executor, calls } = stubExecutor({ output: '', exitCode: 1, running: false });
    const gateway = gatewayWith(executor);
    const { workspaceId } = await gateway.openWorkspace(process.cwd());
    await gateway.repoSearch(workspaceId, 'query', { contextLines: requested, maxResults: 9_999, ignoreCase: true });
    const decoded = decodeSearchCommand(calls[0]!.command);
    assert.equal(decoded.contextLines, expected, `contextLines ${requested} must clamp to ${expected}`);
    assert.equal(decoded.ignoreCase, '1');
  }
});

test('gateway repo.search rejects an unknown workspace id and emits telemetry outcomes', async () => {
  const events: GatewayTelemetryEvent[] = [];
  const { executor } = stubExecutor({ output: '', exitCode: 1, running: false });
  const gateway = gatewayWith(executor, { record(event) { events.push(event); } });

  await assert.rejects(() => gateway.repoSearch('ws_not_real', 'query'), /Unknown workspace_id/);

  const { workspaceId } = await gateway.openWorkspace(process.cwd());
  await gateway.repoSearch(workspaceId, 'query');

  const searchEvents = events.filter((event) => event.tool === 'repo.search');
  assert.equal(searchEvents.length, 2, 'both the failure and the success must be traced');
  assert.deepEqual(searchEvents.map((event) => event.success), [false, true]);
});

// --------------------------------------------------------------------------
// Gate 3 — capability profile
// --------------------------------------------------------------------------

test('private stdio default profile is exactly the accepted five tools', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor)));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), DEFAULT_TOOLS);
});

test('private stdio search opt-in adds exactly repo.search in the accepted position', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), { inspect: true }));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), INSPECT_TOOLS);

  const search = tools.tools.find((tool) => tool.name === 'repo.search');
  assert.deepEqual(search?.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
});

test('the inspect profile declares every added tool read-only and strictly typed', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), { inspect: true }));
  const tools = await client.listTools();

  for (const name of ['repo.list', 'repo.search', 'repo.diff']) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} must be present under the inspect profile`);
    assert.deepEqual(tool!.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      `${name} must be annotated read-only and non-destructive`);
  }

  const { workspaceId } = JSON.parse(String((await client.callTool({
    name: 'workspace.open', arguments: { path: process.cwd() },
  }) as { content: { text: string }[] }).content[0]!.text)) as { workspaceId: string };

  // Strict schemas: an unknown argument is a rejection, never a silently ignored field.
  for (const [name, args] of [
    ['repo.list', { workspace_id: workspaceId, recursive: true }],
    ['repo.diff', { workspace_id: workspaceId, staged: true }],
    ['repo.list', { workspace_id: workspaceId, max_entries: 0 }],
    ['repo.list', { workspace_id: workspaceId, max_entries: 1_001 }],
  ] as const) {
    const response = await client.callTool({ name, arguments: args as Record<string, unknown> });
    assert.equal((response as { isError?: boolean }).isError, true,
      `${name} must reject ${JSON.stringify(args)}`);
  }
});

test('private stdio search opt-in is an explicit true, never a truthy value', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), { inspect: false }));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), DEFAULT_TOOLS);
});

test('private stdio profiles compose independently and never expose DC-class authority', async (t) => {
  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());
  const callerContext = createGatewayCallerContext({
    ownerId: 'local.private.stdio', sessionId: 'sid_surface', adapterId: 'private.stdio.v1',
  });
  const coordinator = new DurableMutationCoordinator({
    store,
    backends: [{ kind: 'devspace', readExact: async () => 'x', updateExisting: async () => undefined }],
  });

  for (const [options, expected] of [
    [{ mutationContext: { callerContext, coordinator } }, MUTATION_TOOLS],
    [{ inspect: true, mutationContext: { callerContext, coordinator } }, FULL_TOOLS],
  ] as const) {
    const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
    const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), options));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), expected);

    for (const name of tools.tools.map((tool) => tool.name)) {
      for (const forbidden of FORBIDDEN_TOOL_FRAGMENTS) {
        assert.equal(name.includes(forbidden), false, `stdio surface must not expose ${name}`);
      }
    }
  }
});

test('private stdio repo.search rejects control characters and oversized queries', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 1, running: false });
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), { inspect: true }));
  const { workspaceId } = JSON.parse(String((await client.callTool({
    name: 'workspace.open', arguments: { path: process.cwd() },
  }) as { content: { text: string }[] }).content[0]!.text)) as { workspaceId: string };

  for (const query of ['line\nbreak', 'carriage\rreturn', 'nul\u0000byte', 'x'.repeat(257)]) {
    const response = await client.callTool({ name: 'repo.search', arguments: { workspace_id: workspaceId, query } });
    assert.equal((response as { isError?: boolean }).isError, true, `query ${JSON.stringify(query.slice(0, 12))} must be denied`);
  }
});
