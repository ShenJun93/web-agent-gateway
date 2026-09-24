import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpProtocolClient, type CdpCommand, type CdpTransport } from '../src/browser-harness/cdp-protocol.js';
import { createCdpBrowserBackend } from '../src/browser-harness/cdp-browser-backend.js';

test('CDP protocol client increments ids and propagates the target session', async () => {
  const commands: CdpCommand[] = [];
  const transport: CdpTransport = {
    async send(command) {
      commands.push(command);
      return { id: command.id, result: { ok: true }, ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }) };
    },
    async close() {},
  };
  const client = new CdpProtocolClient(transport, 'session_target');
  assert.deepEqual(await client.call('Runtime.evaluate', { expression: '1+1' }), { ok: true });
  assert.deepEqual(await client.call('Page.getNavigationHistory'), { ok: true });
  assert.deepEqual(commands, [
    { id: 1, method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: 'session_target' },
    { id: 2, method: 'Page.getNavigationHistory', sessionId: 'session_target' },
  ]);
});

test('CDP protocol client turns protocol failures into bounded errors', async () => {
  const transport: CdpTransport = {
    async send(command) { return { id: command.id, error: { code: -32601, message: 'method not found' } }; },
    async close() {},
  };
  const client = new CdpProtocolClient(transport);
  await assert.rejects(() => client.call('Nope.missing'), /CDP Nope\.missing failed \(-32601\): method not found/);
});

test('CDP browser backend attaches one page target and routes page commands to its session', async () => {
  const commands: CdpCommand[] = [];
  let closed = false;
  const transport: CdpTransport = {
    async send(command) {
      commands.push(command);
      if (command.method === 'Target.getTargets') {
        return { id: command.id, result: { targetInfos: [{ targetId: 'page_1', type: 'page', url: 'https://example.test/', title: 'Example' }] } };
      }
      if (command.method === 'Target.attachToTarget') return { id: command.id, result: { sessionId: 'cdp_session_1' } };
      if (command.method === 'Runtime.evaluate') return { id: command.id, sessionId: command.sessionId, result: { result: { value: 2 } } };
      if (command.method === 'Page.captureScreenshot') return { id: command.id, sessionId: command.sessionId, result: { data: 'UE5H' } };
      if (command.method === 'Target.closeTarget') return { id: command.id, result: { success: true } };
      throw new Error(`unexpected command ${command.method}`);
    },
    async close() { closed = true; },
  };
  const backend = createCdpBrowserBackend({ connect: async (profileId) => {
    assert.equal(profileId, 'profile_a');
    return transport;
  }});
  const session = await backend.open('profile_a');
  assert.equal(session.targetId, 'page_1');
  assert.deepEqual(await session.describe(), { url: 'https://example.test/', title: 'Example' });
  assert.deepEqual(await session.exec({ method: 'Runtime.evaluate', params: { expression: '1+1' } }), { result: { value: 2 } });
  assert.deepEqual(await session.screenshot(), { mimeType: 'image/png', dataBase64: 'UE5H' });
  await session.close();
  assert.equal(closed, true);
  const runtime = commands.find((command) => command.method === 'Runtime.evaluate');
  assert.equal(runtime?.sessionId, 'cdp_session_1');
  assert.deepEqual(commands.find((command) => command.method === 'Target.attachToTarget')?.params, { targetId: 'page_1', flatten: true });
});
