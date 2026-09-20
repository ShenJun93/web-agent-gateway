import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseChatGptOperatorObservation,
  parseChatGptOperatorToolCall,
} from '../browser/extension/chatgpt-call-parser-v4.js';
import {
  createBrowserOperatorExtensionCore,
  createSessionCorrelationStore,
  proposalIdentity,
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

  const msg = 'msg-0001';
  assert.equal(core.queueProviderRequest(sender, request, msg), true);
  assert.equal(core.queueProviderRequest(sender, { ...request, requestId: 'req_v4_again0001' }, msg), false,
    're-observing the same message is the same proposal');
  assert.equal(core.queueProviderRequest(
    { url: 'https://chatgpt.com.evil.test/c/1', tabId: 8 }, { ...request, requestId: 'req_v4_other111' }, msg,
  ), false, 'a lookalike origin is not the trusted origin');
  assert.equal(core.queueProviderRequest(
    { url: 'https://chatgpt.com/c/1' }, { ...request, requestId: 'req_v4_notab11' }, msg,
  ), false, 'a request without a tab has no session');
  assert.equal(core.queueProviderRequest(
    sender, { ...request, version: 3, requestId: 'req_v3_12345678' } as never, msg,
  ), false, 'a v3 envelope cannot acquire v4 authority');
  assert.equal(core.queueProviderRequest(
    sender, { ...request, tool: 'mutation.approve', requestId: 'req_v4_approve1' } as never, msg,
  ), false, 'approval is not a browser tool');
  assert.equal(core.queueProviderRequest(sender, { ...request, requestId: 'req_v4_noid00001' }, ''), false,
    'a turn with no provider identity cannot be deduplicated, so it is refused');

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
  assert.equal(core.queueProviderRequest({ url: 'https://chatgpt.com/c/1', tabId: 7 }, request, 'msg-actor'), true);
  const contentScript = senderActor({ id: runtime.id, url: 'https://chatgpt.com/c/1', tab: { id: 7 } }, runtime);
  assert.equal(core.takeForExecution(request.requestId, contentScript as string), undefined);
  assert.equal(core.dismiss(request.requestId, contentScript as string), false);
  assert.ok(core.takeForExecution(request.requestId, senderActor({ id: runtime.id, url: panel }, runtime) as string));
});

