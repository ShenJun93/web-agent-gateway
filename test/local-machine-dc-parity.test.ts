import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

  await writeFile(
    join(root, 'nested', 'secret.txt'),
    'API_KEY=fixture-secret-value\nneedle with secret context\n',
    'utf8',
  );
  const redactedSearch = await context.search(workspaceId, 'needle with secret context', {
    path: 'nested',
    ignoreCase: false,
    maxResults: 10,
    contextLines: 1,
  }) as {
    matches: Array<{ text: string; before: string[]; after: string[] }>;
  };
  assert.deepEqual(redactedSearch.matches[0]?.before, ['API_KEY=<REDACTED>']);
  assert.equal(redactedSearch.matches[0]?.text, 'needle with secret context');

  await context.move(workspaceId, 'nested/source.txt', 'nested/moved.txt');
  assert.equal(await readFile(join(root, 'nested', 'moved.txt'), 'utf8'), 'Alpha needle\nsecond line\n');

  await assert.rejects(
    () => context.delete(workspaceId, 'nested', false),
    /non-empty directory delete/,
  );
  await context.delete(workspaceId, 'nested/moved.txt');
  await context.delete(workspaceId, 'nested/secret.txt');
  await context.delete(workspaceId, 'nested');
  await assert.rejects(() => readFile(join(root, 'nested', 'moved.txt'), 'utf8'));
});

