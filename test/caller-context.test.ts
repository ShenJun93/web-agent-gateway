import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';

const input = {
  ownerId: 'owner_a',
  sessionId: 'session_a',
  adapterId: 'adapter_a',
  correlation: {
    provider: 'chatgpt',
    clientId: 'client_a',
    conversationRef: 'conv/123',
  },
};

test('trusted caller context validates and deeply freezes admitted identity', () => {
  const context = createGatewayCallerContext(input);
  assert.deepEqual(context, input);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.correlation), true);
  assert.throws(() => { (context as any).ownerId = 'other'; });
  assert.throws(() => { (context.correlation as any).provider = 'other'; });
});
test('trusted caller context rejects values outside exact v1 bounds', () => {
  for (const bad of [
    { ...input, ownerId: '' },
    { ...input, ownerId: 'x'.repeat(129) },
    { ...input, sessionId: 'bad value' },
    { ...input, adapterId: 'bad/value' },
    { ...input, correlation: { provider: 'x'.repeat(65) } },
    { ...input, correlation: { clientId: 'x'.repeat(129) } },
    { ...input, correlation: { conversationRef: 'é'.repeat(257) } },
    { ...input, correlation: { conversationRef: 'bad\u0001ref' } },
    { ...input, correlation: { conversationRef: 'bad\u0000ref' } },
    { ...input, extra: true },
    { ...input, correlation: { provider: 'chatgpt', extra: true } },
  ]) {
    assert.throws(() => createGatewayCallerContext(bad));
  }
});
test('trusted caller context requires every authority field', () => {
  for (const missing of ['ownerId', 'sessionId', 'adapterId'] as const) {
    const candidate = { ...input } as Record<string, unknown>;
    delete candidate[missing];
    assert.throws(() => createGatewayCallerContext(candidate));
  }
});

test('trusted caller context accepts exact v1 maximum bounds', () => {
  const context = createGatewayCallerContext({
    ownerId: 'o'.repeat(128),
    sessionId: 's'.repeat(128),
    adapterId: 'a'.repeat(128),
    correlation: {
      provider: 'p'.repeat(64),
      clientId: 'c'.repeat(128),
      conversationRef: 'é'.repeat(256),
    },
  });
  assert.equal(context.ownerId.length, 128);
  assert.equal(Buffer.byteLength(context.correlation?.conversationRef ?? '', 'utf8'), 512);
});
