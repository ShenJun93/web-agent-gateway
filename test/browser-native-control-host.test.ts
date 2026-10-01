import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';
import { NativeMessageDecoder, encodeNativeMessage } from '../src/browser-adapter/native-framing.js';
import { runNativeBrowserControlHost } from '../src/browser-adapter/native-host-browser-control.js';
import {
  createExistingBrowserControlClient,
  ExistingBrowserControlClientError,
} from '../src/browser-harness/existing-browser-control-client.js';

const ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;

test('browser control native host multiplexes bounded WAG clients to one extension port', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-control-host-'));
  const discoveryPath = join(root, 'browser-control-v1.json');
  const extensionToHost = new PassThrough();
  const hostToExtension = new PassThrough();
  const host = await runNativeBrowserControlHost({
    input: extensionToHost,
    output: hostToExtension,
    expectedOrigin: ORIGIN,
    discoveryPath,
    bearerToken: 'x'.repeat(43),
  });
  t.after(async () => {
    await host.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const decoder = new NativeMessageDecoder();
  hostToExtension.on('data', (chunk) => {
    for (const request of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
      const row = request as any;
      let result: unknown;
      if (row.method === 'targets.list') {
        result = [{
          targetId: 'tab_7', windowId: 'window_3', title: 'Existing',
          url: 'https://example.test/', origin: 'https://example.test',
          active: false, attachable: true, ownership: 'USER_EXISTING', attached: false,
        }];
      } else if (row.method === 'target.attach' || row.method === 'target.describe') {
        result = {
          targetId: row.targetId, windowId: 'window_3', title: 'Existing',
          url: 'https://example.test/', origin: 'https://example.test',
          active: false, attachable: true, ownership: 'USER_EXISTING', attached: true,
        };
      } else if (row.method === 'target.release') {
        result = { targetId: row.targetId, released: true };
      } else if (row.method === 'target.screenshot') {
        result = { mimeType: 'image/png', dataBase64: 'cG5n' };
      } else {
        result = { nodes: [] };
      }
      extensionToHost.write(encodeNativeMessage({
        version: 1, type: 'control.result', requestId: row.requestId, result,
      }));
    }
  });

  const a = createExistingBrowserControlClient({ discoveryPath });
  const b = createExistingBrowserControlClient({ discoveryPath });

  const [targets, attached] = await Promise.all([
    a.listTargets(),
    b.attach('tab_7'),
  ]);
  assert.equal(targets[0]?.targetId, 'tab_7');
  assert.equal(attached.attached, true);
  assert.deepEqual(await a.exec('tab_7', 'Accessibility.getFullAXTree'), { nodes: [] });
  assert.equal((await b.screenshot('tab_7')).dataBase64, 'cG5n');
  assert.equal((await a.release('tab_7')).released, true);
});

test('browser control WAG client fails closed on unavailable host discovery', async () => {
  const client = createExistingBrowserControlClient({
    discoveryPath: join(tmpdir(), 'definitely-missing-wag-browser-control-v1.json'),
    timeoutMs: 50,
  });
  await assert.rejects(
    () => client.listTargets(),
    /discovery unavailable/,
  );
});
