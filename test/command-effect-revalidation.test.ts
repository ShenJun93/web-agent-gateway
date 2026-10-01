import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';

test('command.run revalidates authority immediately before process spawn', async (t) => {
  let execCalls = 0;
  const executor = {
    async openWorkspace(root: string): Promise<string> {
      return `devspace_${root.length}`;
    },
    async execCommand() {
      execCalls += 1;
      return { output: 'should-not-run', exitCode: 0, running: false };
    },
    async interruptCommand(): Promise<void> {},
  } as unknown as DevspaceExecutor;

  const gateway = createGateway({
    executor,
    allowedRoots: [process.cwd()],
    verifyProfiles: {},
  });

  let authorizeCalls = 0;
  const commandContext = {
    async authorize(): Promise<void> {
      authorizeCalls += 1;
      if (authorizeCalls === 2) {
        throw new Error('Gateway denied command: authority revoked at effect boundary');
      }
    },
  };

  const server = createGatewayMcpServer(gateway, { commandContext });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'command-effect-revalidation', version: '1.0.0' },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const opened = await client.callTool({
    name: 'workspace.open',
    arguments: { path: process.cwd() },
  });
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.match(workspaceId ?? '', /^ws_/);

  const result = await client.callTool({
    name: 'command.run',
    arguments: {
      workspace_id: workspaceId,
      argv: ['node', '--version'],
    },
  });

  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /authority revoked at effect boundary/);
  assert.equal(authorizeCalls, 2, 'command authority must be checked at ingress and again at effect');
  assert.equal(execCalls, 0, 'effect-boundary denial must happen before executor.execCommand');
});
