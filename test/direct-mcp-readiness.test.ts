import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayCallerContext } from '../src/caller-context.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { DurableCommitCoordinator } from '../src/git-commit.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import { projectedTools } from '../scripts/prepare-direct-mcp-tunnel.js';

/**
 * The direct-MCP surface is the one a remote MCP client discovers over the Secure MCP Tunnel.
 *
 * Unlike WAG's own browser adapters, that client is not ours: it decides whether to ask its user
 * to confirm a write from the tool annotations alone, and ADR-0020 records the provider's own
 * warning that a read-only annotation may cause that confirmation to be skipped. So on this
 * surface an annotation is part of the security contract, not documentation, and an omitted hint
 * silently becomes the specification's default rather than WAG's claim.
 *
 * These tests pin the whole declared surface rather than sampling it, so that a tool added later
 * cannot reach a remote client under-declared.
 */

interface Hints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Every tool the extended direct surface exposes, with the exact hints a remote client must see.
 *
 * `workspace.open` is deliberately not read-only: it canonicalises a root, opens a DevSpace
 * workspace and mints a durable caller-owned record.
 */
const DECLARED_SURFACE: ReadonlyArray<readonly [string, Hints]> = [
  ['health', { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['workspace.open', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
  ['repo.list', { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['repo.search', { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['repo.snapshot', { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['repo.diff', { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['file.read', { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['verify.run', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
  ['mutation.preview', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ['file.create', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
  ['mutation.result', { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['git.commit', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
  ['git.commit.result', { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
];

/** Names WAG derives locally and must never accept from a tool argument (ADR-0015, ADR-0020). */
const CALLER_IDENTITY_FIELDS = [
  'owner_id', 'ownerId', 'session_id', 'sessionId', 'adapter_id', 'adapterId',
  'correlation', 'correlation_id', 'provider', 'client_id', 'clientId',
  'lease_id', 'leaseId', 'delegation_id', 'delegationId', 'goal_id', 'goalId',
  'authority', 'approval_id', 'approvalId', 'canonical_root', 'canonicalRoot',
];

/** The full extended surface, wired the way `serve-stdio` wires it under local opt-in. */
async function openDirectSurface(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wag-direct-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'alpha\n');

  const callerContext = createGatewayCallerContext({
    ownerId: 'owner_direct', sessionId: 'session_direct', adapterId: 'private.stdio.v1',
    correlation: { provider: 'chatgpt', clientId: 'direct-mcp-test' },
  });
  const store = new SqliteDurableStore(':memory:');
  t.after(() => store.close());

  const mutationBackend = {
    kind: 'fake',
    readExact: async () => 'alpha\n',
    readExactIfPresent: async () => 'alpha\n',
    createNew: async () => undefined,
    updateExisting: async () => undefined,
  };
  const commitBackend = {
    kind: 'fake',
    plan: async () => { throw new Error('not exercised: this test asserts the declaration'); },
    commit: async () => { throw new Error('not exercised: this test asserts the declaration'); },
  };

  const executor = new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' });
  const gateway = createGateway({ executor, allowedRoots: [root], verifyProfiles: { unit: { argv: ['node', '--version'] } } });
  const server = createGatewayMcpServer(gateway, {
    inspect: true,
    mutationContext: {
      callerContext,
      coordinator: new DurableMutationCoordinator({ store, backends: [mutationBackend] }),
    },
    gitCommitContext: {
      callerContext,
      coordinator: new DurableCommitCoordinator({ store, backend: commitBackend as never }),
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'direct-mcp-readiness', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, root };
}

test('the direct MCP surface is exactly the required ChatGPT tool loop', async (t) => {
  const { client } = await openDirectSurface(t);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    DECLARED_SURFACE.map(([name]) => name),
    'a direct client must discover read, mutation, verify and commit in one surface',
  );
});

test('every direct tool declares all four hints, so none falls back to a specification default', async (t) => {
  const { client } = await openDirectSurface(t);
  const tools = await client.listTools();
  for (const tool of tools.tools) {
    const annotations = tool.annotations as Partial<Hints> | undefined;
    assert.ok(annotations, `${tool.name} must declare annotations to a client that is not ours`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      assert.equal(
        typeof annotations[hint], 'boolean',
        `${tool.name} omits ${hint}, so a remote client would apply the specification default rather than WAG's claim`,
      );
    }
  }
});

test('each direct tool declares the hints its behaviour actually warrants', async (t) => {
  const { client } = await openDirectSurface(t);
  const tools = await client.listTools();
  for (const [name, expected] of DECLARED_SURFACE) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} must be present on the direct surface`);
    assert.deepEqual(tool.annotations, expected, `${name} declares the wrong hints to a remote client`);
  }
});

test('no direct tool claims read-only while creating durable state', async (t) => {
  const { client } = await openDirectSurface(t);
  const tools = await client.listTools();
  // The regression this pins: `workspace.open` mints a durable caller-owned workspace record,
  // and previously claimed `readOnlyHint: true` — the one annotation class ADR-0020 warns can
  // cause a provider-side write confirmation to be skipped.
  for (const name of ['workspace.open', 'verify.run', 'mutation.preview', 'file.create', 'git.commit']) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.equal(
      tool?.annotations?.readOnlyHint, false,
      `${name} changes durable state and must not claim read-only`,
    );
  }
});

test('changing transport grants no authority: no direct tool accepts a caller identity', async (t) => {
  const { client } = await openDirectSurface(t);
  const tools = await client.listTools();
  const schemas = JSON.stringify(tools.tools.map((tool) => ({ name: tool.name, schema: tool.inputSchema })));
  for (const field of CALLER_IDENTITY_FIELDS) {
    assert.doesNotMatch(
      schemas, new RegExp(`"${field}"`),
      `the direct surface must not accept ${field} from a tool argument; WAG derives it locally`,
    );
  }
});

test('every direct tool refuses unknown arguments instead of silently dropping them', async (t) => {
  const { client } = await openDirectSurface(t);
  const tools = await client.listTools();
  for (const tool of tools.tools) {
    const schema = tool.inputSchema as { properties?: object; additionalProperties?: unknown } | undefined;
    // `health` declares no properties because it takes no arguments; strictness is meaningless there.
    if (!schema?.properties || Object.keys(schema.properties).length === 0) continue;
    assert.equal(
      schema.additionalProperties, false,
      `${tool.name} accepts unknown arguments; a remote client's stray or injected field would be `
      + 'stripped in silence rather than refused, so nothing would ever surface the attempt',
    );
  }
});

/**
 * The tunnel preparation instrument tells an operator which tools a remote client would reach.
 * It measures the real server rather than describing it, so what remains checkable — and what
 * this pins — is that its config-to-options mapping opts in to the same capabilities the runtime
 * does, and that an unconfigured gateway still projects exactly the accepted five.
 */
test('the tunnel instrument projects the surface the server really registers', async (t) => {
  const base: PrivateGatewayConfig = {
    allowedRoots: ['E:/nowhere'],
    devspace: { baseUrl: 'http://127.0.0.1:1', resourceUrl: 'http://127.0.0.1:1/mcp' },
    verifyProfiles: { unit: { argv: ['node', '--version'] } },
  };

  const executor = new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' });
  const gateway = createGateway({ executor, allowedRoots: [process.cwd()], verifyProfiles: base.verifyProfiles });

  const defaultServer = createGatewayMcpServer(gateway);
  const [defaultClientTransport, defaultServerTransport] = InMemoryTransport.createLinkedPair();
  const defaultClient = new Client({ name: 'projection-default', version: '1.0.0' }, { capabilities: {} });
  await defaultServer.connect(defaultServerTransport);
  await defaultClient.connect(defaultClientTransport);
  t.after(async () => { await defaultClient.close(); await defaultServer.close(); });
  assert.deepEqual(
    (await projectedTools(base)).tools,
    (await defaultClient.listTools()).tools.map((tool) => tool.name),
    'the instrument must project the accepted five when nothing is opted in',
  );
  assert.deepEqual((await projectedTools(base)).missing, ["mutation", "commit"]);

  const full: PrivateGatewayConfig = {
    ...base,
    repositoryEngineering: {
      inspect: true,
      mutation: { statePath: 'E:/nowhere/state.sqlite', ownerId: 'owner_direct' },
      gitCommit: {},
    },
  };
  const { client } = await openDirectSurface(t);
  assert.deepEqual(
    (await projectedTools(full)).tools,
    (await client.listTools()).tools.map((tool) => tool.name),
    'the instrument must project the full loop in the order the server registers it',
  );
  assert.deepEqual((await projectedTools(full)).missing, [], 'a fully configured gateway completes the loop');
});

test('a direct client cannot smuggle an identity past the schema', async (t) => {
  const { client } = await openDirectSurface(t);
  // `repo.snapshot` was the tool that proved this gap: before it was made strict, this call
  // reached the handler with `owner_id` quietly removed, and failed for an unrelated reason.
  const injected = await client.callTool({
    name: 'repo.snapshot',
    arguments: { workspace_id: 'ws_whatever', owner_id: 'attacker-selected-owner' },
  });
  assert.equal(injected.isError, true);
  assert.match(JSON.stringify(injected.content), /Invalid arguments for tool repo\.snapshot/);
});
