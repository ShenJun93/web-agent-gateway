import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { DevspaceExecutor, ExecResult } from '../src/executor/devspace.js';
import type { LocalMachineContext } from '../src/local-machine-runtime.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';
import type { GatewayTelemetryEvent } from '../src/telemetry.js';

const DEFAULT_TOOLS = ['health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run', 'result.chunk'];
const INSPECT_TOOLS = ['health', 'workspace.open', 'repo.list', 'repo.search', 'repo.snapshot', 'repo.diff', 'file.read', 'verify.run', 'result.chunk'];
const MUTATION_TOOLS = ['health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run', 'mutation.preview', 'file.replace', 'file.edit_block', 'file.append', 'file.create', 'mutation.result', 'result.chunk'];
const FULL_TOOLS = ['health', 'workspace.open', 'repo.list', 'repo.search', 'repo.snapshot', 'repo.diff', 'file.read', 'verify.run', 'mutation.preview', 'file.replace', 'file.edit_block', 'file.append', 'file.create', 'mutation.result', 'result.chunk'];
const COMMIT_TOOLS = ['health', 'workspace.open', 'repo.list', 'repo.search', 'repo.snapshot', 'repo.diff', 'file.read', 'verify.run', 'command.run', 'mutation.preview', 'file.replace', 'file.edit_block', 'file.append', 'file.create', 'mutation.result', 'git.commit', 'git.commit.result', 'result.chunk'];
const PUSH_TOOLS = ['health', 'workspace.open', 'repo.list', 'repo.search', 'repo.snapshot', 'repo.diff', 'file.read', 'verify.run', 'command.run', 'mutation.preview', 'file.replace', 'file.edit_block', 'file.append', 'file.create', 'mutation.result', 'git.commit', 'git.commit.result', 'git.remote.inspect', 'git.push', 'git.push.result', 'result.chunk'];

/**
 * Repository-only profiles stay narrow. Full local-computer/DC-parity operations are exposed only
 * when the production runtime wires a LocalMachineContext. This guard prevents a repository-only
 * profile from accidentally acquiring process/terminal or broad filesystem verbs.
 * Git mutations are limited to exact commit plus the separate Human-gated remote push surface.
 */
