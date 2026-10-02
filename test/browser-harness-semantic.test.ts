import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import type { BrowserPort } from '../src/browser-harness/browser-port.js';
import {
  createSemanticBrowser,
  FIXED_MEDIA_INSPECT_FUNCTION,
} from '../src/browser-harness/semantic-browser.js';

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
            {
              ignored: false,
              role: { value: 'generic' },
              name: { value: 'ProseMirror' },
              value: { value: 'pm-old' },
              backendDOMNodeId: 45,
              properties: [
                { name: 'focusable', value: { value: true } },
                { name: 'editable', value: { value: 'richtext' } },
              ],
            },
            {
              ignored: false,
              role: { value: 'video' },
              name: { value: 'Demo video' },
              backendDOMNodeId: 46,
              properties: [{ name: 'focusable', value: { value: true } }],
            },
            { ignored: true, role: { value: 'generic' }, backendDOMNodeId: 44 },
          ],
        };
      }
      if (request.method === 'DOM.resolveNode') {
        const backendNodeId = request.params?.backendNodeId;
        return { object: { objectId: `object_${String(backendNodeId)}` } };
      }
      if (request.method === 'Runtime.callFunctionOn') {
        const args = request.params?.arguments;
        const objectId = request.params?.objectId;
        const declaration = request.params?.functionDeclaration;
        if (Array.isArray(args)) {
          const first = args[0] as { value?: unknown } | undefined;
          return {
            result: {
              value: objectId === 'object_43'
                ? { supported: true, value: first?.value }
                : { supported: false, value: null },
            },
          };
        }
        if (typeof declaration === 'string' && declaration.includes('isContentEditable')) {
          return { result: { value: objectId === 'object_45' } };
        }
        if (declaration === FIXED_MEDIA_INSPECT_FUNCTION) {
          return {
            result: {
              value: objectId === 'object_46'
                ? {
                    supported: true,
                    tag: 'video',
                    paused: false,
                    ended: false,
                    muted: false,
                    volume: 0.8,
                    duration: 12.5,
                    currentTime: 3.25,
                    playbackRate: 1,
                    readyState: 4,
                    networkState: 1,
                    error: null,
                    audioDecodedBytes: 4096,
                    audioTrackCount: null,
                    capturedAudioTrackCount: 1,
                    videoWidth: 1280,
                    videoHeight: 720,
                  }
                : { supported: false },
            },
          };
        }
        return { result: { value: true } };
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
  assert.equal(snapshot.nodes.length, 4);
  assert.deepEqual(snapshot.nodes.map((node) => ({ role: node.role, name: node.name, editable: node.editable })), [
    { role: 'button', name: 'Submit', editable: false },
    { role: 'textbox', name: 'Question', editable: true },
    { role: 'generic', name: 'ProseMirror', editable: true },
    { role: 'video', name: 'Demo video', editable: false },
  ]);
  assert.match(snapshot.nodes[0]!.ref, /^node_00000000-0000-4000-8000-000000000101_0$/);
});

test('semantic click uses fixed in-target DOM activation without OS mouse injection', async () => {
  const f = fixture();
  const snapshot = await f.semantic.snapshot(OWNER, SESSION);
  f.calls.length = 0;
  await f.semantic.click(OWNER, SESSION, snapshot.nodes[0]!.ref);
  assert.deepEqual(f.calls, [
    { method: 'DOM.resolveNode', params: { backendNodeId: 42 } },
    { method: 'Runtime.callFunctionOn', params: {
      objectId: 'object_42',
      functionDeclaration: 'function(){if(typeof this.click==="function"){this.click();return true;}return false;}',
      returnByValue: true,
      userGesture: true,
    } },
    { method: 'Runtime.releaseObject', params: { objectId: 'object_42' } },
  ]);
});

