import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWindowsUiaDesktopBackend,
  resolveWindowsDesktopWindow,
  type WindowsUiaBridgeClient,
} from '../src/desktop-harness/windows-uia-backend.js';

function bridgeFixture() {
  const calls: Record<string, unknown>[] = [];
  const bridge: WindowsUiaBridgeClient = {
    async request(value) {
      calls.push(value);
      switch (value.op) {
        case 'resolveWindow':
          return { hwndHex: '1a2b', title: 'Fixture' };
        case 'snapshot':
          return {
            nodes: [
              {
                backendElementId: 'uia:1,2,3',
                role: 'edit',
                name: 'Input',
                value: 'alpha',
                enabled: true,
                patterns: ['Value'],
              },
              {
                backendElementId: 'uia:1,2,4',
                role: 'button',
                name: 'Apply',
                enabled: true,
                patterns: ['Invoke'],
              },
            ],
          };
        case 'screenshot':
          return { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
        case 'invoke':
        case 'setValue':
        case 'toggle':
        case 'select':
          return { ok: true };
        default:
          throw new Error('unexpected operation');
      }
    },
  };
  return { bridge, calls };
}

test('Windows UIA bridge resolves one exact visible process window and normalizes hwnd', async () => {
  const f = bridgeFixture();
  assert.deepEqual(await resolveWindowsDesktopWindow(f.bridge, 1234), {
    hwndHex: '1A2B',
    title: 'Fixture',
  });
  assert.deepEqual(f.calls, [{ op: 'resolveWindow', pid: 1234 }]);
});

test('Windows UIA backend exposes bounded semantic nodes and semantic effects only', async () => {
  const f = bridgeFixture();
  const backend = createWindowsUiaDesktopBackend({ bridge: f.bridge });
  const session = await backend.open({
    targetId: 'target_fixture',
    pid: 1234,
    processInstanceId: 'created:fixture',
    executablePath: 'C:\\fixture.exe',
    nativeWindowId: 'hwnd:1A2B',
    title: 'Fixture',
  });

  const nodes = await session.snapshot();
  assert.deepEqual(nodes.map((node) => [node.name, node.role, node.value, node.patterns]), [
    ['Input', 'edit', 'alpha', ['Value']],
    ['Apply', 'button', undefined, ['Invoke']],
  ]);

  await session.setValue(nodes[0]!.backendElementId, 'beta');
  await session.invoke(nodes[1]!.backendElementId);
  await session.toggle('uia:1,2,5');
  await session.select('uia:1,2,6');

  assert.deepEqual(f.calls, [
    { op: 'snapshot', hwndHex: '1A2B' },
    { op: 'setValue', hwndHex: '1A2B', backendElementId: 'uia:1,2,3', value: 'beta' },
    { op: 'invoke', hwndHex: '1A2B', backendElementId: 'uia:1,2,4' },
    { op: 'toggle', hwndHex: '1A2B', backendElementId: 'uia:1,2,5' },
    { op: 'select', hwndHex: '1A2B', backendElementId: 'uia:1,2,6' },
  ]);
  assert.deepEqual(await session.screenshot(), {
    mimeType: 'image/png',
    dataBase64: 'iVBORw0KGgo=',
  });
});

test('Windows UIA backend rejects malformed bridge identities and screenshots', async () => {
  const invalidWindow: WindowsUiaBridgeClient = {
    async request() { return { hwndHex: '../bad', title: 'bad' }; },
  };
  await assert.rejects(
    () => resolveWindowsDesktopWindow(invalidWindow, 1),
    /invalid hwnd/,
  );

  const invalidSnapshot: WindowsUiaBridgeClient = {
    async request(value) {
      if (value.op === 'snapshot') {
        return {
          nodes: [{
            backendElementId: 'screen:10,20',
            role: 'button',
            name: 'Bad',
            enabled: true,
            patterns: ['Invoke'],
          }],
        };
      }
      return { mimeType: 'image/jpeg', dataBase64: 'bad' };
    },
  };
  const session = await createWindowsUiaDesktopBackend({ bridge: invalidSnapshot }).open({
    targetId: 'target_fixture',
    pid: 1,
    processInstanceId: 'created:fixture',
    executablePath: 'C:\\fixture.exe',
    nativeWindowId: 'hwnd:1',
    title: 'Fixture',
  });
  await assert.rejects(() => session.snapshot(), /invalid element identity/);
  await assert.rejects(() => session.screenshot(), /invalid screenshot/);
});
