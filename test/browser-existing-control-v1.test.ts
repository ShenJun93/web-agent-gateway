import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExistingBrowserControlError,
  createExistingBrowserControlV1,
  describeExistingBrowserTab,
} from '../browser/extension/existing-browser-control-v1.js';
import { FIXED_MEDIA_INSPECT_FUNCTION } from '../src/browser-harness/semantic-browser.js';

function fixture() {
  const tabs = [
    {
      id: 11,
      windowId: 5,
      title: 'Signed-in app',
      url: 'https://app.example.test/account?token=secret#fragment',
      active: false,
    },
    {
      id: 12,
      windowId: 5,
      title: 'Internal',
      url: 'edge://settings/',
      active: true,
    },
  ];
  const calls: unknown[][] = [];
  let detachListener: ((source: { tabId?: number }) => void) | undefined;
  let debuggerEventListener: ((source: { tabId?: number }, method: string, params: Record<string, unknown>) => void) | undefined;
  const chromeApi = {
    tabs: {
      async query(queryInfo: Record<string, unknown>) {
        calls.push(['query', queryInfo]);
        if (queryInfo.active === true && queryInfo.windowId === 5) {
          return tabs.filter((row) => row.active);
        }
        return tabs;
      },
      async get(tabId: number) {
        calls.push(['get', tabId]);
        const tab = tabs.find((row) => row.id === tabId);
        if (!tab) throw new Error('No tab');
        return tab;
      },
      async create(options: { url: string; active: boolean }) {
        calls.push(['create', options]);
        const tab = { id: 13, windowId: 5, title: 'New tab', url: options.url, active: options.active };
        tabs.push(tab);
        // Edge may resolve tabs.create() before url metadata is populated.
        return { id: tab.id, windowId: tab.windowId, title: tab.title, active: tab.active };
      },
      async remove(tabId: number) {
        calls.push(['remove', tabId]);
        const index = tabs.findIndex((row) => row.id === tabId);
        if (index >= 0) tabs.splice(index, 1);
      },
      async group(options: { tabIds: number[] }) {
        calls.push(['group', options]);
        return 9;
      },
    },
    tabGroups: {
      async update(groupId: number, options: Record<string, unknown>) {
        calls.push(['group.update', groupId, options]);
        return { id: groupId, ...options };
      },
    },
    debugger: {
      async attach(target: { tabId: number }, version: string) {
        calls.push(['attach', target, version]);
      },
      async detach(target: { tabId: number }) {
        calls.push(['detach', target]);
      },
      async sendCommand(target: { tabId: number }, method: string, params?: Record<string, unknown>) {
        calls.push(params === undefined ? ['sendCommand', target, method] : ['sendCommand', target, method, params]);
        return {
          frameTree: {
            frame: {
              url: 'https://app.example.test/account?oauth=secret#done',
            },
          },
        };
      },
      onDetach: {
        addListener(listener: (source: { tabId?: number }) => void) {
          detachListener = listener;
        },
      },
      onEvent: {
        addListener(listener: (source: { tabId?: number }, method: string, params: Record<string, unknown>) => void) {
          debuggerEventListener = listener;
        },
      },
    },
  };
  return {
    chromeApi,
    calls,
    detach: (tabId: number) => detachListener?.({ tabId }),
    debuggerEvent: (tabId: number, method: string, params: Record<string, unknown>) =>
      debuggerEventListener?.({ tabId }, method, params),
  };
}

test('existing-browser discovery is focus-free and strips query/hash secrets', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);
  const targets = await control.listTargets();

  assert.deepEqual(f.calls, [['query', {}]]);
  assert.deepEqual(targets[0], {
    tabId: 11,
    windowId: 5,
    title: 'Signed-in app',
    url: 'https://app.example.test/account',
    origin: 'https://app.example.test',
    active: false,
    attachable: true,
    ownership: 'USER_EXISTING',
  });
  assert.equal(targets[1]?.attachable, false);
  assert.equal(targets[1]?.url, null);
  assert.equal(JSON.stringify(targets).includes('token=secret'), false);
});

test('AI-owned target creation is inactive and close removes only that created tab', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);

  const created = await control.create();
  assert.equal(created.tabId, 13);
  assert.equal(created.active, false);
  assert.equal(created.attachable, true);
  assert.deepEqual(f.calls[0], ['create', { url: 'about:blank', active: false }]);

  const closed = await control.close(13);
  assert.deepEqual(closed, { tabId: 13, closed: true });
  assert.deepEqual(f.calls.at(-1), ['remove', 13]);

  const replay = await control.close(13);
  assert.deepEqual(replay, { tabId: 13, closed: false });
});

