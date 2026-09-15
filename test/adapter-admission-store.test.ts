import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'wag-admission-store-'));
  const path = join(dir, 'state.sqlite');
  return { dir, path, store: new SqliteDurableStore(path) };
}

const adapterId = 'browser.chatgpt.native.v1';
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

test('local principal is minted once per database', async (t) => {
  const { dir, store } = await tempStore();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const first = store.getOrCreateLocalPrincipal(1_000);
  const second = store.getOrCreateLocalPrincipal(2_000);

  assert.match(first.ownerId, /^owner_[0-9a-f-]{36}$/);
  assert.deepEqual(second, first);
  assert.equal(first.createdAt, 1_000);
});

test('adapter session key reuses one WAG session and isolates different correlation', async (t) => {
  const { dir, store } = await tempStore();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const principal = store.getOrCreateLocalPrincipal(1_000);

  const first = store.getOrCreateAdapterSession({
    ownerId: principal.ownerId, adapterId, correlationSha256: digestA, createdAt: 1_000,
  });
  const again = store.getOrCreateAdapterSession({
    ownerId: principal.ownerId, adapterId, correlationSha256: digestA, createdAt: 2_000,
  });
  const other = store.getOrCreateAdapterSession({
    ownerId: principal.ownerId, adapterId, correlationSha256: digestB, createdAt: 3_000,
  });

  assert.match(first.sessionId, /^session_[0-9a-f-]{36}$/);
  assert.deepEqual(again, first);
  assert.equal(first.createdAt, 1_000);
  assert.notEqual(other.sessionId, first.sessionId);
  assert.deepEqual(store.getAdapterSession(first.sessionId), first);
  assert.deepEqual(store.findAdapterSession(principal.ownerId, adapterId, digestA), first);
});

test('principal and adapter session survive SQLite reopen', async (t) => {
  const { dir, path, store } = await tempStore();
  const principal = store.getOrCreateLocalPrincipal(10);
  const session = store.getOrCreateAdapterSession({
    ownerId: principal.ownerId, adapterId, correlationSha256: digestA, createdAt: 20,
  });
  store.close();

  const reopened = new SqliteDurableStore(path);
  t.after(async () => { reopened.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(reopened.getOrCreateLocalPrincipal(999), principal);
  assert.deepEqual(reopened.findAdapterSession(principal.ownerId, adapterId, digestA), session);
});

test('admission schema persists no raw correlation or credential columns', async (t) => {
  const { dir, path, store } = await tempStore();
  const principal = store.getOrCreateLocalPrincipal(1);
  store.getOrCreateAdapterSession({
    ownerId: principal.ownerId, adapterId, correlationSha256: digestA, createdAt: 2,
  });

  const db = new DatabaseSync(path, { readOnly: true });
  t.after(async () => { db.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const identityColumns = db.prepare("PRAGMA table_info('gateway_identity')").all()
    .map((row) => String((row as Record<string, unknown>).name));
  const sessionColumns = db.prepare("PRAGMA table_info('adapter_sessions')").all()
    .map((row) => String((row as Record<string, unknown>).name));
  assert.deepEqual(identityColumns, ['singleton_id', 'owner_id', 'created_at']);
  assert.deepEqual(sessionColumns, [
    'session_id', 'owner_id', 'adapter_id', 'correlation_sha256', 'created_at',
  ]);

  const forbidden = /bearer|token|tab|provider|conversation|mcp|backend|pid|raw_correlation|correlation_id/i;
  assert.doesNotMatch(identityColumns.join(','), forbidden);
  assert.doesNotMatch(sessionColumns.join(','), forbidden);

  const sessionRow = db.prepare('SELECT * FROM adapter_sessions').get() as Record<string, unknown>;
  assert.equal(sessionRow.correlation_sha256, digestA);
  assert.equal(sessionRow.adapter_id, adapterId);
});
