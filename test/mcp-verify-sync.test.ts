import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';
import { startPinnedDevspace } from './devspace-fixture.js';

test('ordinary MCP client receives synchronous verify.run result without Tasks', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const gateway = createGateway({
    executor: new DevspaceExecutor(fixture), allowedRoots: [fixture.workspaceRoot],
    verifyProfiles: { version: { argv: ['node', '--version'], timeoutMs: 5_000 } },
  });
  const server = createGatewayMcpServer(gateway);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sync-verify', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  const opened = await client.callTool({ name: 'workspace.open', arguments: { path: fixture.workspaceRoot } });
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.match(workspaceId ?? '', /^ws_/);
  const result = await client.callTool({
    name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'version' },
  });
  assert.notEqual(result.isError, true);
  const value = result.structuredContent as { profile?: string; exitCode?: number; output?: string } | undefined;
  assert.equal(value?.profile, 'version');
  assert.equal(value?.exitCode, 0);
  assert.match(value?.output ?? '', /^v24\./);
});
