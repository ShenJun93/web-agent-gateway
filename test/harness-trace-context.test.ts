import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createChildTraceContext,
  createRootTraceContext,
  extractMcpTraceContext,
  formatTraceparent,
  injectMcpTraceContext,
  parseTraceparent,
} from '../src/harness-trace-context.js';

function deterministic(bytes: number): Uint8Array {
  return Uint8Array.from({ length: bytes }, (_, index) => index + 1);
}

test('W3C traceparent parsing and formatting is strict and lowercase', () => {
  const value = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  assert.deepEqual(parseTraceparent(value), {
    version: '00',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    parentId: '00f067aa0ba902b7',
    traceFlags: '01',
  });
  assert.equal(formatTraceparent({
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    traceFlags: '01',
  }), value);
  for (const invalid of [
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
    '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01',
  ]) {
    assert.throws(() => parseTraceparent(invalid), /Invalid W3C traceparent/);
  }
});

test('root and child contexts preserve trace identity and rotate span ids', () => {
  const root = createRootTraceContext({ randomBytes: deterministic, sampled: true });
  const child = createChildTraceContext(root, {
    randomBytes: (bytes) => Uint8Array.from({ length: bytes }, (_, index) => index + 33),
  });
  assert.equal(root.traceId, '0102030405060708090a0b0c0d0e0f10');
  assert.equal(root.spanId, '0102030405060708');
  assert.equal(root.traceFlags, '01');
  assert.equal(child.traceId, root.traceId);
  assert.notEqual(child.spanId, root.spanId);
  assert.equal(child.traceFlags, root.traceFlags);
});

test('MCP _meta extraction and injection uses standard trace keys without mutating caller metadata', () => {
  const incoming = {
    keep: 'value',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    tracestate: 'vendor=abc',
    baggage: 'tenant=opaque',
  };
  const context = extractMcpTraceContext(incoming)!;
  assert.equal(context.spanId, '00f067aa0ba902b7');
  const outgoing = injectMcpTraceContext({ keep: 'value' }, context);
  assert.deepEqual(outgoing, {
    keep: 'value',
    traceparent: incoming.traceparent,
    tracestate: 'vendor=abc',
    baggage: 'tenant=opaque',
  });
  assert.deepEqual(incoming.keep, 'value');
});
