import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';
import { NativeMessageDecoder, encodeNativeMessage } from '../src/browser-adapter/native-framing.js';
import { runNativeBrowserControlHost } from '../src/browser-adapter/native-host-browser-control.js';
import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';

const ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;

test('BrowserMcpContext ATTACH_EXISTING uses one semantic stack through native control bridge', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-existing-runtime-integration-'));
  const discoveryPath = join(root, 'browser-control-v1.json');
  const extensionToHost = new PassThrough();
  const hostToExtension = new PassThrough();
  const host = await runNativeBrowserControlHost({
    input: extensionToHost,
    output: hostToExtension,
    expectedOrigin: ORIGIN,
    discoveryPath,
    bearerToken: 'y'.repeat(43),
  });
  t.after(async () => {
    await host.close().catch(() => undefined);
  });

  let attached = false;
  let typed = '';
  let clicked = false;
  const decoder = new NativeMessageDecoder();
  hostToExtension.on('data', (chunk) => {
    for (const raw of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
      const request = raw as any;
      const target = {
        targetId: 'tab_7', windowId: 'window_3', title: 'Authenticated',
        url: 'https://example.test/target', origin: 'https://example.test',
        active: false, attachable: true, ownership: 'USER_EXISTING', attached,
      };
      let result: unknown = {};
      switch (request.method) {
        case 'targets.list': result = [target]; break;
        case 'target.watch': result = { targetId: 'tab_7', baselineSequence: 0 }; break;
        case 'target.continuity': result = { sequence: 0, reason: 'NO_CHANGE', target: null }; break;
        case 'target.attach': attached = true; result = { ...target, attached: true }; break;
        case 'target.describe': result = { ...target, attached }; break;
        case 'target.release': attached = false; result = { targetId: 'tab_7', released: true }; break;
        case 'target.screenshot': result = { mimeType: 'image/png', dataBase64: 'cG5n' }; break;
        case 'target.exec': {
          const method = request.cdpMethod as string;
          const params = request.params as Record<string, any> | undefined;
          if (method === 'Accessibility.getFullAXTree') {
            result = {
              nodes: [
                {
                  ignored: false, role: { value: 'textbox' }, name: { value: 'Name' },
                  properties: [{ name: 'editable', value: { value: true } }],
                  backendDOMNodeId: 1,
                },
                {
                  ignored: false, role: { value: 'button' }, name: { value: 'Submit' },
                  properties: [{ name: 'focusable', value: { value: true } }],
                  backendDOMNodeId: 2,
                },
                ...(clicked ? [{
                  ignored: false, role: { value: 'StaticText' }, name: { value: 'submitted:' + typed },
                  backendDOMNodeId: 3,
                }] : []),
              ],
            };
          } else if (method === 'Input.insertText') {
            typed = String(params?.text ?? '');
          } else if (method === 'DOM.getBoxModel') {
            result = { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } };
          } else if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
            clicked = true;
          }
          break;
        }
      }
      extensionToHost.write(encodeNativeMessage({
        version: 1, type: 'control.result', requestId: request.requestId, result,
      }));
    }
  });

  const context = createPrivateBrowserMcpContext({
    owner: { ownerId: 'owner_integration', sessionId: 'session_integration', adapterId: 'private.stdio.v1' },
    edgeExecutablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    controlDiscoveryPath: discoveryPath,
    killSwitch: () => false,
  });
  t.after(async () => {
    await context.closeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const targets = await context.targets();
  assert.equal(targets[0]?.targetId, 'tab_7');
  const opened = await context.open('existing', 'ATTACH_EXISTING', 'tab_7');
  assert.equal(opened.executionMode, 'ATTACH_EXISTING');
  assert.equal(opened.ownershipMode, 'ATTACHED_EXISTING');

  const snapshot = await context.snapshot(opened.browserSessionId);
  const input = snapshot.nodes.find((node) => node.name === 'Name');
  const button = snapshot.nodes.find((node) => node.name === 'Submit');
  assert.ok(input && button);

  assert.equal((await context.exec(opened.browserSessionId, 'fill.1', {
    type: 'fill', ref: input.ref, text: 'WAG',
  })).state, 'SUCCEEDED');
  assert.equal((await context.exec(opened.browserSessionId, 'click.1', {
    type: 'click', ref: button.ref,
  })).state, 'SUCCEEDED');

  const after = await context.snapshot(opened.browserSessionId);
  assert.ok(after.nodes.some((node) => node.name === 'submitted:WAG'));
  assert.equal((await context.close(opened.browserSessionId)).state, 'CLOSED');
  assert.equal(attached, false);
  assert.equal((await context.targets())[0]?.targetId, 'tab_7');
});
