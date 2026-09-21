import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCorrelationStore } from '../browser/extension/service-worker-core.js';

class FakeSessionStorage {
  readonly values = new Map<string, string>();
  async get(key: string) { return { [key]: this.values.get(key) }; }
  async set(entries: Record<string, string>) {
    for (const [key, value] of Object.entries(entries)) this.values.set(key, value);
  }
  async remove(key: string) { this.values.delete(key); }
}

function ids() {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
}

test('session correlation survives service-worker object recreation for a live tab', async () => {
  const storage = new FakeSessionStorage();
  const first = createSessionCorrelationStore(storage, ids());
  const correlation = await first.forTab(17);
  const recreated = createSessionCorrelationStore(storage, ids());
  assert.equal(await recreated.forTab(17), correlation);
  assert.match(correlation, /^session_[0-9a-f-]{36}$/);
});

test('tab removal deletes only that tab correlation', async () => {
  const storage = new FakeSessionStorage();
  const store = createSessionCorrelationStore(storage, ids());
  const first = await store.forTab(3);
  const second = await store.forTab(4);
  await store.removeTab(3);
  assert.equal(storage.values.has('wag.session.tab.3'), false);
  assert.equal(storage.values.get('wag.session.tab.4'), second);
  assert.notEqual(await store.forTab(3), first);
});

test('empty session storage mints a fresh correlation and never uses tab id as authority value', async () => {
  const storage = new FakeSessionStorage();
  const store = createSessionCorrelationStore(storage, ids());
  const value = await store.forTab(99);
  assert.match(value, /^session_/);
  assert.doesNotMatch(value, /99/);
  assert.deepEqual([...storage.values.keys()], ['wag.session.tab.99']);
  assert.equal(storage.values.get('wag.session.tab.99'), value);
});

test('provider messages cannot supply correlation or storage identity', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../browser/extension/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /createSessionCorrelationStore\(chrome\.storage\.session/);
  assert.match(source, /sessionCorrelations\.forTab\(tabId\)/);
  assert.match(source, /return true;/);
  assert.match(source, /chrome\.tabs\.onRemoved\.addListener/);
  assert.doesNotMatch(source, /sessionsByTab/);
  assert.doesNotMatch(source, /message\.(?:sessionId|correlationId|correlation_id|storageKey|storage_key)/);
});

test('service-worker preserves peek -> handshake -> take ordering across successor protocol', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../browser/extension/service-worker.js', import.meta.url), 'utf8');
  // The actor argument is whatever the shipped generation uses — v3 passed the literal,
  // v4 derives it from the sender. What must hold across generations is the ordering.
  assert.match(source, /peekForExecution\(message\.requestId,\s*\w+\)/);
  assert.match(source, /native\.ensureReady\(pending\.sessionId\)/);
  assert.match(source, /takeForExecution\(message\.requestId,\s*\w+\)/);
  assert.match(source, /native\.postTool\(request\)/);
  const peek = source.indexOf('peekForExecution');
  const ready = source.indexOf('native.ensureReady');
  const take = source.indexOf('takeForExecution');
  const post = source.indexOf('native.postTool');
  assert.ok(peek >= 0 && peek < ready && ready < take && take < post);
});

class FakeNativePort {
  readonly posted: any[] = [];
  readonly messageListeners: ((msg: any) => void)[] = [];
  readonly disconnectListeners: (() => void)[] = [];
  disconnected = false;

  readonly onMessage = {
    addListener: (fn: (msg: any) => void) => { this.messageListeners.push(fn); },
  };

  readonly onDisconnect = {
    addListener: (fn: () => void) => { this.disconnectListeners.push(fn); },
  };

  postMessage(message: any) {
    if (this.disconnected) throw new Error('Port is disconnected');
    this.posted.push(message);
  }

  emitMessage(message: any) {
    for (const fn of this.messageListeners) fn(message);
  }

  emitDisconnect() {
    for (const fn of this.disconnectListeners) fn();
  }

  disconnect() {
    this.disconnected = true;
    this.emitDisconnect();
  }
}

const EXPECTED_TOOLS = ['health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read'] as const;

