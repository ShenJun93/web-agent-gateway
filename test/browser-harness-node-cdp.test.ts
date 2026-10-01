import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNodeCdpTransport,
  resolveCdpWebSocketEndpoint,
} from '../src/browser-harness/node-cdp-transport.js';

class FakeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    this.sent.push(data);
    const command = JSON.parse(data) as { id: number; method: string };
    queueMicrotask(() => this.emit('message', {
      data: JSON.stringify({ id: command.id, result: { method: command.method } }),
    }));
  }

  close(): void {
    this.emit('close');
  }
}

test('CDP endpoint discovery is loopback-only by default', async () => {
  await assert.rejects(
    () => resolveCdpWebSocketEndpoint({ endpointUrl: 'http://192.0.2.10:9222' }),
    /Remote CDP endpoint is denied/,
  );
  assert.equal(
    await resolveCdpWebSocketEndpoint({ endpointUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
    'ws://127.0.0.1:9222/devtools/browser/abc',
  );
});

test('HTTP CDP endpoint discovery resolves the browser websocket URL', async () => {
  const seen: string[] = [];
  const resolved = await resolveCdpWebSocketEndpoint({
    endpointUrl: 'http://127.0.0.1:9333',
    fetchImpl: async (url) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        async json() { return { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/xyz' }; },
      };
    },
  });
  assert.equal(resolved, 'ws://127.0.0.1:9333/devtools/browser/xyz');
  assert.deepEqual(seen, ['http://127.0.0.1:9333/json/version']);
});

test('node CDP transport correlates commands by id over one WebSocket', async () => {
  const socket = new FakeSocket();
  const transportPromise = createNodeCdpTransport({
    endpointUrl: 'ws://127.0.0.1:9333/devtools/browser/abc',
    createWebSocket(url) {
      assert.equal(url, 'ws://127.0.0.1:9333/devtools/browser/abc');
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
    commandTimeoutMs: 1000,
  });
  const transport = await transportPromise;
  const response = await transport.send({ id: 41, method: 'Target.getTargets' });
  assert.deepEqual(response, { id: 41, result: { method: 'Target.getTargets' } });
  assert.deepEqual(JSON.parse(socket.sent[0]!), { id: 41, method: 'Target.getTargets' });
  await transport.close();
  assert.equal(socket.readyState, 3);
});
