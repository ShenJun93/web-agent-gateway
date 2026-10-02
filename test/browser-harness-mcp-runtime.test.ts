import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import type { BrowserPort } from '../src/browser-harness/browser-port.js';
import {
  createPrivateBrowserMcpContext,
} from '../src/browser-harness/browser-mcp-runtime.js';
import type { SemanticBrowser } from '../src/browser-harness/semantic-browser.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_browser_mcp',
  sessionId: 'session_browser_mcp',
  adapterId: 'private.stdio.v1',
};
const SESSION = 'browser_00000000-0000-4000-8000-000000000111';

function unusedPort(): BrowserPort {
  const unavailable = async (): Promise<never> => { throw new Error('unused BrowserPort method'); };
  return {
    open: unavailable,
    describe: unavailable,
    snapshot: unavailable,
    exec: unavailable,
    screenshot: unavailable,
    close: unavailable,
  };
}

test('browser MCP exact-once coordinator never replays a succeeded semantic effect', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-mcp-effect-'));
  let clicks = 0;
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() { clicks += 1; },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async inspectMedia() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'msedge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    port: unusedPort(),
    semantic,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const action = { type: 'click' as const, ref: 'node_00000000-0000-4000-8000-000000000222_0' };
  const first = await runtime.exec(SESSION, 'browser.click.once', action);
  assert.equal(first.state, 'SUCCEEDED');
  assert.equal(clicks, 1);

  const second = await runtime.exec(SESSION, 'browser.click.once', action);
  assert.equal(second.effectId, first.effectId);
  assert.equal(second.state, 'SUCCEEDED');
  assert.equal(clicks, 1, 'a successful idempotent retry must not dispatch a second click');

  await assert.rejects(
    () => runtime.exec(SESSION, 'browser.click.once', {
      type: 'press',
      key: 'Enter',
    }),
    /conflicts with a different effect plan/i,
  );
  assert.equal(clicks, 1);
});

test('browser MCP outcome-unknown blocks blind replay after an uncertain semantic effect', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-mcp-unknown-'));
  let attempts = 0;
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() {
      attempts += 1;
      throw new Error('connection disappeared after dispatch boundary');
    },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async inspectMedia() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'msedge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    port: unusedPort(),
    semantic,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const action = { type: 'click' as const, ref: 'node_00000000-0000-4000-8000-000000000333_0' };
  await assert.rejects(
    () => runtime.exec(SESSION, 'browser.click.unknown', action),
    /connection disappeared/i,
  );
  assert.equal(attempts, 1);

  await assert.rejects(
    () => runtime.exec(SESSION, 'browser.click.unknown', action),
    /not claimable from OUTCOME_UNKNOWN/i,
  );
  assert.equal(attempts, 1, 'OUTCOME_UNKNOWN must never dispatch the effect again');
});

test('attached browser effect fingerprint binds target id and claim epoch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-mcp-fence-fp-'));
  let epoch = 1;
  let clicks = 0;
  const sessionId = 'browser_00000000-0000-4000-8000-000000000444';
  const handle = () => ({
    browserSessionId: sessionId,
    profileId: 'attached',
    owner: OWNER,
    backend: 'cdp' as const,
    executionMode: 'ATTACH_EXISTING' as const,
    ownershipMode: 'ATTACHED_EXISTING' as const,
    controlState: 'RUNNING' as const,
    targetId: 'tab_7',
    claimEpoch: epoch,
    claimExpiresAt: Date.now() + 30_000,
    createdAt: 1,
    lastSeenAt: 1,
    state: 'ACTIVE' as const,
  });
  const port: BrowserPort = {
    async open() { return handle(); },
    async describe() { return handle(); },
    async snapshot() { throw new Error('unused'); },
    async exec() { throw new Error('unused'); },
    async screenshot() { throw new Error('unused'); },
    async close() { return { ...handle(), state: 'CLOSED' as const }; },
  };
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() { clicks += 1; },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async inspectMedia() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'msedge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    port,
    semantic,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const opened = await runtime.open('attached', 'ATTACH_EXISTING', 'tab_7');
  const action = {
    type: 'click' as const,
    ref: 'node_00000000-0000-4000-8000-000000000555_0',
  };
  const first = await runtime.exec(opened.browserSessionId, 'browser.fenced.click.once', action);
  assert.equal(first.state, 'SUCCEEDED');
  assert.equal(clicks, 1);

  epoch = 2;
  const rebound = await runtime.describe(opened.browserSessionId);
  assert.equal(rebound.claimEpoch, 2);

  await assert.rejects(
    () => runtime.exec(opened.browserSessionId, 'browser.fenced.click.once', action),
    /conflicts with a different effect plan/i,
  );
  assert.equal(clicks, 1, 'epoch change must never replay an idempotent attached-browser effect');
});


