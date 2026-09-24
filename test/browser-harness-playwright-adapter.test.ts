import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createPlaywrightCdpBackend,
  type PlaywrightChromiumLike,
} from '../src/browser-harness/playwright-cdp-adapter.js';

const OWNER: GatewayAuthority = { ownerId: 'owner', sessionId: 'session', adapterId: 'private.stdio.v1' };

test('Playwright adapter uses connectOverCDP only for the dedicated profile endpoint and closes owned browser', async () => {
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const chromium: PlaywrightChromiumLike = {
    async connectOverCDP(endpoint, options) {
      calls.push({ kind: 'connect', value: { endpoint, options } });
      return {
        contexts() {
          return [{
            pages() {
              return [{
                url: () => 'https://notebooklm.google.com/',
                async title() { return 'Notebook'; },
                async screenshot() { return new Uint8Array([80, 78, 71]); },
              }];
            },
            async newCDPSession() {
              return {
                async send(method, params) { calls.push({ kind: 'cdp', value: { method, params } }); return { ok: true }; },
                async detach() { calls.push({ kind: 'detach' }); },
              };
            },
          }];
        },
        async close() { calls.push({ kind: 'browser.close' }); },
      };
    },
  };
  const backend = createPlaywrightCdpBackend({
    chromium,
    endpointForProfile: async (profile) => {
      assert.equal(profile.profileId, 'notebook99');
      return 'http://127.0.0.1:9333';
    },
  });
  assert.equal(backend.kind, 'playwright-cdp');
  const session = await backend.open({ profileId: 'notebook99', owner: OWNER, userDataDir: 'E:/AI-BROWSER/profiles/notebook99' });
  assert.deepEqual(await session.describe(), { url: 'https://notebooklm.google.com/', title: 'Notebook' });
  assert.deepEqual(await session.exec({ method: 'Runtime.evaluate', params: { expression: '1+1' } }), { ok: true });
  assert.deepEqual(await session.screenshot(), { mimeType: 'image/png', dataBase64: 'UE5H' });
  await session.close();

  assert.deepEqual(calls[0], {
    kind: 'connect',
    value: {
      endpoint: 'http://127.0.0.1:9333',
      options: { timeout: 30000, isLocal: true, noDefaults: true },
    },
  });
  assert.deepEqual(calls.slice(-2).map((item) => item.kind), ['detach', 'browser.close']);
});
