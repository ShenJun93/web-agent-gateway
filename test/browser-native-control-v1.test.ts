import assert from 'node:assert/strict';
import test from 'node:test';

import { createNativeBrowserControlV1 } from '../browser/extension/native-browser-control-v1.js';

class FakeEvent<T extends (...args: any[]) => void> {
  listeners: T[] = [];
  addListener(listener: T) { this.listeners.push(listener); }
  emit(...args: Parameters<T>) { for (const listener of this.listeners) listener(...args); }
}

class FakePort {
  messages: unknown[] = [];
  onMessage = new FakeEvent<(message: any) => void>();
  onDisconnect = new FakeEvent<() => void>();
  postMessage(message: unknown) { this.messages.push(message); }
}

test('native browser control routes bounded target operations over one native port', async () => {
  const port = new FakePort();
  const calls: unknown[][] = [];
  const attached = new Set<number>();
  const target = {
    tabId: 7, windowId: 3, title: 'Existing', url: 'https://example.test/',
    origin: 'https://example.test', active: false, attachable: true, ownership: 'USER_EXISTING',
  };
  const control = {
    async listTargets() { calls.push(['list']); return [target]; },
    async attach(tabId: number) { calls.push(['attach', tabId]); attached.add(tabId); return { ...target, state: 'ATTACHED' }; },
    async describe(tabId: number) { calls.push(['describe', tabId]); return { ...target, attached: attached.has(tabId) }; },
    async exec(tabId: number, method: string, params?: Record<string, unknown>) {
      calls.push(['exec', tabId, method, params]);
      return { nodes: [] };
    },
    async screenshot(tabId: number) { calls.push(['screenshot', tabId]); return { mimeType: 'image/png' as const, dataBase64: 'cG5n' }; },
    async release(tabId: number) { calls.push(['release', tabId]); const released = attached.delete(tabId); return { tabId, released }; },
    isAttached(tabId: number) { return attached.has(tabId); },
  };

  const native = createNativeBrowserControlV1({ connectNative: () => port as never, control });
  native.ensureConnected();

  const request = (n: number, method: string, extra: Record<string, unknown> = {}) => ({
    version: 1, type: 'control.request',
    requestId: `bctl_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    method, ...extra,
  });

  port.onMessage.emit(request(1, 'targets.list'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((port.messages[0] as any).result[0], {
    targetId: 'tab_7', windowId: 'window_3', title: 'Existing',
    url: 'https://example.test/', origin: 'https://example.test',
    active: false, attachable: true, ownership: 'USER_EXISTING', attached: false,
  });

  port.onMessage.emit(request(2, 'target.attach', { targetId: 'tab_7' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((port.messages[1] as any).result.attached, true);

  port.onMessage.emit(request(3, 'target.exec', {
    targetId: 'tab_7', cdpMethod: 'Accessibility.getFullAXTree',
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((port.messages[2] as any).result, { nodes: [] });

  port.onMessage.emit(request(4, 'target.screenshot', { targetId: 'tab_7' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((port.messages[3] as any).result.dataBase64, 'cG5n');

  port.onMessage.emit(request(5, 'target.release', { targetId: 'tab_7' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((port.messages[4] as any).result.released, true);
  assert.ok(calls.some((row) => row[0] === 'exec'));
});

test('native browser control rejects arbitrary Runtime.evaluate before control dispatch', async () => {
  const port = new FakePort();
  let execCalled = false;
  const native = createNativeBrowserControlV1({
    connectNative: () => port as never,
    control: {
      async listTargets() { return []; },
      async attach() { return {}; },
      async describe() { return {}; },
      async exec() { execCalled = true; return {}; },
      async screenshot() { return { mimeType: 'image/png' as const, dataBase64: '' }; },
      async release(tabId: number) { return { tabId, released: false }; },
      isAttached() { return false; },
    },
  });
  native.ensureConnected();
  port.onMessage.emit({
    version: 1, type: 'control.request',
    requestId: 'bctl_00000000-0000-4000-8000-000000000099',
    method: 'target.exec', targetId: 'tab_7',
    cdpMethod: 'Runtime.evaluate', params: { expression: 'document.cookie' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(execCalled, false);
  assert.equal((port.messages[0] as any).type, 'control.error');
  assert.equal((port.messages[0] as any).error.code, 'CONTROL_METHOD_DENIED');
});