test('AI tab grouping keeps the user active tab stable and never activates the agent target', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);

  const grouped = await control.group(11, 'WAG • Acceptance');
  assert.deepEqual(grouped, {
    tabId: 11,
    groupId: 9,
    groupTitle: 'WAG • Acceptance',
    activeStable: true,
  });
  assert.deepEqual(f.calls, [
    ['get', 11],
    ['query', { active: true, windowId: 5 }],
    ['group', { tabIds: [11] }],
    ['group.update', 9, { title: 'WAG • Acceptance', color: 'cyan', collapsed: false }],
    ['query', { active: true, windowId: 5 }],
  ]);
  assert.equal(f.calls.some((row) => row[0] === 'update' || row[0] === 'windows.update'), false);
});

test('attach/probe/release targets an exact tab without focus or browser-close operations', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);

  const attached = await control.attach(11);
  assert.equal(attached.state, 'ATTACHED');
  assert.equal(control.isAttached(11), true);

  const probe = await control.probe(11);
  assert.deepEqual(probe, {
    tabId: 11,
    attached: true,
    origin: 'https://app.example.test',
    url: 'https://app.example.test/account',
  });

  const released = await control.release(11);
  assert.deepEqual(released, { tabId: 11, released: true });
  assert.equal(control.isAttached(11), false);
  assert.deepEqual(f.calls, [
    ['get', 11],
    ['attach', { tabId: 11 }, '1.3'],
    ['sendCommand', { tabId: 11 }, 'Page.enable'],
    ['sendCommand', { tabId: 11 }, 'Page.getFrameTree'],
    ['detach', { tabId: 11 }],
  ]);
});

test('download control is bounded and forwards only sanitized events for an attached tab', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);
  await control.attach(11);
  const events: unknown[] = [];
  const unsubscribe = control.onControlEvent((event) => events.push(event));

  await control.exec(11, 'Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: 'C:\\WAG\\capture',
    eventsEnabled: true,
  });
  assert.deepEqual(f.calls.at(-1), [
    'sendCommand',
    { tabId: 11 },
    'Browser.setDownloadBehavior',
    { behavior: 'allowAndName', downloadPath: 'C:\\WAG\\capture', eventsEnabled: true },
  ]);

  f.debuggerEvent(11, 'Runtime.consoleAPICalled', { type: 'log' });
  f.debuggerEvent(12, 'Browser.downloadWillBegin', {
    guid: 'ignored', url: 'https://example.test/ignored', suggestedFilename: 'ignored.bin',
  });
  assert.deepEqual(events, []);

  f.debuggerEvent(11, 'Browser.downloadWillBegin', {
    frameId: 'frame-secret',
    guid: 'download-1',
    url: 'https://example.test/report.pdf?signature=secret#fragment',
    suggestedFilename: 'report.pdf',
  });
  f.debuggerEvent(11, 'Browser.downloadProgress', {
    guid: 'download-1',
    state: 'completed',
    receivedBytes: 999,
    filePath: 'C:\\untrusted\\report.pdf',
  });
  assert.deepEqual(events, [
    {
      tabId: 11,
      method: 'Browser.downloadWillBegin',
      params: { guid: 'download-1', url: 'https://example.test/report.pdf', suggestedFilename: 'report.pdf' },
    },
    {
      tabId: 11,
      method: 'Browser.downloadProgress',
      params: { guid: 'download-1', state: 'completed' },
    },
  ]);

  await assert.rejects(
    () => control.exec(11, 'Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: 'C:\\WAG\\capture', eventsEnabled: true,
    }),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'CONTROL_PARAMS_INVALID',
  );
  unsubscribe();
});

test('external debugger detach invalidates local attachment state', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);
  await control.attach(11);
  f.detach(11);
  assert.equal(control.isAttached(11), false);
  await assert.rejects(
    () => control.probe(11),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'TARGET_NOT_ATTACHED',
  );
});

test('non-web and missing targets fail closed before debugger attach', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);

  await assert.rejects(
    () => control.attach(12),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'TARGET_NOT_ATTACHABLE',
  );
  await assert.rejects(
    () => control.attach(999),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'TARGET_NOT_FOUND',
  );
  assert.equal(f.calls.some((row) => row[0] === 'attach'), false);
});

