import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { encodeNativeMessage, NativeMessageDecoder } from '../src/browser-adapter/native-framing.js';
import type { BrowserAdapterRequest, BrowserAdapterResponse } from '../src/browser-adapter/protocol.js';
import type { LocalAdapterLink } from '../src/browser-adapter/local-link.js';
import { parseNativeHostInvocation, runNativeHost } from '../src/browser-adapter/native-host.js';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionOrigin = `chrome-extension://${extensionId}/`;
const sid = 'session_12345678';

class FakeLink implements LocalAdapterLink {
  closed = false;
  calls: BrowserAdapterRequest[] = [];
  async listTools() { return ['health', 'workspace.open', 'file.read'] as const; }
  async call(request: BrowserAdapterRequest): Promise<BrowserAdapterResponse> {
    this.calls.push(request);
    return { version: 1, type: 'result', requestId: request.requestId, result: { ok: true } };
  }
  async close() { this.closed = true; }
}

function decodeAll(buffer: Buffer): BrowserAdapterResponse[] {
  return new NativeMessageDecoder().push(buffer) as BrowserAdapterResponse[];
}
test('native host creates a local link only after successful session.bind', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const link = new FakeLink();
  const factoryCalls: string[] = [];
  const running = runNativeHost({
    input, output, expectedOrigin: extensionOrigin,
    linkFactory: async (correlationId) => { factoryCalls.push(correlationId); return link; },
  });

  for (const request of [
    { version: 1, type: 'hello', requestId: 'req_hello_001' },
    { version: 1, type: 'session.bind', requestId: 'req_bind_0001', sessionId: sid, provider: 'chatgpt', origin: 'https://chatgpt.com' },
    { version: 1, type: 'tools.list', requestId: 'req_tools_001', sessionId: sid },
    { version: 1, type: 'tool.call', requestId: 'req_call_0001', sessionId: sid, tool: 'health', arguments: {} },
    { version: 1, type: 'session.unbind', requestId: 'req_unbind_01', sessionId: sid },
  ]) input.write(encodeNativeMessage(request));
  input.end();
  await running;

  assert.deepEqual(factoryCalls, [sid]);
  assert.equal(link.calls.length, 1);
  assert.equal(link.closed, true);
  assert.ok(decodeAll(Buffer.concat(chunks)).every((value) => value.type === 'result'));
});
test('native host stays unbound when admission fails', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const running = runNativeHost({
    input, output, expectedOrigin: extensionOrigin,
    linkFactory: async () => { throw new Error('secret bootstrap failure'); },
  });

  input.write(encodeNativeMessage({ version: 1, type: 'hello', requestId: 'req_hello_fail' }));
  input.write(encodeNativeMessage({
    version: 1, type: 'session.bind', requestId: 'req_bind_fail1', sessionId: sid,
    provider: 'chatgpt', origin: 'https://chatgpt.com',
  }));
  input.write(encodeNativeMessage({
    version: 1, type: 'tool.call', requestId: 'req_call_bad1', sessionId: sid,
    tool: 'health', arguments: {},
  }));
  input.end();
  await running;

  const responses = decodeAll(Buffer.concat(chunks));
  assert.equal(responses[0]?.type, 'result');
  assert.equal(responses[1]?.type, 'error');
  assert.equal(responses[2]?.type, 'error');
  assert.doesNotMatch(JSON.stringify(responses), /secret bootstrap failure/);
});
test('native host reconnect admits the same browser correlation through a fresh link', async () => {
  const factoryCalls: string[] = [];
  const runOnce = async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const link = new FakeLink();
    const running = runNativeHost({
      input, output, expectedOrigin: extensionOrigin,
      linkFactory: async (correlationId) => { factoryCalls.push(correlationId); return link; },
    });
    input.write(encodeNativeMessage({
      version: 1, type: 'session.bind', requestId: `req_bind_${factoryCalls.length}`, sessionId: sid,
      provider: 'chatgpt', origin: 'https://chatgpt.com',
    }));
    input.end();
    await running;
    assert.equal(link.closed, true);
  };
  await runOnce();
  await runOnce();
  assert.deepEqual(factoryCalls, [sid, sid]);
});

test('native host rejects duplicate ids and calls before binding without creating a link', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  let factoryCalls = 0;
  const running = runNativeHost({ input, output, expectedOrigin: extensionOrigin, linkFactory: async () => { factoryCalls += 1; return new FakeLink(); } });
  input.write(encodeNativeMessage({ version: 1, type: 'hello', requestId: 'req_same_0001' }));
  input.write(encodeNativeMessage({ version: 1, type: 'hello', requestId: 'req_same_0001' }));
  input.write(encodeNativeMessage({
    version: 1, type: 'tool.call', requestId: 'req_call_bad2', sessionId: sid,
    tool: 'health', arguments: {},
  }));
  input.end();
  await running;
  const responses = decodeAll(Buffer.concat(chunks));
  assert.equal(responses[0]?.type, 'result');
  assert.equal(responses[1]?.type, 'error');
  assert.equal(responses[2]?.type, 'error');
  assert.equal(factoryCalls, 0);
});

test('native host rejects non-extension origins and malformed frames fail closed', async () => {
  let factoryCalls = 0;
  await assert.rejects(() => runNativeHost({
    input: new PassThrough(), output: new PassThrough(), expectedOrigin: 'https://chatgpt.com/',
    linkFactory: async () => { factoryCalls += 1; return new FakeLink(); },
  }), /origin/i);
  assert.equal(factoryCalls, 0);

  const input = new PassThrough();
  const running = runNativeHost({ input, output: new PassThrough(), expectedOrigin: extensionOrigin, linkFactory: async () => new FakeLink() });
  const invalid = Buffer.alloc(4);
  invalid.writeUInt32LE(0, 0);
  input.end(invalid);
  await assert.rejects(running, /length/i);
});
test('native host invocation finds one caller origin and requires absolute discovery override', () => {
  assert.deepEqual(parseNativeHostInvocation([
    'node', 'native-host.js', extensionOrigin, '--discovery', 'C:\\temp\\browser-adapter.json',
  ], { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }), {
    expectedOrigin: extensionOrigin,
    discoveryPath: 'C:\\temp\\browser-adapter.json',
  });

  assert.throws(() => parseNativeHostInvocation([
    'node', 'native-host.js', extensionOrigin, '--discovery', 'relative.json',
  ], { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }), /absolute/i);
  assert.throws(() => parseNativeHostInvocation([
    'node', 'native-host.js', extensionOrigin, extensionOrigin,
  ], { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }), /origin/i);
});