test('native session controller performs full v2 handshake and profile verification', async () => {
  const { createNativeSessionController } = await import('../browser/extension/native-session-core.js');
  let activePort: FakeNativePort | undefined;
  const toolResponses: any[] = [];
  const native = createNativeSessionController({
    connectNative: () => {
      activePort = new FakeNativePort();
      return activePort;
    },
    randomUUID: ids(),
    onToolResponse: (res) => toolResponses.push(res),
  });

  const readyPromise = native.ensureReady('session_1001');
  assert.ok(activePort);
  assert.equal(activePort.posted.length, 1);
  const helloReq = activePort.posted[0];
  assert.equal(helloReq.version, 2);
  assert.equal(helloReq.type, 'hello');
  assert.match(helloReq.requestId, /^ctl_hello_/);

  // reply with valid hello
  activePort.emitMessage({
    version: 2,
    type: 'result',
    requestId: helloReq.requestId,
    result: { protocolVersion: 2, adapterId: 'browser.chatgpt.native.inspect.v2' },
  });

  await Promise.resolve(); // tick microtasks
  assert.equal(activePort.posted.length, 2);
  const bindReq = activePort.posted[1];
  assert.equal(bindReq.version, 2);
  assert.equal(bindReq.type, 'session.bind');
  assert.match(bindReq.requestId, /^ctl_bind_/);
  assert.equal(bindReq.sessionId, 'session_1001');
  assert.equal(bindReq.provider, 'chatgpt');
  assert.equal(bindReq.origin, 'https://chatgpt.com');

  // reply with valid bind
  activePort.emitMessage({
    version: 2,
    type: 'result',
    requestId: bindReq.requestId,
    result: { sessionId: 'session_1001', provider: 'chatgpt' },
  });

  await Promise.resolve();
  assert.equal(activePort.posted.length, 3);
  const toolsReq = activePort.posted[2];
  assert.equal(toolsReq.version, 2);
  assert.equal(toolsReq.type, 'tools.list');
  assert.match(toolsReq.requestId, /^ctl_tools_/);
  assert.equal(toolsReq.sessionId, 'session_1001');

  // reply with exact 5 tools
  activePort.emitMessage({
    version: 2,
    type: 'result',
    requestId: toolsReq.requestId,
    result: { tools: [...EXPECTED_TOOLS] },
  });

  await readyPromise;
  assert.equal(native.isConnected(), true);

  // subsequent ensureReady for same session resolves immediately without posting messages
  await native.ensureReady('session_1001');
  assert.equal(activePort.posted.length, 3);

  // postTool transmits tool request to port
  const toolCallReq = {
    version: 2 as const,
    type: 'tool.call' as const,
    requestId: 'req_tool_01',
    sessionId: 'session_1001',
    tool: 'health' as const,
    arguments: {},
  };
  native.postTool(toolCallReq);
  assert.equal(activePort.posted.length, 4);
  assert.deepEqual(activePort.posted[3], toolCallReq);

  // tool response is forwarded to onToolResponse
  const toolResp = { version: 2, type: 'result', requestId: 'req_tool_01', result: { ok: true } };
  activePort.emitMessage(toolResp);
  assert.deepEqual(toolResponses, [toolResp]);
});

test('native session controller rejects on hello protocol or adapterId mismatch', async () => {
  const { createNativeSessionController } = await import('../browser/extension/native-session-core.js');

  // wrong protocolVersion
  {
    let port: FakeNativePort | undefined;
    const native = createNativeSessionController({
      connectNative: () => { port = new FakeNativePort(); return port; },
      randomUUID: ids(),
      onToolResponse: () => {},
    });
    const p = native.ensureReady('session_bad_hello');
    port!.emitMessage({
      version: 2,
      type: 'result',
      requestId: port!.posted[0].requestId,
      result: { protocolVersion: 1, adapterId: 'browser.chatgpt.native.inspect.v2' },
    });
    await assert.rejects(p, /protocol/i);
    assert.equal(native.isConnected(), false);
  }

  // wrong adapterId
  {
    let port: FakeNativePort | undefined;
    const native = createNativeSessionController({
      connectNative: () => { port = new FakeNativePort(); return port; },
      randomUUID: ids(),
      onToolResponse: () => {},
    });
    const p = native.ensureReady('session_bad_adapter');
    port!.emitMessage({
      version: 2,
      type: 'result',
      requestId: port!.posted[0].requestId,
      result: { protocolVersion: 2, adapterId: 'browser.chatgpt.native.v1' },
    });
    await assert.rejects(p, /adapter/i);
    assert.equal(native.isConnected(), false);
  }
});

