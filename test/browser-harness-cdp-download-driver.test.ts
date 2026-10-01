import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createCdpBrowserDownloadDriver,
  createFileBrowserDownloadStorage,
  type BrowserLevelCdpClient,
} from '../src/browser-harness/cdp-download-driver.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_download',
  sessionId: 'session_download',
  adapterId: 'private.stdio.v1',
};
const SESSION = 'browser_00000000-0000-4000-8000-000000000099';

function fakeClient() {
  const listeners = new Map<string, Set<(params: Readonly<Record<string, unknown>>) => void>>();
  const calls: Array<{ method: string; params?: Readonly<Record<string, unknown>> }> = [];

  const client: BrowserLevelCdpClient = {
    async call(owner, browserSessionId, method, params) {
      assert.deepEqual(owner, OWNER);
      assert.equal(browserSessionId, SESSION);
      calls.push({ method, ...(params === undefined ? {} : { params }) });
      return {};
    },
    onEvent(owner, browserSessionId, method, listener) {
      assert.deepEqual(owner, OWNER);
      assert.equal(browserSessionId, SESSION);
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      return () => { set.delete(listener); };
    },
  };

  return {
    client,
    calls,
    emit(method: string, params: Readonly<Record<string, unknown>>) {
      for (const listener of listeners.get(method) ?? []) listener(params);
    },
    listenerCount(method: string) {
      return listeners.get(method)?.size ?? 0;
    },
  };
}

test('CDP download driver arms Browser events before trigger, captures allowAndName bytes, and cleans capture directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-cdp-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fakeClient();
  const storage = createFileBrowserDownloadStorage({
    root,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  });
  const driver = createCdpBrowserDownloadDriver({ client: f.client, storage });
  const order: string[] = [];

  const result = await driver.captureNext(OWNER, SESSION, async () => {
    order.push('trigger');
    const behavior = f.calls.find((call) => call.method === 'Browser.setDownloadBehavior');
    assert.ok(behavior);
    assert.deepEqual(
      {
        behavior: behavior.params?.behavior,
        eventsEnabled: behavior.params?.eventsEnabled,
      },
      { behavior: 'allowAndName', eventsEnabled: true },
    );
    const directory = behavior.params?.downloadPath;
    assert.equal(typeof directory, 'string');
    assert.equal(f.listenerCount('Browser.downloadWillBegin'), 1);
    assert.equal(f.listenerCount('Browser.downloadProgress'), 1);

    const guid = '7d21f781-5514-4ccd-bff0-5bf2d55dbe72';
    await writeFile(join(directory as string, guid), Buffer.from('a,b\n1,2\n'));
    f.emit('Browser.downloadWillBegin', {
      frameId: 'frame_1',
      guid,
      url: 'https://example.test/report.csv',
      suggestedFilename: 'report?.csv',
    });
    f.emit('Browser.downloadProgress', {
      guid,
      totalBytes: 8,
      receivedBytes: 8,
      state: 'completed',
      filePath: 'C:\\not-authority\\report.csv',
    });
  }, 5000);

  order.push('done');
  assert.deepEqual(order, ['trigger', 'done']);
  assert.equal(result.filename, 'report?.csv');
  assert.equal(result.sourceUrl, 'https://example.test/report.csv');
  assert.equal(new TextDecoder().decode(result.bytes), 'a,b\n1,2\n');
  assert.equal(f.listenerCount('Browser.downloadWillBegin'), 0);
  assert.equal(f.listenerCount('Browser.downloadProgress'), 0);
  assert.deepEqual(await readdir(root), []);
});

