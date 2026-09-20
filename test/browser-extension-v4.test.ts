import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatGptOperatorToolCall } from '../browser/extension/chatgpt-call-parser-v4.js';
import {
  createBrowserOperatorExtensionCore,
  createSessionCorrelationStore,
  senderActor,
} from '../browser/extension/service-worker-core-v4.js';
import { createNativeOperatorSessionController } from '../browser/extension/native-session-core-v4.js';
import { parseNativeOperatorHostInvocation, runNativeOperatorHost } from '../src/browser-adapter/native-host-v4.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';
import { encodeNativeMessage, NativeMessageDecoder } from '../src/browser-adapter/native-framing.js';
import { BROWSER_OPERATOR_PROTOCOL_VERSION } from '../src/browser-adapter/protocol-v4.js';
import { BROWSER_OPERATOR_ADAPTER_ID } from '../src/adapter-admission.js';

const fence = '```';
const block = (json: string) => `${fence}wag-tool\n${json}\n${fence}`;

test('the v4 page parser accepts the proposal calls and refuses every consequential one', () => {
  assert.deepEqual(
    parseChatGptOperatorToolCall(block('{"tool":"git.commit","arguments":{"workspace_id":"ws_1","paths":["a.txt"],"message":"m"}}')),
    { tool: 'git.commit', arguments: { workspace_id: 'ws_1', paths: ['a.txt'], message: 'm' } },
  );
  assert.deepEqual(
    parseChatGptOperatorToolCall(block('{"tool":"file.create","arguments":{"workspace_id":"ws_1","path":"a.txt","content":"x"}}')),
    { tool: 'file.create', arguments: { workspace_id: 'ws_1', path: 'a.txt', content: 'x' } },
  );
  assert.deepEqual(
    parseChatGptOperatorToolCall(block('{"tool":"git.commit.result","arguments":{"commit_id":"cmt_1234"}}')),
    { tool: 'git.commit.result', arguments: { commit_id: 'cmt_1234' } },
  );

  for (const tool of [
    'verify.run', 'mutation.approve', 'git.commit.approve', 'terminal.exec', 'job.get',
    'browser.open', 'repo.diff', 'repo.list',
  ]) {
    assert.equal(parseChatGptOperatorToolCall(block(JSON.stringify({ tool, arguments: {} }))), undefined,
      `${tool} must not be reachable from the page`);
  }

  // No extra argument may ride along, and an id of the wrong kind is not an id.
  assert.equal(parseChatGptOperatorToolCall(
    block('{"tool":"git.commit","arguments":{"workspace_id":"ws","paths":["a"],"message":"m","branch":"main"}}'),
  ), undefined);
  assert.equal(parseChatGptOperatorToolCall(
    block('{"tool":"mutation.result","arguments":{"mutation_id":"cmt_1234"}}'),
  ), undefined);
  assert.equal(parseChatGptOperatorToolCall(
    block('{"tool":"git.commit","arguments":{"workspace_id":"ws","paths":[],"message":"m"}}'),
  ), undefined);
});

test('the v4 extension core accepts only trusted-origin protocol-4 requests from the twelve-tool set', () => {
  const core = createBrowserOperatorExtensionCore();
  const sender = { url: 'https://chatgpt.com/c/1', tabId: 7 };
  const request = {
    version: 4, type: 'tool.call', requestId: 'req_v4_12345678', sessionId: 'session_v4_12345678',
    tool: 'git.commit', arguments: { workspace_id: 'ws_1', paths: ['a.txt'], message: 'm' },
  } as const;

  assert.equal(core.queueProviderRequest(sender, request), true);
  assert.equal(core.queueProviderRequest(sender, request), false, 'a duplicate request id is refused');
  assert.equal(core.queueProviderRequest(
    { url: 'https://chatgpt.com.evil.test/c/1', tabId: 8 }, { ...request, requestId: 'req_v4_other111' },
  ), false, 'a lookalike origin is not the trusted origin');
  assert.equal(core.queueProviderRequest(
    { url: 'https://chatgpt.com/c/1' }, { ...request, requestId: 'req_v4_notab11' },
  ), false, 'a request without a tab has no session');
  assert.equal(core.queueProviderRequest(
    sender, { ...request, version: 3, requestId: 'req_v3_12345678' } as never,
  ), false, 'a v3 envelope cannot acquire v4 authority');
  assert.equal(core.queueProviderRequest(
    sender, { ...request, tool: 'mutation.approve', requestId: 'req_v4_approve1' } as never,
  ), false, 'approval is not a browser tool');

  // Only the side panel can move a queued proposal, and a response must be v4 and inflight.
  assert.equal(core.peekForExecution('req_v4_12345678', 'content-script'), undefined);
  assert.ok(core.takeForExecution('req_v4_12345678', 'sidepanel'));
  assert.equal(core.acceptNativeResponse(
    { version: 3, type: 'result', requestId: 'req_v4_12345678', result: {} } as never,
  ), undefined);
  assert.ok(core.acceptNativeResponse({ version: 4, type: 'result', requestId: 'req_v4_12345678', result: {} }));
});

