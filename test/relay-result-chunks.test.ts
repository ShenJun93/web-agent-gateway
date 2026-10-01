import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  RELAY_MESSAGE_MAX_BYTES,
  RELAY_DIRECT_RESULT_MAX_BYTES,
  RelayResultChunkStore,
  type RelayResultChunk,
} from '../src/relay-result-chunks.js';

function mcpTextResult(value: object) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function mcpImageResult(dataBase64: string) {
  const metadata = { mime_type: 'image/png', size_bytes: Buffer.from(dataBase64, 'base64').length };
  return {
    content: [
      { type: 'image', data: dataBase64, mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify(metadata) },
    ],
    structuredContent: metadata,
  };
}

function encodedMcpChunk(chunk: RelayResultChunk) {
  return mcpTextResult(chunk);
}

function reassemble(store: RelayResultChunkStore, first: RelayResultChunk): Buffer {
  const pieces: Buffer[] = [];
  for (let index = 0; index < first.chunk_count; index += 1) {
    const chunk = index === 0 ? first : store.get(first.result_id, index);
    assert.equal(chunk.chunk_index, index);
    assert.equal(chunk.chunk_count, first.chunk_count);
    assert.equal(chunk.sha256, first.sha256);
    assert.ok(
      Buffer.byteLength(JSON.stringify(encodedMcpChunk(chunk)), 'utf8') < RELAY_MESSAGE_MAX_BYTES,
      'every chunk MCP result must serialize below the relay message limit',
    );
    pieces.push(Buffer.from(chunk.data_base64, 'base64'));
  }
  return Buffer.concat(pieces);
}

test('small MCP results remain direct under the relay budget', () => {
  const store = new RelayResultChunkStore();
  const value = mcpTextResult({ ok: true, text: 'small' });
  assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') < RELAY_DIRECT_RESULT_MAX_BYTES);
  assert.equal(store.wrap(value), value);
});

test('an 8 MiB browser screenshot is chunked and reassembles byte-for-byte', () => {
  const store = new RelayResultChunkStore({
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  });
  const raw = Buffer.alloc(8 * 1024 * 1024, 0xa5);
  const original = mcpImageResult(raw.toString('base64'));
  assert.ok(Buffer.byteLength(JSON.stringify(original), 'utf8') > RELAY_MESSAGE_MAX_BYTES);

  const first = store.wrap(original) as RelayResultChunk;
  assert.equal(first.chunked, true);
  assert.match(first.result_id, /^result_[0-9a-f-]{36}$/);

  const rebuilt = reassemble(store, first);
  assert.equal(rebuilt.length, first.serialized_bytes);
  assert.equal(createHash('sha256').update(rebuilt).digest('hex'), first.sha256);
  assert.deepEqual(JSON.parse(rebuilt.toString('utf8')), original);
});

test('expired relay chunks fail closed instead of replaying the original tool', () => {
  let now = 10_000;
  const store = new RelayResultChunkStore({
    now: () => now,
    ttlMs: 1_000,
    randomUUID: () => '00000000-0000-4000-8000-000000000002',
  });
  const original = mcpTextResult({ payload: 'x'.repeat(RELAY_DIRECT_RESULT_MAX_BYTES) });
  const first = store.wrap(original) as RelayResultChunk;
  assert.equal(first.chunked, true);
  now += 1_001;
  assert.throws(
    () => store.get(first.result_id, 0),
    /unavailable or expired/i,
  );
});
