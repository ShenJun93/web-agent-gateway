import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SqliteRemoteRelayCallStore,
} from '../src/remote-relay-call-store.js';

const SECRET = Buffer.alloc(32, 0x44);
const NOW = 1_790_548_800_000;

test('SQLite relay call store persists only encrypted local result and recovers it after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-relay-call-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const callId = 'call_durable_result';
  const plaintext = Buffer.from(JSON.stringify({
    kind: 'tool.result',
    ok: true,
    result: { structuredContent: { secret_marker: 'LOCAL-RESULT-PLAINTEXT' } },
  }), 'utf8');

  const first = new SqliteRemoteRelayCallStore(path, {
    secret: SECRET,
    now: () => NOW,
  });
  const claim = first.claim(callId, NOW + 60_000);
  assert.equal(claim.claimed, true);
  assert.equal(claim.record.state, 'EXECUTING');
  first.complete(callId, 'COMPLETED', plaintext);
  assert.deepEqual(first.get(callId)?.result, plaintext);
  first.close();

  const rawDb = await readFile(path);
  assert.equal(rawDb.includes(Buffer.from(callId, 'utf8')), false, 'raw call id is hashed at rest');
  assert.equal(
    rawDb.includes(Buffer.from('LOCAL-RESULT-PLAINTEXT', 'utf8')),
    false,
    'tool result plaintext is encrypted at rest',
  );

  const second = new SqliteRemoteRelayCallStore(path, {
    secret: SECRET,
    now: () => NOW + 1_000,
  });
  assert.deepEqual(second.get(callId), {
    state: 'COMPLETED',
    expiresAt: NOW + 60_000,
    result: plaintext,
  });
  assert.deepEqual(second.claim(callId, NOW + 60_000), {
    claimed: false,
    record: {
      state: 'COMPLETED',
      expiresAt: NOW + 60_000,
      result: plaintext,
    },
  });
  second.close();
});

test('interrupted EXECUTING call becomes UNKNOWN on restart and is never claimable again', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-relay-call-unknown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');

  const first = new SqliteRemoteRelayCallStore(path, {
    secret: SECRET,
    now: () => NOW,
  });
  assert.equal(first.claim('call_interrupted', NOW + 60_000).claimed, true);
  first.close();

  const second = new SqliteRemoteRelayCallStore(path, {
    secret: SECRET,
    now: () => NOW + 1_000,
  });
  assert.deepEqual(second.get('call_interrupted'), {
    state: 'UNKNOWN',
    expiresAt: NOW + 60_000,
  });
  assert.deepEqual(second.claim('call_interrupted', NOW + 60_000), {
    claimed: false,
    record: {
      state: 'UNKNOWN',
      expiresAt: NOW + 60_000,
    },
  });
  second.close();
});

test('wrong device secret cannot decrypt a persisted call result', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-relay-call-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');

  const first = new SqliteRemoteRelayCallStore(path, {
    secret: SECRET,
    now: () => NOW,
  });
  first.claim('call_secret_bound', NOW + 60_000);
  first.complete('call_secret_bound', 'COMPLETED', Buffer.from('{"ok":true}', 'utf8'));
  first.close();

  const wrong = new SqliteRemoteRelayCallStore(path, {
    secret: Buffer.alloc(32, 0x55),
    now: () => NOW + 1_000,
  });
  assert.throws(() => wrong.get('call_secret_bound'), /authentication failed/);
  wrong.close();
});

test('expired call metadata and ciphertext are removed locally', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-relay-call-expiry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  let now = NOW;

  const store = new SqliteRemoteRelayCallStore(path, {
    secret: SECRET,
    now: () => now,
  });
  store.claim('call_expiring', NOW + 1_000);
  store.complete('call_expiring', 'FAILED', Buffer.from('{"ok":false}', 'utf8'));
  now = NOW + 1_001;
  assert.equal(store.get('call_expiring'), undefined);
  store.close();
});
