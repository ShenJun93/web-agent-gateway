import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startGatewayHttpServer } from '../src/http-server.js';
import { createGateway } from '../src/server.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const TOKEN = 'recovery-token-0123456789abcdef0123456789abcdef';

async function connectClient(url: string, name: string) {
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

test('a second client recovers the original verify.run task result after reconnect', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(`${fixture.workspaceRoot}\\slow-verify.js`, "setTimeout(() => console.log('durable-result'), 1500);\n", 'utf8');
  const gateway = createGateway({
    executor: new DevspaceExecutor(fixture),
    allowedRoots: [fixture.workspaceRoot],
    verifyProfiles: { slow: { argv: ['node', 'slow-verify.js'], timeoutMs: 5_000 } },
  });
  const http = await startGatewayHttpServer({ gateway, bearerToken: TOKEN });
  t.after(() => http.close());

  const first = await connectClient(http.mcpUrl, 'task-client-a');
  const opened = await first.callTool({ name: 'workspace.open', arguments: { path: fixture.workspaceRoot } });
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.match(workspaceId ?? '', /^ws_/);

  const stream = first.experimental.tasks.callToolStream(
    { name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'slow' } },
    CallToolResultSchema,
    { task: { ttl: 60_000 } },
  );
  const firstMessage = await stream.next();
  assert.equal(firstMessage.done, false);
  assert.equal(firstMessage.value?.type, 'taskCreated');
  const taskId = firstMessage.value?.type === 'taskCreated' ? firstMessage.value.task.taskId : undefined;
  assert.ok(taskId);
  await first.close();

  const second = await connectClient(http.mcpUrl, 'task-client-b');
  t.after(() => second.close());
  let task = await second.experimental.tasks.getTask(taskId);
  for (let attempt = 0; attempt < 40 && task.status !== 'completed' && task.status !== 'failed'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    task = await second.experimental.tasks.getTask(taskId);
  }
  assert.equal(task.status, 'completed');
  const result = await second.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
  assert.notEqual(result.isError, true);
  const value = result.structuredContent as { profile?: string; exitCode?: number; output?: string } | undefined;
  assert.equal(value?.profile, 'slow');
  assert.equal(value?.exitCode, 0);
  assert.equal(value?.output, 'durable-result');
});


test('raw tasks/cancel is rejected until executor interruption is implemented', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(`${fixture.workspaceRoot}\\slow-cancel.js`, "setTimeout(() => console.log('still-completed'), 1200);\n", 'utf8');
  const gateway = createGateway({
    executor: new DevspaceExecutor(fixture),
    allowedRoots: [fixture.workspaceRoot],
    verifyProfiles: { slowcancel: { argv: ['node', 'slow-cancel.js'], timeoutMs: 5_000 } },
  });
  const http = await startGatewayHttpServer({ gateway, bearerToken: TOKEN });
  t.after(() => http.close());

  const client = await connectClient(http.mcpUrl, 'task-cancel-probe');
  t.after(() => client.close());
  const opened = await client.callTool({ name: 'workspace.open', arguments: { path: fixture.workspaceRoot } });
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.ok(workspaceId);
  const stream = client.experimental.tasks.callToolStream(
    { name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'slowcancel' } },
    CallToolResultSchema,
    { task: { ttl: 60_000 } },
  );
  const created = await stream.next();
  assert.equal(created.value?.type, 'taskCreated');
  const taskId = created.value?.type === 'taskCreated' ? created.value.task.taskId : undefined;
  assert.ok(taskId);

  const cancelResponse = await fetch(http.mcpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cancel-probe', method: 'tasks/cancel', params: { taskId } }),
  });
  const cancelBody = await cancelResponse.text();
  assert.match(cancelBody, /cancellation .*not supported|cancellation .*disabled/i);

  let task = await client.experimental.tasks.getTask(taskId);
  for (let attempt = 0; attempt < 40 && task.status !== 'completed' && task.status !== 'failed'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    task = await client.experimental.tasks.getTask(taskId);
  }
  assert.equal(task.status, 'completed');
  const result = await client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
  const value = result.structuredContent as { output?: string } | undefined;
  assert.equal(value?.output, 'still-completed');
});
