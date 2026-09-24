import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import type { BrowserPort } from '../src/browser-harness/browser-port.js';
import { createSemanticBrowser } from '../src/browser-harness/semantic-browser.js';

const OWNER: GatewayAuthority = { ownerId: 'owner', sessionId: 'session', adapterId: 'private.stdio.v1' };
const SESSION = 'browser_00000000-0000-4000-8000-000000000099';

function fixture() {
  const calls: Array<{ method: string; params?: Readonly<Record<string, unknown>> }> = [];
  let snapshots = 0;
  const port: BrowserPort = {
    async open() { throw new Error('not used'); },
    async describe() { throw new Error('not used'); },
    async snapshot() {
      snapshots += 1;
      return {
        browserSessionId: SESSION,
        url: snapshots === 1 ? 'https://example.test/' : 'https://example.test/changed',
        title: 'Example',
        targetId: 'target',
        observedAt: snapshots,
      };
    },
    async exec(_owner, _session, request) {
      calls.push(request);
      if (request.method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Submit' },
              backendDOMNodeId: 42,
              properties: [{ name: 'focusable', value: { value: true } }],
            },
            {
              ignored: false,
              role: { value: 'textbox' },
              name: { value: 'Question' },
              backendDOMNodeId: 43,
              properties: [
                { name: 'focusable', value: { value: true } },
                { name: 'editable', value: { value: true } },
              ],
            },
            { ignored: true, role: { value: 'generic' }, backendDOMNodeId: 44 },
          ],
        };
      }
      if (request.method === 'DOM.getBoxModel') {
        return { model: { border: [10, 20, 30, 20, 30, 40, 10, 40] } };
      }
      return {};
    },
    async screenshot() { throw new Error('not used'); },
    async close() { throw new Error('not used'); },
  };
  let id = 1;
  const semantic = createSemanticBrowser({
    port,
    randomUUID: () => `00000000-0000-4000-8000-00000000010${id++}`,
  });
  return { semantic, calls };
}

test('semantic snapshot produces opaque refs from accessible DOM-backed nodes only', async () => {
  const f = fixture();
  const snapshot = await f.semantic.snapshot(OWNER, SESSION);
  assert.equal(snapshot.nodes.length, 2);
  assert.deepEqual(snapshot.nodes.map((node) => ({ role: node.role, name: node.name, editable: node.editable })), [
    { role: 'button', name: 'Submit', editable: false },
    { role: 'textbox', name: 'Question', editable: true },
  ]);
  assert.match(snapshot.nodes[0]!.ref, /^node_00000000-0000-4000-8000-000000000101_0$/);
});

test('semantic click uses backend DOM identity and pointer input rather than screen coordinates from the caller', async () => {
  const f = fixture();
  const snapshot = await f.semantic.snapshot(OWNER, SESSION);
  f.calls.length = 0;
  await f.semantic.click(OWNER, SESSION, snapshot.nodes[0]!.ref);
  assert.deepEqual(f.calls, [
    { method: 'DOM.scrollIntoViewIfNeeded', params: { backendNodeId: 42 } },
    { method: 'DOM.getBoxModel', params: { backendNodeId: 42 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 20, y: 30 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 20, y: 30, button: 'left', clickCount: 1 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 20, y: 30, button: 'left', clickCount: 1 } },
  ]);
});

test('semantic fill focuses the exact DOM node, selects existing text and inserts bounded text', async () => {
  const f = fixture();
  const snapshot = await f.semantic.snapshot(OWNER, SESSION);
  f.calls.length = 0;
  await f.semantic.fill(OWNER, SESSION, snapshot.nodes[1]!.ref, 'hello');
  assert.deepEqual(f.calls, [
    { method: 'DOM.focus', params: { backendNodeId: 43 } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2 } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 } },
    { method: 'Input.insertText', params: { text: 'hello' } },
  ]);
  await assert.rejects(() => f.semantic.fill(OWNER, SESSION, snapshot.nodes[0]!.ref, 'x'), /not editable/);
});

test('semantic refs fail closed after a new snapshot or navigation', async () => {
  const f = fixture();
  const first = await f.semantic.snapshot(OWNER, SESSION);
  await f.semantic.snapshot(OWNER, SESSION);
  await assert.rejects(() => f.semantic.click(OWNER, SESSION, first.nodes[0]!.ref), /stale or unknown/);

  const second = await f.semantic.snapshot(OWNER, SESSION);
  await f.semantic.navigate(OWNER, SESSION, 'https://example.test/next');
  await assert.rejects(() => f.semantic.click(OWNER, SESSION, second.nodes[0]!.ref), /stale or unknown/);
  assert.deepEqual(f.calls.at(-1), {
    method: 'Page.navigate',
    params: { url: 'https://example.test/next' },
  });
});

test('semantic navigation and key input reject unsupported schemes and keys', async () => {
  const f = fixture();
  await assert.rejects(() => f.semantic.navigate(OWNER, SESSION, 'file:///C:/secret.txt'), /scheme is denied/);
  await assert.rejects(() => f.semantic.press(OWNER, SESSION, 'F12'), /not supported/);
  await f.semantic.press(OWNER, SESSION, 'Enter');
  assert.deepEqual(f.calls.slice(-2), [
    { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'Enter', code: 'Enter' } },
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter', code: 'Enter' } },
  ]);
});

test('semantic file selection accepts only bounded internal absolute paths and current refs', async () => {
  const f = fixture();
  const snapshot = await f.semantic.snapshot(OWNER, SESSION);
  f.calls.length = 0;
  await f.semantic.setFiles(OWNER, SESSION, snapshot.nodes[0]!.ref, [
    'E:\\WAG-Artifacts\\artifact_a\\a.txt',
    'E:\\WAG-Artifacts\\artifact_b\\b.txt',
  ]);
  assert.deepEqual(f.calls, [{
    method: 'DOM.setFileInputFiles',
    params: {
      files: [
        'E:\\WAG-Artifacts\\artifact_a\\a.txt',
        'E:\\WAG-Artifacts\\artifact_b\\b.txt',
      ],
      backendNodeId: 42,
    },
  }]);

  await assert.rejects(
    () => f.semantic.setFiles(OWNER, SESSION, snapshot.nodes[0]!.ref, ['relative.txt']),
    /internal path is invalid/,
  );
  await f.semantic.snapshot(OWNER, SESSION);
  await assert.rejects(
    () => f.semantic.setFiles(OWNER, SESSION, snapshot.nodes[0]!.ref, ['E:\\safe.txt']),
    /stale or unknown/,
  );
});
