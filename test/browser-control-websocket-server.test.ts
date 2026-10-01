import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
      () => server.client.exec('tab_7', 'Accessibility.getFullAXTree'),
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
