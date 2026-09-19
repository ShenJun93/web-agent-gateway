import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_VERIFY_MAX_BYTES,
  BROWSER_VERIFY_PROTOCOL_VERSION,
  parseBrowserVerifyRequest,
  parseBrowserVerifyResponse,
  serializedVerifyBytes,
} from '../src/browser-adapter/protocol-v3.js';

const rid = 'req_v3_12345678';
const sid = 'session_v3_12345678';

test('browser verify protocol v3 exposes exactly five inspect plus two proposal/result tools', () => {
  assert.equal(BROWSER_VERIFY_PROTOCOL_VERSION, 3);
  assert.equal(BROWSER_VERIFY_MAX_BYTES, 256 * 1024);
  for (const request of [
    { version: 3, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'health', arguments: {} },
    { version: 3, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'workspace.open', arguments: { path: 'E:/fixture' } },
    { version: 3, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.search', arguments: { workspace_id: 'ws_123', query: 'foo' } },
    { version: 3, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'repo.snapshot', arguments: { workspace_id: 'ws_123' } },
    { version: 3, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'file.read', arguments: { workspace_id: 'ws_123', path: 'note.txt' } },
    { version: 3, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'verify.preview', arguments: { workspace_id: 'ws_123', profile: 'unit' } },
    { version: 3, type: 'tool.call', requestId: rid, sessionId: sid, tool: 'verify.result', arguments: { request_id: 'verifyreq_12345678-1234-1234-1234-123456789abc' } },
  ] as const) assert.equal(parseBrowserVerifyRequest(request).type, 'tool.call');

  for (const tool of ['verify.run', 'mutation.preview', 'mutation.result', 'job.get', 'terminal.exec', 'browser.open']) {
    assert.throws(() => parseBrowserVerifyRequest({
      version: 3, type: 'tool.call', requestId: rid, sessionId: sid, tool, arguments: {},
    }));
  }
});

test('browser verify protocol rejects v2 and strict verify argument violations', () => {
  assert.throws(() => parseBrowserVerifyRequest({ version: 2, type: 'hello', requestId: rid }));
  assert.throws(() => parseBrowserVerifyRequest({
    version: 3, type: 'tool.call', requestId: rid, sessionId: sid,
    tool: 'verify.preview', arguments: { workspace_id: 'ws', profile: 'unit;rm' },
  }));
  assert.throws(() => parseBrowserVerifyRequest({
    version: 3, type: 'tool.call', requestId: rid, sessionId: sid,
    tool: 'verify.preview', arguments: { workspace_id: 'ws', profile: 'unit', argv: ['cmd'] },
  }));
  assert.throws(() => parseBrowserVerifyRequest({
    version: 3, type: 'tool.call', requestId: rid, sessionId: sid,
    tool: 'verify.result', arguments: { request_id: 'job_12345678' },
  }));
});

test('browser verify protocol validates bounded v3 responses', () => {
  const ok = parseBrowserVerifyResponse({
    version: 3, type: 'result', requestId: rid, result: { state: 'PENDING_APPROVAL' },
  });
  assert.equal(ok.type, 'result');
  assert.throws(() => parseBrowserVerifyResponse({
    version: 2, type: 'result', requestId: rid, result: {},
  }));
  const oversized = {
    version: 3, type: 'result', requestId: rid, result: { output: 'x'.repeat(BROWSER_VERIFY_MAX_BYTES) },
  };
  assert.ok(serializedVerifyBytes(oversized) > BROWSER_VERIFY_MAX_BYTES);
  assert.throws(() => parseBrowserVerifyResponse(oversized), /size|limit/i);
});