test('the shipped worker entry is pinned to the v4 modules and the derived actor', async () => {
  const { readFile } = await import('node:fs/promises');
  // The product ships v4 now. The manifest names this file, and this file names v4 modules only.
  const manifest = JSON.parse(
    await readFile(new URL('../browser/extension/manifest.json', import.meta.url), 'utf8'),
  ) as { background?: { service_worker?: string } };
  assert.equal(manifest.background?.service_worker, 'service-worker.js');
  const source = await readFile(new URL('../browser/extension/service-worker.js', import.meta.url), 'utf8');

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

test('a schema-refused frame is answered, and the admitted session survives it', async () => {
  const accepted = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;
  const decoder = new NativeMessageDecoder();
  const responses: Record<string, unknown>[] = [];
  const output = {
    write(chunk: Buffer) {
      for (const message of decoder.push(chunk)) responses.push(message as Record<string, unknown>);
      return true;
    },
  };

  let closed = 0;
  const link = {
    listTools: async () => ['health'],
    call: async () => ({ version: 4, type: 'result', requestId: 'req_after_bad1', result: { ok: true } }),
    close: async () => { closed += 1; },
  };

  const frames = [
    { version: 4, type: 'session.bind', requestId: 'req_bind_ok0001', sessionId: 'session_live_0001', provider: 'chatgpt', origin: 'https://chatgpt.com' },
    // A tool the surface does not have. Live evidence: this used to end the process and take
    // the admitted session with it.
    { version: 4, type: 'tool.call', requestId: 'req_bad_tool001', sessionId: 'session_live_0001', tool: 'mutation.approve', arguments: {} },
    // An unanswerable frame: no salvageable request id, so it is dropped rather than answered.
    { version: 4, type: 'tool.call', sessionId: 'session_live_0001' },
    { version: 4, type: 'ping', requestId: 'req_after_bad1', sessionId: 'session_live_0001' },
  ].map((value) => encodeNativeMessage(value));

  async function* input() { for (const frame of frames) yield frame; }

  await runNativeOperatorHost({
    input: input() as never,
    output: output as never,
    linkFactory: async () => link as never,
    expectedOrigin: accepted,
  });

  assert.deepEqual(responses.map((response) => response.requestId),
    ['req_bind_ok0001', 'req_bad_tool001', 'req_after_bad1']);
  assert.equal((responses[1] as { type: string }).type, 'error');
  assert.equal((responses[1] as { error: { code: string } }).error.code, 'MALFORMED_REQUEST');
  // The session outlived the refusal, which is the whole point.
  assert.equal((responses[2] as { type: string }).type, 'result');
  assert.equal(closed, 1, 'the link is closed exactly once, at the end of the stream');
});

/**
 * Both of these came out of the live dogfood on 2026-09-20, not from review: the proposal was
 * accepted by the page half and then vanished before a human could act on it.
 */
test('an untagged code block is still a proposal, and another language never is', () => {
  const payload = '{"tool":"workspace.open","arguments":{"path":"E:\\repo"}}';

  // chatgpt.com renders code blocks through CodeMirror and drops the fence info string, so the
  // language arrives empty. The payload shape is what selects a proposal.
  assert.deepEqual(
    parseChatGptOperatorObservation({ text: payload, codeBlocks: [{ language: '', text: payload }] }),
    { tool: 'workspace.open', arguments: { path: 'E:\repo' } },
  );
  assert.deepEqual(
    parseChatGptOperatorObservation({ text: payload, codeBlocks: [{ language: 'wag-tool', text: payload }] }),
    { tool: 'workspace.open', arguments: { path: 'E:\repo' } },
  );

  for (const language of ['json', 'js', 'bash', 'wag-tools', 'WAG-TOOL']) {
    assert.equal(
      parseChatGptOperatorObservation({ text: payload, codeBlocks: [{ language, text: payload }] }),
      undefined,
      `${language} must not be read as a proposal`,
    );
  }
  // Untagged widens what is *selected*, never what is allowed.
  for (const bad of [
    '{"tool":"mutation.approve","arguments":{}}',
    '{"tool":"workspace.open","arguments":{"path":"E:\\repo"},"extra":1}',
    '{"path":"E:\\repo"}',
  ]) {
    assert.equal(
      parseChatGptOperatorObservation({ text: bad, codeBlocks: [{ language: '', text: bad }] }),
      undefined,
    );
  }
});

/**
 * The duplicate-proposal finding from the live dogfood on 2026-09-20.
 *
 * Every one of these is a way the same assistant message gets observed again: a DOM rescan, a
 * page reload, an MV3 suspension, an extension reload, and the side panel reopening. Each used
 * to mint a fresh random request id and pile up another entry in the panel. The fix is a
 * stable identity that survives all of them — and two genuinely different messages carrying
 * byte-identical payloads must still be two proposals.
 */
test('the same assistant message is one proposal across every way it gets re-observed', async () => {
  const backing = new Map<string, unknown>();
  const storage = {
    get: async (key: string | null) => (key === null
      ? Object.fromEntries(backing)
      : (backing.has(key) ? { [key]: backing.get(key) } : {})),
    set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) backing.set(k, v); },
    remove: async (key: string) => { backing.delete(key); },
  };
  const sender = { url: 'https://chatgpt.com/c/1', tabId: 7 };
  // Every observation mints a new request id, exactly as the shipped worker does.
  let issued = 0;
  const observe = (
    core: ReturnType<typeof createBrowserOperatorExtensionCore>,
    messageId: string,
  ) => {
    issued += 1;
    return core.queueProviderRequest(sender, {
      version: 4, type: 'tool.call', requestId: 'req_v4_obs' + String(issued).padStart(6, '0'),
      sessionId: 'session_v4_dupe', tool: 'workspace.open', arguments: { path: 'E:\\repo' },
    } as never, messageId);
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // A DOM rescan: same worker, same message, observed again.
  const core = createBrowserOperatorExtensionCore(storage);
  assert.equal(observe(core, 'assistant-msg-a'), true);
  assert.equal(observe(core, 'assistant-msg-a'), false, 'a DOM rescan is not a second proposal');
  assert.equal(core.pending().length, 1);
  await settle();

  // A page reload and an MV3 suspension both look like a fresh core over the same storage.
  const afterReload = createBrowserOperatorExtensionCore(storage);
  await afterReload.restore();
  assert.equal(afterReload.pending().length, 1, 'the proposal survives, exactly once');
  assert.equal(observe(afterReload, 'assistant-msg-a'), false, 'the reloaded page re-observes it in vain');
  assert.equal(afterReload.pending().length, 1);
  await settle();

  // The side panel reopening triggers another rescan of the same conversation.
  const afterPanelOpen = createBrowserOperatorExtensionCore(storage);
  await afterPanelOpen.restore();
  assert.equal(observe(afterPanelOpen, 'assistant-msg-a'), false);
  assert.equal(afterPanelOpen.pending().length, 1);

  // A second message proposing the identical payload is a genuinely different proposal.
  assert.equal(observe(afterPanelOpen, 'assistant-msg-b'), true);
  assert.equal(afterPanelOpen.pending().length, 2, 'identical payloads from different messages are two');
  await settle();

  // Running one and then rescanning must not raise it again.
  const first = afterPanelOpen.pending()[0]!;
  assert.ok(afterPanelOpen.takeForExecution(first.requestId, 'sidepanel'));
  await settle();
  assert.equal(observe(afterPanelOpen, 'assistant-msg-a'), false, 'a proposal already run is not re-offered');

  // Dismissing means no, and survives a restart: the panel must not resurrect it.
  const remaining = afterPanelOpen.pending()[0]!;
  assert.equal(afterPanelOpen.dismiss(remaining.requestId, 'sidepanel'), true);
  await settle();
  const afterExtensionReload = createBrowserOperatorExtensionCore(storage);
  await afterExtensionReload.restore();
  assert.deepEqual(afterExtensionReload.pending(), []);
  assert.equal(observe(afterExtensionReload, 'assistant-msg-b'), false, 'a dismissed proposal stays dismissed');

  // A different tab is a different proposal even for the same message id, and so is a
  // different WAG session: neither can suppress the other's.
  const otherTab = createBrowserOperatorExtensionCore(storage);
  await otherTab.restore();
  assert.equal(otherTab.queueProviderRequest(
    { url: 'https://chatgpt.com/c/1', tabId: 99 },
    {
      version: 4, type: 'tool.call', requestId: 'req_v4_othertab1', sessionId: 'session_v4_dupe',
      tool: 'workspace.open', arguments: { path: 'E:\\repo' },
    } as never,
    'assistant-msg-a',
  ), true, 'another tab is another proposal');
  assert.equal(otherTab.queueProviderRequest(
    sender,
    {
      version: 4, type: 'tool.call', requestId: 'req_v4_othersess', sessionId: 'session_v4_other',
      tool: 'workspace.open', arguments: { path: 'E:\\repo' },
    } as never,
    'assistant-msg-a',
  ), true, 'another WAG session is another proposal');
});

test('the persisted queue is revalidated on the way back in, and stays bounded', async () => {
  const backing = new Map<string, unknown>();
  const storage = {
    get: async (key: string | null) => (key === null
      ? Object.fromEntries(backing)
      : (backing.has(key) ? { [key]: backing.get(key) } : {})),
    set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) backing.set(k, v); },
    remove: async (key: string) => { backing.delete(key); },
  };
  const request = (n: number) => ({
    version: 4 as const, type: 'tool.call' as const,
    requestId: `req_v4_store${String(n).padStart(4, '0')}`, sessionId: 'session_v4_store',
    tool: 'workspace.open' as const, arguments: { path: 'E:\\repo' },
  });

  // Storage is not a trusted channel just because this extension wrote it: a tool outside the
  // surface, a missing identity and a non-object are all dropped rather than restored.
  await storage.set({
    'wag.operator.seen.v4': ['kept-identity', 42, { not: 'a string' }],
    'wag.operator.queue.v4': [
      { tabId: 5, identity: 'i-bad-tool', request: { ...request(9), tool: 'mutation.approve' } },
      { tabId: 5, request: request(3) },
      { tabId: 'five', identity: 'i-bad-tab', request: request(4) },
      'not an object',
      { tabId: 5, identity: 'i-ok', request: request(2) },
    ],
  });
  const restored = createBrowserOperatorExtensionCore(storage);
  await restored.restore();
  assert.deepEqual(restored.pending().map((item) => item.requestId), ['req_v4_store0002']);
  assert.equal(restored.pending()[0]!.tabId, 5);

  // One browser session cannot bury the panel.
  const capped = createBrowserOperatorExtensionCore();
  const sender = { url: 'https://chatgpt.com/c/1', tabId: 5 };
  for (let i = 0; i < 8; i += 1) {
    assert.equal(capped.queueProviderRequest(sender, request(100 + i) as never, `msg-${i}`), true);
  }
  assert.equal(capped.queueProviderRequest(sender, request(200) as never, 'msg-over'), false,
    'the queue is bounded');
});