test('native session controller rejects on tools mismatch (missing, extra, reordered, duplicate)', async () => {
  const { createNativeSessionController } = await import('../browser/extension/native-session-core.js');

  const variations: { name: string; tools: unknown }[] = [
    { name: 'missing tool', tools: ['health', 'workspace.open', 'repo.search', 'repo.snapshot'] },
    { name: 'extra tool', tools: [...EXPECTED_TOOLS, 'verify.run'] },
    { name: 'reordered tools', tools: ['workspace.open', 'health', 'repo.search', 'repo.snapshot', 'file.read'] },
    { name: 'duplicate tools', tools: ['health', 'health', 'workspace.open', 'repo.search', 'repo.snapshot'] },
    { name: 'non-array tools', tools: 'health,workspace.open' },
  ];

  for (const { name, tools } of variations) {
    let port: FakeNativePort | undefined;
    const native = createNativeSessionController({
      connectNative: () => { port = new FakeNativePort(); return port; },
      randomUUID: ids(),
      onToolResponse: () => {},
    });

    const p = native.ensureReady('session_tools_test');
    // hello
    port!.emitMessage({
      version: 2, type: 'result', requestId: port!.posted[0].requestId,
      result: { protocolVersion: 2, adapterId: 'browser.chatgpt.native.inspect.v2' },
    });
    await Promise.resolve();
    // bind
    port!.emitMessage({
      version: 2, type: 'result', requestId: port!.posted[1].requestId,
      result: { sessionId: 'session_tools_test', provider: 'chatgpt' },
    });
    await Promise.resolve();
    // tools
    port!.emitMessage({
      version: 2, type: 'result', requestId: port!.posted[2].requestId,
      result: { tools },
    });

    await assert.rejects(p, /tool/i, `Expected rejection for: ${name}`);
    assert.equal(native.isConnected(), false);
  }
});

test('native session controller rejects on native host error responses', async () => {
  const { createNativeSessionController } = await import('../browser/extension/native-session-core.js');

  // hello error
  {
    let port: FakeNativePort | undefined;
    const native = createNativeSessionController({
      connectNative: () => { port = new FakeNativePort(); return port; },
      randomUUID: ids(),
      onToolResponse: () => {},
    });
    const p = native.ensureReady('session_err1');
    port!.emitMessage({
      version: 2, type: 'error', requestId: port!.posted[0].requestId,
      error: { code: 'CRASH', message: 'Host crashed' },
    });
    await assert.rejects(p, /Host crashed/);
  }

  // bind error
  {
    let port: FakeNativePort | undefined;
    const native = createNativeSessionController({
      connectNative: () => { port = new FakeNativePort(); return port; },
      randomUUID: ids(),
      onToolResponse: () => {},
    });
    const p = native.ensureReady('session_err2');
    port!.emitMessage({
      version: 2, type: 'result', requestId: port!.posted[0].requestId,
      result: { protocolVersion: 2, adapterId: 'browser.chatgpt.native.inspect.v2' },
    });
    await Promise.resolve();
    port!.emitMessage({
      version: 2, type: 'error', requestId: port!.posted[1].requestId,
      error: { code: 'ADMISSION_FAILED', message: 'Admission rejected' },
    });
    await assert.rejects(p, /Admission rejected/);
  }
});

test('native session controller handles session switch with unbind -> bind -> tools.list', async () => {
  const { createNativeSessionController } = await import('../browser/extension/native-session-core.js');
  let port: FakeNativePort | undefined;
  const native = createNativeSessionController({
    connectNative: () => { port = new FakeNativePort(); return port; },
    randomUUID: ids(),
    onToolResponse: () => {},
  });

  // initial session A
  const pA = native.ensureReady('session_AAA');
  port!.emitMessage({ version: 2, type: 'result', requestId: port!.posted[0].requestId, result: { protocolVersion: 2, adapterId: 'browser.chatgpt.native.inspect.v2' } });
  await Promise.resolve();
  port!.emitMessage({ version: 2, type: 'result', requestId: port!.posted[1].requestId, result: { sessionId: 'session_AAA', provider: 'chatgpt' } });
  await Promise.resolve();
  port!.emitMessage({ version: 2, type: 'result', requestId: port!.posted[2].requestId, result: { tools: [...EXPECTED_TOOLS] } });
  await pA;
  assert.equal(port!.posted.length, 3);

  // switch to session B
  const pB = native.ensureReady('session_BBB');
  await Promise.resolve();
  assert.equal(port!.posted.length, 4);
  const unbindReq = port!.posted[3];
  assert.equal(unbindReq.type, 'session.unbind');
  assert.equal(unbindReq.sessionId, 'session_AAA');

  // reply to unbind
  port!.emitMessage({ version: 2, type: 'result', requestId: unbindReq.requestId, result: { unbound: true } });
  await Promise.resolve();
  assert.equal(port!.posted.length, 5);
  const bindReq = port!.posted[4];
  assert.equal(bindReq.type, 'session.bind');
  assert.equal(bindReq.sessionId, 'session_BBB');

  // reply to bind
  port!.emitMessage({ version: 2, type: 'result', requestId: bindReq.requestId, result: { sessionId: 'session_BBB', provider: 'chatgpt' } });
  await Promise.resolve();
  assert.equal(port!.posted.length, 6);
  const toolsReq = port!.posted[5];
  assert.equal(toolsReq.type, 'tools.list');
  assert.equal(toolsReq.sessionId, 'session_BBB');

  // reply to tools.list
  port!.emitMessage({ version: 2, type: 'result', requestId: toolsReq.requestId, result: { tools: [...EXPECTED_TOOLS] } });
  await pB;
  assert.equal(native.isConnected(), true);
});

