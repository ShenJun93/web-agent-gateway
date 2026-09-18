import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_ADAPTER_MAX_BYTES,
  BROWSER_ADAPTER_PROTOCOL_VERSION,
  parseBrowserAdapterRequest,
  parseBrowserAdapterResponse,
  serializedBytes,
} from '../src/browser-adapter/protocol.js';

const rid = 'req_12345678';
const sid = 'session_12345678';

test('browser adapter protocol accepts the v2 lifecycle envelopes', () => {
  assert.equal(BROWSER_ADAPTER_PROTOCOL_VERSION, 2);
  assert.equal(BROWSER_ADAPTER_MAX_BYTES, 256 * 1024);
  assert.equal(parseBrowserAdapterRequest({ version: 2, type: 'hello', requestId: rid }).type, 'hello');
  assert.equal(parseBrowserAdapterRequest({ version: 2, type: 'session.bind', requestId: rid, sessionId: sid, provider: 'chatgpt', origin: 'https://chatgpt.com' }).type, 'session.bind');
  assert.equal(parseBrowserAdapterRequest({ version: 2, type: 'tools.list', requestId: rid, sessionId: sid }).type, 'tools.list');
  assert.equal(parseBrowserAdapterRequest({ version: 2, type: 'ping', requestId: rid, sessionId: sid }).type, 'ping');
  assert.equal(parseBrowserAdapterRequest({ version: 2, type: 'session.unbind', requestId: rid, sessionId: sid }).type, 'session.unbind');
});

test('browser adapter protocol allows exactly the five read-only browser tools', () => {
  for (const request of [
    { version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'health', arguments: {} },
    { version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'workspace.open', arguments: { path: 'E:/fixture' } },
    { version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'foo', ignore_case: true, max_results: 50, context_lines: 2 } },
    { version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.snapshot', arguments: { workspace_id: 'ws_123', max_files: 200 } },
    { version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'file.read', arguments: { workspace_id: 'ws_123', path: 'note.txt' } },
  ] as const) {
    assert.equal(parseBrowserAdapterRequest(request).type, 'tool.call');
  }

  for (const tool of ['verify.run', 'mutation.preview', 'mutation.result', 'job.get', 'arbitrary.tool']) {
    assert.throws(() => parseBrowserAdapterRequest({
      version: 2, type: 'tool.call', requestId: rid, sessionId: sid,
      tool, arguments: {},
    }));
  }

  for (const extra of [
    { owner_id: 'owner' }, { session_id: 'session' }, { adapter_id: 'adapter' },
    { provider: 'chatgpt' }, { client_id: 'client' }, { conversation_ref: 'conv' },
  ]) {
    assert.throws(() => parseBrowserAdapterRequest({
      version: 2, type: 'tool.call', requestId: rid, sessionId: sid,
      tool: 'file.read', arguments: { workspace_id: 'ws_123', path: 'note.txt', ...extra },
    }));
    assert.throws(() => parseBrowserAdapterRequest({
      version: 2, type: 'tool.call', requestId: rid, sessionId: sid,
      tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'foo', ...extra },
    }));
    assert.throws(() => parseBrowserAdapterRequest({
      version: 2, type: 'tool.call', requestId: rid, sessionId: sid,
      tool: 'repo.snapshot', arguments: { workspace_id: 'ws_123', ...extra },
    }));
  }
});

test('browser adapter protocol strictly validates repo.search bounds', () => {
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: '' } }), /query/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'a'.repeat(257) } }), /query/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'æ—¥'.repeat(129) } }), /query/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'newline\n' } }), /query/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'return\r' } }), /query/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'nul\0' } }), /query/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'foo', max_results: 51 } }), /max_results/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'foo', max_results: 0 } }), /max_results/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'foo', context_lines: 3 } }), /context_lines/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'foo', context_lines: -1 } }), /context_lines/);
});

test('browser adapter protocol strictly validates repo.snapshot bounds', () => {
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.snapshot', arguments: { workspace_id: 'ws_123', max_files: 0 } }), /max_files/);
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.snapshot', arguments: { workspace_id: 'ws_123', max_files: 201 } }), /max_files/);
});

test('browser adapter protocol is strict about version, ids and extra keys', () => {
  assert.throws(() => parseBrowserAdapterRequest({ version: 1, type: 'hello', requestId: rid }));
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'hello', requestId: 'x' }));
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'ping', requestId: rid, sessionId: 'x' }));
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'hello', requestId: rid, extra: true }));
});

test('browser adapter protocol validates bounded responses', () => {
  const ok = parseBrowserAdapterResponse({
    version: 2, type: 'result', requestId: rid, result: { status: 'ok' },
  });
  assert.equal(ok.type, 'result');
  const failure = parseBrowserAdapterResponse({
    version: 2, type: 'error', requestId: rid,
    error: { code: 'BAD_REQUEST', message: 'rejected' },
  });
  assert.equal(failure.type, 'error');
  assert.throws(() => parseBrowserAdapterResponse({
    version: 2, type: 'error', requestId: rid,
    error: { code: 'BAD_REQUEST', message: 'x'.repeat(9000) },
  }));
});

test('browser adapter protocol rejects serialized envelopes above 256 KiB', () => {
  const oversized = {
    version: 2, type: 'tool.call', requestId: rid, sessionId: sid,
    tool: 'workspace.open', arguments: { path: 'x'.repeat(BROWSER_ADAPTER_MAX_BYTES) },
  };
  assert.ok(serializedBytes(oversized) > BROWSER_ADAPTER_MAX_BYTES);
  assert.throws(() => parseBrowserAdapterRequest(oversized), /size|large|limit/i);
});
