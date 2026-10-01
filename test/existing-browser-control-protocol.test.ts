import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseExistingBrowserControlRequest,
  parseExistingBrowserControlResponse,
  parseExistingBrowserTarget,
} from '../src/browser-adapter/existing-browser-control-protocol.js';

const ID = 'bctl_00000000-0000-4000-8000-000000000001';

test('existing browser control protocol accepts bounded target and semantic transport requests', () => {
  assert.equal(parseExistingBrowserControlRequest({
    version: 1, type: 'control.request', requestId: ID, method: 'targets.list',
  }).method, 'targets.list');

  const exec = parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'DOM.focus',
    params: { backendNodeId: 9 },
  });
  assert.equal(exec.targetId, 'tab_7');
  assert.equal(exec.cdpMethod, 'DOM.focus');

  assert.equal(parseExistingBrowserTarget({
    targetId: 'tab_7',
    windowId: 'window_3',
    title: 'Authenticated',
    url: 'https://example.test/',
    origin: 'https://example.test',
    active: false,
    attachable: true,
    ownership: 'USER_EXISTING',
    attached: false,
  }).ownership, 'USER_EXISTING');

  assert.equal(parseExistingBrowserControlResponse({
    version: 1, type: 'control.result', requestId: ID, result: { ok: true },
  }).type, 'control.result');
});

test('existing browser control protocol denies raw CDP and malformed target identities', () => {
  assert.throws(() => parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Runtime.evaluate',
    params: { expression: 'document.cookie' },
  }), /denied/);

  assert.throws(() => parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.attach',
    targetId: '7',
  }), /target id/);

  assert.throws(() => parseExistingBrowserControlResponse({
    version: 1, type: 'control.result', requestId: ID, result: {}, extra: true,
  }), /Unexpected/);
});
