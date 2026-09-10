import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import {
  DevspaceExecutor,
  REQUIRED_DEVSPACE_TOOLS,
  type DevspaceTokenSource,
} from '../src/executor/devspace.js';

interface FakeDevspace {
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}

async function startFakeDevspace(acceptToken: string | null): Promise<FakeDevspace> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers.authorization ?? '');
    if (acceptToken === null || req.headers.authorization !== `Bearer ${acceptToken}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'gateway-tools/list', result: {
      tools: REQUIRED_DEVSPACE_TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })),
    } }));
  });
  const port = await listen(server);
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => closeServer(server) };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake DevSpace has no TCP address');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('DevSpace executor refreshes once after 401 and retries with the replacement token', async (t) => {
  const fake = await startFakeDevspace('fresh-token');
  t.after(() => fake.close());
  let token = 'expired-token';
  let refreshCount = 0;
  const source: DevspaceTokenSource = {
    async getAccessToken() { return token; },
    async refreshAfterUnauthorized() {
      refreshCount += 1;
      token = 'fresh-token';
      return token;
    },
  };
  const executor = new DevspaceExecutor({ baseUrl: fake.baseUrl, tokenSource: source });
  assert.deepEqual((await executor.listTools()).map((tool) => tool.name), [...REQUIRED_DEVSPACE_TOOLS]);
  assert.equal(refreshCount, 1);
  assert.deepEqual(fake.requests, ['Bearer expired-token', 'Bearer fresh-token']);
});

test('DevSpace executor never retries a second 401', async (t) => {
  const fake = await startFakeDevspace(null);
  t.after(() => fake.close());
  let refreshCount = 0;
  const source: DevspaceTokenSource = {
    async getAccessToken() { return 'expired-token'; },
    async refreshAfterUnauthorized() { refreshCount += 1; return 'still-bad'; },
  };
  const executor = new DevspaceExecutor({ baseUrl: fake.baseUrl, tokenSource: source });
  await assert.rejects(() => executor.listTools(), /HTTP 401/);
  assert.equal(refreshCount, 1);
  assert.equal(fake.requests.length, 2);
});
test('static DevSpace accessToken callers remain single-request compatible', async (t) => {
  const fake = await startFakeDevspace('static-token');
  t.after(() => fake.close());
  const executor = new DevspaceExecutor({ baseUrl: fake.baseUrl, accessToken: 'static-token' });
  assert.deepEqual((await executor.listTools()).map((tool) => tool.name), [...REQUIRED_DEVSPACE_TOOLS]);
  assert.deepEqual(fake.requests, ['Bearer static-token']);
});
