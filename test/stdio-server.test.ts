import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { createGateway } from '../src/server.js';
import { startGatewayStdioServer } from '../src/stdio-server.js';
import { NonCancellingTaskStore } from '../src/task-store.js';

class SpyTaskStore extends NonCancellingTaskStore {
  cleanupCount = 0;
  override cleanup(): void {
    this.cleanupCount += 1;
    super.cleanup();
  }
}

test('stdio runtime owns only MCP transport/server/task-store lifecycle', async () => {
  const gateway = createGateway({
    executor: new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' }),
    allowedRoots: [process.cwd()],
    verifyProfiles: {},
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const taskStore = new SpyTaskStore();
  const runtime = await startGatewayStdioServer({ gateway, input, output, taskStore });
  assert.equal(output.readableLength, 0, 'stdio runtime must not emit diagnostics before MCP traffic');
  assert.equal(taskStore.cleanupCount, 0);

  await runtime.close();
  assert.equal(taskStore.cleanupCount, 1);
  await runtime.close();
  assert.equal(taskStore.cleanupCount, 1, 'close must be idempotent');
});