test('local-machine read pagination, multi-read and recursive list cover large local trees without unbounded output', async (t) => {
  const { root, context, workspaceId } = await fixture(t);

  await context.mkdir(workspaceId, 'tree');
  await context.mkdir(workspaceId, 'tree/deep');
  await writeFile(join(root, 'tree', 'a.txt'), 'alpha\n', 'utf8');
  await writeFile(join(root, 'tree', 'deep', 'b.txt'), 'bravo\n', 'utf8');

  const lines = Array.from({ length: 1_200 }, (_, index) =>
    `line-${String(index).padStart(4, '0')} ${'x'.repeat(80)}`);
  const largeText = lines.join('\n') + '\n';
  assert.ok(Buffer.byteLength(largeText, 'utf8') > 64 * 1024);
  await writeFile(join(root, 'large.txt'), largeText, 'utf8');

  await assert.rejects(
    () => context.read(workspaceId, 'large.txt'),
    /use offset\/length pagination/,
  );

  const page = await context.read(workspaceId, 'large.txt', { offset: 100, length: 3 }) as {
    content: string;
    raw_sha256: string;
    offset: number;
    length: number;
    total_lines: number;
    has_more: boolean;
    truncated: boolean;
  };
  assert.equal(page.content, lines.slice(100, 103).join('\n'));
  assert.equal(page.raw_sha256, createHash('sha256').update(largeText).digest('hex'));
  assert.equal(page.offset, 100);
  assert.equal(page.length, 3);
  assert.equal(page.total_lines, 1_201);
  assert.equal(page.has_more, true);
  assert.equal(page.truncated, false);

  const tail = await context.read(workspaceId, 'large.txt', { offset: -2, length: 2 }) as {
    content: string;
    offset: number;
    length: number;
    has_more: boolean;
  };
  assert.equal(tail.offset, 1_199);
  assert.equal(tail.content, lines[1_199] + '\n');
  assert.equal(tail.length, 2);
  assert.equal(tail.has_more, false);

  const many = await context.readMany(
    workspaceId,
    ['tree/a.txt', 'tree/deep/b.txt', 'missing.txt'],
  ) as {
    files: Array<{ path: string; result?: { content: string }; error?: string }>;
  };
  assert.equal(many.files[0]?.result?.content, 'alpha');
  assert.equal(many.files[1]?.result?.content, 'bravo');
  assert.match(many.files[2]?.error ?? '', /missing path/i);

  const shallow = await context.list(workspaceId, 'tree', 20, 1) as {
    entries: Array<{ name: string; path?: string; depth?: number }>;
  };
  assert.equal(shallow.entries.some((entry) => entry.name === 'b.txt'), false);

  const recursive = await context.list(workspaceId, 'tree', 20, 3) as {
    entries: Array<{ name: string; path?: string; depth?: number }>;
    depth: number;
    truncated: boolean;
  };
  assert.equal(recursive.depth, 3);
  assert.equal(recursive.truncated, false);
  assert.ok(recursive.entries.some((entry) => entry.path === 'tree/deep/b.txt' && entry.depth === 2));
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

test('local-machine can terminate an externally started process only after an observed identity token', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('external process termination proof currently requires Windows CreationDate identity');
    return;
  }
  const { context, workspaceId } = await fixture(t);
  const external = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (!external.pid) throw new Error('external fixture process did not start');
  external.unref();

  t.after(() => {
    try { process.kill(external.pid!, 'SIGKILL'); } catch {}
  });

  await assert.rejects(
    () => context.processTerminate(workspaceId, String(external.pid)),
    /process record/,
    'a raw PID is never itself termination authority',
  );

  let inspected: {
    found: boolean;
    pid: number;
    process_id?: string;
    observed?: boolean;
    terminable?: boolean;
  } | undefined;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    inspected = await context.processInspect(workspaceId, String(external.pid)) as typeof inspected;
    if (inspected?.found && inspected.process_id) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.equal(inspected?.found, true);
  assert.equal(inspected?.pid, external.pid);
  assert.equal(inspected?.observed, true);
  assert.equal(inspected?.terminable, true);
  assert.match(inspected?.process_id ?? '', /^obs_/);

  const terminated = await context.processTerminate(workspaceId, inspected!.process_id!) as {
    terminated: boolean;
    observed: boolean;
    state: string;
  };
  assert.equal(terminated.terminated, true);
  assert.equal(terminated.observed, true);
  assert.equal(terminated.state, 'TERMINATED');

  await assert.rejects(
    () => context.processTerminate(workspaceId, inspected!.process_id!),
    /process record/,
    'observation tokens are single-use after termination',
  );
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

  const listed = await context.terminalList(workspaceId) as {
    terminals: Array<{ terminal_id: string; state: string }>;
  };
  assert.ok(listed.terminals.some((entry) =>
    entry.terminal_id === opened.terminal_id && entry.state === 'RUNNING'));

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

test('persistent terminal broker reconnects after LocalMachineContext reconstruction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-local-terminal-recovery-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'state.sqlite');
  const terminalRegistryPath = join(dir, 'terminals');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const callerContext = createGatewayCallerContext({
    ownerId: 'local.private.stdio',
    sessionId: 'session_terminal_recovery',
    adapterId: 'private.stdio.v1',
  });
  let second: ReturnType<typeof createLocalMachineContext> | undefined;
  let workspaceId = '';
  let terminalId = '';

  t.after(async () => {
    if (second && workspaceId && terminalId) {
      await second.terminalClose(workspaceId, terminalId).catch(() => undefined);
    }
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const first = createLocalMachineContext({
    store,
    callerContext,
    workspaceIdentities: identities,
    killSwitch: () => false,
    terminalRegistryPath,
  });
  workspaceId = (await first.open(root) as { workspace_id: string }).workspace_id;
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const opened = await first.terminalOpen(workspaceId, shell) as {
    terminal_id: string;
    persistent: boolean;
    state: string;
  };
  terminalId = opened.terminal_id;
  assert.equal(opened.persistent, true);
  assert.equal(opened.state, 'RUNNING');

  const command = process.platform === 'win32'
    ? "Write-Output 'API_KEY=terminal-recovery-secret'; Write-Output 'terminal-before-restart'\r\n"
    : "printf 'API_KEY=terminal-recovery-secret\\nterminal-before-restart\\n'\n";
  await first.terminalInput(workspaceId, terminalId, Buffer.from(command, 'utf8').toString('base64'));

  second = createLocalMachineContext({
    store,
    callerContext,
    workspaceIdentities: identities,
    killSwitch: () => false,
    terminalRegistryPath,
  });
  const reopened = (await second.open(root) as { workspace_id: string }).workspace_id;
  workspaceId = reopened;

  const listed = await second.terminalList(reopened) as {
    terminals: Array<{ terminal_id: string; persistent?: boolean; state: string }>;
  };
  assert.ok(listed.terminals.some((entry) =>
    entry.terminal_id === terminalId && entry.persistent === true && entry.state === 'RUNNING'));

  let output = '';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !output.includes('terminal-before-restart')) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const result = await second.terminalOutput(reopened, terminalId) as { output: string };
    output += result.output;
  }
  assert.match(output, /terminal-before-restart/);
  assert.doesNotMatch(output, /terminal-recovery-secret/);
  assert.match(output, /API_KEY=<REDACTED>/);

  const terminalDir = join(terminalRegistryPath, terminalId);
  const tokenText = await readFile(join(terminalDir, 'token.txt'), 'utf8');
  const listingJson = JSON.stringify(listed);
  assert.match(tokenText, /^TERMINAL_TOKEN=[a-f0-9]{64}\n$/);
  assert.doesNotMatch(listingJson, /TERMINAL_TOKEN|[a-f0-9]{64}/);

  const afterRestart = process.platform === 'win32'
    ? "Write-Output 'terminal-after-restart'\r\n"
    : "printf 'terminal-after-restart\\n'\n";
  await second.terminalInput(
    reopened,
    terminalId,
    Buffer.from(afterRestart, 'utf8').toString('base64'),
  );

  let afterOutput = '';
  const secondDeadline = Date.now() + 5_000;
  while (Date.now() < secondDeadline && !afterOutput.includes('terminal-after-restart')) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const result = await second.terminalOutput(reopened, terminalId) as { output: string };
    afterOutput += result.output;
  }
  assert.match(afterOutput, /terminal-after-restart/);

  const closed = await second.terminalClose(reopened, terminalId) as { closed: boolean };
  assert.equal(closed.closed, true);
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
