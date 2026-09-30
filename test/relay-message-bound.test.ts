import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { BrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';
import { createGatewayCallerContext } from '../src/caller-context.js';
import type { DesktopMcpContext } from '../src/desktop-harness/desktop-mcp-runtime.js';
import type { LocalMachineContext } from '../src/local-machine-runtime.js';
import { RELAY_MESSAGE_MAX_BYTES } from '../src/relay-result-chunks.js';
import { createGatewayMcpServer, type GatewayApi } from '../src/server.js';

const WORKSPACE_ID = 'ws_relay_bound';
const BROWSER_ID = 'browser_00000000-0000-4000-8000-000000000001';
const DESKTOP_ID = 'desktop_00000000-0000-4000-8000-000000000001';
const LARGE = 'x'.repeat(64 * 1024);
const ESCAPE_HEAVY = '\\"'.repeat(32 * 1024);
const CONTROL_HEAVY = '\u0001'.repeat(40_000);
const IMAGE_BASE64 = Buffer.alloc(4 * 1024 * 1024, 0xa5).toString('base64');
const BROWSER_IMAGE_BASE64 = Buffer.alloc(8 * 1024 * 1024, 0x5a).toString('base64');
const DESKTOP_IMAGE_BASE64 = Buffer.alloc(3 * 1024 * 1024, 0xd1).toString('base64');

function hugePdf() {
  const page = 'p'.repeat(64 * 1024);
  return {
    path: 'doc.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    raw_sha256: 'a'.repeat(64),
    page_count: 10,
    start_page: 1,
    extracted_pages: 2,
    extracted_chars: page.length,
    pages: [{ page: 1, text: page }, { page: 2, text: page }],
    content: page + '\n\n' + page,
    has_more: true,
    truncated: true,
    redacted: false,
  };
}

function hugeSearch() {
  return {
    matches: Array.from({ length: 20 }, (_, index) => ({
      path: `src/file-${index}.txt`,
      line: index + 1,
      text: LARGE,
      before: [LARGE],
      after: [LARGE],
    })),
    truncated: true,
    visited_files: 20,
    cursor: 'cursor_next',
  };
}

function machineContext(): LocalMachineContext {
  return {
    open: async () => ({ workspace_id: WORKSPACE_ID }),
    describe: async () => ({ workspace_id: WORKSPACE_ID, root: 'C:/relay-bound', backend: 'local-machine' }),
    list: async () => ({
      path: '.',
      depth: 8,
      entries: Array.from({ length: 200 }, (_, index) => ({
        name: `entry-${index}-${'n'.repeat(240)}`,
        type: 'file',
        path: `deep/${index}/${'p'.repeat(800)}`,
        depth: 8,
      })),
      truncated: true,
    }),
    read: async (_id, path) => {
      if (path.endsWith('.png')) throw new Error('not text');
      return hugePdf();
    },
    readMany: async (_id, paths) => ({
      files: paths.map((path) => ({
        path,
        result: { content: LARGE, size_bytes: LARGE.length, raw_sha256: 'b'.repeat(64) },
      })),
    }),
    readImage: async (_id, path) => ({
      path,
      mime_type: 'image/png',
      size_bytes: 4 * 1024 * 1024,
      sha256: 'c'.repeat(64),
      data_base64: IMAGE_BASE64,
    }),
    extractPdf: async () => hugePdf(),
    search: async () => hugeSearch(),
    searchContinue: async () => hugeSearch(),
    searchList: async () => ({ searches: [], active_count: 0, max_active: 32, paused_ttl_ms: 600000 }),
    searchCancel: async (_workspaceId, searchId) => ({ search_id: searchId, cancelled: false, state: 'NOT_FOUND' }),
    info: async () => ({ path: '.', type: 'directory' }),
    mkdir: async () => ({ created: true }),
    move: async () => ({ moved: true }),
    delete: async () => ({ deleted: true }),
    commandRun: async () => ({ exitCode: 0, output: CONTROL_HEAVY, timedOut: false, truncated: true, durationMs: 1, cwd: '.' }),
    processStart: async () => ({ process_id: 'proc_test', pid: 1 }),
    processList: async () => ({
      processes: Array.from({ length: 500 }, (_, index) => ({
        pid: index + 1,
        parent_pid: 0,
        name: `process-${index}`,
        executable_path: `C:/${'x'.repeat(700)}/app.exe`,
        creation_date: '2026-09-27T00:00:00.000Z',
      })),
      truncated: true,
    }),
    processInspect: async () => ({ found: true, pid: 1 }),
    processTerminate: async () => ({ terminated: true }),
    terminalOpen: async () => ({ terminal_id: 'term_test' }),
    terminalList: async () => ({
      terminals: Array.from({ length: 200 }, (_, index) => ({
        terminal_id: `term_${index}`,
        pid: index,
        cwd: `C:/${'t'.repeat(2_000)}`,
        state: 'RUNNING',
        persistent: true,
      })),
    }),
    terminalOutput: async () => ({ output: ESCAPE_HEAVY, truncated: true }),
    terminalInput: async () => ({ written: true }),
    terminalClose: async () => ({ closed: true }),
  };
}

function hugeCommitResult() {
  const paths = Array.from({ length: 64 }, (_, index) =>
    `src/${String(index).padStart(2, '0')}-${'c'.repeat(980)}.ts`,
  );
  const changes = paths.map((path) => ({ status: 'M' as const, path }));
  return {
    commitId: 'cmt_00000000-0000-4000-8000-000000000010',
    state: 'PENDING_APPROVAL' as const,
    branch: 'work/relay-bound',
    oldHead: '1'.repeat(40),
    treeSha: '2'.repeat(40),
    paths,
    changes,
    eolNormalized: paths,
    fingerprint: '3'.repeat(64),
    reviewDeadline: 999_999_999_999_999,
  };
}

function browserContext(): BrowserMcpContext {
  return {
    open: async () => ({ browserSessionId: BROWSER_ID }),
    describe: async () => ({ browserSessionId: BROWSER_ID }),
    snapshot: async () => ({
      snapshotId: 'snap_1',
      browserSessionId: BROWSER_ID,
      url: 'https://example.test/',
      title: 'Example',
      nodes: Array.from({ length: 500 }, (_, index) => ({
        ref: `ref_${index}`,
        role: 'button'.repeat(80),
        name: 'n'.repeat(1_024),
        value: 'v'.repeat(2_048),
        disabled: false,
        editable: false,
        focusable: true,
      })),
      truncated: true,
    }),
    exec: async () => ({ effectId: 'effect_00000000-0000-4000-8000-000000000001' }),
    effect: async () => ({ effectId: 'effect_00000000-0000-4000-8000-000000000001' }),
    screenshot: async () => ({ mimeType: 'image/png', dataBase64: BROWSER_IMAGE_BASE64 }),
    close: async () => ({ browserSessionId: BROWSER_ID }),
    closeAll: async () => undefined,
  } as unknown as BrowserMcpContext;
}

function desktopContext(): DesktopMcpContext {
  return {
    open: async () => ({ desktopSessionId: DESKTOP_ID }),
    describe: async () => ({ desktopSessionId: DESKTOP_ID }),
    snapshot: async () => ({
      snapshotId: 'desktop-snap-1',
      desktopSessionId: DESKTOP_ID,
      pid: 1,
      executablePath: 'C:/Windows/System32/notepad.exe',
      nativeWindowId: '0x1',
      title: 'Relay bound',
      nodes: Array.from({ length: 100 }, (_, index) => ({
        ref: `desktop_node_00000000-0000-4000-8000-000000000001_${index}`,
        role: 'Edit',
        name: 'n'.repeat(1_024),
        value: 'v'.repeat(2_048),
        enabled: true,
        patterns: ['Value'],
      })),
      observedAt: 1,
    }),
    exec: async () => ({ effectId: 'effect_00000000-0000-4000-8000-000000000002' }),
    effect: async () => ({ effectId: 'effect_00000000-0000-4000-8000-000000000002' }),
    screenshot: async () => ({ mimeType: 'image/png', dataBase64: DESKTOP_IMAGE_BASE64 }),
    close: async () => ({ desktopSessionId: DESKTOP_ID }),
    closeAll: async () => undefined,
  } as unknown as DesktopMcpContext;
}

test('all currently oversized live-tool defaults serialize below 256 KiB after relay bounding', async (t) => {
  const gateway = {
    health: async () => ({ status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 6 }),
    openWorkspace: async () => ({ workspaceId: 'unused' }),
    readFile: async () => ({ content: 'unused' }),
    verifyRun: async () => ({ exitCode: 0, output: CONTROL_HEAVY }),
    commandRun: async () => ({ exitCode: 0, output: CONTROL_HEAVY }),
    repoSnapshot: async () => ({ branch: 'main', head: 'a'.repeat(40), dirty: false, status: [], diffStat: '', files: [], filesTruncated: false }),
    repoList: async () => ({ path: '.', entries: [], truncated: false }),
    repoDiff: async () => ({ path: '.', diff: ESCAPE_HEAVY, truncated: true }),
    repoSearch: async () => ({ matches: [], truncated: false }),
  } as unknown as GatewayApi;

  const callerContext = createGatewayCallerContext({
    ownerId: 'relay-bound',
    sessionId: 'session_relay_bound',
    adapterId: 'private.stdio.v1',
  });
  const commitCoordinator = {
    preview: async () => hugeCommitResult(),
    result: () => hugeCommitResult(),
  };
  const server = createGatewayMcpServer(gateway, {
    inspect: true,
    machineContext: machineContext(),
    browserContext: browserContext(),
    desktopContext: desktopContext(),
    commandContext: { authorize: async () => undefined },
    gitCommitContext: { callerContext, coordinator: commitCoordinator as never },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'relay-bound', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const twenty = Array.from({ length: 20 }, (_, index) => `file-${index}.txt`);
  const cases: Array<[string, Record<string, unknown>]> = [
    ['machine.list', { workspace_id: WORKSPACE_ID }],
    ['machine.read', { workspace_id: WORKSPACE_ID, path: 'doc.pdf' }],
    ['machine.read_many', { workspace_id: WORKSPACE_ID, paths: twenty }],
    ['machine.image.read', { workspace_id: WORKSPACE_ID, path: 'image.png' }],
    ['machine.pdf.extract', { workspace_id: WORKSPACE_ID, path: 'doc.pdf' }],
    ['machine.search', { workspace_id: WORKSPACE_ID, query: 'needle' }],
    ['machine.search_continue', { workspace_id: WORKSPACE_ID, cursor: 'cursor_opaque' }],
    ['machine.command.run', {
      workspace_id: WORKSPACE_ID,
      argv: ['node', '--version'],
      max_output_tokens: 20_000,
    }],
    ['machine.process.list', { workspace_id: WORKSPACE_ID }],
    ['machine.terminal.list', { workspace_id: WORKSPACE_ID }],
    ['machine.terminal.output', { workspace_id: WORKSPACE_ID, terminal_id: 'term_test' }],
    ['browser.snapshot', { browser_session_id: BROWSER_ID }],
    ['browser.screenshot', { browser_session_id: BROWSER_ID }],
    ['desktop.snapshot', { desktop_session_id: DESKTOP_ID }],
    ['desktop.screenshot', { desktop_session_id: DESKTOP_ID }],
    ['repo.list', { workspace_id: WORKSPACE_ID }],
    ['repo.search', { workspace_id: WORKSPACE_ID, query: 'needle' }],
    ['file.read', { workspace_id: WORKSPACE_ID, path: 'image.png' }],
    ['verify.run', { workspace_id: WORKSPACE_ID, profile: 'unit' }],
    ['command.run', {
      workspace_id: WORKSPACE_ID,
      argv: ['node', '--version'],
      max_output_tokens: 10_000,
    }],
    ['git.commit', { workspace_id: WORKSPACE_ID, paths: hugeCommitResult().paths, message: 'test: relay bound' }],
    ['git.commit.result', { commit_id: 'cmt_00000000-0000-4000-8000-000000000010' }],
  ];

  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, name);
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(bytes < RELAY_MESSAGE_MAX_BYTES, `${name} serialized to ${bytes} bytes`);
    const chunk = result.structuredContent as {
      chunked?: boolean;
      result_id?: string;
      chunk_index?: number;
      chunk_count?: number;
      data_base64?: string;
      sha256?: string;
    };
    assert.equal(chunk.chunked, true, name + ' should use relay chunking for this oversized fixture');
    assert.match(chunk.result_id ?? '', /^result_[0-9a-f-]{36}$/);
    assert.ok((chunk.chunk_count ?? 0) > 1);

    if (name === 'browser.screenshot' || name === 'desktop.screenshot') {
      const pieces: Buffer[] = [];
      for (let index = 0; index < (chunk.chunk_count ?? 0); index += 1) {
        const part = index === 0
          ? chunk
          : (await client.callTool({
              name: 'result.chunk',
              arguments: { result_id: chunk.result_id, chunk_index: index },
            })).structuredContent as typeof chunk;
        assert.equal(part.chunk_index, index);
        assert.equal(part.chunk_count, chunk.chunk_count);
        assert.equal(part.sha256, chunk.sha256);
        assert.equal(typeof part.data_base64, 'string');
        pieces.push(Buffer.from(part.data_base64!, 'base64'));
      }
      const rebuilt = Buffer.concat(pieces);
      assert.equal(createHash('sha256').update(rebuilt).digest('hex'), chunk.sha256);
      const original = JSON.parse(rebuilt.toString('utf8')) as {
        content: Array<{ type: string; data?: string }>;
      };
      assert.equal(original.content[0]?.type, 'image');
      assert.equal(
        original.content[0]?.data,
        name === 'browser.screenshot' ? BROWSER_IMAGE_BASE64 : DESKTOP_IMAGE_BASE64,
      );
    }
  }
});
