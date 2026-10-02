import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { BrowserMcpContext, BrowserMcpEffect } from '../src/browser-harness/browser-mcp-runtime.js';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import { createGatewayMcpServer, type GatewayApi } from '../src/server.js';
import { ToolUsageDiagnostics } from '../src/tool-usage-diagnostics.js';
import { projectedTools } from '../scripts/prepare-direct-mcp-tunnel.js';

const BROWSER_TOOLS = [
  'browser.targets',
  'browser.open',
  'browser.describe',
  'browser.snapshot',
  'browser.wait_for',
  'browser.assert',
  'browser.media.inspect',
  'browser.exec',
  'browser.upload_file',
  'browser.download',
  'browser.effect.get',
  'browser.screenshot',
  'browser.close',
] as const;

const EFFECT_ID = 'effect_00000000-0000-4000-8000-000000000003';
const ATTEMPT_ID = 'attempt_00000000-0000-4000-8000-000000000004';

function effectView(resourceId: string, kind = 'browser.click'): BrowserMcpEffect {
  return {
    effectId: EFFECT_ID,
    kind,
    resourceId,
    planFingerprint: 'effectfp_test',
    state: 'SUCCEEDED',
    createdAt: 1,
    updatedAt: 2,
    attemptId: ATTEMPT_ID,
    resultDigest: 'sha256_test',
  };
}

function fullBrowserConfig(): PrivateGatewayConfig {
  const root = process.cwd();
  return {
    allowedRoots: [root],
    devspace: {
      baseUrl: 'http://127.0.0.1:7676',
      resourceUrl: 'http://127.0.0.1:7676/mcp',
    },
    verifyProfiles: {
      unit: { argv: ['node', '--version'] },
    },
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath: join(root, '.wag-browser-mcp-test.sqlite'),
        ownerId: 'local.private.stdio',
      },
      gitCommit: {},
      browser: {
        edgeExecutablePath: join(root, 'fake-msedge.exe'),
        profileRoot: join(root, '.wag-browser-profiles'),
      },
    },
  };
}

test('browser opt-in adds the bounded BrowserPort target/session surface to the current extended surface', async () => {
  const config = fullBrowserConfig();
  const repositoryEngineering = config.repositoryEngineering!;
  const { browser: _browser, ...withoutBrowserEngineering } = repositoryEngineering;
  const baseline = await projectedTools({
    ...config,
    repositoryEngineering: withoutBrowserEngineering,
  });
  const projected = await projectedTools(config);
  assert.equal(baseline.missing.length, 0);
  assert.equal(projected.missing.length, 0);
  assert.equal(projected.tools.length, baseline.tools.length + BROWSER_TOOLS.length);
  assert.ok(projected.tools.includes('result.chunk'));
  for (const name of BROWSER_TOOLS) {
    assert.equal(baseline.tools.includes(name), false, name + ' must be browser opt-in only');
    assert.ok(projected.tools.includes(name), name);
  }
  assert.equal(projected.tools.some((name) => name.includes('cdp') || name.includes('playwright')), false,
    'raw transport implementation names must not become public MCP tools');
});