test('attach failures become structured bounded error classes', async () => {
  const f = fixture();
  f.chromeApi.debugger.attach = async () => {
    throw new Error('Another debugger is already attached to the tab');
  };
  const control = createExistingBrowserControlV1(f.chromeApi);

  await assert.rejects(
    () => control.attach(11),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'DEBUGGER_ALREADY_ATTACHED'
      && !error.message.includes('tab 11'),
  );
});

test('tab description bounds title and never returns credentials or query strings', () => {
  const row = describeExistingBrowserTab({
    id: 7,
    windowId: 2,
    active: true,
    title: 'x'.repeat(500),
    url: 'https://user:pass@example.test/path?q=secret#frag',
  });
  assert.equal(row.title.length, 256);
  assert.equal(row.url, 'https://example.test/path');
  assert.equal(row.origin, 'https://example.test');
  assert.equal(JSON.stringify(row).includes('user'), false);
  assert.equal(JSON.stringify(row).includes('pass'), false);
  assert.equal(JSON.stringify(row).includes('secret'), false);
});

test('fixed DOM click command is allowed but arbitrary Runtime.callFunctionOn is denied', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);
  await control.attach(11);

  await assert.rejects(
    () => control.exec(11, 'Runtime.callFunctionOn', {
      objectId: 'object_42',
      functionDeclaration: 'function(){return document.cookie}',
      returnByValue: true,
    }),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'CONTROL_PARAMS_INVALID',
  );

  await control.exec(11, 'Runtime.callFunctionOn', {
    objectId: 'object_42',
    functionDeclaration: 'function(){if(typeof this.click==="function"){this.click();return true;}return false;}',
    returnByValue: true,
    userGesture: true,
  });

  assert.equal(
    f.calls.some((row) => row[0] === 'sendCommand' && row[2] === 'Runtime.callFunctionOn'),
    true,
  );
});

test('fixed native-value fill function accepts one bounded string and rejects parameter widening', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);
  await control.attach(11);

  await control.exec(11, 'Runtime.callFunctionOn', {
    objectId: 'object_43',
    functionDeclaration: "function(value){let proto=null;if(this instanceof HTMLInputElement)proto=HTMLInputElement.prototype;else if(this instanceof HTMLTextAreaElement)proto=HTMLTextAreaElement.prototype;else return {supported:false,value:null};const descriptor=Object.getOwnPropertyDescriptor(proto,\"value\");if(!descriptor||typeof descriptor.set!==\"function\")return {supported:false,value:null};descriptor.set.call(this,value);this.dispatchEvent(new Event(\"input\",{bubbles:true}));this.dispatchEvent(new Event(\"change\",{bubbles:true}));return {supported:true,value:this.value};}",
    arguments: [{ value: 'hello' }],
    returnByValue: true,
  });

  await assert.rejects(
    () => control.exec(11, 'Runtime.callFunctionOn', {
      objectId: 'object_43',
      functionDeclaration: "function(value){let proto=null;if(this instanceof HTMLInputElement)proto=HTMLInputElement.prototype;else if(this instanceof HTMLTextAreaElement)proto=HTMLTextAreaElement.prototype;else return {supported:false,value:null};const descriptor=Object.getOwnPropertyDescriptor(proto,\"value\");if(!descriptor||typeof descriptor.set!==\"function\")return {supported:false,value:null};descriptor.set.call(this,value);this.dispatchEvent(new Event(\"input\",{bubbles:true}));this.dispatchEvent(new Event(\"change\",{bubbles:true}));return {supported:true,value:this.value};}",
      arguments: [{ value: 'bad\0text' }],
      returnByValue: true,
    }),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'CONTROL_PARAMS_INVALID',
  );

  await assert.rejects(
    () => control.exec(11, 'Runtime.callFunctionOn', {
      objectId: 'object_43',
      functionDeclaration: "function(value){let proto=null;if(this instanceof HTMLInputElement)proto=HTMLInputElement.prototype;else if(this instanceof HTMLTextAreaElement)proto=HTMLTextAreaElement.prototype;else return {supported:false,value:null};const descriptor=Object.getOwnPropertyDescriptor(proto,\"value\");if(!descriptor||typeof descriptor.set!==\"function\")return {supported:false,value:null};descriptor.set.call(this,value);this.dispatchEvent(new Event(\"input\",{bubbles:true}));this.dispatchEvent(new Event(\"change\",{bubbles:true}));return {supported:true,value:this.value};}",
      arguments: [{ value: 'hello', extra: true }],
      returnByValue: true,
    }),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'CONTROL_PARAMS_INVALID',
  );
});

