import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startGatewayHttpServer } from '../src/http-server.js';
import { createGateway } from '../src/server.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const TOKEN = 'sync-verify-token-0123456789abcdef0123456789abcdef';

test('ordinary MCP client receives synchronous verify.run result without Tasks', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const gateway = createGateway({
    executor: new DevspaceExecutor(fixture), allowedRoots: [fixture.workspaceRoot],
    verifyProfiles: { version: { argv: ['node', '--version'], timeoutMs: 5_000 } },
  });
  const http = await startGatewayHttpServer({ gateway, bearerToken: TOKEN });
  t.after(() => http.close());
  const client = new Client({ name: 'sync-verify', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(http.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());

  const opened = await client.callTool({ name: 'workspace.open', arguments: { path: fixture.workspaceRoot } });
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.match(workspaceId ?? '', /^ws_/);

  const result = await client.callTool({ name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'version' } });
  assert.notEqual(result.isError, true);
  const value = result.structuredContent as { profile?: string; exitCode?: number; output?: string } | undefined;
  assert.equal(value?.profile, 'version');
  assert.equal(value?.exitCode, 0);
  assert.match(value?.output ?? '', /^v24\./);
});
