import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserControlWebSocketV1 } from '../browser/extension/browser-control-websocket-v1.js';

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  listeners = new Map<string, Array<(event?: any) => void>>();

  constructor(readonly url: string) {}

  addEventListener(name: string, listener: (event?: any) => void) {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }

  emit(name: string, event?: any) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit('close'); }
}

test('extension WebSocket transport pairs and returns bounded control responses', async () => {
  const values: Record<string, unknown> = {};
  const sockets: FakeSocket[] = [];
  const WebSocketImpl = class extends FakeSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  };

  let downloadListener: ((event: any) => void) | undefined;
  let downloadSubscriptions = 0;
  const control = {
    onDownloadEvent(listener: (event: any) => void) {
      downloadSubscriptions += 1;
      downloadListener = listener;
      return () => { if (downloadListener === listener) downloadListener = undefined; };
    },
    async listTargets() {
      return [{
        tabId: 7,
        windowId: 3,
        title: 'Existing',
        url: 'https://example.test/',
        origin: 'https://example.test',
        active: false,
        attachable: true,
        ownership: 'USER_EXISTING',
      }];
    },
    async group(tabId: number, title = 'WAG • AI') {
      return { tabId, groupId: 9, groupTitle: title, activeStable: true };
    },
    async attach() { return {}; },
    async describe() { return {}; },
    async exec() { return {}; },
    async screenshot() { return { mimeType: 'image/png', dataBase64: '' }; },
    async release(tabId: number) { return { tabId, released: true }; },
    isAttached() { return false; },
  };

  const transport = createBrowserControlWebSocketV1({
    storage: {
      async get(key: string) { return { [key]: values[key] }; },
      async set(value: Record<string, unknown>) { Object.assign(values, value); },
      async remove(key: string) { delete values[key]; },
    },
    control,
    WebSocketImpl: WebSocketImpl as any,
    setTimeoutImpl: (() => 1) as any,
    clearTimeoutImpl: (() => undefined) as any,
  });

  await transport.configure({
    endpoint: 'ws://127.0.0.1:17841/browser-control',
    pairingToken: 'x'.repeat(43),
  });
  const socket = sockets.at(-1)!;
  socket.emit('open');
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    version: 1,
    type: 'control.hello',
    extensionRelease: {
      schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1',
      sourceHead: 'development',
    },
    pairingToken: 'x'.repeat(43),
  });

  socket.emit('message', { data: JSON.stringify({ version: 1, type: 'control.ready' }) });
  assert.equal(transport.isConnected(), true);
  assert.equal(downloadSubscriptions, 1);
  assert.ok(downloadListener);
  downloadListener!({
    tabId: 7,
    method: 'Browser.downloadProgress',
    params: { guid: 'download-1', state: 'completed' },
  });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Browser.downloadProgress',
    params: { guid: 'download-1', state: 'completed' },
  });

  socket.emit('message', { data: JSON.stringify({
    version: 1,
    type: 'control.request',
    requestId: 'bctl_00000000-0000-4000-8000-000000000001',
    method: 'targets.list',
  }) });
  await new Promise((resolve) => setImmediate(resolve));

  const response = JSON.parse(socket.sent.at(-1)!);
  assert.equal(response.type, 'control.result');
  assert.equal(response.requestId, 'bctl_00000000-0000-4000-8000-000000000001');
  assert.equal(response.result[0].targetId, 'tab_7');
  assert.equal(response.result[0].attached, false);

  transport.stop();
  assert.equal(downloadListener, undefined);
  await transport.configure({
    endpoint: 'ws://127.0.0.1:17841/browser-control',
    pairingToken: 'a'.repeat(64),
  });
  assert.equal(downloadSubscriptions, 2, 'start after stop must restore download event forwarding');

  await transport.clearConfig();
  assert.equal(transport.isConnected(), false);
  assert.equal(await transport.loadConfig(), null);
});

test('extension WebSocket config refuses non-loopback endpoints', async () => {
  const transport = createBrowserControlWebSocketV1({
    storage: { async get() { return {}; }, async set() {}, async remove() {} },
    control: {},
    WebSocketImpl: FakeSocket as any,
  });
  await assert.rejects(
    () => transport.configure({
      endpoint: 'ws://192.168.1.5:17841/browser-control',
      pairingToken: 'x'.repeat(43),
    }),
    /loopback/,
  );
});
