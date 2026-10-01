import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import { ArtifactPort } from '../src/artifact-harness/artifact-port.js';
import {
  createBrowserDownloadController,
  type BrowserDownloadDriver,
} from '../src/browser-harness/browser-download.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_dl', sessionId: 'session_dl', adapterId: 'private.stdio.v1' };
const OTHER: GatewayAuthority = { ownerId: 'owner_dl', sessionId: 'session_other', adapterId: 'private.stdio.v1' };

test('browser download captures after arming the driver and persists bytes as an owned artifact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-browser-download-'));
  let uuid = 1;
  const artifacts = new ArtifactPort({
    root: join(dir, 'artifacts'),
    authorizeSource: async () => { throw new Error('download must not use arbitrary source-path import'); },
    randomUUID: () => `00000000-0000-4000-8000-${String(uuid++).padStart(12, '0')}`,
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const order: string[] = [];
  const driver: BrowserDownloadDriver = {
    async captureNext(owner, browserSessionId, trigger, timeoutMs) {
      assert.deepEqual(owner, OWNER);
      assert.equal(browserSessionId, 'browser_00000000-0000-4000-8000-000000000001');
      assert.equal(timeoutMs, 45000);
      order.push('armed');
      await trigger();
      order.push('captured');
      return {
        filename: 'report?.csv',
        bytes: new TextEncoder().encode('a,b\n1,2\n'),
        sourceUrl: 'https://example.test/report.csv',
      };
    },
  };

  const controller = createBrowserDownloadController({ driver, artifacts });
  const artifact = await controller.download(
    OWNER,
    'browser_00000000-0000-4000-8000-000000000001',
    async () => { order.push('trigger'); },
    { timeoutMs: 45000 },
  );

  assert.deepEqual(order, ['armed', 'trigger', 'captured']);
  assert.equal(artifact.filename, 'report_.csv');
  assert.equal(await readFile(artifact.internalPath, 'utf8'), 'a,b\n1,2\n');
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(() => artifacts.get(OTHER, artifact.artifactId), /another authority/);
});

test('browser download failure does not manufacture an artifact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-browser-download-'));
  const artifacts = new ArtifactPort({
    root: join(dir, 'artifacts'),
    authorizeSource: async () => { throw new Error('not used'); },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  let triggerCount = 0;
  const controller = createBrowserDownloadController({
    artifacts,
    driver: {
      async captureNext(_owner, _session, trigger) {
        await trigger();
        throw new Error('download interrupted');
      },
    },
  });
  await assert.rejects(
    () => controller.download(OWNER, 'browser_00000000-0000-4000-8000-000000000001', async () => {
      triggerCount += 1;
    }),
    /download interrupted/,
  );
  assert.equal(triggerCount, 1);
  assert.deepEqual(await artifacts.list(OWNER), []);
});

test('browser download rejects unbounded timeouts before arming the driver', async () => {
  let armed = false;
  const controller = createBrowserDownloadController({
    artifacts: {
      async createBytes() { throw new Error('not used'); },
    },
    driver: {
      async captureNext() {
        armed = true;
        throw new Error('not used');
      },
    },
  });

  await assert.rejects(
    () => controller.download(OWNER, 'browser_00000000-0000-4000-8000-000000000001', async () => {}, {
      timeoutMs: 121000,
    }),
    /timeout is invalid/,
  );
  assert.equal(armed, false);
});
