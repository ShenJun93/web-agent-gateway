import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessPort } from '../src/process-harness/process-port.js';
import { createNodeProcessBackend } from '../src/process-harness/node-process-backend.js';
import type { GatewayAuthority } from '../src/caller-context.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_node', sessionId: 'session_node', adapterId: 'private.stdio.v1' };

test('Node ProcessPort backend uses direct argv, constructed environment and captures output', async () => {
  const backend = createNodeProcessBackend({
    envSource: { ...process.env, WAG_PROCESS_SECRET: 'must-not-leak' },
  });
  const port = createProcessPort({
    backend,
    effectAllowed: () => true,
    randomUUID: () => '00000000-0000-4000-8000-000000000011',
  });
  const started = await port.start(OWNER, {
    argv: [
      process.execPath,
      '-e',
      'process.stdout.write(String(process.env.WAG_PROCESS_SECRET || "clean"))',
    ],
  });
  const done = await port.wait(OWNER, started.processId, 5000);
  assert.equal(done.state, 'EXITED');
  assert.equal(done.exitCode, 0);
  assert.equal((await port.read(OWNER, started.processId)).stdout, 'clean');
});

test('Node ProcessPort backend stops only the exact owned process tree', async (t) => {
  const backend = createNodeProcessBackend();
  let n = 12;
  const port = createProcessPort({
    backend,
    effectAllowed: () => true,
    randomUUID: () => `00000000-0000-4000-8000-0000000000${n++}`,
  });
  const argv = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
  const first = await port.start(OWNER, { argv });
  const second = await port.start(OWNER, { argv });
  t.after(async () => {
    await port.stop(OWNER, first.processId).catch(() => undefined);
    await port.stop(OWNER, second.processId).catch(() => undefined);
  });

  assert.equal((await port.stop(OWNER, first.processId)).state, 'STOPPED');
  assert.equal((await port.describe(OWNER, second.processId)).state, 'RUNNING');
  assert.equal((await port.stop(OWNER, second.processId)).state, 'STOPPED');
});
