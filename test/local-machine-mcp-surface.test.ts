import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { DevspaceExecutor } from '../src/executor/devspace.js';
import type { LocalMachineContext } from '../src/local-machine-runtime.js';
import { createGateway, createGatewayMcpServer } from '../src/server.js';

test('machine MCP surface routes DC-parity verbs to LocalMachineContext with strict arguments', async (t) => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const workspaceId = 'ws_machine_surface';
  const record = async (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
    return { name, args };
  };

  const machineContext: LocalMachineContext = {
    open: async (path) => record('open', path),
    describe: async (id) => record('describe', id),
    list: async (id, path, maxEntries, depth) => record('list', id, path, maxEntries, depth),
    search: async (id, query, options) => record('search', id, query, options),
    searchContinue: async (id, cursor, maxResults) => record('searchContinue', id, cursor, maxResults),
    info: async (id, path) => record('info', id, path),
    read: async (id, path, options) => record('read', id, path, options),
    readMany: async (id, paths, options) => record('readMany', id, paths, options),
    readImage: async (_id, path) => ({
      path,
      mime_type: 'image/png',
      size_bytes: 8,
      sha256: 'a'.repeat(64),
      data_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
    }),
    mkdir: async (id, path) => record('mkdir', id, path),
    move: async (id, from, to) => record('move', id, from, to),
    delete: async (id, path, recursive) => record('delete', id, path, recursive),
    commandRun: async (id, argv, options) => record('commandRun', id, argv, options),
    processList: async (id) => record('processList', id),
    processInspect: async (id, value) => record('processInspect', id, value),
    processStart: async (id, argv, options) => record('processStart', id, argv, options),
    processTerminate: async (id, processId) => record('processTerminate', id, processId),
    terminalOpen: async (id, shell, cwd) => record('terminalOpen', id, shell, cwd),
    terminalList: async (id) => record('terminalList', id),
    terminalOutput: async (id, terminalId) => record('terminalOutput', id, terminalId),
    terminalInput: async (id, terminalId, base64) => record('terminalInput', id, terminalId, base64),
    terminalClose: async (id, terminalId) => record('terminalClose', id, terminalId),
  };

  const executor = {
    openWorkspace: async () => 'unused',
    execCommand: async () => ({ output: '', exitCode: 0, running: false }),
    interruptCommand: async () => {},
  } as unknown as DevspaceExecutor;

  const gateway = createGateway({
    executor,
    allowedRoots: [process.cwd()],
    verifyProfiles: {},
  });
  const server = createGatewayMcpServer(gateway, { machineContext });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'machine-surface-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, name + ' should succeed');
    return result.structuredContent as { name: string; args: unknown[] };
  };

  assert.equal((await invoke('machine.list', {
    workspace_id: workspaceId,
    path: '.',
    max_entries: 25,
    depth: 3,
  })).name, 'list');

  assert.equal((await invoke('machine.read', {
    workspace_id: workspaceId,
    path: 'note.txt',
    offset: -5,
    length: 2,
  })).name, 'read');

  assert.equal((await invoke('machine.read_many', {
    workspace_id: workspaceId,
    paths: ['a.txt', 'b.txt'],
    offset: 10,
    length: 20,
  })).name, 'readMany');

  const image = await client.callTool({
    name: 'machine.image.read',
    arguments: { workspace_id: workspaceId, path: 'pixel.png' },
  });
  assert.notEqual(image.isError, true);
  assert.equal((image.structuredContent as { mime_type?: string }).mime_type, 'image/png');
  assert.equal((image.content[0] as { type?: string }).type, 'image');

  assert.equal((await invoke('machine.search', {
    workspace_id: workspaceId,
    query: 'needle',
    path: 'src',
    ignore_case: true,
    max_results: 7,
    context_lines: 2,
  })).name, 'search');

  assert.equal((await invoke('machine.search_continue', {
    workspace_id: workspaceId,
    cursor: 'cursor_opaque',
    max_results: 9,
  })).name, 'searchContinue');

  assert.equal((await invoke('machine.info', {
    workspace_id: workspaceId,
    path: 'note.txt',
  })).name, 'info');

  assert.equal((await invoke('machine.mkdir', {
    workspace_id: workspaceId,
    path: 'new-dir',
  })).name, 'mkdir');

  assert.equal((await invoke('machine.move', {
    workspace_id: workspaceId,
    from: 'a.txt',
    to: 'b.txt',
  })).name, 'move');

  assert.equal((await invoke('machine.delete', {
    workspace_id: workspaceId,
    path: 'b.txt',
    recursive: false,
  })).name, 'delete');

  assert.equal((await invoke('machine.process.list', {
    workspace_id: workspaceId,
  })).name, 'processList');

  assert.equal((await invoke('machine.process.inspect', {
    workspace_id: workspaceId,
    id_or_pid: '1234',
  })).name, 'processInspect');

  assert.equal((await invoke('machine.process.terminate', {
    workspace_id: workspaceId,
    process_id: 'proc_123',
  })).name, 'processTerminate');

  assert.equal((await invoke('machine.terminal.open', {
    workspace_id: workspaceId,
    shell: 'powershell',
    cwd: '.',
  })).name, 'terminalOpen');

  assert.equal((await invoke('machine.terminal.list', {
    workspace_id: workspaceId,
  })).name, 'terminalList');

  assert.equal((await invoke('machine.terminal.output', {
    workspace_id: workspaceId,
    terminal_id: 'term_123',
  })).name, 'terminalOutput');

  const base64 = Buffer.from('Write-Output ok\r\n', 'utf8').toString('base64');
  assert.equal((await invoke('machine.terminal.input', {
    workspace_id: workspaceId,
    terminal_id: 'term_123',
    base64,
  })).name, 'terminalInput');

  assert.equal((await invoke('machine.terminal.close', {
    workspace_id: workspaceId,
    terminal_id: 'term_123',
  })).name, 'terminalClose');

  const list = calls.find((call) => call.name === 'list');
  assert.deepEqual(list?.args, [workspaceId, '.', 25, 3]);

  const readCall = calls.find((call) => call.name === 'read');
  assert.deepEqual(readCall?.args, [workspaceId, 'note.txt', { offset: -5, length: 2 }]);

  const readManyCall = calls.find((call) => call.name === 'readMany');
  assert.deepEqual(readManyCall?.args, [workspaceId, ['a.txt', 'b.txt'], { offset: 10, length: 20 }]);

  const search = calls.find((call) => call.name === 'search');
  assert.deepEqual(search?.args, [
    workspaceId,
    'needle',
    { path: 'src', ignoreCase: true, maxResults: 7, contextLines: 2 },
  ]);

  const continued = calls.find((call) => call.name === 'searchContinue');
  assert.deepEqual(continued?.args, [workspaceId, 'cursor_opaque', 9]);

  const injected = await client.callTool({
    name: 'machine.process.terminate',
    arguments: { workspace_id: workspaceId, process_id: 'proc_123', force_any_pid: true },
  });
  assert.equal(injected.isError, true);
  assert.match(JSON.stringify(injected.content), /Invalid arguments/);
});