test('semantic fill prefers fixed native-value replacement for framework-safe inputs', async () => {
  const f = fixture();
  const snapshot = await f.semantic.snapshot(OWNER, SESSION);
  f.calls.length = 0;
  await f.semantic.fill(OWNER, SESSION, snapshot.nodes[1]!.ref, 'hello');
  assert.deepEqual(f.calls, [
    { method: 'DOM.resolveNode', params: { backendNodeId: 43 } },
    { method: 'Runtime.callFunctionOn', params: {
      objectId: 'object_43',
      functionDeclaration: "function(value){let proto=null;if(this instanceof HTMLInputElement)proto=HTMLInputElement.prototype;else if(this instanceof HTMLTextAreaElement)proto=HTMLTextAreaElement.prototype;else return {supported:false,value:null};const descriptor=Object.getOwnPropertyDescriptor(proto,\"value\");if(!descriptor||typeof descriptor.set!==\"function\")return {supported:false,value:null};descriptor.set.call(this,value);this.dispatchEvent(new Event(\"input\",{bubbles:true}));this.dispatchEvent(new Event(\"change\",{bubbles:true}));return {supported:true,value:this.value};}",
      arguments: [{ value: 'hello' }],
      returnByValue: true,
    } },
    { method: 'Runtime.releaseObject', params: { objectId: 'object_43' } },
  ]);
  await assert.rejects(() => f.semantic.fill(OWNER, SESSION, snapshot.nodes[0]!.ref, 'x'), /not editable/);
});

test('semantic fill selects rich contenteditable in-target before bounded text insertion', async () => {
  const f = fixture();
  const snapshot = await f.semantic.snapshot(OWNER, SESSION);
  f.calls.length = 0;
  await f.semantic.fill(OWNER, SESSION, snapshot.nodes[2]!.ref, 'pm-new');
  assert.deepEqual(f.calls, [
    { method: 'DOM.resolveNode', params: { backendNodeId: 45 } },
    { method: 'Runtime.callFunctionOn', params: {
      objectId: 'object_45',
      functionDeclaration: "function(value){let proto=null;if(this instanceof HTMLInputElement)proto=HTMLInputElement.prototype;else if(this instanceof HTMLTextAreaElement)proto=HTMLTextAreaElement.prototype;else return {supported:false,value:null};const descriptor=Object.getOwnPropertyDescriptor(proto,\"value\");if(!descriptor||typeof descriptor.set!==\"function\")return {supported:false,value:null};descriptor.set.call(this,value);this.dispatchEvent(new Event(\"input\",{bubbles:true}));this.dispatchEvent(new Event(\"change\",{bubbles:true}));return {supported:true,value:this.value};}",
      arguments: [{ value: 'pm-new' }],
      returnByValue: true,
    } },
    { method: 'Runtime.callFunctionOn', params: {
      objectId: 'object_45',
      functionDeclaration: "function(){if(!(this instanceof HTMLElement)||!this.isContentEditable)return false;this.focus();const selection=this.ownerDocument.getSelection();if(!selection)return false;const range=this.ownerDocument.createRange();range.selectNodeContents(this);selection.removeAllRanges();selection.addRange(range);return true;}",
      returnByValue: true,
    } },
    { method: 'Input.insertText', params: { text: 'pm-new' } },
    { method: 'Runtime.releaseObject', params: { objectId: 'object_45' } },
  ]);
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


test('semantic media inspection uses only the fixed WAG-owned function and returns bounded playback evidence', async () => {
  const f = fixture();
  const snapshot = await f.semantic.snapshot(OWNER, SESSION);
  f.calls.length = 0;
  const media = await f.semantic.inspectMedia(OWNER, SESSION, snapshot.nodes[3]!.ref);

  assert.deepEqual(media, {
    tag: 'video',
    paused: false,
    ended: false,
    muted: false,
    volume: 0.8,
    duration_seconds: 12.5,
    current_time_seconds: 3.25,
    playback_rate: 1,
    ready_state: 4,
    network_state: 1,
    error: null,
    audio_evidence: 'PRESENT',
    audio_decoded_bytes: 4096,
    captured_audio_track_count: 1,
    video_width: 1280,
    video_height: 720,
  });
  assert.deepEqual(f.calls, [
    { method: 'DOM.resolveNode', params: { backendNodeId: 46 } },
    { method: 'Runtime.callFunctionOn', params: {
      objectId: 'object_46',
      functionDeclaration: FIXED_MEDIA_INSPECT_FUNCTION,
      returnByValue: true,
    } },
    { method: 'Runtime.releaseObject', params: { objectId: 'object_46' } },
  ]);
  await assert.rejects(
    () => f.semantic.inspectMedia(OWNER, SESSION, snapshot.nodes[0]!.ref),
    /not a media element/i,
  );
});