test('browser exact-once recovery correlates diagnostics to durable effect state without replay', async (t) => {
  const calls: unknown[][] = [];
  const browserContext: BrowserMcpContext = {
    async targets() {
      calls.push(['targets']);
      return [{
        targetId: 'tab_7',
        windowId: 'window_3',
        title: 'Existing',
        url: 'https://example.test/',
        origin: 'https://example.test',
        active: false,
        attachable: true,
        ownership: 'USER_EXISTING',
        attached: false,
      }];
    },
    async open(profileId, mode, targetId, groupTitle) {
      calls.push(['open', profileId, mode, targetId, groupTitle]);
      return {
        browserSessionId: 'browser_00000000-0000-4000-8000-000000000001',
        profileId,
        backend: 'cdp',
        ...(mode === undefined ? {} : { executionMode: mode }),
        processId: 'process_00000000-0000-4000-8000-000000000002',
        pid: 1234,
        createdAt: 1,
        lastSeenAt: 1,
        state: 'ACTIVE',
      };
    },
    async describe(browserSessionId) {
      calls.push(['describe', browserSessionId]);
      return {
        browserSessionId,
        profileId: 'acceptance',
        backend: 'cdp',
        createdAt: 1,
        lastSeenAt: 2,
        state: 'ACTIVE',
      };
    },
    async snapshot(browserSessionId) {
      calls.push(['snapshot', browserSessionId]);
      return {
        snapshotId: 'snapshot_test',
        browserSessionId,
        url: 'https://example.test/',
        title: 'Example',
        nodes: [],
        truncated: false,
      };
    },
    async exec(browserSessionId, idempotencyKey, action) {
      calls.push(['exec', browserSessionId, idempotencyKey, action]);
      return effectView(browserSessionId, `browser.${action.type}`);
    },
    async uploadFile(browserSessionId, idempotencyKey, workspaceId, ref, paths) {
      calls.push(['uploadFile', browserSessionId, idempotencyKey, workspaceId, ref, paths]);
      return effectView(browserSessionId, 'browser.upload_file');
    },
    async download(browserSessionId, ref, timeoutMs) {
      calls.push(['download', browserSessionId, ref, timeoutMs]);
      return {
        artifactId: 'artifact_00000000-0000-4000-8000-000000000020',
        filename: 'report.pdf',
        sizeBytes: 123,
        sha256: 'a'.repeat(64),
      };
    },
    async waitFor(browserSessionId, conditions, mode, timeoutMs, intervalMs) {
      calls.push(['waitFor', browserSessionId, conditions, mode, timeoutMs, intervalMs]);
      return {
        matched: true,
        mode: mode ?? 'all',
        results: [],
        browser_session_id: browserSessionId,
        snapshot_id: 'snapshot_wait',
        attempts: 2,
        elapsed_ms: 50,
      };
    },
    async assertSemantic(browserSessionId, conditions, mode) {
      calls.push(['assertSemantic', browserSessionId, conditions, mode]);
      return {
        matched: true,
        mode: mode ?? 'all',
        results: [],
        browser_session_id: browserSessionId,
        snapshot_id: 'snapshot_assert',
        attempts: 1,
        elapsed_ms: 1,
      };
    },
    async inspectMedia(browserSessionId, ref) {
      calls.push(['inspectMedia', browserSessionId, ref]);
      return {
        tag: 'video',
        paused: false,
        ended: false,
        muted: false,
        volume: 1,
        duration_seconds: 30,
        current_time_seconds: 1,
        playback_rate: 1,
        ready_state: 4,
        network_state: 1,
        error: null,
        audio_evidence: 'PRESENT',
        audio_decoded_bytes: 123,
        video_width: 1280,
        video_height: 720,
      };
    },
    async effect(effectId) {
      calls.push(['effect', effectId]);
      return effectView('browser_00000000-0000-4000-8000-000000000001');
    },
    async screenshot(browserSessionId) {
      calls.push(['screenshot', browserSessionId]);
      return { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
    },
    async close(browserSessionId) {
      calls.push(['close', browserSessionId]);
      return {
        browserSessionId,
        profileId: 'acceptance',
        backend: 'cdp',
        createdAt: 1,
        lastSeenAt: 3,
        state: 'CLOSED',
      };
    },
    async pauseForUser(browserSessionId) {
      calls.push(['pauseForUser', browserSessionId]);
      return {
        browserSessionId,
        profileId: 'acceptance',
        backend: 'cdp',
        controlState: 'PAUSED_FOR_USER',
        createdAt: 1,
        lastSeenAt: 3,
        state: 'ACTIVE',
      };
    },
    async takeUserControl(browserSessionId) {
      calls.push(['takeUserControl', browserSessionId]);
      return {
        browserSessionId,
        profileId: 'acceptance',
        backend: 'cdp',
        controlState: 'USER_CONTROL',
        createdAt: 1,
        lastSeenAt: 3,
        state: 'ACTIVE',
      };
    },
    async resumeAutomation(browserSessionId) {
      calls.push(['resumeAutomation', browserSessionId]);
      return {
        browserSessionId,
        profileId: 'acceptance',
        backend: 'cdp',
        controlState: 'RUNNING',
        createdAt: 1,
        lastSeenAt: 3,
        state: 'ACTIVE',
      };
    },
    async suspendForRestart() {},
    async closeAll() {},
  };

  let requestNumber = 1;
  const diagnostics = new ToolUsageDiagnostics({
    capacity: 16,
    randomUUID: () => `00000000-0000-4000-8000-${String(requestNumber++).padStart(12, '0')}`,
  });
  const gateway = {
    health: async () => ({
      status: 'ok' as const,
      executor: 'devspace' as const,
      protocolVersion: 'test',
      toolCount: 6,
    }),
  } as unknown as GatewayApi;
  const server = createGatewayMcpServer(gateway, { browserContext, diagnosticsContext: diagnostics });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-mcp-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });

  const tools = (await client.listTools()).tools;
  for (const name of BROWSER_TOOLS) assert.ok(tools.some((tool) => tool.name === name), name);
  const downloadTool = tools.find((tool) => tool.name === 'browser.download');
  assert.ok(downloadTool);
  assert.deepEqual(downloadTool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });

  const targets = await client.callTool({ name: 'browser.targets', arguments: {} });
  assert.equal(targets.isError === true, false);
  assert.equal((targets.structuredContent as { targets?: unknown[] } | undefined)?.targets?.length, 1);
  assert.deepEqual(calls.at(-1), ['targets']);

  const sessionId = 'browser_00000000-0000-4000-8000-000000000001';
  const executed = await client.callTool({
    name: 'browser.exec',
    arguments: {
      browser_session_id: sessionId,
      idempotency_key: 'acceptance.click.1',
      action: { type: 'click', ref: 'node_00000000-0000-4000-8000-000000000010_0' },
    },
  });
  assert.equal(executed.isError === true, false);
  assert.deepEqual(calls.at(-1), [
    'exec',
    sessionId,
    'acceptance.click.1',
    { type: 'click', ref: 'node_00000000-0000-4000-8000-000000000010_0' },
  ]);
  assert.equal(JSON.stringify(executed.structuredContent).includes('ownerId'), false);
  assert.equal(JSON.stringify(executed.structuredContent).includes('sessionId'), false);
  assert.equal(JSON.stringify(executed.structuredContent).includes('idempotencyKey'), false);

  const uploaded = await client.callTool({
    name: 'browser.upload_file',
    arguments: {
      browser_session_id: sessionId,
      idempotency_key: 'acceptance.upload.1',
      workspace_id: 'ws_upload',
      ref: 'node_00000000-0000-4000-8000-000000000011_0',
      paths: ['demo.mp4'],
    },
  });
  assert.equal(uploaded.isError === true, false);
  assert.deepEqual(calls.at(-1), [
    'uploadFile',
    sessionId,
    'acceptance.upload.1',
    'ws_upload',
    'node_00000000-0000-4000-8000-000000000011_0',
    ['demo.mp4'],
  ]);
  assert.equal(JSON.stringify(uploaded.structuredContent).includes('ownerId'), false);
  assert.equal(JSON.stringify(uploaded.structuredContent).includes('absolute_path'), false);

  const downloaded = await client.callTool({
    name: 'browser.download',
    arguments: {
      browser_session_id: sessionId,
      ref: 'node_00000000-0000-4000-8000-000000000012_0',
      timeout_ms: 5000,
    },
  });
  assert.equal(downloaded.isError === true, false);
  assert.deepEqual(calls.at(-1), [
    'download',
    sessionId,
    'node_00000000-0000-4000-8000-000000000012_0',
    5000,
  ]);
  assert.deepEqual(downloaded.structuredContent, {
    artifact_id: 'artifact_00000000-0000-4000-8000-000000000020',
    filename: 'report.pdf',
    size_bytes: 123,
    sha256: 'a'.repeat(64),
  });
  assert.equal(JSON.stringify(downloaded.structuredContent).includes('internalPath'), false);

  const waitConditions = [{ kind: 'title', operator: 'contains', value: 'Example' }] as const;
  const waited = await client.callTool({
    name: 'browser.wait_for',
    arguments: {
      browser_session_id: sessionId,
      conditions: waitConditions,
      mode: 'all',
      timeout_ms: 1000,
      poll_interval_ms: 100,
    },
  });
  assert.equal(waited.isError === true, false);
  assert.deepEqual(calls.at(-1), ['waitFor', sessionId, waitConditions, 'all', 1000, 100]);
  assert.equal((waited.structuredContent as { matched?: boolean }).matched, true);

  const asserted = await client.callTool({
    name: 'browser.assert',
    arguments: {
      browser_session_id: sessionId,
      conditions: [{ kind: 'url', operator: 'contains', value: 'example.test' }],
    },
  });
  assert.equal(asserted.isError === true, false);
  assert.deepEqual(calls.at(-1), [
    'assertSemantic',
    sessionId,
    [{ kind: 'url', operator: 'contains', value: 'example.test' }],
    undefined,
  ]);

  const media = await client.callTool({
    name: 'browser.media.inspect',
    arguments: {
      browser_session_id: sessionId,
      ref: 'node_00000000-0000-4000-8000-000000000012_0',
    },
  });
  assert.equal(media.isError === true, false);
  assert.deepEqual(calls.at(-1), [
    'inspectMedia',
    sessionId,
    'node_00000000-0000-4000-8000-000000000012_0',
  ]);
  assert.equal((media.structuredContent as { audio_evidence?: string }).audio_evidence, 'PRESENT');

  const recentResponse = await client.callTool({
    name: 'diagnostics.recent',
    arguments: { limit: 10 },
  });
  const recent = recentResponse.structuredContent as {
    events: Array<{
      request_id?: string;
      tool: string;
      effect_id?: string;
      attempt_id?: string;
      success: boolean;
    }>;
    in_flight: unknown[];
  };
  const execEvent = recent.events.find((event) => event.tool === 'browser.exec');
  assert.ok(execEvent);
  assert.match(execEvent.request_id ?? '', /^request_[0-9a-f-]{36}$/);
  assert.equal(execEvent.success, true);
  assert.equal(execEvent.effect_id, EFFECT_ID);
  assert.equal(execEvent.attempt_id, ATTEMPT_ID);
  assert.deepEqual(recent.in_flight, []);

  const recovered = await client.callTool({
    name: 'browser.effect.get',
    arguments: { effect_id: EFFECT_ID },
  });
  assert.equal(recovered.isError === true, false);
  assert.deepEqual(calls.at(-1), ['effect', EFFECT_ID]);
  assert.equal((recovered.structuredContent as { state?: string } | undefined)?.state, 'SUCCEEDED');
  assert.equal(JSON.stringify(recovered.structuredContent).includes('ownerId'), false);
  assert.equal(JSON.stringify(recovered.structuredContent).includes('sessionId'), false);

  const raw = await client.callTool({
    name: 'browser.exec',
    arguments: {
      browser_session_id: sessionId,
      idempotency_key: 'acceptance.raw.1',
      action: { type: 'cdp', method: 'Runtime.evaluate' },
    },
  });
  assert.equal(raw.isError, true, 'raw CDP action must be rejected by the public schema');

  const opened = await client.callTool({
    name: 'browser.open',
    arguments: { profile_id: 'acceptance' },
  });
  assert.equal(opened.isError === true, false);
  assert.equal(JSON.stringify(opened.structuredContent).includes('ownerId'), false);
  assert.equal(JSON.stringify(opened.structuredContent).includes('sessionId'), false);
  assert.equal((opened.structuredContent as { pid?: number } | undefined)?.pid, 1234);

  const visible = await client.callTool({
    name: 'browser.open',
    arguments: { profile_id: 'acceptance-visible', mode: 'WAG_VISIBLE' },
  });
  assert.equal(visible.isError === true, false);
  assert.equal(
    (visible.structuredContent as { executionMode?: string } | undefined)?.executionMode,
    'WAG_VISIBLE',
  );
  assert.deepEqual(calls.filter((row) => row[0] === 'open').at(-1), [
    'open', 'acceptance-visible', 'WAG_VISIBLE', undefined, undefined,
  ]);

  const attached = await client.callTool({
    name: 'browser.open',
    arguments: {
      profile_id: 'acceptance-existing',
      mode: 'ATTACH_EXISTING',
      target_id: 'tab_7',
    },
  });
  assert.equal(attached.isError === true, false);
  assert.deepEqual(calls.filter((row) => row[0] === 'open').at(-1), [
    'open', 'acceptance-existing', 'ATTACH_EXISTING', 'tab_7', undefined,
  ]);

  const grouped = await client.callTool({
    name: 'browser.open',
    arguments: {
      profile_id: 'acceptance-ai-group',
      mode: 'AI_TAB_GROUP',
      target_id: 'tab_7',
      group_title: 'WAG • Acceptance',
    },
  });
  assert.equal(grouped.isError === true, false);
  assert.deepEqual(calls.filter((row) => row[0] === 'open').at(-1), [
    'open', 'acceptance-ai-group', 'AI_TAB_GROUP', 'tab_7', 'WAG • Acceptance',
  ]);

  for (const [index, type] of [
    'pause_for_user',
    'take_user_control',
    'resume_automation',
  ].entries()) {
    const controlled = await client.callTool({
      name: 'browser.exec',
      arguments: {
        browser_session_id: sessionId,
        idempotency_key: `acceptance.control.${index + 1}`,
        action: { type },
      },
    });
    assert.equal(controlled.isError === true, false, type);
    assert.deepEqual(calls.filter((row) => row[0] === 'exec').at(-1), [
      'exec', sessionId, `acceptance.control.${index + 1}`, { type },
    ]);
  }
});
