import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { DevspaceExecutor, ExecResult } from '../src/executor/devspace.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';
import type { GatewayTelemetryEvent } from '../src/telemetry.js';

const DEFAULT_TOOLS = ['health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run'];
const INSPECT_TOOLS = ['health', 'workspace.open', 'repo.list', 'repo.search', 'repo.snapshot', 'repo.diff', 'file.read', 'verify.run'];
const MUTATION_TOOLS = [...DEFAULT_TOOLS, 'mutation.preview', 'file.replace', 'file.create', 'mutation.result'];
const FULL_TOOLS = [...INSPECT_TOOLS, 'mutation.preview', 'file.replace', 'file.create', 'mutation.result'];
const COMMIT_TOOLS = [...INSPECT_TOOLS, 'command.run', 'mutation.preview', 'file.replace', 'file.create', 'mutation.result', 'git.commit', 'git.commit.result'];

/**
 * DC-class authority stays unavailable unless WAG defines a narrower accepted contract.
 * command.run is the one accepted process capability: argv-only, Goal-Lease-authorized and
 * bounded by WAG's sanitized runner. Raw shell/terminal/PTY and broad Git/filesystem verbs remain
 * absent. git.commit and git.commit.result are the only accepted Git tools (ADR-0023).
 */
const ACCEPTED_GIT_TOOLS = new Set(['git.commit', 'git.commit.result']);
const FORBIDDEN_TOOL_FRAGMENTS = [
  'verify.preview', 'verify.result', 'job.', 'shell', 'process', 'terminal', 'pty', 'exec',
  'git.', 'commit', 'push', 'fetch', 'pull', 'merge', 'amend', 'reset', 'checkout', 'branch',
  'file.write', 'file.patch', 'file.move', 'file.delete',
  'directory', 'config.set', 'set_config', 'forward',
];

