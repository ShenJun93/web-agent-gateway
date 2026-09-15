import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCorrelationStore } from '../browser/extension/service-worker-core.js';

class FakeSessionStorage {
  readonly values = new Map<string, string>();
  async get(key: string) { return { [key]: this.values.get(key) }; }
  async set(entries: Record<string, string>) {
    for (const [key, value] of Object.entries(entries)) this.values.set(key, value);
  }
  async remove(key: string) { this.values.delete(key); }
}

function ids() {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
}

test('session correlation survives service-worker object recreation for a live tab', async () => {
  const storage = new FakeSessionStorage();
  const first = createSessionCorrelationStore(storage, ids());
  const correlation = await first.forTab(17);
  const recreated = createSessionCorrelationStore(storage, ids());
  assert.equal(await recreated.forTab(17), correlation);
  assert.match(correlation, /^session_[0-9a-f-]{36}$/);
});

test('tab removal deletes only that tab correlation', async () => {
  const storage = new FakeSessionStorage();
  const store = createSessionCorrelationStore(storage, ids());
  const first = await store.forTab(3);
  const second = await store.forTab(4);
  await store.removeTab(3);
  assert.equal(storage.values.has('wag.session.tab.3'), false);
  assert.equal(storage.values.get('wag.session.tab.4'), second);
  assert.notEqual(await store.forTab(3), first);
});

test('empty session storage mints a fresh correlation and never uses tab id as authority value', async () => {
  const storage = new FakeSessionStorage();
  const store = createSessionCorrelationStore(storage, ids());
  const value = await store.forTab(99);
  assert.match(value, /^session_/);
  assert.doesNotMatch(value, /99/);
  assert.deepEqual([...storage.values.keys()], ['wag.session.tab.99']);
  assert.equal(storage.values.get('wag.session.tab.99'), value);
});

test('provider messages cannot supply correlation or storage identity', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../browser/extension/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /createSessionCorrelationStore\(chrome\.storage\.session/);
  assert.match(source, /sessionCorrelations\.forTab\(tabId\)/);
  assert.match(source, /return true;/);
  assert.match(source, /chrome\.tabs\.onRemoved\.addListener/);
  assert.doesNotMatch(source, /sessionsByTab/);
  assert.doesNotMatch(source, /message\.(?:sessionId|correlationId|correlation_id|storageKey|storage_key)/);
});
