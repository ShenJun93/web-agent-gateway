import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { createLocalMachineContext } from '../src/local-machine-runtime.js';
import { WorkspaceIdentityRegistry } from '../src/workspace-identity.js';

async function fixture(t: test.TestContext, killSwitch = false) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-local-dc-parity-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'state.sqlite');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const context = createLocalMachineContext({
    store,
    callerContext: createGatewayCallerContext({
      ownerId: 'local.private.stdio',
      sessionId: 'session_dc_parity',
      adapterId: 'private.stdio.v1',
    }),
    workspaceIdentities: identities,
    killSwitch: () => killSwitch,
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const opened = await context.open(root) as { workspace_id: string };
  return { root, context, workspaceId: opened.workspace_id };
}

test('local-machine filesystem parity covers info/search/mkdir/move/delete inside the owned root', async (t) => {
  const { root, context, workspaceId } = await fixture(t);

  await context.mkdir(workspaceId, 'nested');
  await writeFile(join(root, 'nested', 'source.txt'), 'Alpha needle\nsecond line\n', 'utf8');

  const info = await context.info(workspaceId, 'nested/source.txt') as {
    type: string;
    size_bytes: number;
    realpath: string;
  };
  assert.equal(info.type, 'file');
  assert.ok(info.size_bytes > 0);
  assert.match(info.realpath, /source\.txt$/i);

  const searched = await context.search(workspaceId, 'NEEDLE', {
    path: 'nested',
    ignoreCase: true,
    maxResults: 10,
    contextLines: 1,
  }) as {
    matches: Array<{ path: string; line: number; text: string; before: string[]; after: string[] }>;
    truncated: boolean;
  };
  assert.equal(searched.truncated, false);
  assert.deepEqual(searched.matches.map((m) => [m.path, m.line, m.text]), [
    ['nested/source.txt', 1, 'Alpha needle'],
  ]);

  await context.move(workspaceId, 'nested/source.txt', 'nested/moved.txt');
  assert.equal(await readFile(join(root, 'nested', 'moved.txt'), 'utf8'), 'Alpha needle\nsecond line\n');

  await assert.rejects(
    () => context.delete(workspaceId, 'nested', false),
    /non-empty directory delete/,
  );
  await context.delete(workspaceId, 'nested/moved.txt');
  await context.delete(workspaceId, 'nested');
  await assert.rejects(() => readFile(join(root, 'nested', 'moved.txt'), 'utf8'));
});

test('local-machine owned process lifecycle supports start, inspect, list and terminate', async (t) => {
  const { context, workspaceId } = await fixture(t);

  const started = await context.processStart(workspaceId, [
    process.execPath,
    '-e',
    'setInterval(() => {}, 1000)',
  ]) as { process_id: string; pid: number; started: boolean };
  assert.equal(started.started, true);
  assert.match(started.process_id, /^proc_/);
  assert.ok(started.pid > 0);

  const inspected = await context.processInspect(workspaceId, started.process_id) as {
    found: boolean;
    pid: number;
    owned?: boolean;
    process_id?: string;
  };
  assert.equal(inspected.found, true);
  assert.equal(inspected.pid, started.pid);
  assert.equal(inspected.owned, true);
  assert.equal(inspected.process_id, started.process_id);

  const listed = await context.processList(workspaceId) as {
    processes: Array<{ pid: number; process_id?: string; owned?: boolean }>;
  };
  assert.ok(listed.processes.some((p) =>
    p.pid === started.pid && p.process_id === started.process_id && p.owned === true));

  const terminated = await context.processTerminate(workspaceId, started.process_id) as {
    terminated: boolean;
    state: string;
  };
  assert.equal(terminated.terminated, true);
  assert.equal(terminated.state, 'TERMINATED');
});

test('local-machine interactive terminal supports bounded input/output and close', async (t) => {
  const { context, workspaceId } = await fixture(t);
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';

  const opened = await context.terminalOpen(workspaceId, shell) as {
    terminal_id: string;
    state: string;
  };
  assert.match(opened.terminal_id, /^term_/);
  assert.equal(opened.state, 'RUNNING');

  const command = process.platform === 'win32'
    ? "Write-Output 'terminal-ok'; exit\r\n"
    : "printf 'terminal-ok\\n'; exit\n";
  await context.terminalInput(
    workspaceId,
    opened.terminal_id,
    Buffer.from(command, 'utf8').toString('base64'),
  );

  let output = '';
  let state = 'RUNNING';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !output.includes('terminal-ok')) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const result = await context.terminalOutput(workspaceId, opened.terminal_id) as {
      output: string;
      state: string;
    };
    output += result.output;
    state = result.state;
  }
  assert.match(output, /terminal-ok/);

  const closed = await context.terminalClose(workspaceId, opened.terminal_id) as {
    closed: boolean;
    state: string;
  };
  assert.equal(closed.closed, true);
  assert.ok(['EXITED', 'TERMINATED'].includes(closed.state) || state === 'EXITED');
});

test('autonomous stop blocks new filesystem/process/terminal effects but leaves inspection available', async (t) => {
  const { context, workspaceId } = await fixture(t, true);

  await context.info(workspaceId);
  await context.list(workspaceId);

  await assert.rejects(() => context.mkdir(workspaceId, 'blocked'), /KILL_SWITCH_ENGAGED/);
  await assert.rejects(
    () => context.processStart(workspaceId, [process.execPath, '--version']),
    /KILL_SWITCH_ENGAGED/,
  );
  await assert.rejects(
    () => context.terminalOpen(workspaceId, process.platform === 'win32' ? 'powershell' : 'bash'),
    /KILL_SWITCH_ENGAGED/,
  );
});
