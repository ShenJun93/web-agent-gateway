import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';

import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';
import {
  loadOrCreateBrowserControlPairingState,
  startBrowserControlWebSocketServer,
} from '../src/browser-harness/browser-control-websocket-server.js';

const ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port allocation failed');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function waitMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
}

test('Browser Control WebSocket authenticates exact extension and routes target/group control', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-ws-'));
  const port = await freePort();
  const statePath = join(root, 'pairing.json');
  const state = await loadOrCreateBrowserControlPairingState(statePath, port);
  const server = await startBrowserControlWebSocketServer({ statePath, pairingState: state });
  t.after(async () => {
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const socket = new WebSocket(state.endpoint, { headers: { Origin: ORIGIN } });
  await waitOpen(socket);
  socket.send(JSON.stringify({ version: 1, type: 'control.hello', pairingToken: state.pairingToken }));
  assert.equal((await waitMessage(socket)).type, 'control.ready');
  assert.equal(server.connected(), true);

  socket.on('message', (data) => {
    const request = JSON.parse(data.toString());
    if (request.type !== 'control.request') return;
    let result: unknown;
    if (request.method === 'targets.list') {
      result = [{
        targetId: 'tab_7', windowId: 'window_3', title: 'Existing',
        url: 'https://example.test/', origin: 'https://example.test',
        active: false, attachable: true, ownership: 'USER_EXISTING', attached: false,
      }];
    } else if (request.method === 'target.create') {
      result = {
        targetId: 'tab_9', windowId: 'window_3', title: 'New tab',
        url: null, origin: null,
        active: false, attachable: true, ownership: 'USER_EXISTING', attached: false,
      };
    } else if (request.method === 'target.close') {
      result = { targetId: request.targetId, closed: true };
    } else if (request.method === 'target.group') {
      result = {
        targetId: request.targetId,
        groupId: 'group_9',
        groupTitle: request.groupTitle,
        activeStable: true,
      };
    } else if (request.method === 'target.watch') {
      result = { targetId: request.targetId, baselineSequence: 4 };
    } else if (request.method === 'target.continuity') {
      result = {
        sequence: 7,
        reason: 'SUCCESSOR',
        target: {
          targetId: 'tab_8', windowId: 'window_3', title: 'OAuth Successor',
          url: 'https://auth.example.test/callback', origin: 'https://auth.example.test',
          active: false, attachable: true, ownership: 'USER_EXISTING', attached: false,
        },
      };
    } else {
      result = {};
    }
    socket.send(JSON.stringify({
      version: 1, type: 'control.result', requestId: request.requestId, result,
    }));
  });

  const targets = await server.client.listTargets();
  assert.equal(targets[0]?.targetId, 'tab_7');
  assert.equal((await server.client.createTarget()).targetId, 'tab_9');
  assert.deepEqual(
    await server.client.closeTarget('tab_9'),
    { targetId: 'tab_9', closed: true },
  );
  assert.deepEqual(
    await server.client.groupTarget('tab_7', 'WAG • Test'),
    { targetId: 'tab_7', groupId: 'group_9', groupTitle: 'WAG • Test', activeStable: true },
  );
  assert.deepEqual(
    await server.client.watchContinuity('tab_7'),
    { targetId: 'tab_7', baselineSequence: 4 },
  );
  assert.deepEqual(
    await server.client.resolveContinuity('tab_7', 'tab_7'),
    {
      sequence: 7,
      reason: 'SUCCESSOR',
      target: {
        targetId: 'tab_8', windowId: 'window_3', title: 'OAuth Successor',
        url: 'https://auth.example.test/callback', origin: 'https://auth.example.test',
        active: false, attachable: true, ownership: 'USER_EXISTING', attached: false,
      },
    },
  );
  socket.close();
});


test('Browser Control WebSocket routes only bounded download events to the exact target subscription', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-ws-download-events-'));
  const port = await freePort();
  const statePath = join(root, 'pairing.json');
  const state = await loadOrCreateBrowserControlPairingState(statePath, port);
  const server = await startBrowserControlWebSocketServer({ statePath, pairingState: state });
  t.after(async () => {
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const socket = new WebSocket(state.endpoint, { headers: { Origin: ORIGIN } });
  await waitOpen(socket);
  socket.send(JSON.stringify({ version: 1, type: 'control.hello', pairingToken: state.pairingToken }));
  assert.equal((await waitMessage(socket)).type, 'control.ready');

  const observed: unknown[] = [];
  const unsubscribe = server.client.onEvent!(
    'tab_7',
    'Browser.downloadProgress',
    (params) => observed.push(params),
  );

  socket.send(JSON.stringify({
    version: 1,
    type: 'control.event',
    targetId: 'tab_8',
    method: 'Browser.downloadProgress',
    params: { guid: 'download-1', state: 'completed' },
  }));
  socket.send(JSON.stringify({
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Runtime.consoleAPICalled',
    params: {},
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, []);

  socket.send(JSON.stringify({
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Browser.downloadProgress',
    params: { guid: 'download-1', state: 'completed' },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, [{ guid: 'download-1', state: 'completed' }]);

  unsubscribe();
  socket.send(JSON.stringify({
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Browser.downloadProgress',
    params: { guid: 'download-2', state: 'completed' },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.length, 1);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.close();
  await closed;
});

test('Browser Control WebSocket rejects wrong extension origin before pairing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-ws-origin-'));
  const port = await freePort();
  const statePath = join(root, 'pairing.json');
  const state = await loadOrCreateBrowserControlPairingState(statePath, port);
  const server = await startBrowserControlWebSocketServer({ statePath, pairingState: state });
  t.after(async () => {
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const socket = new WebSocket(state.endpoint, {
    headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  });
  const refused = await new Promise<boolean>((resolve) => {
    socket.once('unexpected-response', () => resolve(true));
    socket.once('error', () => resolve(true));
    socket.once('open', () => resolve(false));
  });
  assert.equal(refused, true);
  socket.terminate();
});

test('Browser Control WebSocket bounds target enumeration to 512 entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-ws-target-bound-'));
  const port = await freePort();
  const statePath = join(root, 'pairing.json');
  const state = await loadOrCreateBrowserControlPairingState(statePath, port);
  const server = await startBrowserControlWebSocketServer({ statePath, pairingState: state });
  const socket = new WebSocket(state.endpoint, { headers: { Origin: ORIGIN } });
  try {
    await waitOpen(socket);
    socket.send(JSON.stringify({ version: 1, type: 'control.hello', pairingToken: state.pairingToken }));
    assert.equal((await waitMessage(socket)).type, 'control.ready');
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      if (request.type !== 'control.request' || request.method !== 'targets.list') return;
      const result = Array.from({ length: 513 }, (_, index) => ({
        targetId: 'tab_' + String(index + 1),
        windowId: 'window_1',
        title: 'Target ' + String(index + 1),
        url: 'https://example.test/',
        origin: 'https://example.test',
        active: false,
        attachable: true,
        ownership: 'USER_EXISTING',
        attached: false,
      }));
      socket.send(JSON.stringify({
        version: 1,
        type: 'control.result',
        requestId: request.requestId,
        result,
      }));
    });
    await assert.rejects(() => server.client.listTargets(), /target list exceeds limit/);
  } finally {
    socket.terminate();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Browser Control WebSocket rejects oversized non-screenshot responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-ws-response-bound-'));
  const port = await freePort();
  const statePath = join(root, 'pairing.json');
  const state = await loadOrCreateBrowserControlPairingState(statePath, port);
  const server = await startBrowserControlWebSocketServer({ statePath, pairingState: state });
  const socket = new WebSocket(state.endpoint, { headers: { Origin: ORIGIN } });
  try {
    await waitOpen(socket);
    socket.send(JSON.stringify({ version: 1, type: 'control.hello', pairingToken: state.pairingToken }));
    assert.equal((await waitMessage(socket)).type, 'control.ready');
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      if (request.type !== 'control.request' || request.method !== 'target.exec') return;
      socket.send(JSON.stringify({
        version: 1,
        type: 'control.result',
        requestId: request.requestId,
        result: { blob: 'A'.repeat(300 * 1024) },
      }));
    });
    await assert.rejects(
      () => server.client.exec('tab_7', 'DOM.getBoxModel'),
      /response exceeds size limit/,
    );
  } finally {
    socket.terminate();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Browser Control WebSocket caps concurrent pending requests at 128', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-ws-pending-bound-'));
  const port = await freePort();
  const statePath = join(root, 'pairing.json');
  const state = await loadOrCreateBrowserControlPairingState(statePath, port);
  const server = await startBrowserControlWebSocketServer({
    statePath,
    pairingState: state,
    requestTimeoutMs: 60_000,
  });
  const socket = new WebSocket(state.endpoint, { headers: { Origin: ORIGIN } });
  try {
    await waitOpen(socket);
    socket.send(JSON.stringify({ version: 1, type: 'control.hello', pairingToken: state.pairingToken }));
    assert.equal((await waitMessage(socket)).type, 'control.ready');

    const waiting = Array.from({ length: 128 }, () =>
      server.client.listTargets().catch(() => undefined),
    );
    await assert.rejects(
      () => server.client.listTargets(),
      /pending request limit reached/,
    );
    socket.terminate();
    await Promise.all(waiting);
  } finally {
    socket.terminate();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Browser Control WebSocket gives Accessibility tree a bounded larger response budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-ws-ax-budget-'));
  const port = await freePort();
  const statePath = join(root, 'pairing.json');
  const state = await loadOrCreateBrowserControlPairingState(statePath, port);
  const server = await startBrowserControlWebSocketServer({ statePath, pairingState: state });
  const socket = new WebSocket(state.endpoint, { headers: { Origin: ORIGIN } });
  try {
    await waitOpen(socket);
    socket.send(JSON.stringify({ version: 1, type: 'control.hello', pairingToken: state.pairingToken }));
    assert.equal((await waitMessage(socket)).type, 'control.ready');
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      if (request.type !== 'control.request' || request.method !== 'target.exec') return;
      socket.send(JSON.stringify({
        version: 1,
        type: 'control.result',
        requestId: request.requestId,
        result: { nodes: [], padding: 'A'.repeat(512 * 1024) },
      }));
    });
    const value = await server.client.exec('tab_7', 'Accessibility.getFullAXTree');
    assert.equal(typeof value, 'object');
  } finally {
    socket.terminate();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Browser Control WebSocket requests extension self-reload on release mismatch and converges on reconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-ws-release-'));
  const port = await freePort();
  const statePath = join(root, 'pairing.json');
  const releaseStatePath = join(root, 'extension-release.json');
  const state = await loadOrCreateBrowserControlPairingState(statePath, port);
  const expected = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const previous = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const server = await startBrowserControlWebSocketServer({
    statePath,
    pairingState: state,
    expectedExtensionSourceHead: expected,
    extensionReleaseStatePath: releaseStatePath,
  });

  const first = new WebSocket(state.endpoint, { headers: { Origin: ORIGIN } });
  try {
    await waitOpen(first);
    const reloadRequestPromise = new Promise<any>((resolve, reject) => {
      const onMessage = (data: Buffer) => {
        let message: any;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (message?.type !== 'control.request' || message?.method !== 'extension.reload') return;
        first.off('message', onMessage);
        first.off('error', onError);
        resolve(message);
      };
      const onError = (error: Error) => {
        first.off('message', onMessage);
        reject(error);
      };
      first.on('message', onMessage);
      first.once('error', onError);
    });
    first.send(JSON.stringify({
      version: 1,
      type: 'control.hello',
      pairingToken: state.pairingToken,
      extensionRelease: {
        schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1',
        sourceHead: previous,
      },
    }));
    const reloadRequest = await reloadRequestPromise;
    assert.equal(reloadRequest.type, 'control.request');
    assert.equal(reloadRequest.method, 'extension.reload');
    first.send(JSON.stringify({
      version: 1,
      type: 'control.result',
      requestId: reloadRequest.requestId,
      result: {
        accepted: true,
        schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1',
        sourceHead: previous,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    first.close();

    const second = new WebSocket(state.endpoint, { headers: { Origin: ORIGIN } });
    try {
      await waitOpen(second);
      second.send(JSON.stringify({
        version: 1,
        type: 'control.hello',
        pairingToken: state.pairingToken,
        extensionRelease: {
          schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1',
          sourceHead: expected,
        },
      }));
      assert.equal((await waitMessage(second)).type, 'control.ready');
      await new Promise((resolve) => setTimeout(resolve, 25));
      const release = JSON.parse(await readFile(releaseStatePath, 'utf8')) as Record<string, unknown>;
      assert.equal(release.connected, true);
      assert.equal(release.expectedSourceHead, expected);
      assert.equal(release.observedSourceHead, expected);
      assert.equal(release.match, true);
      assert.equal(release.reloadRequested, false);
      assert.equal(release.lastError, null);
    } finally {
      second.close();
    }
  } finally {
    first.terminate();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
