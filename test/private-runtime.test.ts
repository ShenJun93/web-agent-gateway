import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import type { DevspaceOAuthSession } from '../src/executor/devspace-oauth.js';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import {
  bootstrapPrivateGateway,
  PrivateRuntimeError,
} from '../src/private-runtime.js';

async function startFakeDevspace(toolNames: string[]): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'gateway-tools/list', result: {
      tools: toolNames.map((name) => ({ name, inputSchema: { type: 'object' } })),
    } }));
  });
  const port = await listen(server);
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake DevSpace has no address');
  return address.port;
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function config(baseUrl: string): PrivateGatewayConfig {
  return {
    allowedRoots: [process.cwd()],
    devspace: { baseUrl, resourceUrl: `${baseUrl}/mcp` },
    verifyProfiles: { version: { argv: ['node', '--version'] } },
  };
}

function fakeSession() {
  let closed = false;
  const session: DevspaceOAuthSession & { readonly closed: boolean } = {
    get closed() { return closed; },
    async getAccessToken() { return 'test-access'; },
    async refreshAfterUnauthorized() { return 'test-access'; },
    close() { closed = true; },
  };
  return session;
}

test('private runtime removes owner token after auth and owns OAuth cleanup only', async (t) => {
  const required = ['open_workspace', 'read', 'apply_patch', 'exec_command', 'write_stdin', 'show_changes'];
  const devspace = await startFakeDevspace(required);
  t.after(() => devspace.close());
  const session = fakeSession();
  const env = { DEVSPACE_OAUTH_OWNER_TOKEN: 'owner-token-long-enough-for-runtime' };
  const runtime = await bootstrapPrivateGateway(config(devspace.baseUrl), {
    env,
    oauthFactory: async () => session,
  });

  assert.equal(env.DEVSPACE_OAUTH_OWNER_TOKEN, undefined);
  assert.equal(runtime.health.status, 'ok');
  assert.equal(session.closed, false);
  await runtime.close();
  assert.equal(session.closed, true);
  await runtime.close();
});

test('private runtime fails before OAuth when owner token is missing', async () => {
  let called = false;
  await assert.rejects(
    () => bootstrapPrivateGateway(config('http://127.0.0.1:1'), {
      env: {},
      oauthFactory: async () => { called = true; return fakeSession(); },
    }),
    (error: unknown) => error instanceof PrivateRuntimeError && error.code === 'DEVSPACE_OWNER_TOKEN_MISSING',
  );
  assert.equal(called, false);
});
test('private runtime closes OAuth session when DevSpace compatibility fails', async (t) => {
  const devspace = await startFakeDevspace(['open_workspace']);
  t.after(() => devspace.close());
  const session = fakeSession();
  const env = { DEVSPACE_OAUTH_OWNER_TOKEN: 'owner-token-long-enough-for-runtime' };

  await assert.rejects(
    () => bootstrapPrivateGateway(config(devspace.baseUrl), {
      env,
      oauthFactory: async () => session,
    }),
    (error: unknown) => error instanceof PrivateRuntimeError && error.code === 'DEVSPACE_COMPAT_FAILED',
  );
  assert.equal(env.DEVSPACE_OAUTH_OWNER_TOKEN, undefined);
  assert.equal(session.closed, true);
});

test('private runtime wraps OAuth bootstrap failure without leaking the cause text', async () => {
  const secret = 'owner-token-that-must-not-appear';
  const env = { DEVSPACE_OAUTH_OWNER_TOKEN: secret };
  await assert.rejects(
    () => bootstrapPrivateGateway(config('http://127.0.0.1:1'), {
      env,
      oauthFactory: async () => { throw new Error(`upstream rejected ${secret}`); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof PrivateRuntimeError);
      assert.equal(error.code, 'DEVSPACE_AUTH_FAILED');
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
