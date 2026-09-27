import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createGatewayCallerContext } from '../src/caller-context.js';
import {
  createGatewayMcpServer,
  type GatewayApi,
} from '../src/server.js';

async function connect(t: test.TestContext, server: ReturnType<typeof createGatewayMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'remote-git-push-mcp', version: '1.0.0' },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('MCP publishes only git.push proposal/consume plus read-only result, never grant issuance tools', async (t) => {
  const callerContext = createGatewayCallerContext({
    ownerId: 'local.private.stdio',
    sessionId: 'sid_push_mcp',
    adapterId: 'private.stdio.v1',
  });
  let requested: unknown;
  let resultId = '';
  const coordinator = {
    async request(caller: unknown, workspaceId: string, input: unknown) {
      requested = { caller, workspaceId, input };
      return {
        pushId: 'push_fixture',
        status: 'approval_required' as const,
        state: 'PENDING' as const,
        sourceOid: 'a'.repeat(40),
        destinationRef: 'refs/heads/feat/mcp-push',
        remoteDisplayName: 'origin',
        resolvedPushUrl: 'https://github.com/example/repo.git',
        expectedRemoteState: { kind: 'ABSENT' as const },
        grantFingerprint: 'b'.repeat(64),
        reviewDeadline: 1234,
      };
    },
    result(_caller: unknown, pushId: string) {
      resultId = pushId;
      return {
        pushId,
        status: 'approval_required' as const,
        state: 'PENDING' as const,
        sourceOid: 'a'.repeat(40),
        destinationRef: 'refs/heads/feat/mcp-push',
        remoteDisplayName: 'origin',
        resolvedPushUrl: 'https://github.com/example/repo.git',
        expectedRemoteState: { kind: 'ABSENT' as const },
        grantFingerprint: 'b'.repeat(64),
        reviewDeadline: 1234,
      };
    },
  };

  const server = createGatewayMcpServer({} as GatewayApi, {
    remoteGitPushContext: { callerContext, coordinator },
  });
  const client = await connect(t, server);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.equal(names.includes('git.push'), true);
  assert.equal(names.includes('git.push.result'), true);
  for (const forbidden of [
    'git.push.approve',
    'git.push.activate',
    'remote_push_grant.create',
    'remote_push_grant.approve',
    'remote_push_grant.activate',
    'remote_push_grant.renew',
  ]) {
    assert.equal(names.includes(forbidden), false, forbidden);
  }
  assert.equal(
    names.some((name) => /(?:grant|push).*(?:approve|activate|renew|create)/i.test(name)),
    false,
  );

  const pushTool = tools.tools.find((tool) => tool.name === 'git.push');
  assert.deepEqual(pushTool?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });

  const source = 'a'.repeat(40);
  const receipt = 'c'.repeat(64);
  const response = await client.callTool({
    name: 'git.push',
    arguments: {
      workspace_id: 'ws_fixture',
      remote: 'origin',
      source_oid: source,
      destination_ref: 'refs/heads/feat/mcp-push',
      reviewed_oid: source,
      review_receipt_sha256: receipt,
    },
  });
  assert.notEqual(response.isError, true);
  assert.equal((response.structuredContent as { state?: string }).state, 'PENDING');
  assert.deepEqual(requested, {
    caller: callerContext,
    workspaceId: 'ws_fixture',
    input: {
      remote: 'origin',
      sourceOid: source,
      destinationRef: 'refs/heads/feat/mcp-push',
      reviewedOid: source,
      reviewReceiptDigest: receipt,
    },
  });

  const result = await client.callTool({
    name: 'git.push.result',
    arguments: { push_id: 'push_fixture' },
  });
  assert.notEqual(result.isError, true);
  assert.equal(resultId, 'push_fixture');
});

test('git.push schema refuses symbolic source and unknown authority fields before coordinator invocation', async (t) => {
  const callerContext = createGatewayCallerContext({
    ownerId: 'local.private.stdio',
    sessionId: 'sid_push_schema',
    adapterId: 'private.stdio.v1',
  });
  let calls = 0;
  const coordinator = {
    async request() {
      calls += 1;
      throw new Error('must not reach coordinator');
    },
    result() {
      throw new Error('unused');
    },
  };
  const client = await connect(
    t,
    createGatewayMcpServer({} as GatewayApi, {
      remoteGitPushContext: { callerContext, coordinator },
    }),
  );

  for (const arguments_ of [
    {
      workspace_id: 'ws_fixture',
      remote: 'origin',
      source_oid: 'HEAD',
      destination_ref: 'refs/heads/feat/test',
    },
    {
      workspace_id: 'ws_fixture',
      remote: 'origin',
      source_oid: 'a'.repeat(40),
      destination_ref: 'refs/heads/feat/test',
      approve: true,
    },
  ]) {
    const response = await client.callTool({ name: 'git.push', arguments: arguments_ });
    assert.equal(response.isError, true);
  }
  assert.equal(calls, 0);
});
