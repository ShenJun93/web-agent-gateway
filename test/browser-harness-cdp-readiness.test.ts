import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForLoopbackCdpReady } from '../src/browser-harness/cdp-readiness.js';

test('CDP readiness retries bounded loopback discovery until the endpoint becomes available', async () => {
  let calls = 0;
  let clock = 1000;
  const websocket = await waitForLoopbackCdpReady({
    endpointUrl: 'http://127.0.0.1:9333',
    timeoutMs: 1000,
    pollIntervalMs: 50,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return {
        ok: true,
        status: 200,
        async json() {
          return { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/ready' };
        },
      };
    },
  });
  assert.equal(websocket, 'ws://127.0.0.1:9333/devtools/browser/ready');
  assert.equal(calls, 3);
});

test('CDP readiness fails closed at its deadline', async () => {
  let clock = 0;
  await assert.rejects(() => waitForLoopbackCdpReady({
    endpointUrl: 'http://127.0.0.1:9333',
    timeoutMs: 100,
    pollIntervalMs: 50,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async () => { throw new Error('still unavailable'); },
  }), /did not become ready: still unavailable/);
});
