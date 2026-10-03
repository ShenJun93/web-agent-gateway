import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseExistingBrowserControlEvent,
  parseExistingBrowserControlRequest,
  parseExistingBrowserControlResponse,
  parseExistingBrowserTarget,
} from '../src/browser-adapter/existing-browser-control-protocol.js';

const ID = 'bctl_00000000-0000-4000-8000-000000000001';

test('existing browser control protocol accepts bounded target and semantic transport requests', () => {
  assert.equal(parseExistingBrowserControlRequest({
    version: 1, type: 'control.request', requestId: ID, method: 'targets.list',
  }).method, 'targets.list');
  assert.equal(parseExistingBrowserControlRequest({
    version: 1, type: 'control.request', requestId: ID, method: 'target.create',
  }).method, 'target.create');
  assert.equal(parseExistingBrowserControlRequest({
    version: 1, type: 'control.request', requestId: ID, method: 'target.close', targetId: 'tab_7',
  }).method, 'target.close');

  const grouped = parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.group',
    targetId: 'tab_7',
    groupTitle: 'WAG • Acceptance',
  });
  assert.equal(grouped.groupTitle, 'WAG • Acceptance');

  const watch = parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.watch',
    targetId: 'tab_7',
  });
  assert.equal(watch.targetId, 'tab_7');

  const continuity = parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.continuity',
    targetId: 'tab_7',
    currentTargetId: 'tab_8',
  });
  assert.equal(continuity.currentTargetId, 'tab_8');

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

  const downloadBehavior = parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Browser.setDownloadBehavior',
    params: { behavior: 'allowAndName', downloadPath: 'C:\\WAG\\capture', eventsEnabled: true },
  });
  assert.equal(downloadBehavior.cdpMethod, 'Browser.setDownloadBehavior');

  const notificationPermission = parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Browser.setPermission',
    params: {
      permission: { name: 'notifications' },
      setting: 'granted',
      origin: 'https://example.test',
    },
  });
  assert.equal(notificationPermission.cdpMethod, 'Browser.setPermission');

  const cameraDenied = parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Browser.setPermission',
    params: {
      permission: { name: 'camera' },
      setting: 'denied',
      origin: 'https://example.test',
    },
  });
  assert.equal(cameraDenied.cdpMethod, 'Browser.setPermission');

  const event = parseExistingBrowserControlEvent({
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Browser.downloadWillBegin',
    params: { guid: 'download-1', url: 'https://example.test/report.pdf', suggestedFilename: 'report.pdf' },
  });
  assert.equal(event.targetId, 'tab_7');
  assert.equal(event.method, 'Browser.downloadWillBegin');

  const dialogResponse = parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Page.handleJavaScriptDialog',
    params: { accept: true, promptText: 'approved' },
  });
  assert.equal(dialogResponse.cdpMethod, 'Page.handleJavaScriptDialog');

  const dialogOpening = parseExistingBrowserControlEvent({
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Page.javascriptDialogOpening',
    params: {
      url: 'https://example.test/',
      message: 'Continue?',
      type: 'confirm',
      defaultPrompt: '',
    },
  });
  assert.equal(dialogOpening.method, 'Page.javascriptDialogOpening');

  const dialogClosed = parseExistingBrowserControlEvent({
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Page.javascriptDialogClosed',
    params: { result: true },
  });
  assert.equal(dialogClosed.method, 'Page.javascriptDialogClosed');

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
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Browser.setDownloadBehavior',
    params: { behavior: 'allow', downloadPath: 'C:\\WAG\\capture', eventsEnabled: true },
  }), /download behavior/);

  assert.throws(() => parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Browser.setPermission',
    params: { permission: { name: 'camera' }, setting: 'granted', origin: 'https://example.test' },
  }), /permission params/);

  assert.throws(() => parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Browser.setPermission',
    params: { permission: { name: 'notifications' }, setting: 'granted', origin: 'https://example.test/path?token=secret' },
  }), /permission params/);

  assert.throws(() => parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Browser.setPermission',
    params: { permission: { name: 'notifications', extra: true }, setting: 'granted', origin: 'https://example.test' },
  }), /Unexpected/);

  assert.throws(() => parseExistingBrowserControlEvent({
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Runtime.consoleAPICalled',
    params: {},
  }), /control event method/);

  assert.throws(() => parseExistingBrowserControlEvent({
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Browser.downloadWillBegin',
    params: { guid: 'download-1', url: 'https://example.test/report.pdf?token=secret', suggestedFilename: 'report.pdf' },
  }), /download begin event/);

  assert.throws(() => parseExistingBrowserControlEvent({
    version: 1,
    type: 'control.event',
    targetId: 'tab_7',
    method: 'Page.javascriptDialogOpening',
    params: {
      url: 'https://example.test/?token=secret',
      message: 'Continue?',
      type: 'confirm',
      defaultPrompt: '',
    },
  }), /dialog opening event/);

  assert.throws(() => parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.exec',
    targetId: 'tab_7',
    cdpMethod: 'Page.handleJavaScriptDialog',
    params: { accept: 'yes' },
  }), /dialog response params/);

  assert.throws(() => parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.attach',
    targetId: '7',
  }), /target id/);

  assert.throws(() => parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.continuity',
    targetId: 'tab_7',
    currentTargetId: '7',
  }), /current target id/);

  assert.throws(() => parseExistingBrowserControlRequest({
    version: 1,
    type: 'control.request',
    requestId: ID,
    method: 'target.group',
    targetId: 'tab_7',
    groupTitle: 'x'.repeat(65),
  }), /group title/);

  assert.throws(() => parseExistingBrowserControlResponse({
    version: 1, type: 'control.result', requestId: ID, result: {}, extra: true,
  }), /Unexpected/);
});
