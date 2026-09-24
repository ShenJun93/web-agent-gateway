import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HarnessTracer,
  createMemorySpanExporter,
} from '../src/harness-observability.js';
import { startObservedMcpCall } from '../src/mcp-observability-bridge.js';

function bytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => index + 1);
}

test('valid incoming MCP trace becomes the parent and outgoing metadata carries the WAG child span', async () => {
  const exporter = createMemorySpanExporter();
  const tracer = new HarnessTracer({ exporter, randomBytes: bytes });
  const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const call = startObservedMcpCall(tracer, {
    name: 'mcp.tools.call',
    meta: { traceparent: incoming, tracestate: 'vendor=opaque', keep: 'x' },
  });
  assert.equal(call.incomingTrace, 'ACCEPTED');
  assert.equal(call.span.context.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.notEqual(call.span.context.spanId, '00f067aa0ba902b7');
  const downstream = call.downstreamMeta({ keep: 'x' });
  assert.equal(downstream.keep, 'x');
  assert.equal(downstream.tracestate, 'vendor=opaque');
  assert.match(String(downstream.traceparent), /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
  const record = await call.span.finish();
  assert.equal(record.parentSpanId, '00f067aa0ba902b7');
});

test('invalid incoming traceparent restarts a local trace instead of failing the tool call', async () => {
  const exporter = createMemorySpanExporter();
  const tracer = new HarnessTracer({ exporter, randomBytes: bytes });
  const call = startObservedMcpCall(tracer, {
    name: 'mcp.tools.call',
    meta: { traceparent: 'not-a-traceparent', tracestate: 'vendor=opaque' },
  });
  assert.equal(call.incomingTrace, 'RESTARTED');
  assert.equal(call.span.context.traceId, '0102030405060708090a0b0c0d0e0f10');
  await call.span.finish();
});

test('malformed tracestate or baggage is discarded without breaking a valid traceparent', async () => {
  const exporter = createMemorySpanExporter();
  const tracer = new HarnessTracer({ exporter, randomBytes: bytes });
  const call = startObservedMcpCall(tracer, {
    name: 'mcp.tools.call',
    meta: {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'bad\nstate',
      baggage: 'bad\u0000bag',
    },
  });
  assert.equal(call.incomingTrace, 'ACCEPTED');
  assert.equal(call.span.context.tracestate, undefined);
  assert.equal(call.span.context.baggage, undefined);
  const downstream = call.downstreamMeta();
  assert.equal('tracestate' in downstream, false);
  assert.equal('baggage' in downstream, false);
  await call.span.finish();
});

test('trace propagation never projects authority or local correlation fields into MCP metadata', async () => {
  const exporter = createMemorySpanExporter();
  const tracer = new HarnessTracer({ exporter, randomBytes: bytes });
  const call = startObservedMcpCall(tracer, {
    name: 'mcp.tools.call',
    authority: { ownerId: 'owner_a', sessionId: 'session_a', adapterId: 'private.stdio.v1' },
    correlation: { workspaceId: 'ws_1', effectId: 'effect_00000000-0000-4000-8000-000000000001' },
  });
  const downstream = call.downstreamMeta();
  assert.deepEqual(Object.keys(downstream), ['traceparent']);
  await call.span.finish();
  assert.equal(exporter.records[0]?.authority?.ownerId, 'owner_a');
  assert.equal(exporter.records[0]?.correlation.workspaceId, 'ws_1');
});
