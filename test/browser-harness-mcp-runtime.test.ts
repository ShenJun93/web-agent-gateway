import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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


test('browser download captures one attached-tab download into an authority-owned artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-download-runtime-'));
  const sessionId = 'browser_00000000-0000-4000-8000-000000000888';
  const handle = {
    browserSessionId: sessionId,
    profileId: 'download',
    owner: OWNER,
    backend: 'cdp' as const,
    executionMode: 'AI_TAB_GROUP' as const,
    ownershipMode: 'WAG_OWNED' as const,
    controlState: 'RUNNING' as const,
    targetId: 'tab_7',
    claimEpoch: 1,
    claimExpiresAt: Date.now() + 30_000,
    createdAt: 1,
    lastSeenAt: 1,
    state: 'ACTIVE' as const,
  };
  const port: BrowserPort = {
    async open() { return handle; },
    async describe() { return handle; },
    async snapshot() { throw new Error('unused'); },
    async exec() { throw new Error('unused'); },
    async screenshot() { throw new Error('unused'); },
    async close() { return { ...handle, state: 'CLOSED' as const }; },
  };
  const listeners = new Map<string, Set<(params: Readonly<Record<string, unknown>>) => void>>();
  let downloadPath = '';
  const control = {
    async exec(targetId: string, method: string, params?: Readonly<Record<string, unknown>>) {
      assert.equal(targetId, 'tab_7');
      assert.equal(method, 'Browser.setDownloadBehavior');
      assert.equal(params?.behavior, 'allowAndName');
      assert.equal(params?.eventsEnabled, true);
      downloadPath = String(params?.downloadPath ?? '');
      return {};
    },
    onEvent(targetId: string, method: string, listener: (params: Readonly<Record<string, unknown>>) => void) {
      assert.equal(targetId, 'tab_7');
      const key = targetId + ':' + method;
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
  } as any;
  const bytes = Buffer.from('WAG M11 download fixture\n', 'utf8');
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click(_owner, actualSession, ref) {
      assert.equal(actualSession, sessionId);
      assert.equal(ref, 'node_00000000-0000-4000-8000-000000000889_0');
      assert.ok(downloadPath.length > 0, 'download capture must be armed before click');
      await mkdir(downloadPath, { recursive: true });
      await writeFile(join(downloadPath, 'download-1'), bytes);
      for (const listener of listeners.get('tab_7:Browser.downloadWillBegin') ?? []) {
        listener({
          guid: 'download-1',
          url: 'https://example.test/report.txt',
          suggestedFilename: 'report.txt',
        });
      }
      for (const listener of listeners.get('tab_7:Browser.downloadProgress') ?? []) {
        listener({ guid: 'download-1', state: 'completed' });
      }
    },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async inspectMedia() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const effectStatePath = join(root, 'effects.sqlite');
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'msedge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath,
    killSwitch: () => false,
    port,
    semantic,
    control,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const opened = await runtime.open('download', 'AI_TAB_GROUP', undefined, 'WAG M11');
  assert.equal(opened.browserSessionId, sessionId);
  const artifact = await runtime.download(
    sessionId,
    'node_00000000-0000-4000-8000-000000000889_0',
    5_000,
  );
  assert.equal(artifact.filename, 'report.txt');
  assert.equal(artifact.sizeBytes, bytes.length);
  assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
  const persisted = await readFile(join(
    effectStatePath + '.browser-artifacts',
    artifact.artifactId,
    artifact.filename,
  ));
  assert.deepEqual(persisted, bytes);
  assert.equal(listeners.has('tab_7:Browser.downloadWillBegin'), false, 'download begin subscription must be released after completion');
  assert.equal(listeners.has('tab_7:Browser.downloadProgress'), false, 'download progress subscription must be released after completion');
  assert.equal(listeners.has('tab_7:Page.javascriptDialogOpening'), true, 'session dialog opening watcher stays active');
  assert.equal(listeners.has('tab_7:Page.javascriptDialogClosed'), true, 'session dialog closed watcher stays active');
});