const ACCEPTED_GIT_TOOLS = new Set(['git.commit', 'git.commit.result', 'git.remote.inspect', 'git.push', 'git.push.result']);
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
    authority: { mode: 'AUTONOMOUS_LOCAL', kill_switch: 'CLEAR' },
    capabilities: {
      FILE_READ: { granted: true, denied: false, grantable: true, requires_human: false, reason: 'WORKSPACE_OWNED' },
      LOCAL_COMMAND: { granted: false, denied: true, grantable: true, requires_human: true, reason: 'WORKSPACE_NOT_GRANTED' },
      GIT_PUSH: { granted: false, denied: true, grantable: true, requires_human: true, reason: 'REMOTE_EFFECT_GRANT_REQUIRED' },
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

test('direct stdio autonomous mutation executes immediately and returns the terminal result', async (t) => {
  const { executor } = stubExecutor({ output: '', exitCode: 0, running: false });
  const callerContext = createGatewayCallerContext({
    ownerId: 'owner_direct_autonomous',
    sessionId: 'session_direct_autonomous',
    adapterId: 'private.stdio.v1',
  });
  let admissions = 0;
  let rejections = 0;
  const preview = {
    status: 'approval_required' as const,
    mutationId: 'mut_direct_autonomous',
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
    async editBlock() { return preview; },
    async append() { return preview; },
    result() { return result; },
    async admitByPolicy() { admissions += 1; return { admitted: true as const }; },
    rejectLocal() { rejections += 1; return true; },
  };
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), {
    mutationContext: { callerContext, coordinator, autonomous: true },
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

test('direct stdio autonomous policy denial has no human-review fallback for mutations or commits', async (t) => {
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
  const denied = { admitted: false as const, code: 'KILL_SWITCH_ENGAGED' as const, detail: 'kill switch' };
  const client = await connect(t, createGatewayMcpServer(gatewayWith(executor), {
    mutationContext: {
      callerContext,
      autonomous: true,
      coordinator: {
        async preview() { return mutationPreview; },
        async replace() { return mutationPreview; },
        async editBlock() { return mutationPreview; },
        async append() { return mutationPreview; },
        result() { throw new Error('denied direct mutation must not read a success result'); },
        async admitByPolicy() { return denied; },
        rejectLocal() { mutationRejected += 1; return true; },
      },
    },
    gitCommitContext: {
      callerContext,
      autonomous: true,
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
  assert.match(JSON.stringify(mutation.content), /KILL_SWITCH_ENGAGED/);
  assert.equal(mutationRejected, 1);

  const commit = await client.callTool({
    name: 'git.commit',
    arguments: { workspace_id: 'ws_direct', paths: ['note.txt'], message: 'test: direct deny' },
  });
  assert.equal(commit.isError, true);
  assert.match(JSON.stringify(commit.content), /KILL_SWITCH_ENGAGED/);
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

test('repository-only stdio profiles compose independently and do not expose machine authority', async (t) => {
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
  const remotePushCoordinator = {
    async inspect(_caller: unknown, _workspaceId: string, input: { remote: string; refs: string[] }) {
      return {
        repositoryIdentity: 'repo_' + '1'.repeat(64),
        effectiveFetchUrl: 'https://github.com/example/repo.git',
        effectivePushUrl: 'https://github.com/example/repo.git',
        defaultBranch: 'refs/heads/main',
        refs: input.refs.map((ref) => ({ ref, oid: null })),
        authenticationState: 'UNKNOWN' as const,
        remote: input.remote,
        observedAt: '2026-10-01T00:00:00.000Z',
      };
    },
    async request() {
      return {
        pushId: 'push_fixture',
        status: 'approval_required' as const,
        state: 'PENDING' as const,
        sourceOid: 'a'.repeat(40),
        destinationRef: 'refs/heads/feat/fixture',
        remoteDisplayName: 'origin',
        resolvedPushUrl: 'https://github.com/example/repo.git',
        expectedRemoteState: { kind: 'ABSENT' as const },
        grantFingerprint: 'b'.repeat(64),
        reviewDeadline: 2_000,
      };
    },
    result() {
      return {
        pushId: 'push_fixture',
        status: 'approval_required' as const,
        state: 'PENDING' as const,
        sourceOid: 'a'.repeat(40),
        destinationRef: 'refs/heads/feat/fixture',
        remoteDisplayName: 'origin',
        resolvedPushUrl: 'https://github.com/example/repo.git',
        expectedRemoteState: { kind: 'ABSENT' as const },
        grantFingerprint: 'b'.repeat(64),
        reviewDeadline: 2_000,
      };
    },
  };

  for (const [options, expected] of [
    [{ mutationContext: { callerContext, coordinator } }, MUTATION_TOOLS],
    [{ inspect: true, mutationContext: { callerContext, coordinator } }, FULL_TOOLS],
    [{
      inspect: true,
      mutationContext: { callerContext, coordinator },
      gitCommitContext: { callerContext, coordinator: commitCoordinator },
      commandContext: { authorize: async () => undefined },
    }, COMMIT_TOOLS],
    [{
      inspect: true,
      mutationContext: { callerContext, coordinator },
      gitCommitContext: { callerContext, coordinator: commitCoordinator },
      remoteGitPushContext: { callerContext, coordinator: remotePushCoordinator },
      commandContext: { authorize: async () => undefined },
    }, PUSH_TOOLS],
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

test('frozen 16-tool snapshots reach local-machine work through existing tool names', async (t) => {
  const { executor, calls } = stubExecutor({ output: '', exitCode: 0, running: false });
  const gateway = gatewayWith(executor);
  const machineCalls: string[] = [];
  const machineWorkspaceId = 'ws_machine_compat';
  const machineContext: LocalMachineContext = {
    async open(path) {
      machineCalls.push('open:' + path);
      return {
        workspace_id: machineWorkspaceId,
        root: path,
        authority: { mode: 'AUTONOMOUS_LOCAL', kill_switch: 'CLEAR' },
      };
    },
    async describe(workspaceId) {
      if (workspaceId !== machineWorkspaceId) throw new Error('not a machine workspace');
      machineCalls.push('describe');
      return {
        workspace_id: workspaceId,
        root: 'machine-root',
        backend: 'local-machine',
        authority: { mode: 'AUTONOMOUS_LOCAL', kill_switch: 'CLEAR' },
      };
    },
    async list(workspaceId) {
      assert.equal(workspaceId, machineWorkspaceId);
      machineCalls.push('list');
      return { path: '.', entries: [{ name: 'note.txt', type: 'file' }], truncated: false };
    },
    async read(workspaceId, path) {
      assert.equal(workspaceId, machineWorkspaceId);
      machineCalls.push('read:' + path);
      if (path === 'image.png') throw new Error('Gateway rejected local-machine non-UTF-8 content');
      assert.equal(path, 'note.txt');
      return { content: 'machine-read\n', raw_sha256: 'a'.repeat(64), size_bytes: 13, encoding: 'utf-8' };
    },
    async readMany() { throw new Error('not used'); },
    async readImage(workspaceId, path) {
      assert.equal(workspaceId, machineWorkspaceId);
      assert.equal(path, 'image.png');
      machineCalls.push('image');
      return {
        path,
        mime_type: 'image/png',
        size_bytes: 8,
        sha256: 'b'.repeat(64),
        data_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
      };
    },
    async extractPdf() { throw new Error('not used'); },
    async inspectDocx() { throw new Error('not used'); },
    async createDocx() { throw new Error('not used'); },
    async replaceDocxText() { throw new Error('not used'); },
    async inspectXlsx() { throw new Error('not used'); },
    async createXlsx() { throw new Error('not used'); },
    async setXlsxCells() { throw new Error('not used'); },
    async createPdf() { throw new Error('not used'); },
    async overlayPdfText() { throw new Error('not used'); },
    async commandRun(workspaceId, argv) {
      assert.equal(workspaceId, machineWorkspaceId);
      machineCalls.push('command:' + JSON.stringify(argv));
      return {
        exitCode: 0,
        output: argv[1] === '--version' ? 'machine-command' : 'machine-command-wide',
        timedOut: false,
        truncated: false,
        durationMs: 1,
        cwd: 'machine-root',
      };
    },
    async searchContinue() { throw new Error('not used'); },
    async searchList() { throw new Error('not used'); },
    async searchCancel() { throw new Error('not used'); },
    async search(workspaceId, query) {
      assert.equal(workspaceId, machineWorkspaceId);
      assert.equal(query, 'needle');
      machineCalls.push('search');
      return { matches: [{ path: 'note.txt', line: 1, text: 'needle' }], truncated: false, visited_files: 1 };
    },
    async info() { throw new Error('not used'); },
    async mkdir() { throw new Error('not used'); },
    async move() { throw new Error('not used'); },
    async delete() { throw new Error('not used'); },
    async processList() { throw new Error('not used'); },
    async processInspect() { throw new Error('not used'); },
    async processStart() { throw new Error('not used'); },
    async processTerminate() { throw new Error('not used'); },
    async terminalOpen() { throw new Error('not used'); },
    async terminalList() { throw new Error('not used'); },
    async terminalOutput() { throw new Error('not used'); },
    async terminalInput() { throw new Error('not used'); },
    async terminalClose() { throw new Error('not used'); },
  };
  const capabilityContext = {
    describe(workspaceId: string) {
      return {
        workspace_id: workspaceId,
        authority: { mode: 'AUTONOMOUS_LOCAL', kill_switch: 'CLEAR' },
        capabilities: {
          LOCAL_COMMAND: {
            granted: true, denied: false, grantable: true, requires_human: false,
            reason: 'AUTONOMOUS_LOCAL_PROFILE',
          },
        },
      };
    },
  };
  const commandContext = {
    async authorize(workspaceId: string) {
      assert.equal(workspaceId, machineWorkspaceId);
      machineCalls.push('authorize');
    },
  };

  const client = await connect(t, createGatewayMcpServer(gateway, {
    inspect: true,
    machineContext,
    capabilityContext,
    commandContext,
  }));

  // This path intentionally does not exist, so DevSpace/canonical workspace open fails first and
  // the compatibility bridge opens it through the machine backend without changing the tool schema.
  const target = process.cwd() + '/__wag_machine_compat_missing__';
  const opened = await client.callTool({ name: 'workspace.open', arguments: { path: target } });
  assert.notEqual(opened.isError, true);
  assert.equal((opened.structuredContent as { workspaceId?: string }).workspaceId, machineWorkspaceId);

  const listed = await client.callTool({
    name: 'repo.list',
    arguments: { workspace_id: machineWorkspaceId },
  });
  assert.notEqual(listed.isError, true);
  assert.deepEqual(
    (listed.structuredContent as { entries?: unknown[] }).entries,
    [{ name: 'note.txt', type: 'file' }],
  );

  const read = await client.callTool({
    name: 'file.read',
    arguments: { workspace_id: machineWorkspaceId, path: 'note.txt' },
  });
  assert.equal((read.structuredContent as { content?: string }).content, 'machine-read\n');

  const image = await client.callTool({
    name: 'file.read',
    arguments: { workspace_id: machineWorkspaceId, path: 'image.png' },
  });
  assert.notEqual(image.isError, true);
  assert.equal((image.structuredContent as { mime_type?: string }).mime_type, 'image/png');
  assert.equal((image.content[0] as { type?: string }).type, 'image');

  const searched = await client.callTool({
    name: 'repo.search',
    arguments: { workspace_id: machineWorkspaceId, query: 'needle' },
  });
  assert.notEqual(searched.isError, true);
  assert.equal((searched.structuredContent as { matches?: unknown[] }).matches?.length, 1);

  const command = await client.callTool({
    name: 'command.run',
    arguments: { workspace_id: machineWorkspaceId, argv: ['node', '--version'] },
  });
  assert.equal((command.structuredContent as { output?: string }).output, 'machine-command');

  const widerArgv = await client.callTool({
    name: 'command.run',
    arguments: { workspace_id: machineWorkspaceId, argv: ['node', 'hello world'] },
  });
  assert.notEqual(widerArgv.isError, true);
  assert.equal((widerArgv.structuredContent as { output?: string }).output, 'machine-command-wide');

  assert.equal(calls.length, 0, 'local-machine compatibility calls must not reach DevSpace exec');
  assert.ok(machineCalls.some((entry) => entry.startsWith('open:')));
  assert.ok(machineCalls.includes('list'));
  assert.ok(machineCalls.includes('read:note.txt'));
  assert.ok(machineCalls.includes('read:image.png'));
  assert.ok(machineCalls.includes('image'));
  assert.ok(machineCalls.includes('search'));
  assert.ok(machineCalls.some((entry) => entry.startsWith('command:')));
});
