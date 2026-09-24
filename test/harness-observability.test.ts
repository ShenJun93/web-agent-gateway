import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  HarnessTracer,
  correlationFromEffect,
  createMemorySpanExporter,
} from '../src/harness-observability.js';
import type { HarnessEffectRecord } from '../src/harness-effect-ledger.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_a',
  sessionId: 'session_a',
  adapterId: 'private.stdio.v1',
};

function bytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index + 1) & 0xff);
}

test('HarnessTracer exports parent/child spans with explicit authority and resource correlation', async () => {
  const exporter = createMemorySpanExporter();
  let now = 100;
  const tracer = new HarnessTracer({ exporter, now: () => now++, randomBytes: bytes });
  const root = tracer.startSpan('mcp.tools.call', {
    authority: OWNER,
    correlation: { requestId: 'request_1', workspaceId: 'ws_1' },
  });
  const child = tracer.startSpan('browser.snapshot', {
    parent: root.context,
    authority: OWNER,
    correlation: { browserSessionId: 'browser_00000000-0000-4000-8000-000000000001' },
  });
  const childRecord = await child.finish();
  const rootRecord = await root.finish();

  assert.equal(childRecord.parentSpanId, root.context.spanId);
  assert.equal(childRecord.traceId, root.context.traceId);
  assert.equal(childRecord.status, 'OK');
  assert.deepEqual(rootRecord.authority, OWNER);
  assert.deepEqual(rootRecord.correlation, { requestId: 'request_1', workspaceId: 'ws_1' });
  assert.equal(exporter.records.length, 2);
});

test('failed span records error class without recording arbitrary exception/message content', async () => {
  const exporter = createMemorySpanExporter();
  const tracer = new HarnessTracer({ exporter, randomBytes: bytes });
  const span = tracer.startSpan('process.stop');
  const record = await span.fail('PROCESS_TIMEOUT');
  assert.equal(record.status, 'ERROR');
  assert.equal(record.errorClass, 'PROCESS_TIMEOUT');
  assert.equal('message' in record, false);
  await assert.rejects(() => span.finish(), /already finished/);
});

test('effect correlation links ids but never copies effect arguments or result content', () => {
  const effect: HarnessEffectRecord = {
    effectId: 'effect_00000000-0000-4000-8000-000000000001',
    ownerId: OWNER.ownerId,
    sessionId: OWNER.sessionId,
    adapterId: OWNER.adapterId,
    idempotencyKey: 'RUN-1',
    kind: 'browser.notebook99.submit',
    resourceId: 'browser:session:notebook99',
    planFingerprint: 'effectfp_deadbeef',
    state: 'EXECUTING',
    createdAt: 1,
    updatedAt: 2,
    attemptId: 'attempt_00000000-0000-4000-8000-000000000001',
  };
  assert.deepEqual(correlationFromEffect(effect, { requestId: 'request_2' }), {
    requestId: 'request_2',
    resourceId: effect.resourceId,
    effectId: effect.effectId,
    attemptId: effect.attemptId,
  });
});