test('browser upload resolves workspace-relative paths at effect time and replays exactly once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-upload-effect-'));
  let resolutions = 0;
  let selections = 0;
  const selected: string[][] = [];
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() { throw new Error('unused'); },
    async fill() { throw new Error('unused'); },
    async setFiles(_owner, _session, _ref, paths) {
      selections += 1;
      selected.push([...paths]);
    },
    async inspectMedia() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'msedge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    port: unusedPort(),
    semantic,
    resolveUploadFiles: async (workspaceId, paths) => {
      resolutions += 1;
      assert.equal(workspaceId, 'ws_upload');
      assert.deepEqual(paths, ['demo.mp4']);
      return [{
        relative_path: 'demo.mp4',
        absolute_path: join(root, 'workspace', 'demo.mp4'),
        size_bytes: 1234,
      }];
    },
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const ref = 'node_00000000-0000-4000-8000-000000000666_0';
  const first = await runtime.uploadFile(
    SESSION,
    'browser.upload.once',
    'ws_upload',
    ref,
    ['demo.mp4'],
  );
  assert.equal(first.state, 'SUCCEEDED');
  assert.equal(resolutions, 1);
  assert.equal(selections, 1);
  assert.deepEqual(selected, [[join(root, 'workspace', 'demo.mp4')]]);

  const replay = await runtime.uploadFile(
    SESSION,
    'browser.upload.once',
    'ws_upload',
    ref,
    ['demo.mp4'],
  );
  assert.equal(replay.effectId, first.effectId);
  assert.equal(replay.state, 'SUCCEEDED');
  assert.equal(resolutions, 1, 'successful retry must not re-resolve workspace files');
  assert.equal(selections, 1, 'successful retry must not dispatch DOM.setFileInputFiles again');

  await assert.rejects(
    () => runtime.uploadFile(SESSION, 'browser.upload.once', 'ws_upload', ref, ['other.mp4']),
    /conflicts with a different effect plan/i,
  );
  assert.equal(selections, 1);
});


test('browser wait_for polls semantic state while assert observes exactly once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-wait-'));
  let snapshots = 0;
  const port: BrowserPort = {
    async open() { throw new Error('unused'); },
    async describe() {
      return {
        browserSessionId: SESSION,
        profileId: 'wait',
        owner: OWNER,
        backend: 'cdp',
        executionMode: 'WAG_HEADLESS',
        ownershipMode: 'WAG_OWNED',
        controlState: 'RUNNING',
        createdAt: 1,
        lastSeenAt: 1,
        state: 'ACTIVE',
      };
    },
    async snapshot() { throw new Error('unused'); },
    async exec() { throw new Error('unused'); },
    async screenshot() { throw new Error('unused'); },
    async close() {
      return {
        browserSessionId: SESSION,
        profileId: 'wait',
        owner: OWNER,
        backend: 'cdp',
        executionMode: 'WAG_HEADLESS',
        ownershipMode: 'WAG_OWNED',
        controlState: 'STOPPED',
        createdAt: 1,
        lastSeenAt: 2,
        state: 'CLOSED',
      };
    },
  };
  const semantic: SemanticBrowser = {
    async snapshot() {
      snapshots += 1;
      const ready = snapshots >= 2;
      const suffix = String(snapshots).padStart(2, '0');
      return {
        snapshotId: '00000000-0000-4000-8000-0000000007' + suffix,
        browserSessionId: SESSION,
        url: 'https://example.test/upload',
        title: ready ? 'Upload ready' : 'Processing',
        nodes: ready ? [{
          ref: 'node_00000000-0000-4000-8000-0000000007' + suffix + '_0',
          role: 'status',
          name: 'Checks complete',
          disabled: false,
          editable: false,
          focusable: false,
        }] : [],
        truncated: false,
      };
    },
    async navigate() { throw new Error('unused'); },
    async click() { throw new Error('unused'); },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async inspectMedia() {
      return {
        tag: 'video',
        paused: false,
        ended: false,
        muted: false,
        volume: 1,
        duration_seconds: 10,
        current_time_seconds: 1,
        playback_rate: 1,
        ready_state: 4,
        network_state: 1,
        error: null,
        audio_evidence: 'PRESENT',
      };
    },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'msedge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    port,
    semantic,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const waited = await runtime.waitFor(SESSION, [
    { kind: 'title', operator: 'contains', value: 'ready' },
    { kind: 'node', role: 'status', name: 'Checks complete' },
  ], 'all', 500, 50);
  assert.equal(waited.matched, true);
  assert.equal(waited.attempts, 2);
  assert.equal(snapshots, 2);

  const beforeAssert = snapshots;
  const asserted = await runtime.assertSemantic(SESSION, [
    { kind: 'url', operator: 'contains', value: '/upload' },
  ]);
  assert.equal(asserted.matched, true);
  assert.equal(asserted.attempts, 1);
  assert.equal(snapshots, beforeAssert + 1, 'browser.assert must make exactly one semantic observation');

  await assert.rejects(
    () => runtime.assertSemantic(SESSION, [
      { kind: 'node', name: 'Processing failed' },
    ]),
    /semantic assertion failed/i,
  );
  assert.equal(snapshots, beforeAssert + 2);

  const media = await runtime.inspectMedia(
    SESSION,
    'node_00000000-0000-4000-8000-000000000702_0',
  );
  assert.equal(media.audio_evidence, 'PRESENT');
});