test('native session controller disconnect rejects pending and clears state for full re-handshake', async () => {
  const { createNativeSessionController } = await import('../browser/extension/native-session-core.js');
  let port: FakeNativePort | undefined;
  const native = createNativeSessionController({
    connectNative: () => { port = new FakeNativePort(); return port; },
    randomUUID: ids(),
    onToolResponse: () => {},
  });

  const p1 = native.ensureReady('session_dc');
  port!.emitDisconnect();
  await assert.rejects(p1, /disconnect/i);
  assert.equal(native.isConnected(), false);

  // subsequent ensureReady should reconnect and start fresh with hello
  const firstPort = port;
  const retry = native.ensureReady('session_dc');
  const retryPort = port;
  retryPort!.emitDisconnect();
  await assert.rejects(retry, /disconnect/i);
  assert.ok(retryPort !== firstPort);
  assert.equal(retryPort!.posted[0].type, 'hello')
});

test('native session controller rejects control response with invalid protocol version', async () => {
  const { createNativeSessionController } = await import('../browser/extension/native-session-core.js');
  let activePort: FakeNativePort | undefined;
  const native = createNativeSessionController({
    connectNative: () => { activePort = new FakeNativePort(); return activePort; },
    randomUUID: ids(),
    onToolResponse: () => {},
  });

  const p = native.ensureReady('session_bad_version');

  activePort!.emitMessage({
    version: 1,
    type: 'result',
    requestId: activePort!.posted[0].requestId,
    result: { protocolVersion: 2, adapterId: 'browser.chatgpt.native.inspect.v2' },
  });

  await Promise.resolve();
  activePort!.emitDisconnect();
  await assert.rejects(p, /version/i);
  assert.equal(native.isConnected(), false);
});

test('native session controller disconnects and resets state when tools.list handshake fails', async () => {
  const { createNativeSessionController } = await import('../browser/extension/native-session-core.js');
  let activePort: FakeNativePort | undefined;
  const native = createNativeSessionController({
    connectNative: () => { activePort = new FakeNativePort(); return activePort; },
    randomUUID: ids(),
    onToolResponse: () => {},
  });

  const p = native.ensureReady('session_fail_tools');
  const firstPort = activePort!;

  firstPort.emitMessage({
    version: 2, type: 'result', requestId: firstPort.posted[0].requestId,
    result: { protocolVersion: 2, adapterId: 'browser.chatgpt.native.inspect.v2' },
  });
  await Promise.resolve();

  firstPort.emitMessage({
    version: 2, type: 'result', requestId: firstPort.posted[1].requestId,
    result: { sessionId: 'session_fail_tools', provider: 'chatgpt' },
  });
  await Promise.resolve();

  firstPort.emitMessage({
    version: 2, type: 'result', requestId: firstPort.posted[2].requestId,
    result: { tools: ['health'] },
  });

  await assert.rejects(p, /tool/i);
  assert.equal(firstPort.disconnected, true);
  assert.equal(native.isConnected(), false);

  const retry = native.ensureReady('session_fail_tools');
  const retryPort = activePort!;
  retryPort.emitDisconnect();
  await assert.rejects(retry, /disconnect/i);
  assert.ok(retryPort !== firstPort);
  assert.equal(retryPort.posted[0].type, 'hello');
});
