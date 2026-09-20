import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  BROWSER_ADAPTER_V1_ID,
  BROWSER_INSPECT_ADAPTER_ID,
  BROWSER_OPERATOR_ADAPTER_ID,
  BROWSER_VERIFY_ADAPTER_ID,
} from '../src/adapter-admission.js';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { createBrowserOperatorAdmittedMcpServer } from '../src/server.js';
import {
  BROWSER_OPERATOR_MAX_BYTES,
  BROWSER_OPERATOR_PROTOCOL_VERSION,
  parseBrowserOperatorRequest,
} from '../src/browser-adapter/protocol-v4.js';
import { BROWSER_VERIFY_PROTOCOL_VERSION } from '../src/browser-adapter/protocol-v3.js';

/** The successor surface, in order. Twelve tools: the accepted seven plus five proposals. */
const OPERATOR_TOOLS = [
  'health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read',
  'verify.preview', 'verify.result',
  'mutation.preview', 'file.create', 'mutation.result',
  'git.commit', 'git.commit.result',
];

const caller = createGatewayCallerContext({
  ownerId: 'owner-v4', sessionId: 'session-v4', adapterId: BROWSER_OPERATOR_ADAPTER_ID,
});

function envelope(tool: string, args: Record<string, unknown>) {
  return {
    version: BROWSER_OPERATOR_PROTOCOL_VERSION,
    type: 'tool.call',
    requestId: 'req_abcdef12',
    sessionId: 'session_abcdef12',
    tool,
    arguments: args,
  };
}

async function connected() {
  const calls: unknown[] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const gateway = {
    health: async () => ({
      status: 'ok' as const, executor: 'devspace' as const, protocolVersion: '2026-07-28', toolCount: 6,
    }),
  };
  const workspaces = {
    open: async () => ({ workspaceId: 'ws_v4' }),
    read: async () => ({ content: 'alpha' }),
    search: async () => ({ matches: [], truncated: false }),
    snapshot: async () => ({
      branch: 'main', head: '1234', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false,
    }),
  };
  const verify = {
    preview: () => ({
      status: 'approval_required' as const, request_id: 'verifyreq_1', profile: 'unit',
      fingerprint: 'a'.repeat(64), expires_at: 61_000,
    }),
    result: () => ({ request_id: 'verifyreq_1', profile: 'unit', state: 'PENDING_APPROVAL' as const, expires_at: 61_000 }),
  };
  const mutation = {
    preview: async (received: unknown, workspaceId: string, input: unknown) => {
      record('mutation.preview')(received, workspaceId, input);
      return { status: 'approval_required' as const, mutationId: 'mut_1' } as never;
    },
    result: (received: unknown, id: string) => {
      record('mutation.result')(received, id);
      return { mutationId: id, state: 'PENDING_APPROVAL' } as never;
    },
  };
  const commit = {
    preview: async (received: unknown, workspaceId: string, input: unknown) => {
      record('git.commit')(received, workspaceId, input);
      return { status: 'approval_required' as const, commitId: 'cmt_1' } as never;
    },
    result: (received: unknown, id: string) => {
      record('git.commit.result')(received, id);
      return { commitId: id, state: 'PENDING_APPROVAL' } as never;
    },
  };

  const server = createBrowserOperatorAdmittedMcpServer(gateway, {
    callerContext: caller, workspaces, verify, mutation, commit,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-v4-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { calls, client, server };
}

test('the successor adapter identity is distinct from every accepted one', () => {
  const ids = [
    BROWSER_ADAPTER_V1_ID, BROWSER_INSPECT_ADAPTER_ID, BROWSER_VERIFY_ADAPTER_ID, BROWSER_OPERATOR_ADAPTER_ID,
  ];
  assert.equal(new Set(ids).size, ids.length, 'no adapter id may be reused');
  assert.equal(BROWSER_OPERATOR_ADAPTER_ID, 'browser.chatgpt.native.operator.v4');
  assert.equal(BROWSER_OPERATOR_PROTOCOL_VERSION, 4);
  assert.notEqual(BROWSER_OPERATOR_PROTOCOL_VERSION, BROWSER_VERIFY_PROTOCOL_VERSION);
  assert.equal(BROWSER_VERIFY_PROTOCOL_VERSION, 3, 'v3 stays frozen at protocol 3');
});

test('the operator surface is exactly the accepted seven plus five proposals', async (t) => {
  const c = await connected();
  t.after(async () => { await c.client.close(); await c.server.close(); });

  const tools = await c.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), OPERATOR_TOOLS);

  // Nothing that causes an effect, names a ref, or takes execution input.
  const forbidden = [
    'verify.run', 'job.', 'shell', 'process', 'terminal', 'pty', 'exec',
    'approve', 'reject', 'dispatch', 'push', 'fetch', 'pull', 'merge', 'amend', 'reset',
    'checkout', 'branch', 'file.write', 'file.move', 'file.delete', 'directory', 'forward',
    'repo.list', 'repo.diff', 'config.set',
  ];
  for (const name of tools.tools.map((tool) => tool.name)) {
    for (const fragment of forbidden) {
      if (name === 'git.commit' || name === 'git.commit.result') continue;
      assert.equal(name.includes(fragment), false, `the browser surface must not expose ${name}`);
    }
  }

  // No schema may accept authority, argv, environment or approval input.
  const schemas = JSON.stringify(tools.tools.map((tool) => tool.inputSchema));
  for (const field of [
    'owner_id', 'session_id', 'adapter_id', 'argv', 'env', 'job_id', 'approval', 'dispatch',
    'branch', 'force', 'amend', 'allow_empty', 'sign',
  ]) {
    assert.doesNotMatch(schemas, new RegExp(`"${field}"`), `no tool may accept ${field}`);
  }
});