test('the proposal identity ignores key order and separates every field', () => {
  const a = proposalIdentity('s1', 7, 'm1', 'file.create', { path: 'a', content: 'x' });
  const b = proposalIdentity('s1', 7, 'm1', 'file.create', { content: 'x', path: 'a' });
  assert.equal(a, b, 'argument key order is not part of the identity');

  const distinct = new Set([
    a,
    proposalIdentity('s2', 7, 'm1', 'file.create', { path: 'a', content: 'x' }),
    proposalIdentity('s1', 8, 'm1', 'file.create', { path: 'a', content: 'x' }),
    proposalIdentity('s1', 7, 'm2', 'file.create', { path: 'a', content: 'x' }),
    proposalIdentity('s1', 7, 'm1', 'mutation.result', { path: 'a', content: 'x' }),
    proposalIdentity('s1', 7, 'm1', 'file.create', { path: 'a', content: 'y' }),
  ]);
  assert.equal(distinct.size, 6, 'each field changes the identity');

  // Field boundaries must not be forgeable by concatenation.
  assert.notEqual(
    proposalIdentity('s', 1, 'ab', 'health', {}),
    proposalIdentity('s', 1, 'a', 'bhealth', {}),
  );
});

test('the shipped worker re-attaches open conversations and rescans when the panel opens', async () => {
  const { readFile } = await import('node:fs/promises');
  const worker = await readFile(new URL('../browser/extension/service-worker.js', import.meta.url), 'utf8');
  const content = await readFile(new URL('../browser/extension/content/chatgpt.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(
    await readFile(new URL('../browser/extension/manifest.json', import.meta.url), 'utf8'),
  ) as { permissions: string[]; host_permissions: string[] };

  // Re-injection is what removes the manual page reload, and it is scoped to the one host the
  // content script already runs on.
  assert.ok(manifest.permissions.includes('scripting'));
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.ok(worker.includes("chrome.tabs.query({ url: 'https://chatgpt.com/*' })"));
  assert.ok(worker.includes("files: ['content/chatgpt.js']"));
  assert.ok(worker.includes('chrome.runtime.onInstalled'));
  assert.ok(worker.includes('chrome.runtime.onStartup'));
  assert.ok(worker.includes('attachAndRescan()'));

  // The panel open path runs it, and the page answers a rescan.
  assert.ok(worker.includes("message?.type === 'panel.state'"));
  assert.ok(content.includes("message?.type !== 'provider.rescan'"));
  assert.ok(content.includes('scheduleScan(true)'));
  assert.ok(content.includes('messageId: assistantMessageId(node)'));

  // The identity is carried to the core; nothing else may stand in for it.
  assert.ok(worker.includes('core.queueProviderRequest({ url: senderUrl, tabId }, request, message.messageId)'));
  // Re-attachment is not authority: only the panel can still move a proposal.
  for (const call of ['peekForExecution', 'takeForExecution', 'dismiss']) {
    assert.equal(worker.includes(`${call}(message.requestId, 'sidepanel')`), false);
  }
});

/**
 * The root cause of the duplicate proposals in the live dogfood on 2026-09-20.
 *
 * `forTab` read storage and wrote it in two awaits. Two observations arriving together — which
 * is exactly what a rescan produces — both saw an empty slot and both minted, so one browser
 * tab became two WAG sessions. That split the tab's workspaces and made one assistant message
 * look like two proposals, because the session is part of a proposal's identity.
 */
test('concurrent observations of one tab mint exactly one correlation', async () => {
  const backing = new Map<string, string>();
  let reads = 0;
  const storage = {
    // A real storage round trip is asynchronous, so the read resolves on a later turn than the
    // caller. That gap is the whole bug.
    get: async (key: string) => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return backing.has(key) ? { [key]: backing.get(key)! } : {};
    },
    set: async (items: Record<string, string>) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      for (const [k, v] of Object.entries(items)) backing.set(k, v);
    },
    remove: async (key: string) => { backing.delete(key); },
  };
  let minted = 0;
  const uuid = () => {
    minted += 1;
    return `0000000${minted}-0000-4000-8000-000000000000`;
  };

  const store = createSessionCorrelationStore(storage, uuid);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => store.forTab(42)));

  assert.equal(new Set(results).size, 1, 'one tab is one WAG session');
  assert.equal(minted, 1, 'only one correlation was ever generated');
  assert.equal(backing.get('wag.session.tab.42'), results[0]);

  // A later call still reuses the stored value, and a different tab is still a different session.
  assert.equal(await store.forTab(42), results[0]);
  assert.notEqual(await store.forTab(43), results[0]);

  // Closing the tab drops the binding, including any in-flight mint for it.
  await store.removeTab(42);
  assert.notEqual(await store.forTab(42), results[0]);
  assert.ok(reads > 0);
});