interface StubCall {
  workspaceId: string;
  command: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

function stubExecutor(result: ExecResult, calls: StubCall[] = []) {
  const executor = {
    openWorkspace: async (root: string) => `devspace_${root.length}`,
    execCommand: async (workspaceId: string, command: string, maxOutputTokens: number, timeoutMs: number) => {
      calls.push({ workspaceId, command, maxOutputTokens, timeoutMs });
      return result;
    },
    interruptCommand: async () => {},
  } as unknown as DevspaceExecutor;
  return { executor, calls };
}

/** The search helper encodes `<helper64> <query64> <ignoreCase> <contextLines>`. */
/**
 * The search command is `node -e "<stub>" <helper> <query> <ignoreCase> <contextLines> <root>`,
 * all base64url except the two small literals. Counted from the end so a future argument does
 * not silently shift what these assertions read — which is exactly what happened when the
 * admitted root was appended for the repository-identity assertion (ADR-0024).
 */
function decodeSearchCommand(command: string) {
  const parts = command.trim().split(' ');
  const decode = (value: string) => Buffer.from(value, 'base64url').toString('utf8');
  return {
    query: decode(parts[parts.length - 4]!),
    ignoreCase: parts[parts.length - 3],
    contextLines: parts[parts.length - 2],
    canonicalRoot: decode(parts[parts.length - 1]!),
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
  assert.equal(decoded.canonicalRoot, process.cwd(),
    'the helper must be told which repository it is allowed to read');
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

test('gateway command.run reuses the sanitized bounded argv runner', async () => {
  const { executor, calls } = stubExecutor({ output: 'ok\n', exitCode: 0, running: false });
  const gateway = gatewayWith(executor);
  const { workspaceId } = await gateway.openWorkspace(process.cwd());

  const result = await gateway.commandRun(
    workspaceId,
    ['node', '--version'],
    { timeoutMs: 2_345, maxOutputTokens: 678 },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'ok');
  assert.equal(result.timedOut, false);
  assert.equal(result.cwd, '.');
  assert.ok(result.durationMs >= 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.workspaceId, `devspace_${process.cwd().length}`);
  assert.equal(calls[0]!.timeoutMs, 2_345);
  assert.equal(calls[0]!.maxOutputTokens, 678);
  assert.match(calls[0]!.command, /^node -e /, 'argv must travel through the WAG-owned helper');

  for (const argv of [['node', 'hello world'], ['node', '&&'], ['node', 'x'.repeat(513)]]) {
    await assert.rejects(
      () => gateway.commandRun(workspaceId, argv),
      /Invalid verify profile argv/,
    );
  }
  assert.equal(calls.length, 1, 'unsafe argv must be refused before executor invocation');
});

test('gateway command.run accepts only a workspace-contained cwd and passes it as runner data', async () => {
  const { executor, calls } = stubExecutor({ output: 'cwd-ok\n', exitCode: 0, running: false });
  const gateway = gatewayWith(executor);
  const { workspaceId } = await gateway.openWorkspace(process.cwd());

  const result = await gateway.commandRun(workspaceId, ['node', '--version'], { cwd: 'src' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.cwd, 'src');
  assert.equal(result.timedOut, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.command, /^node -e /);

  for (const cwd of ['../escape', '/absolute', 'C:/absolute', 'src/../test']) {
    await assert.rejects(
      () => gateway.commandRun(workspaceId, ['node', '--version'], { cwd }),
      /Gateway denied|Invalid command cwd/,
    );
  }
  assert.equal(calls.length, 1, 'unsafe cwd must be refused before executor invocation');
});

test('workspace.open embeds capability preflight and capabilities.describe returns the same authority snapshot', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
  const gateway = gatewayWith(executor);
  const authority = {
    workspace_id: 'dynamic',
    lease: { state: 'ACTIVE', lease_id: 'lease_fixture', expires_at: 12345 },
    capabilities: {
      FILE_READ: { granted: true, denied: false, grantable: true, requires_human: false, reason: 'WORKSPACE_OWNED' },
      LOCAL_COMMAND: { granted: false, denied: true, grantable: true, requires_human: true, reason: 'WORKSPACE_NOT_GRANTED' },
      GIT_PUSH: { granted: false, denied: true, grantable: false, requires_human: true, reason: 'REMOTE_EFFECT_NOT_GRANTED' },
    },
  };
  const capabilityContext = {
    describe(workspaceId: string) {
      return { ...authority, workspace_id: workspaceId };
    },
  };
  const client = await connect(t, createGatewayMcpServer(gateway, { capabilityContext }));
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'capabilities.describe'));

  const openedRaw = await client.callTool({ name: 'workspace.open', arguments: { path: process.cwd() } });
  const opened = JSON.parse(String((openedRaw as { content: { text: string }[] }).content[0]!.text)) as {
    workspaceId: string;
    authority: typeof authority;
  };
  assert.equal(opened.authority.workspace_id, opened.workspaceId);
  assert.equal(opened.authority.capabilities.LOCAL_COMMAND.reason, 'WORKSPACE_NOT_GRANTED');

  const describedRaw = await client.callTool({
    name: 'capabilities.describe',
    arguments: { workspace_id: opened.workspaceId },
  });
  const described = JSON.parse(String((describedRaw as { content: { text: string }[] }).content[0]!.text)) as typeof authority;
  assert.deepEqual(described, opened.authority);
});

test('direct stdio lease-only mutation executes immediately and returns the terminal result', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
  const callerContext = createGatewayCallerContext({
    ownerId: 'owner_direct_lease',
    sessionId: 'session_direct_lease',
    adapterId: 'private.stdio.v1',
  });
  let admissions = 0;
  let rejections = 0;
  const preview = {
    status: 'approval_required' as const,
    mutationId: 'mut_direct_lease',
    fingerprint: 'f'.repeat(64),
    expiresAt: 2_000,
    path: 'note.txt',
    baseSha256: 'a'.repeat(64),
    resultSha256: 'b'.repeat(64),
    additions: 1,
    removals: 1,
  };
  const result = {
    mutationId: preview.mutationId,
    state: 'SUCCEEDED' as const,
    path: preview.path,
    baseSha256: preview.baseSha256,
    resultSha256: preview.resultSha256,
    fingerprint: preview.fingerprint,
    additions: 1,
    removals: 1,
    reviewDeadline: 2_000,
    completedAt: 1_100,
  };
  const coordinator = {
    async preview() { return preview; },
    async replace() { return preview; },
    result() { return result; },
    async admitByPolicy() { admissions += 1; return { admitted: true as const }; },
    rejectLocal() { rejections += 1; return true; },
  };
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), {
    mutationContext: { callerContext, coordinator, leaseOnly: true },
  }));

  const response = await client.callTool({
    name: 'file.replace',
    arguments: {
      workspace_id: 'ws_direct',
      path: 'note.txt',
      base_sha256: preview.baseSha256,
      content: 'changed\n',
    },
  });

  assert.notEqual(response.isError, true);
  assert.equal((response.structuredContent as { state?: string }).state, 'SUCCEEDED');
  assert.equal('status' in (response.structuredContent as object), false,
    'direct stdio must not return approval_required after policy admission');
  assert.equal(admissions, 1);
  assert.equal(rejections, 0);
});