test('browser download fails before click when the attached control bridge cannot stream download events', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-download-no-events-'));
  const sessionId = 'browser_00000000-0000-4000-8000-000000000890';
  const handle = {
    browserSessionId: sessionId,
    profileId: 'download-no-events',
    owner: OWNER,
    backend: 'cdp' as const,
    executionMode: 'ATTACH_EXISTING' as const,
    ownershipMode: 'ATTACHED_EXISTING' as const,
    controlState: 'RUNNING' as const,
    targetId: 'tab_7',
    claimEpoch: 1,
    claimExpiresAt: Date.now() + 30_000,
    createdAt: 1,
    lastSeenAt: 1,
    state: 'ACTIVE' as const,
  };
  const port: BrowserPort = {
    async open() { return handle; },
    async describe() { return handle; },
    async snapshot() { throw new Error('unused'); },
    async exec() { throw new Error('unused'); },
    async screenshot() { throw new Error('unused'); },
    async close() { return { ...handle, state: 'CLOSED' as const }; },
  };
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
    port,
    semantic,
    control: { async exec() { return {}; } } as any,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  await runtime.open('download-no-events', 'ATTACH_EXISTING', 'tab_7');
  await assert.rejects(
    () => runtime.download(
      sessionId,
      'node_00000000-0000-4000-8000-000000000891_0',
      5_000,
    ),
    /download capture is unavailable/i,
  );
  assert.equal(clicks, 0, 'missing event bridge must fail before the download-triggering click');
});


test('browser dialogs use stale-safe ids, exact target fencing, and prompt-only text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-dialog-runtime-'));
  const sessionId = 'browser_00000000-0000-4000-8000-000000000892';
  const handle = {
    browserSessionId: sessionId,
    profileId: 'dialog',
    owner: OWNER,
    backend: 'cdp' as const,
    executionMode: 'AI_TAB_GROUP' as const,
    ownershipMode: 'WAG_OWNED' as const,
    controlState: 'RUNNING' as const,
    targetId: 'tab_7',
    claimEpoch: 3,
    claimExpiresAt: Date.now() + 30_000,
    createdAt: 1,
    lastSeenAt: 1,
    state: 'ACTIVE' as const,
  };
  const port: BrowserPort = {
    async open() { return handle; },
    async describe() { return handle; },
    async snapshot() { throw new Error('unused'); },
    async exec() { throw new Error('unused'); },
    async screenshot() { throw new Error('unused'); },
    async close() { return { ...handle, state: 'CLOSED' as const }; },
  };
  const listeners = new Map<string, Set<(params: Readonly<Record<string, unknown>>) => void>>();
  const commands: Array<{ targetId: string; method: string; params?: Readonly<Record<string, unknown>> }> = [];
  const control = {
    async exec(targetId: string, method: string, params?: Readonly<Record<string, unknown>>) {
      commands.push({ targetId, method, params });
      return {};
    },
    onEvent(targetId: string, method: string, listener: (params: Readonly<Record<string, unknown>>) => void) {
      const key = targetId + ':' + method;
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
  } as any;
  const emit = (method: string, params: Readonly<Record<string, unknown>>) => {
    for (const listener of listeners.get('tab_7:' + method) ?? []) listener(params);
  };
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() { throw new Error('unused'); },
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
    control,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  await runtime.open('dialog', 'AI_TAB_GROUP', undefined, 'WAG M13');
  assert.deepEqual(await runtime.dialogGet(sessionId), { open: false });
  assert.equal(listeners.has('tab_7:Page.javascriptDialogOpening'), true);
  assert.equal(listeners.has('tab_7:Page.javascriptDialogClosed'), true);

  emit('Page.javascriptDialogOpening', {
    url: 'https://example.test/',
    message: 'Continue?',
    type: 'confirm',
    defaultPrompt: '',
  });
  const confirm = await runtime.dialogGet(sessionId);
  assert.equal(confirm.open, true);
  if (!confirm.open) throw new Error('confirm dialog missing');
  assert.match(confirm.dialogId, /^dialog_[0-9a-f-]{36}$/);
  assert.equal(confirm.type, 'confirm');
  assert.equal(confirm.message, 'Continue?');

  await assert.rejects(
    () => runtime.dialogRespond(
      sessionId,
      'dialog_00000000-0000-4000-8000-000000000999',
      true,
    ),
    /dialog id is stale/i,
  );
  assert.equal(commands.length, 0, 'stale dialog ids must never dispatch CDP');

  await assert.rejects(
    () => runtime.dialogRespond(sessionId, confirm.dialogId, true, 'not-allowed'),
    /prompt text is only valid for prompt dialogs/i,
  );
  assert.equal(commands.length, 0);

  const dismissed = await runtime.dialogRespond(sessionId, confirm.dialogId, false);
  assert.deepEqual(dismissed, {
    dialogId: confirm.dialogId,
    type: 'confirm',
    accepted: false,
    promptTextProvided: false,
  });
  assert.deepEqual(commands.at(-1), {
    targetId: 'tab_7',
    method: 'Page.handleJavaScriptDialog',
    params: { accept: false },
  });
  assert.deepEqual(await runtime.dialogGet(sessionId), { open: false });

  emit('Page.javascriptDialogOpening', {
    url: 'https://example.test/',
    message: 'Name?',
    type: 'prompt',
    defaultPrompt: 'WAG',
  });
  const prompt = await runtime.dialogGet(sessionId);
  assert.equal(prompt.open, true);
  if (!prompt.open) throw new Error('prompt dialog missing');
  const accepted = await runtime.dialogRespond(sessionId, prompt.dialogId, true, 'Agent');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.promptTextProvided, true);
  assert.deepEqual(commands.at(-1), {
    targetId: 'tab_7',
    method: 'Page.handleJavaScriptDialog',
    params: { accept: true, promptText: 'Agent' },
  });

  await runtime.close(sessionId);
  assert.equal(listeners.has('tab_7:Page.javascriptDialogOpening'), false);
  assert.equal(listeners.has('tab_7:Page.javascriptDialogClosed'), false);
});