test('CDP download driver treats canceled downloads as failure and still releases session capture lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-cdp-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fakeClient();
  let uuid = 1;
  const storage = createFileBrowserDownloadStorage({
    root,
    randomUUID: () => `00000000-0000-4000-8000-${String(uuid++).padStart(12, '0')}`,
  });
  const driver = createCdpBrowserDownloadDriver({ client: f.client, storage });

  await assert.rejects(
    () => driver.captureNext(OWNER, SESSION, async () => {
      const guid = 'download-1';
      f.emit('Browser.downloadWillBegin', {
        guid,
        url: 'https://example.test/one.bin',
        suggestedFilename: 'one.bin',
      });
      f.emit('Browser.downloadProgress', { guid, state: 'canceled', totalBytes: 10, receivedBytes: 3 });
    }, 5000),
    /was canceled/,
  );

  const second = driver.captureNext(OWNER, SESSION, async () => {
    const behavior = f.calls.filter((call) => call.method === 'Browser.setDownloadBehavior').at(-1)!;
    const guid = 'download-2';
    await writeFile(join(behavior.params?.downloadPath as string, guid), Buffer.from('ok'));
    f.emit('Browser.downloadWillBegin', {
      guid,
      url: 'https://example.test/two.bin',
      suggestedFilename: 'two.bin',
    });
    f.emit('Browser.downloadProgress', { guid, state: 'completed', totalBytes: 2, receivedBytes: 2 });
  }, 5000);
  assert.equal(new TextDecoder().decode((await second).bytes), 'ok');
});

test('CDP download driver fails closed when one trigger creates multiple download guids', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-cdp-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fakeClient();
  const driver = createCdpBrowserDownloadDriver({
    client: f.client,
    storage: createFileBrowserDownloadStorage({ root }),
  });

  await assert.rejects(
    () => driver.captureNext(OWNER, SESSION, async () => {
      f.emit('Browser.downloadWillBegin', {
        guid: 'download-a',
        url: 'https://example.test/a',
        suggestedFilename: 'a.bin',
      });
      f.emit('Browser.downloadWillBegin', {
        guid: 'download-b',
        url: 'https://example.test/b',
        suggestedFilename: 'b.bin',
      });
    }, 5000),
    /multiple downloads/,
  );
});

test('CDP download driver does not trust completed event filePath and requires bounded owned bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-cdp-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fakeClient();
  const driver = createCdpBrowserDownloadDriver({
    client: f.client,
    storage: createFileBrowserDownloadStorage({ root }),
    maxBytes: 4,
  });

  await assert.rejects(
    () => driver.captureNext(OWNER, SESSION, async () => {
      const behavior = f.calls.find((call) => call.method === 'Browser.setDownloadBehavior')!;
      const guid = 'download-large';
      await writeFile(join(behavior.params?.downloadPath as string, guid), Buffer.from('12345'));
      f.emit('Browser.downloadWillBegin', {
        guid,
        url: 'https://example.test/large.bin',
        suggestedFilename: 'large.bin',
      });
      f.emit('Browser.downloadProgress', {
        guid,
        state: 'completed',
        totalBytes: 5,
        receivedBytes: 5,
        filePath: 'C:\\attacker-controlled\\fake.bin',
      });
    }, 5000),
    /exceeds size limit/,
  );
});

test('allocation failure cannot strand the per-session active capture guard', async () => {
  const f = fakeClient();
  let allocations = 0;
  const driver = createCdpBrowserDownloadDriver({
    client: f.client,
    storage: {
      async allocate() {
        allocations += 1;
        if (allocations === 1) throw new Error('allocation failed');
        return 'C:\\owned-capture';
      },
      async read() { return new Uint8Array([1]); },
      async cleanup() {},
    },
  });

  await assert.rejects(
    () => driver.captureNext(OWNER, SESSION, async () => {}, 5000),
    /allocation failed/,
  );

  const pending = driver.captureNext(OWNER, SESSION, async () => {
    f.emit('Browser.downloadWillBegin', {
      guid: 'download-retry',
      url: 'https://example.test/retry',
      suggestedFilename: 'retry.bin',
    });
    f.emit('Browser.downloadProgress', {
      guid: 'download-retry',
      state: 'completed',
      totalBytes: 1,
      receivedBytes: 1,
    });
  }, 5000);
  assert.equal((await pending).filename, 'retry.bin');
});