test('a proposal reaches the shared coordinator and returns its record, nothing more', async (t) => {
  const c = await connected();
  t.after(async () => { await c.client.close(); await c.server.close(); });

  await c.client.callTool({
    name: 'mutation.preview',
    arguments: {
      workspace_id: 'ws_v4', path: 'a.txt', base_sha256: 'a'.repeat(64), before: 'x', after: 'y',
    },
  });
  await c.client.callTool({
    name: 'file.create',
    arguments: { workspace_id: 'ws_v4', path: 'new.txt', content: 'hello' },
  });
  await c.client.callTool({
    name: 'git.commit',
    arguments: { workspace_id: 'ws_v4', paths: ['a.txt'], message: 'chore: x\n' },
  });

  const names = c.calls.map((entry) => (entry as unknown[])[0]);
  assert.deepEqual(names, ['mutation.preview', 'mutation.preview', 'git.commit']);

  // The caller tuple the coordinator sees is the server-held one, never anything from the wire.
  for (const entry of c.calls) {
    assert.deepEqual((entry as unknown[])[1], caller);
    assert.equal((entry as unknown[])[2], 'ws_v4');
  }

  // file.create is the empty-base form of a mutation (ADR-0022), not a second write path.
  const creation = c.calls[1] as [string, unknown, string, { baseSha256: string; before: string; after: string }];
  assert.equal(creation[3].before, '');
  assert.equal(creation[3].after, 'hello');
  assert.match(creation[3].baseSha256, /^[a-f0-9]{64}$/);
});

test('the protocol accepts the proposal envelopes and refuses everything consequential', () => {
  const accepted = [
    envelope('mutation.preview', {
      workspace_id: 'ws', path: 'a.txt', base_sha256: 'a'.repeat(64), before: 'x', after: 'y',
    }),
    envelope('file.create', { workspace_id: 'ws', path: 'a.txt', content: 'x' }),
    envelope('mutation.result', { mutation_id: 'mut_1234' }),
    envelope('git.commit', { workspace_id: 'ws', paths: ['a.txt'], message: 'm' }),
    envelope('git.commit.result', { commit_id: 'cmt_1234' }),
  ];
  for (const value of accepted) assert.doesNotThrow(() => parseBrowserOperatorRequest(value));

  const refused = [
    envelope('verify.run', { workspace_id: 'ws', profile: 'unit' }),
    envelope('mutation.approve', { mutation_id: 'mut_1234' }),
    envelope('git.commit.approve', { commit_id: 'cmt_1234' }),
    envelope('terminal.exec', { command: 'whoami' }),
    envelope('repo.diff', { workspace_id: 'ws' }),
    envelope('git.commit', { workspace_id: 'ws', paths: ['a.txt'], message: 'm', branch: 'main' }),
    envelope('git.commit', { workspace_id: 'ws', paths: [], message: 'm' }),
    envelope('mutation.result', { mutation_id: 'cmt_1234' }),
    envelope('git.commit.result', { commit_id: 'mut_1234' }),
    { ...envelope('git.commit', { workspace_id: 'ws', paths: ['a'], message: 'm' }), version: 3 },
  ];
  for (const value of refused) {
    assert.throws(() => parseBrowserOperatorRequest(value), `must refuse ${JSON.stringify(value).slice(0, 60)}`);
  }
});

test('the protocol bounds every proposal input', () => {
  const tooLongMessage = 'x'.repeat(8 * 1024 + 1);
  assert.throws(() => parseBrowserOperatorRequest(
    envelope('git.commit', { workspace_id: 'ws', paths: ['a.txt'], message: tooLongMessage }),
  ));
  assert.throws(() => parseBrowserOperatorRequest(
    envelope('git.commit', { workspace_id: 'ws', paths: Array.from({ length: 65 }, () => 'a'), message: 'm' }),
  ));
  assert.throws(() => parseBrowserOperatorRequest(
    envelope('file.create', { workspace_id: 'ws', path: 'a.txt', content: 'x'.repeat(32 * 1024 + 1) }),
  ));
  assert.throws(() => parseBrowserOperatorRequest(
    envelope('mutation.preview', {
      workspace_id: 'ws', path: 'a.txt', base_sha256: 'not-a-digest', before: 'x', after: 'y',
    }),
  ));

  // And the envelope itself is capped before any of that is even looked at.
  assert.throws(
    () => parseBrowserOperatorRequest(envelope('file.create', {
      workspace_id: 'ws', path: 'a.txt', content: 'x'.repeat(BROWSER_OPERATOR_MAX_BYTES),
    })),
    /exceeds size limit/,
  );
});