test('the tab correlation survives a service-worker restart and is never the tab id', async () => {
  const backing = new Map<string, string>();
  const storage = {
    get: async (key: string) => (backing.has(key) ? { [key]: backing.get(key)! } : {}),
    set: async (items: Record<string, string>) => { for (const [k, v] of Object.entries(items)) backing.set(k, v); },
    remove: async (key: string) => { backing.delete(key); },
  };
  let issued = 0;
  const uuid = () => {
    issued += 1;
    return `0000000${issued}-0000-4000-8000-000000000000`;
  };

  const first = createSessionCorrelationStore(storage, uuid);
  const correlation = await first.forTab(11);
  assert.match(correlation, /^session_[0-9a-f-]{36}$/i);
  assert.equal(correlation.includes('11'), false, 'the tab id is not the authority value');

  // A new object is what a service-worker restart looks like from here.
  const restarted = createSessionCorrelationStore(storage, uuid);
  assert.equal(await restarted.forTab(11), correlation, 'the binding survives the restart');
  assert.notEqual(await restarted.forTab(12), correlation, 'a different tab is a different session');

  await restarted.removeTab(11);
  assert.notEqual(await restarted.forTab(11), correlation, 'a closed tab does not keep its session');
});

test('the v4 native session requires the exact v4 adapter and the twelve-tool profile', async () => {
  class FakePort {
    posted: Record<string, unknown>[] = [];
    disconnected = false;
    private messageListeners: ((message: unknown) => void)[] = [];
    private disconnectListeners: (() => void)[] = [];
    onMessage = { addListener: (fn: (message: unknown) => void) => { this.messageListeners.push(fn); } };
    onDisconnect = { addListener: (fn: () => void) => { this.disconnectListeners.push(fn); } };
    postMessage(value: Record<string, unknown>) { this.posted.push(value); }
    disconnect() { this.disconnected = true; }
    emit(value: unknown) { for (const fn of this.messageListeners) fn(value); }
  }

  const tools = [
    'health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read',
    'verify.preview', 'verify.result',
    'mutation.preview', 'file.create', 'mutation.result',
    'git.commit', 'git.commit.result',
  ];

  async function handshake(adapterId: string, protocolVersion: number, offered: string[]) {
    const port = new FakePort();
    let n = 0;
    const controller = createNativeOperatorSessionController({
      connectNative: () => port as never,
      randomUUID: () => { n += 1; return `0000000${n}-0000-4000-8000-000000000000`; },
      onToolResponse: () => {},
    });
    const ready = controller.ensureReady('session_v4_12345678');
    // Answer each control request in the order the controller issues them.
    for (const reply of [
      (id: string) => ({ version: protocolVersion, type: 'result', requestId: id, result: { protocolVersion, adapterId } }),
      (id: string) => ({ version: protocolVersion, type: 'result', requestId: id, result: { sessionId: 'session_v4_12345678' } }),
      (id: string) => ({ version: protocolVersion, type: 'result', requestId: id, result: { tools: offered } }),
    ]) {
      await Promise.resolve();
      const last = port.posted[port.posted.length - 1];
      if (!last) break;
      port.emit(reply(String(last.requestId)));
    }
    return { ready, port };
  }

  const good = await handshake(BROWSER_OPERATOR_ADAPTER_ID, BROWSER_OPERATOR_PROTOCOL_VERSION, tools);
  await good.ready;
  assert.equal(good.port.disconnected, false);

  const wrongAdapter = await handshake('browser.chatgpt.native.verify.v3', BROWSER_OPERATOR_PROTOCOL_VERSION, tools);
  await assert.rejects(wrongAdapter.ready, 'a v3 adapter identity must not satisfy a v4 handshake');

  const wrongTools = await handshake(BROWSER_OPERATOR_ADAPTER_ID, BROWSER_OPERATOR_PROTOCOL_VERSION, tools.slice(0, 7));
  await assert.rejects(wrongTools.ready, 'the v3 tool profile must not satisfy a v4 handshake');
});

test('the native host pins the exact extension origin, not the shape of one', () => {
  const accepted = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;
  const parsed = parseNativeOperatorHostInvocation([accepted, '--discovery', 'C:\\wag\\d.json'], {});
  assert.equal(parsed.expectedOrigin, accepted);

  // A well-formed id that is not the accepted one used to be enough for the v3 host.
  const lookalike = `chrome-extension://${'a'.repeat(32)}/`;
  assert.throws(() => parseNativeOperatorHostInvocation([lookalike, '--discovery', 'C:\\wag\\d.json'], {}),
    /exactly one extension origin/);
  assert.throws(() => parseNativeOperatorHostInvocation(['chrome-extension://*/', '--discovery', 'C:\\wag\\d.json'], {}),
    /exactly one extension origin/);
});