test('browser permission policy binds current origin and denies sensitive grants before CDP', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-permission-runtime-'));
  const sessionId = 'browser_00000000-0000-4000-8000-000000000893';
  let epoch = 5;
  const describeEpochs: number[] = [];
  const handle = (claimEpoch = epoch) => ({
    browserSessionId: sessionId,
    profileId: 'permission',
    owner: OWNER,
    backend: 'cdp' as const,
    executionMode: 'AI_TAB_GROUP' as const,
    ownershipMode: 'WAG_OWNED' as const,
    controlState: 'RUNNING' as const,
    targetId: 'tab_7',
    claimEpoch,
    claimExpiresAt: Date.now() + 30_000,
    createdAt: 1,
    lastSeenAt: 1,
    state: 'ACTIVE' as const,
  });
  const port: BrowserPort = {
    async open() { return handle(); },
    async describe() {
      const claimed = describeEpochs.length > 0 ? describeEpochs.shift()! : epoch;
      return handle(claimed);
    },
    async snapshot() { throw new Error('unused'); },
    async exec() { throw new Error('unused'); },
    async screenshot() { throw new Error('unused'); },
    async close() { return { ...handle(), state: 'CLOSED' as const }; },
  };
  const commands: Array<{ targetId: string; method: string; params?: Readonly<Record<string, unknown>> }> = [];
  let origin: string | null = 'https://example.test';
  const control = {
    async describe(targetId: string) {
      assert.equal(targetId, 'tab_7');
      return {
        targetId,
        windowId: 'window_5',
        title: 'Example',
        url: origin ? origin + '/account' : null,
        origin,
        active: false,
        attachable: true,
        ownership: 'USER_EXISTING' as const,
        attached: true,
      };
    },
    async exec(targetId: string, method: string, params?: Readonly<Record<string, unknown>>) {
      commands.push({ targetId, method, params });
      return {};
    },
  } as any;
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() { throw new Error('unused'); },
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
    control,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  await runtime.open('permission', 'AI_TAB_GROUP', undefined, 'WAG M14');

  const granted = await runtime.permissionSet(sessionId, 'notifications', 'granted');
  assert.deepEqual(granted, {
    permission: 'notifications',
    setting: 'granted',
    origin: 'https://example.test',
  });
  assert.deepEqual(commands.at(-1), {
    targetId: 'tab_7',
    method: 'Browser.setPermission',
    params: {
      permission: { name: 'notifications' },
      setting: 'granted',
      origin: 'https://example.test',
    },
  });

  const countAfterNotification = commands.length;
  await assert.rejects(
    () => runtime.permissionSet(sessionId, 'camera', 'granted'),
    /permission grant is denied by WAG policy/i,
  );
  assert.equal(commands.length, countAfterNotification, 'sensitive grant must fail before CDP');

  const denied = await runtime.permissionSet(sessionId, 'camera', 'denied');
  assert.deepEqual(denied, {
    permission: 'camera',
    setting: 'denied',
    origin: 'https://example.test',
  });
  assert.deepEqual(commands.at(-1), {
    targetId: 'tab_7',
    method: 'Browser.setPermission',
    params: {
      permission: { name: 'camera' },
      setting: 'denied',
      origin: 'https://example.test',
    },
  });

  origin = null;
  await assert.rejects(
    () => runtime.permissionSet(sessionId, 'notifications', 'prompt'),
    /current http\/https origin/i,
  );

  origin = 'https://example.test';
  const countBeforeRebound = commands.length;
  describeEpochs.push(6, 7);
  await assert.rejects(
    () => runtime.permissionSet(sessionId, 'notifications', 'prompt'),
    /target fencing binding changed/i,
  );
  assert.equal(commands.length, countBeforeRebound);
});