test('fixed contenteditable selection function is exact and cannot be widened', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);
  await control.attach(11);

  const fixed = "function(){if(!(this instanceof HTMLElement)||!this.isContentEditable)return false;this.focus();const selection=this.ownerDocument.getSelection();if(!selection)return false;const range=this.ownerDocument.createRange();range.selectNodeContents(this);selection.removeAllRanges();selection.addRange(range);return true;}";

  await control.exec(11, 'Runtime.callFunctionOn', {
    objectId: 'object_45',
    functionDeclaration: fixed,
    returnByValue: true,
  });

  await assert.rejects(
    () => control.exec(11, 'Runtime.callFunctionOn', {
      objectId: 'object_45',
      functionDeclaration: fixed,
      arguments: [],
      returnByValue: true,
    }),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'CONTROL_PARAMS_INVALID',
  );

  await assert.rejects(
    () => control.exec(11, 'Runtime.callFunctionOn', {
      objectId: 'object_45',
      functionDeclaration: fixed.replace('return true', 'return document.cookie'),
      returnByValue: true,
    }),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'CONTROL_PARAMS_INVALID',
  );
});


test('fixed media inspection function is exact and parameter-widening is denied', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);
  await control.attach(11);

  await control.exec(11, 'Runtime.callFunctionOn', {
    objectId: 'object_46',
    functionDeclaration: FIXED_MEDIA_INSPECT_FUNCTION,
    returnByValue: true,
  });

  await assert.rejects(
    () => control.exec(11, 'Runtime.callFunctionOn', {
      objectId: 'object_46',
      functionDeclaration: FIXED_MEDIA_INSPECT_FUNCTION,
      arguments: [],
      returnByValue: true,
    }),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'CONTROL_PARAMS_INVALID',
  );

  await assert.rejects(
    () => control.exec(11, 'Runtime.callFunctionOn', {
      objectId: 'object_46',
      functionDeclaration: FIXED_MEDIA_INSPECT_FUNCTION.replace('supported:true', 'supported:true,leak:document.cookie'),
      returnByValue: true,
    }),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'CONTROL_PARAMS_INVALID',
  );
});


test('javascript dialog events are sanitized and response command is strictly bounded', async () => {
  const f = fixture();
  const control = createExistingBrowserControlV1(f.chromeApi);
  await control.attach(11);
  const events: unknown[] = [];
  const unsubscribe = control.onControlEvent((event) => events.push(event));

  f.debuggerEvent(12, 'Page.javascriptDialogOpening', {
    url: 'https://ignored.example.test/?token=secret',
    message: 'Ignored',
    type: 'confirm',
    defaultPrompt: '',
  });
  f.debuggerEvent(11, 'Runtime.consoleAPICalled', { type: 'log' });
  assert.deepEqual(events, []);

  f.debuggerEvent(11, 'Page.javascriptDialogOpening', {
    url: 'https://user:pass@app.example.test/account?token=secret#fragment',
    message: 'Continue?',
    type: 'confirm',
    defaultPrompt: '',
    hasBrowserHandler: true,
  });
  assert.deepEqual(events, [{
    tabId: 11,
    method: 'Page.javascriptDialogOpening',
    params: {
      url: 'https://app.example.test/account',
      message: 'Continue?',
      type: 'confirm',
      defaultPrompt: '',
    },
  }]);

  await control.exec(11, 'Page.handleJavaScriptDialog', { accept: false });
  assert.deepEqual(f.calls.at(-1), [
    'sendCommand',
    { tabId: 11 },
    'Page.handleJavaScriptDialog',
    { accept: false },
  ]);

  await assert.rejects(
    () => control.exec(11, 'Page.handleJavaScriptDialog', {
      accept: true,
      promptText: 'x'.repeat(5000),
    }),
    (error: unknown) => error instanceof ExistingBrowserControlError
      && error.code === 'CONTROL_PARAMS_INVALID',
  );

  f.debuggerEvent(11, 'Page.javascriptDialogClosed', {
    result: false,
    userInput: 'do-not-forward',
  });
  assert.deepEqual(events.at(-1), {
    tabId: 11,
    method: 'Page.javascriptDialogClosed',
    params: { result: false },
  });
  unsubscribe();
});
