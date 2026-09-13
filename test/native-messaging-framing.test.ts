import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_ADAPTER_MAX_BYTES } from '../src/browser-adapter/protocol.js';
import { encodeNativeMessage, NativeMessageDecoder } from '../src/browser-adapter/native-framing.js';

test('native framing encodes one little-endian length-prefixed JSON message', () => {
  const value = { version: 1, type: 'hello', requestId: 'req_12345678' };
  const frame = encodeNativeMessage(value);
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4).toString('utf8')), value);
});

test('native decoder waits for complete prefix and body', () => {
  const value = { ok: true, text: 'hello' };
  const frame = encodeNativeMessage(value);
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frame.subarray(2, 6)), []);
  assert.deepEqual(decoder.push(frame.subarray(6)), [value]);
});

test('native decoder emits multiple messages from one chunk', () => {
  const first = { id: 1 };
  const second = { id: 2 };
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([
    encodeNativeMessage(first),
    encodeNativeMessage(second),
  ])), [first, second]);
});

test('native framing rejects zero length and oversized length prefixes', () => {
  const zero = Buffer.alloc(4);
  assert.throws(() => new NativeMessageDecoder().push(zero), /length|zero/i);

  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(BROWSER_ADAPTER_MAX_BYTES + 1, 0);
  assert.throws(() => new NativeMessageDecoder().push(huge), /size|large|limit|length/i);

  assert.throws(() => encodeNativeMessage({ text: 'x'.repeat(BROWSER_ADAPTER_MAX_BYTES) }), /size|large|limit/i);
});

test('native decoder rejects malformed JSON and invalid UTF-8', () => {
  const badJsonBody = Buffer.from('{nope', 'utf8');
  const badJson = Buffer.alloc(4 + badJsonBody.length);
  badJson.writeUInt32LE(badJsonBody.length, 0);
  badJsonBody.copy(badJson, 4);
  assert.throws(() => new NativeMessageDecoder().push(badJson), /json|parse/i);

  const badUtf8Body = Buffer.from([0xc3, 0x28]);
  const badUtf8 = Buffer.alloc(6);
  badUtf8.writeUInt32LE(badUtf8Body.length, 0);
  badUtf8Body.copy(badUtf8, 4);
  assert.throws(() => new NativeMessageDecoder().push(badUtf8), /utf|encoding|decode/i);
});