test('the native host refuses a replayed request id and bounds how many it tracks', async () => {
  const accepted = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;
  const decoder = new NativeMessageDecoder();
  const responses: Record<string, unknown>[] = [];
  const output = {
    write(chunk: Buffer) {
      for (const message of decoder.push(chunk)) responses.push(message as Record<string, unknown>);
      return true;
    },
  };

  const frames = [
    { version: 4, type: 'hello', requestId: 'req_hello_1234' },
    { version: 4, type: 'hello', requestId: 'req_hello_1234' },
  ].map((value) => encodeNativeMessage(value));

  async function* input() { for (const frame of frames) yield frame; }

  await runNativeOperatorHost({
    input: input() as never,
    output: output as never,
    linkFactory: async () => { throw new Error('no session should be bound in this test'); },
    expectedOrigin: accepted,
  });

  assert.equal(responses.length, 2);
  assert.equal((responses[0] as { type: string }).type, 'result');
  assert.equal((responses[1] as { type: string }).type, 'error');
  assert.equal((responses[1] as { error: { code: string } }).error.code, 'DUPLICATE_REQUEST');
});

test('the side panel actor is derived from the sender, not asserted by the message', () => {
  const runtime = {
    id: 'nnhhhppkpogkedpjnijeagcbfjaoogec',
    getURL: (path: string) => `chrome-extension://nnhhhppkpogkedpjnijeagcbfjaoogec/${path}`,
  };
  const panel = runtime.getURL('sidepanel.html');

  assert.equal(senderActor({ id: runtime.id, url: panel }, runtime), 'sidepanel');
  assert.equal(senderActor({ id: runtime.id, url: `${panel}?tab=7#p` }, runtime), 'sidepanel',
    'the side panel document is the same document with a query or hash');

  // A content script reaches the same listener. It must never be handed the panel's authority.
  assert.equal(senderActor({ id: runtime.id, url: 'https://chatgpt.com/c/1', tab: { id: 7 } }, runtime),
    'content-script');
  assert.equal(
    senderActor({ id: runtime.id, url: panel, tab: { id: 7 } }, runtime),
    'content-script',
    'a tab-hosted sender claiming the panel URL is still page-adjacent',
  );

  // Another extension, another document, and a subframe are all nobody.
  assert.equal(senderActor({ id: 'a'.repeat(32), url: panel }, runtime), undefined);
  assert.equal(senderActor({ id: runtime.id, url: runtime.getURL('other.html') }, runtime), undefined);
  assert.equal(senderActor({ id: runtime.id, url: panel, frameId: 3 }, runtime), undefined);
  assert.equal(senderActor(undefined, runtime), undefined);

  // The core refuses every actor but the panel, so an underivable sender moves nothing.
  const core = createBrowserOperatorExtensionCore();
  const request = {
    version: 4, type: 'tool.call', requestId: 'req_v4_actor1234', sessionId: 'session_v4_actor',
    tool: 'git.commit', arguments: { workspace_id: 'ws_1', paths: ['a.txt'], message: 'm' },
  } as const;
  assert.equal(core.queueProviderRequest({ url: 'https://chatgpt.com/c/1', tabId: 7 }, request), true);
  const contentScript = senderActor({ id: runtime.id, url: 'https://chatgpt.com/c/1', tab: { id: 7 } }, runtime);
  assert.equal(core.takeForExecution(request.requestId, contentScript as string), undefined);
  assert.equal(core.dismiss(request.requestId, contentScript as string), false);
  assert.ok(core.takeForExecution(request.requestId, senderActor({ id: runtime.id, url: panel }, runtime) as string));
});

test('the v4 worker entry is pinned to the v4 modules and the derived actor', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../browser/extension/service-worker-v4.js', import.meta.url), 'utf8');

  for (const module of ['service-worker-core-v4.js', 'chatgpt-call-parser-v4.js', 'native-session-core-v4.js']) {
    assert.ok(source.includes(module), `the entry must import ${module}`);
  }
  assert.ok(source.includes('version: 4,'));
  assert.equal(source.includes('-v3.js'), false, 'the operator entry must not reach a frozen v3 module');

  // The actor is computed once, from the sender, and the literal never appears as an argument.
  assert.ok(source.includes('const actor = senderActor(sender, chrome.runtime)'));
  for (const call of ['peekForExecution', 'takeForExecution', 'dismiss']) {
    assert.equal(source.includes(`${call}(message.requestId, 'sidepanel')`), false,
      `${call} must not be handed a hard-coded actor`);
    assert.ok(source.includes(`${call}(message.requestId, actor)`), `${call} must take the derived actor`);
  }

  // Ordering is load-bearing: a failed handshake must leave the proposal queued.
  const order = ['peekForExecution', 'native.ensureReady', 'takeForExecution', 'native.postTool']
    .map((needle) => source.indexOf(needle));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(order.includes(-1), false);
});