test('direct stdio lease-only denial has no human-review fallback for mutations or commits', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
  const callerContext = createGatewayCallerContext({
    ownerId: 'owner_direct_deny',
    sessionId: 'session_direct_deny',
    adapterId: 'private.stdio.v1',
  });
  let mutationRejected = 0;
  let commitRejected = 0;
  const mutationPreview = {
    status: 'approval_required' as const,
    mutationId: 'mut_direct_deny',
    fingerprint: 'c'.repeat(64),
    expiresAt: 2_000,
    path: 'note.txt',
    baseSha256: 'a'.repeat(64),
    resultSha256: 'b'.repeat(64),
    additions: 1,
    removals: 1,
  };
  const commitPreview = {
    status: 'approval_required' as const,
    commitId: 'cmt_direct_deny',
    branch: 'work',
    oldHead: '1'.repeat(40),
    treeSha: '2'.repeat(40),
    paths: ['note.txt'],
    changes: [],
    eolNormalized: [],
    messageSha256: 'd'.repeat(64),
    fingerprint: 'e'.repeat(64),
    expiresAt: 2_000,
  };
  const denied = { admitted: false as const, code: 'NO_LEASE' as const, detail: 'no matching lease' };
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), {
    mutationContext: {
      callerContext,
      leaseOnly: true,
      coordinator: {
        async preview() { return mutationPreview; },
        async replace() { return mutationPreview; },
        result() { throw new Error('denied direct mutation must not read a success result'); },
        async admitByPolicy() { return denied; },
        rejectLocal() { mutationRejected += 1; return true; },
      },
    },
    gitCommitContext: {
      callerContext,
      leaseOnly: true,
      coordinator: {
        async preview() { return commitPreview; },
        result() { throw new Error('denied direct commit must not read a success result'); },
        async admitByPolicy() { return denied; },
        rejectLocal() { commitRejected += 1; return true; },
      },
    },
  }));

  const mutation = await client.callTool({
    name: 'file.replace',
    arguments: {
      workspace_id: 'ws_direct',
      path: 'note.txt',
      base_sha256: mutationPreview.baseSha256,
      content: 'changed\n',
    },
  });
  assert.equal(mutation.isError, true);
  assert.match(JSON.stringify(mutation.content), /NO_LEASE/);
  assert.equal(mutationRejected, 1);

  const commit = await client.callTool({
    name: 'git.commit',
    arguments: { workspace_id: 'ws_direct', paths: ['note.txt'], message: 'test: direct deny' },
  });
  assert.equal(commit.isError, true);
  assert.match(JSON.stringify(commit.content), /NO_LEASE/);
  assert.equal(commitRejected, 1);
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
  assert.deepEqual(search?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test('the inspect profile declares every added tool read-only and strictly typed', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), { inspect: true }));
  const tools = await client.listTools();

  for (const name of ['repo.list', 'repo.search', 'repo.diff']) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} must be present under the inspect profile`);
    assert.deepEqual(tool!.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    backends: [{ kind: 'devspace', readExact: async () => 'x', readExactIfPresent: async () => 'x', createNew: async () => undefined, updateExisting: async () => undefined }],
  });

  const commitCoordinator = new DurableCommitCoordinator({
    store,
    backend: {
      kind: 'devspace',
      plan: async () => { throw new Error('unused'); },
      commit: async () => { throw new Error('unused'); },
    },
  });

  for (const [options, expected] of [
    [{ mutationContext: { callerContext, coordinator } }, MUTATION_TOOLS],
    [{ inspect: true, mutationContext: { callerContext, coordinator } }, FULL_TOOLS],
    [{
      inspect: true,
      mutationContext: { callerContext, coordinator },
      gitCommitContext: { callerContext, coordinator: commitCoordinator },
      commandContext: { authorize: async () => undefined },
    }, COMMIT_TOOLS],
  ] as const) {
    const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
    const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), options));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), expected);

    for (const name of tools.tools.map((tool) => tool.name)) {
      if (ACCEPTED_GIT_TOOLS.has(name)) continue;
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
