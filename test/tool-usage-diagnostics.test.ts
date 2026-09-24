import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createGatewayMcpServer } from '../src/server.js';
import { ToolUsageDiagnostics } from '../src/tool-usage-diagnostics.js';

test('tool usage diagnostics is bounded, sanitized and groups outcomes by tool', () => {
  const diagnostics = new ToolUsageDiagnostics(16);

  let finish = diagnostics.begin('alpha');
  finish(true);

  finish = diagnostics.begin('alpha');
  finish(false, new TypeError('secret-bearing message must not be retained'));

  finish = diagnostics.begin('beta');
  finish(true);

  const recent = diagnostics.recent({ limit: 10 });
  assert.equal(recent.events.length, 3);
  assert.deepEqual(recent.events.map((event) => event.tool), ['alpha', 'alpha', 'beta']);
  assert.deepEqual(recent.events.map((event) => event.success), [true, false, true]);
  assert.equal(recent.events[1]?.error_class, 'TypeError');
  assert.equal(JSON.stringify(recent).includes('secret-bearing'), false);

  const usage = diagnostics.usage();
  assert.equal(usage.total_calls, 3);
  assert.equal(usage.successes, 2);
  assert.equal(usage.failures, 1);
  assert.deepEqual(
    usage.tools.map((entry) => ({
      tool: entry.tool,
      calls: entry.calls,
      failures: entry.failures,
    })),
    [
      { tool: 'alpha', calls: 2, failures: 1 },
      { tool: 'beta', calls: 1, failures: 0 },
    ],
  );
});

test('tool usage diagnostics retains only the configured rolling window', () => {
  const diagnostics = new ToolUsageDiagnostics(16);
  for (let index = 0; index < 20; index += 1) {
    diagnostics.begin('tool-' + String(index % 2))(true);
  }
  const recent = diagnostics.recent({ limit: 100 });
  assert.equal(recent.events.length, 16);
  assert.equal(recent.events[0]?.sequence, 5);
  assert.equal(recent.events.at(-1)?.sequence, 20);
  assert.equal(recent.capacity, 16);
  assert.equal(recent.retained_events, 16);
});

test('diagnostics MCP tools observe ordinary calls but do not recursively count themselves', async (t) => {
  const diagnostics = new ToolUsageDiagnostics();
  const gateway = {
    async health() {
      return { status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 6 };
    },
    async openWorkspace() { throw new Error('not used'); },
    async readFile() { throw new Error('not used'); },
    async verifyRun() { throw new Error('not used'); },
    async commandRun() { throw new Error('not used'); },
    async repoSnapshot() { throw new Error('not used'); },
    async repoList() { throw new Error('not used'); },
    async repoDiff() { throw new Error('not used'); },
    async repoSearch() { throw new Error('not used'); },
  } as never;

  const server = createGatewayMcpServer(gateway, { diagnosticsContext: diagnostics });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'diagnostics-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const health = await client.callTool({ name: 'health', arguments: {} });
  assert.equal(health.isError, undefined);

  const recentResponse = await client.callTool({
    name: 'diagnostics.recent',
    arguments: { limit: 10 },
  });
  assert.equal(recentResponse.isError, undefined);
  const recent = recentResponse.structuredContent as {
    events: Array<{ tool: string; success: boolean }>;
  };
  assert.deepEqual(recent.events.map((event) => event.tool), ['health']);
  assert.equal(recent.events[0]?.success, true);

  const usageResponse = await client.callTool({ name: 'diagnostics.usage', arguments: {} });
  assert.equal(usageResponse.isError, undefined);
  const usage = usageResponse.structuredContent as {
    total_calls: number;
    tools: Array<{ tool: string; calls: number }>;
  };
  assert.equal(usage.total_calls, 1);
  assert.deepEqual(usage.tools.map((entry) => [entry.tool, entry.calls]), [['health', 1]]);
});
