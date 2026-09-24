import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createProcessPort,
  type ProcessBackend,
  type ProcessBackendHandle,
} from '../src/process-harness/process-port.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_a', sessionId: 'session_a', adapterId: 'private.stdio.v1' };
const OTHER: GatewayAuthority = { ownerId: 'owner_a', sessionId: 'session_b', adapterId: 'private.stdio.v1' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function backendFixture() {
  let pid = 4000;
  const handles: Array<{
    spec: { argv: readonly string[]; cwd?: string };
    stopped: boolean;
    writes: string[];
    closed: boolean;
    exit: ReturnType<typeof deferred<{ exitCode: number | null; signal: string | null }>>;
  }> = [];
  const backend: ProcessBackend = {
    async start(spec) {
      const exit = deferred<{ exitCode: number | null; signal: string | null }>();
      const record = { spec, stopped: false, writes: [] as string[], closed: false, exit };
      handles.push(record);
      const handle: ProcessBackendHandle = {
        pid: ++pid,
        read() {
          return {
            stdout: record.writes.join(''),
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
        async write(data) { record.writes.push(data); },
        async closeStdin() { record.closed = true; },
        wait() { return exit.promise; },
        async stopTree() {
          record.stopped = true;
          exit.resolve({ exitCode: null, signal: 'SIGKILL' });
        },
      };
      return handle;
    },
  };
  return { backend, handles };
}

test('ProcessPort owns handles by exact authority and never exposes a foreign process', async () => {
  const f = backendFixture();
  const port = createProcessPort({
    backend: f.backend,
    effectAllowed: () => true,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  });
  const started = await port.start(OWNER, { argv: ['node', '--version'], cwd: 'E:/owned' });
  assert.equal(started.processId, 'process_00000000-0000-4000-8000-000000000001');
  assert.equal(started.pid, 4001);
  assert.equal(started.state, 'RUNNING');
  assert.equal((await port.list(OWNER)).length, 1);
  assert.equal((await port.list(OTHER)).length, 0);
  await assert.rejects(() => port.describe(OTHER, started.processId), /another authority/);
  await assert.rejects(() => port.stop(OTHER, started.processId), /another authority/);
  assert.equal(f.handles[0]!.stopped, false);
});

test('ProcessPort supports bounded stdin/output and natural exit state', async () => {
  const f = backendFixture();
  const port = createProcessPort({
    backend: f.backend,
    effectAllowed: () => true,
    randomUUID: () => '00000000-0000-4000-8000-000000000002',
  });
  const started = await port.start(OWNER, { argv: ['node', 'worker.js'] });
  await port.write(OWNER, started.processId, 'hello\n');
  await port.closeStdin(OWNER, started.processId);
  assert.equal((await port.read(OWNER, started.processId)).stdout, 'hello\n');
  assert.equal(f.handles[0]!.closed, true);
  f.handles[0]!.exit.resolve({ exitCode: 7, signal: null });
  const completed = await port.wait(OWNER, started.processId, 1000);
  assert.equal(completed.state, 'EXITED');
  assert.equal(completed.exitCode, 7);
});

test('ProcessPort cleanup remains available after effect gate closes', async () => {
  const f = backendFixture();
  let allowed = true;
  const port = createProcessPort({
    backend: f.backend,
    effectAllowed: () => allowed,
    randomUUID: () => '00000000-0000-4000-8000-000000000003',
  });
  const started = await port.start(OWNER, { argv: ['node', 'worker.js'] });
  allowed = false;
  await assert.rejects(() => port.write(OWNER, started.processId, 'x'), /effect denied/);
  const stopped = await port.stop(OWNER, started.processId);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(f.handles[0]!.stopped, true);
});

test('ProcessPort reaps a just-spawned child when the pre-effect recheck turns false', async () => {
  const f = backendFixture();
  let checks = 0;
  const port = createProcessPort({
    backend: f.backend,
    effectAllowed: () => ++checks === 1,
    randomUUID: () => '00000000-0000-4000-8000-000000000004',
  });
  await assert.rejects(() => port.start(OWNER, { argv: ['node', 'worker.js'] }), /effect denied/);
  assert.equal(f.handles.length, 1);
  assert.equal(f.handles[0]!.stopped, true);
  assert.deepEqual(await port.list(OWNER), []);
});
