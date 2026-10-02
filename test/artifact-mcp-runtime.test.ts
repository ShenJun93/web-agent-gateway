import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { GatewayAuthority } from '../src/caller-context.js';
import { ArtifactPort } from '../src/artifact-harness/artifact-port.js';
import {
  createArtifactMcpContext,
  type ArtifactMcpContext,
} from '../src/artifact-harness/artifact-mcp-runtime.js';
import type { LocalMachineContext } from '../src/local-machine-runtime.js';
import { createGatewayMcpServer, type GatewayApi } from '../src/server.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_artifact_mcp',
  sessionId: 'session_artifact_mcp',
  adapterId: 'private.stdio.v1',
};

test('artifact MCP context lists and describes sanitized metadata and exports verified bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-artifact-mcp-'));
  const artifacts = new ArtifactPort({
    root: join(root, 'artifacts'),
    authorizeSource: async () => { throw new Error('not used'); },
    randomUUID: () => '00000000-0000-4000-8000-000000000901',
    now: () => 1234,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
  const stored = await artifacts.createBytes(OWNER, 'report.bin', bytes);
  const exports: unknown[][] = [];
  const machineContext = {
    async createBinaryFile(workspaceId: string, path: string, value: Uint8Array, sha256: string) {
      exports.push([workspaceId, path, [...value], sha256]);
      return {
        path,
        size_bytes: value.length,
        sha256,
        state: 'CREATED' as const,
      };
    },
  } as unknown as LocalMachineContext;
  const context = createArtifactMcpContext({ owner: OWNER, artifacts, machineContext });

  const listed = await context.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], {
    artifactId: stored.artifactId,
    filename: 'report.bin',
    sizeBytes: 5,
    sha256: stored.sha256,
    createdAt: 1234,
  });
  assert.equal(JSON.stringify(listed).includes('internalPath'), false);
  assert.equal(JSON.stringify(listed).includes('ownerId'), false);

  const described = await context.describe(stored.artifactId);
  assert.deepEqual(described, listed[0]);

  const exported = await context.export(stored.artifactId, 'ws_artifact_export', 'downloads/report.bin');
  assert.deepEqual(exports, [[
    'ws_artifact_export',
    'downloads/report.bin',
    [1, 2, 3, 4, 5],
    stored.sha256,
  ]]);
  assert.equal(exported.path, 'downloads/report.bin');
  assert.equal(exported.state, 'CREATED');
  assert.equal(JSON.stringify(exported).includes('internalPath'), false);
});

test('artifact MCP surface publishes bounded annotations and sanitized output', async (t) => {
  const artifactId = 'artifact_00000000-0000-4000-8000-000000000902';
  const calls: unknown[][] = [];
  const artifactContext: ArtifactMcpContext = {
    async list(limit) {
      calls.push(['list', limit]);
      return [{
        artifactId,
        filename: 'report.pdf',
        sizeBytes: 321,
        sha256: 'a'.repeat(64),
        createdAt: 1000,
      }];
    },
    async describe(id) {
      calls.push(['describe', id]);
      return {
        artifactId: id,
        filename: 'report.pdf',
        sizeBytes: 321,
        sha256: 'a'.repeat(64),
        createdAt: 1000,
      };
    },
    async export(id, workspaceId, path) {
      calls.push(['export', id, workspaceId, path]);
      return {
        artifact: {
          artifactId: id,
          filename: 'report.pdf',
          sizeBytes: 321,
          sha256: 'a'.repeat(64),
          createdAt: 1000,
        },
        workspaceId,
        path,
        sizeBytes: 321,
        sha256: 'a'.repeat(64),
        state: 'ALREADY_PRESENT',
      };
    },
  };
  const gateway = {
    health: async () => ({
      status: 'ok' as const,
      executor: 'devspace' as const,
      protocolVersion: 'test',
      toolCount: 6,
    }),
  } as unknown as GatewayApi;
  const server = createGatewayMcpServer(gateway, { artifactContext });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'artifact-mcp-test', version: '1' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });

  const tools = (await client.listTools()).tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get('artifact.list')?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(byName.get('artifact.describe')?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(byName.get('artifact.export')?.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });

  const listed = await client.callTool({ name: 'artifact.list', arguments: { limit: 10 } });
  assert.equal(listed.isError === true, false);
  assert.equal(JSON.stringify(listed.structuredContent).includes('internalPath'), false);
  assert.deepEqual(calls.at(-1), ['list', 10]);

  const described = await client.callTool({ name: 'artifact.describe', arguments: { artifact_id: artifactId } });
  assert.equal(described.isError === true, false);
  assert.deepEqual(calls.at(-1), ['describe', artifactId]);

  const exported = await client.callTool({
    name: 'artifact.export',
    arguments: { artifact_id: artifactId, workspace_id: 'ws_export', path: 'downloads/report.pdf' },
  });
  assert.equal(exported.isError === true, false);
  assert.deepEqual(calls.at(-1), ['export', artifactId, 'ws_export', 'downloads/report.pdf']);
  assert.deepEqual(exported.structuredContent, {
    artifact_id: artifactId,
    filename: 'report.pdf',
    size_bytes: 321,
    sha256: 'a'.repeat(64),
    destination: {
      workspace_id: 'ws_export',
      path: 'downloads/report.pdf',
      state: 'ALREADY_PRESENT',
    },
  });
  assert.equal(JSON.stringify(exported.structuredContent).includes('internalPath'), false);
});
