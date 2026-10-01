import assert from 'node:assert/strict';
import test from 'node:test';

import { createExistingBrowserControlV1 } from '../browser/extension/existing-browser-control-v1.js';

class FakeEvent<T extends (...args: any[]) => void> {
  listeners: T[] = [];
  addListener(listener: T) { this.listeners.push(listener); }
  emit(...args: Parameters<T>) { for (const listener of this.listeners) listener(...args); }
}

function fixture() {
  const created = new FakeEvent<(tab: any) => void>();
  const updated = new FakeEvent<(tabId: number, changeInfo: any, tab: any) => void>();
  const tabs = [
    {
      id: 11,
      windowId: 5,
      title: 'App',
      url: 'https://app.example.test/start',
      active: false,
    },
    {
      id: 12,
      windowId: 5,
      title: 'User active',
      url: 'https://user.example.test/',
      active: true,
    },
  ];

  const chromeApi = {
    tabs: {
      async query() { return tabs; },
      async get(tabId: number) {
        const tab = tabs.find((row) => row.id === tabId);
        if (!tab) throw new Error('No tab');
        return tab;
      },
      onCreated: created,
      onUpdated: updated,
    },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand() { return {}; },
      onDetach: { addListener() {} },
    },
  };

  return {
    tabs,
    created,
    updated,
    control: createExistingBrowserControlV1(chromeApi),
  };
}

test('OAuth continuity selects only successor tabs descended from the watched root', async () => {
  const f = fixture();
  await f.control.watchContinuity(11);

  const unrelated = {
    id: 20,
    windowId: 8,
    title: 'Unrelated',
    url: 'https://unrelated.example.test/',
    active: false,
  };
  f.tabs.push(unrelated);
  f.created.emit(unrelated);

  const oauth = {
    id: 13,
    windowId: 7,
    openerTabId: 11,
    title: 'OAuth',
    url: 'https://auth.example.test/authorize?secret=hidden',
    active: false,
  };
  f.tabs.push(oauth);
  f.created.emit(oauth);

  const callback = {
    id: 14,
    windowId: 7,
    openerTabId: 13,
    title: 'Callback',
    url: 'https://app.example.test/callback?code=secret',
    active: false,
  };
  f.tabs.push(callback);
  f.created.emit(callback);

  const resolved = await f.control.resolveContinuity(11, 11);
  assert.equal(resolved.reason, 'SUCCESSOR');
  assert.equal(resolved.target?.tabId, 14);
  assert.equal(resolved.target?.url, 'https://app.example.test/callback');
  assert.equal(JSON.stringify(resolved).includes('secret'), false);
});

test('OAuth continuity observes same-tab redirects without inventing a new target', async () => {
  const f = fixture();
  await f.control.watchContinuity(11);

  const root = f.tabs.find((row) => row.id === 11)!;
  root.url = 'https://auth.example.test/authorize?state=secret';
  root.title = 'OAuth redirect';
  f.updated.emit(11, { url: root.url }, root);

  const resolved = await f.control.resolveContinuity(11, 11);
  assert.equal(resolved.reason, 'ROOT_UPDATED');
  assert.equal(resolved.target?.tabId, 11);
  assert.equal(resolved.target?.url, 'https://auth.example.test/authorize');
});

test('OAuth continuity can return to the root when a successor disappears', async () => {
  const f = fixture();
  await f.control.watchContinuity(11);

  const oauth = {
    id: 13,
    windowId: 7,
    openerTabId: 11,
    title: 'OAuth',
    url: 'https://auth.example.test/',
    active: false,
  };
  f.tabs.push(oauth);
  f.created.emit(oauth);
  assert.equal((await f.control.resolveContinuity(11, 11)).target?.tabId, 13);

  f.tabs.splice(f.tabs.findIndex((row) => row.id === 13), 1);
  const returned = await f.control.resolveContinuity(11, 13);
  assert.equal(returned.reason, 'CURRENT_GONE');
  assert.equal(returned.target?.tabId, 11);
});
