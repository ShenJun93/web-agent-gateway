import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway } from '../src/server.js';
import { startGatewayStdioServer } from '../src/stdio-server.js';

if (false) {
  // @ts-expect-error stdio runtime must not accept MCP v1 TaskStore injection.
  void startGatewayStdioServer({ gateway: null as never, input: null as never, output: null as never, taskStore: null as never });
}

test('stdio runtime owns only MCP transport and server lifecycle', async () => {
  const gateway = createGateway({
    executor: new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' }),
    allowedRoots: [process.cwd()],
    verifyProfiles: {},
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const runtime = await startGatewayStdioServer({ gateway, input, output });
  assert.equal(output.readableLength, 0, 'stdio runtime must not emit diagnostics before MCP traffic');
  await runtime.close();
  await runtime.close();
});
