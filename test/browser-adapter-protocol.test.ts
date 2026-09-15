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

test('browser adapter protocol accepts the v1 lifecycle envelopes', () => {
  assert.equal(BROWSER_ADAPTER_PROTOCOL_VERSION, 1);
  assert.equal(BROWSER_ADAPTER_MAX_BYTES, 256 * 1024);
  assert.equal(parseBrowserAdapterRequest({ version: 1, type: 'hello', requestId: rid }).type, 'hello');
  assert.equal(parseBrowserAdapterRequest({ version: 1, type: 'session.bind', requestId: rid, sessionId: sid, provider: 'chatgpt', origin: 'https://chatgpt.com' }).type, 'session.bind');
  assert.equal(parseBrowserAdapterRequest({ version: 1, type: 'tools.list', requestId: rid, sessionId: sid }).type, 'tools.list');
  assert.equal(parseBrowserAdapterRequest({ version: 1, type: 'ping', requestId: rid, sessionId: sid }).type, 'ping');
  assert.equal(parseBrowserAdapterRequest({ version: 1, type: 'session.unbind', requestId: rid, sessionId: sid }).type, 'session.unbind');
});

test('browser adapter protocol allows only the three read-only browser tools', () => {
  for (const request of [
    { version: 1, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'health', arguments: {} },
    { version: 1, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'workspace.open', arguments: { path: 'E:/fixture' } },
    { version: 1, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'file.read', arguments: { workspace_id: 'ws_123', path: 'note.txt' } },
  ] as const) {
    assert.equal(parseBrowserAdapterRequest(request).type, 'tool.call');
  }
  assert.throws(() => parseBrowserAdapterRequest({
    version: 1, type: 'tool.call', requestId: rid, sessionId: sid,
    tool: 'mutation.preview', arguments: {},
  }));
  for (const extra of [
    { owner_id: 'owner' }, { session_id: 'session' }, { adapter_id: 'adapter' },
    { provider: 'chatgpt' }, { client_id: 'client' }, { conversation_ref: 'conv' },
  ]) {
    assert.throws(() => parseBrowserAdapterRequest({
      version: 1, type: 'tool.call', requestId: rid, sessionId: sid,
      tool: 'file.read', arguments: { workspace_id: 'ws_123', path: 'note.txt', ...extra },
    }));
  }
});

test('browser adapter protocol is strict about version, ids and extra keys', () => {
  assert.throws(() => parseBrowserAdapterRequest({ version: 2, type: 'hello', requestId: rid }));
  assert.throws(() => parseBrowserAdapterRequest({ version: 1, type: 'hello', requestId: 'x' }));
  assert.throws(() => parseBrowserAdapterRequest({ version: 1, type: 'ping', requestId: rid, sessionId: 'x' }));
  assert.throws(() => parseBrowserAdapterRequest({ version: 1, type: 'hello', requestId: rid, extra: true }));
});

test('browser adapter protocol validates bounded responses', () => {
  const ok = parseBrowserAdapterResponse({
    version: 1, type: 'result', requestId: rid, result: { status: 'ok' },
  });
  assert.equal(ok.type, 'result');
  const failure = parseBrowserAdapterResponse({
    version: 1, type: 'error', requestId: rid,
    error: { code: 'BAD_REQUEST', message: 'rejected' },
  });
  assert.equal(failure.type, 'error');
  assert.throws(() => parseBrowserAdapterResponse({
    version: 1, type: 'error', requestId: rid,
    error: { code: 'BAD_REQUEST', message: 'x'.repeat(9000) },
  }));
});

test('browser adapter protocol rejects serialized envelopes above 256 KiB', () => {
  const oversized = {
    version: 1, type: 'tool.call', requestId: rid, sessionId: sid,
    tool: 'workspace.open', arguments: { path: 'x'.repeat(BROWSER_ADAPTER_MAX_BYTES) },
  };
  assert.ok(serializedBytes(oversized) > BROWSER_ADAPTER_MAX_BYTES);
  assert.throws(() => parseBrowserAdapterRequest(oversized), /size|large|limit/i);
});
