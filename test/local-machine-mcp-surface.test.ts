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
    searchList: async (id) => record('searchList', id),
    searchCancel: async (id, searchId) => record('searchCancel', id, searchId),
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
    extractPdf: async (id, path, options) => record('extractPdf', id, path, options),
    inspectDocx: async (id, path, options) => record('inspectDocx', id, path, options),
    createDocx: async (id, path, paragraphs) => record('createDocx', id, path, paragraphs),
    replaceDocxText: async (id, path, sha, find, replacement, replaceAll) =>
      record('replaceDocxText', id, path, sha, find, replacement, replaceAll),
    inspectXlsx: async (id, path, options) => record('inspectXlsx', id, path, options),
    createXlsx: async (id, path, sheets) => record('createXlsx', id, path, sheets),
    setXlsxCells: async (id, path, sha, sheet, cells) =>
      record('setXlsxCells', id, path, sha, sheet, cells),
    createPdf: async (id, path, pages, options) => record('createPdf', id, path, pages, options),
    overlayPdfText: async (id, path, sha, options) => record('overlayPdfText', id, path, sha, options),
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

  assert.equal((await invoke('machine.pdf.extract', {
    workspace_id: workspaceId,
    path: 'document.pdf',
    start_page: 2,
    max_pages: 4,
    max_chars: 12000,
  })).name, 'extractPdf');

  const sha = 'a'.repeat(64);
  assert.equal((await invoke('machine.docx.inspect', {
    workspace_id: workspaceId,
    path: 'document.docx',
    max_paragraphs: 10,
    max_chars: 2048,
  })).name, 'inspectDocx');
  assert.equal((await invoke('machine.docx.create', {
    workspace_id: workspaceId,
    path: 'new.docx',
    paragraphs: ['one', 'two'],
  })).name, 'createDocx');
  assert.equal((await invoke('machine.docx.replace_text', {
    workspace_id: workspaceId,
    path: 'document.docx',
    expected_sha256: sha,
    find: 'old',
    replacement: 'new',
    replace_all: false,
  })).name, 'replaceDocxText');
  assert.equal((await invoke('machine.xlsx.inspect', {
    workspace_id: workspaceId,
    path: 'sheet.xlsx',
    max_cells: 20,
    max_chars: 4096,
  })).name, 'inspectXlsx');
  assert.equal((await invoke('machine.xlsx.create', {
    workspace_id: workspaceId,
    path: 'new.xlsx',
    sheets: [{ name: 'Data', cells: [{ cell: 'A1', value: 'x' }] }],
  })).name, 'createXlsx');
  assert.equal((await invoke('machine.xlsx.set_cells', {
    workspace_id: workspaceId,
    path: 'sheet.xlsx',
    expected_sha256: sha,
    sheet: 'Data',
    cells: [{ cell: 'B2', value: 42 }],
  })).name, 'setXlsxCells');
  assert.equal((await invoke('machine.pdf.create', {
    workspace_id: workspaceId,
    path: 'new.pdf',
    pages: ['page one'],
    font_size: 12,
    margin: 54,
  })).name, 'createPdf');
  assert.equal((await invoke('machine.pdf.overlay_text', {
    workspace_id: workspaceId,
    path: 'document.pdf',
    expected_sha256: sha,
    page: 1,
    text: 'overlay',
    x: 72,
    y: 700,
    font_size: 12,
  })).name, 'overlayPdfText');

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

  assert.equal((await invoke('machine.search_list', {
    workspace_id: workspaceId,
  })).name, 'searchList');

  assert.equal((await invoke('machine.search_cancel', {
    workspace_id: workspaceId,
    search_id: 'search_12345678',
  })).name, 'searchCancel');

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

  const searchList = calls.find((call) => call.name === 'searchList');
  assert.deepEqual(searchList?.args, [workspaceId]);

  const searchCancel = calls.find((call) => call.name === 'searchCancel');
  assert.deepEqual(searchCancel?.args, [workspaceId, 'search_12345678']);

  const injected = await client.callTool({
    name: 'machine.process.terminate',
    arguments: { workspace_id: workspaceId, process_id: 'proc_123', force_any_pid: true },
  });
  assert.equal(injected.isError, true);
  assert.match(JSON.stringify(injected.content), /Invalid arguments/);
});
