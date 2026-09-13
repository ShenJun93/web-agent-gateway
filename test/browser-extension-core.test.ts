import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBrowserExtensionCore } from '../browser/extension/service-worker-core.js';

const health = {
  version: 1 as const,
  type: 'tool.call' as const,
  requestId: 'req_health_001',
  sessionId: 'session_12345678',
  tool: 'health' as const,
  arguments: {},
};

test('extension core queues only trusted ChatGPT tab requests and deduplicates ids', () => {
  const core = createBrowserExtensionCore();
  assert.equal(core.queueProviderRequest({ url: 'https://chatgpt.com/c/abc', tabId: 7 }, health), true);
  assert.equal(core.queueProviderRequest({ url: 'https://chatgpt.com/c/abc', tabId: 7 }, health), false);
  assert.equal(core.queueProviderRequest({ url: 'https://evil.example/', tabId: 8 }, { ...health, requestId: 'req_health_002' }), false);
  assert.equal(core.queueProviderRequest({ url: 'https://chatgpt.com/', tabId: undefined }, { ...health, requestId: 'req_health_003' }), false);
  assert.deepEqual(core.pending(), [{ requestId: health.requestId, tabId: 7, request: health }]);
});

test('only side panel may execute queued requests and native responses correlate to tab', () => {
  const core = createBrowserExtensionCore();
  core.queueProviderRequest({ url: 'https://chatgpt.com/', tabId: 9 }, health);
  assert.equal(core.takeForExecution(health.requestId, 'content'), undefined);
  assert.deepEqual(core.takeForExecution(health.requestId, 'sidepanel'), health);
  assert.equal(core.takeForExecution(health.requestId, 'sidepanel'), undefined);
  const delivered = core.acceptNativeResponse({ version: 1, type: 'result', requestId: health.requestId, result: { status: 'ok' } });
  assert.deepEqual(delivered, { tabId: 9, requestId: health.requestId, response: { version: 1, type: 'result', requestId: health.requestId, result: { status: 'ok' } } });
  assert.equal(core.acceptNativeResponse({ version: 1, type: 'result', requestId: 'req_unknown_01', result: {} }), undefined);
});
test('extension manifest is narrowly scoped and has stable identity', async () => {
  const raw = await readFile(new URL('../browser/extension/manifest.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '114');
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'sidePanel', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.equal('externally_connectable' in manifest, false);
  assert.equal((manifest.background as { service_worker?: string })?.service_worker, 'service-worker.js');
  assert.equal((manifest.side_panel as { default_path?: string })?.default_path, 'sidepanel.html');

  const key = String(manifest.key ?? '');
  assert.ok(key.length > 100, 'manifest public key must be committed');
  const der = Buffer.from(key, 'base64');
  const digest = createHash('sha256').update(der).digest().subarray(0, 16);
  const extensionId = [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join('');
  assert.equal(extensionId, 'nnhhhppkpogkedpjnijeagcbfjaoogec');
});
