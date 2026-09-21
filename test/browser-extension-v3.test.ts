import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatGptVerifyToolCall } from '../browser/extension/chatgpt-call-parser-v3.js';
import { createBrowserVerifyExtensionCore } from '../browser/extension/service-worker-core-v3.js';
import { createNativeVerifySessionController } from '../browser/extension/native-session-core-v3.js';

const block = (json: string) => '~~~PLACEHOLDER~~~'.replace('~~~PLACEHOLDER~~~', '```wag-tool\n' + json + '\n```');

test('v3 ChatGPT parser accepts proposal/result only and rejects direct consequential tools', () => {
  assert.deepEqual(parseChatGptVerifyToolCall(block('{"tool":"verify.preview","arguments":{"workspace_id":"ws_1","profile":"unit"}}')), {
    tool: 'verify.preview', arguments: { workspace_id: 'ws_1', profile: 'unit' },
  });
  assert.deepEqual(parseChatGptVerifyToolCall(block('{"tool":"verify.result","arguments":{"request_id":"verifyreq_12345678-1234-1234-1234-123456789abc"}}')), {
    tool: 'verify.result', arguments: { request_id: 'verifyreq_12345678-1234-1234-1234-123456789abc' },
  });
  for (const tool of ['verify.run', 'mutation.preview', 'terminal.exec', 'job.get', 'browser.open']) {
    assert.equal(parseChatGptVerifyToolCall(block(JSON.stringify({ tool, arguments: {} }))), undefined);
  }
  assert.equal(parseChatGptVerifyToolCall(block('{"tool":"verify.preview","arguments":{"workspace_id":"ws_1","profile":"unit","argv":["cmd"]}}')), undefined);
});

/**
 * Which generation the product ships is pinned by `test/browser-extension-v4.test.ts`, because
 * that is now v4. What belongs here is the other half of the same guarantee: the v3 modules are
 * frozen, so the successor must not have been built by editing them.
 */
test('the v3 modules are still verify-only and still speak protocol 3', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (name: string) => readFile(new URL(`../browser/extension/${name}`, import.meta.url), 'utf8');

  const core = await read('service-worker-core-v3.js');
  assert.match(core, /request\.version === 3/);
  assert.doesNotMatch(core, /version === 4/);
  for (const proposal of ['mutation.preview', 'file.create', 'mutation.result', 'git.commit']) {
    assert.equal(core.includes(proposal), false, `v3 must not have gained ${proposal}`);
  }

  const parser = await read('chatgpt-call-parser-v3.js');
  for (const proposal of ['mutation.preview', 'file.create', 'git.commit']) {
    assert.equal(parser.includes(proposal), false, `the v3 parser must not have gained ${proposal}`);
  }

  const session = await read('native-session-core-v3.js');
  assert.match(session, /verify\.v3/);
  assert.equal(session.includes('operator.v4'), false, 'the v3 session must not accept the v4 adapter');
});

test('v3 extension core accepts only trusted-origin protocol-3 seven-tool requests', () => {
  const core = createBrowserVerifyExtensionCore();
  const sender = { url: 'https://chatgpt.com/c/1', tabId: 7 };
  const request = {
    version: 3, type: 'tool.call', requestId: 'req_v3_12345678', sessionId: 'session_v3_12345678',
    tool: 'verify.preview', arguments: { workspace_id: 'ws_1', profile: 'unit' },
  } as const;
  assert.equal(core.queueProviderRequest(sender, request), true);
  assert.equal(core.queueProviderRequest(sender, request), false);
  assert.equal(core.queueProviderRequest({ url: 'https://example.com', tabId: 8 }, { ...request, requestId: 'req_v3_other1' }), false);
  assert.equal(core.queueProviderRequest(sender, { ...request, version: 2, requestId: 'req_v2_12345678' } as never), false);
  assert.equal(core.queueProviderRequest(sender, { ...request, tool: 'verify.run', requestId: 'req_v3_direct1' } as never), false);
});

class FakePort {
  posted: any[] = [];
  disconnected = false;
  messageListeners: ((message: any) => void)[] = [];
  disconnectListeners: (() => void)[] = [];
  onMessage = { addListener: (fn: (message: any) => void) => this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => this.disconnectListeners.push(fn) };
  postMessage(value: any) { this.posted.push(value); }
  disconnect() { this.disconnected = true; }
  emit(value: any) { for (const fn of this.messageListeners) fn(value); }
}

test('v3 native session requires exact v3 adapter and seven-tool discovery', async () => {
  let port: FakePort | undefined;
  let n = 0;
  const native = createNativeVerifySessionController({
    connectNative: () => { port = new FakePort(); return port; },
    randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    onToolResponse: () => {},
  });
  const ready = native.ensureReady('session_v3_test');
  const hello = port!.posted[0];
  assert.equal(hello.version, 3);
  port!.emit({ version: 3, type: 'result', requestId: hello.requestId, result: { protocolVersion: 3, adapterId: 'browser.chatgpt.native.verify.v3' } });
  await Promise.resolve();
  const bind = port!.posted[1];
  port!.emit({ version: 3, type: 'result', requestId: bind.requestId, result: { sessionId: 'session_v3_test', provider: 'chatgpt' } });
  await Promise.resolve();
  const list = port!.posted[2];
  port!.emit({ version: 3, type: 'result', requestId: list.requestId, result: { tools: ['health','workspace.open','repo.search','repo.snapshot','file.read','verify.preview','verify.result'] } });
  await ready;
  assert.equal(native.isConnected(), true);
  native.postTool({ version: 3, type: 'tool.call', requestId: 'req_v3_send123', sessionId: 'session_v3_test', tool: 'verify.result', arguments: { request_id: 'verifyreq_x' } });
  assert.equal(port!.posted.at(-1).version, 3);
});

test('v3 native session rejects v2 hello identity', async () => {
  let port: FakePort | undefined;
  const native = createNativeVerifySessionController({
    connectNative: () => { port = new FakePort(); return port; },
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    onToolResponse: () => {},
  });
  const ready = native.ensureReady('session_v3_bad');
  port!.emit({ version: 3, type: 'result', requestId: port!.posted[0].requestId, result: { protocolVersion: 2, adapterId: 'browser.chatgpt.native.inspect.v2' } });
  await assert.rejects(ready, /mismatch/i);
  assert.equal(native.isConnected(), false);
});
