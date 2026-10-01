import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { GatewayAuthority } from '../src/caller-context.js';
import type { DesktopPort } from '../src/desktop-harness/desktop-port.js';
import { createPrivateDesktopMcpContext } from '../src/desktop-harness/desktop-mcp-runtime.js';

const OWNER: GatewayAuthority = {
  ownerId: 'local.private.stdio',
  sessionId: 'session_desktop_mcp',
  adapterId: 'private.stdio.v1',
};

test('Desktop MCP runtime keeps semantic effects exact-once and desktop.close does not terminate the process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-desktop-mcp-'));
  let effectCalls = 0;
  let closeCalls = 0;
  const sessionId = 'desktop_00000000-0000-4000-8000-000000000001';
  const target = {
    targetId: 'desktop_target:ws_00000000-0000-4000-8000-000000000002:proc_00000000-0000-4000-8000-000000000003',
    pid: 4321,
    processInstanceId: 'created:1',
    executablePath: 'C:\\fixture.exe',
    nativeWindowId: 'hwnd:1A2B',
    title: 'Fixture',
  };

  const port: DesktopPort = {
    async open() {
      return {
        desktopSessionId: sessionId,
        owner: OWNER,
        target,
        createdAt: 1,
        lastSeenAt: 1,
        state: 'ACTIVE',
      };
    },
    async describe() {
      return {
        desktopSessionId: sessionId,
        owner: OWNER,
        target,
        createdAt: 1,
        lastSeenAt: 2,
        state: 'ACTIVE',
      };
    },
    async snapshot() {
      return {
        snapshotId: '00000000-0000-4000-8000-000000000004',
        desktopSessionId: sessionId,
        target,
        observedAt: 2,
        nodes: [],
      };
    },
    async invoke() { effectCalls += 1; },
    async setValue() { effectCalls += 1; },
    async toggle() { effectCalls += 1; },
    async select() { effectCalls += 1; },
    async screenshot() { return { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }; },
    async close() {
      closeCalls += 1;
      return {
        desktopSessionId: sessionId,
        owner: OWNER,
        target,
        createdAt: 1,
        lastSeenAt: 3,
        state: 'CLOSED',
      };
    },
  };

  const runtime = createPrivateDesktopMcpContext({
    owner: OWNER,
    machineContext: {} as never,
    effectStatePath: join(root, 'desktop-effects.sqlite'),
    killSwitch: () => false,
    port,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const workspaceId = 'ws_00000000-0000-4000-8000-000000000002';
  const processId = 'proc_00000000-0000-4000-8000-000000000003';
  const opened = await runtime.open(workspaceId, processId);
  assert.equal(opened.desktopSessionId, sessionId);
  assert.equal(opened.processId, processId);

  const action = {
    type: 'invoke' as const,
    ref: 'desktop_node_00000000-0000-4000-8000-000000000004_0',
  };
  const first = await runtime.exec(sessionId, 'desktop.invoke.once', action);
  const retry = await runtime.exec(sessionId, 'desktop.invoke.once', action);
  assert.equal(first.state, 'SUCCEEDED');
  assert.equal(retry.effectId, first.effectId);
  assert.equal(retry.resultDigest, first.resultDigest);
  assert.equal(effectCalls, 1, 'idempotent retry must not redispatch UIA action');
  assert.equal((await runtime.effect(first.effectId)).state, 'SUCCEEDED');

  const closed = await runtime.close(sessionId);
  assert.equal(closed.state, 'CLOSED');
  assert.equal(closeCalls, 1);
});

test('Desktop MCP effect boundary rechecks autonomous stop before semantic mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-desktop-stop-'));
  let stopped = false;
  let effects = 0;
  const target = {
    targetId: 'desktop_target:ws_00000000-0000-4000-8000-000000000012:proc_00000000-0000-4000-8000-000000000013',
    pid: 1,
    processInstanceId: 'created:1',
    executablePath: 'C:\\fixture.exe',
    nativeWindowId: 'hwnd:1',
    title: 'Fixture',
  };
  const port: DesktopPort = {
    async open() {
      return {
        desktopSessionId: 'desktop_00000000-0000-4000-8000-000000000011',
        owner: OWNER, target, createdAt: 1, lastSeenAt: 1, state: 'ACTIVE',
      };
    },
    async describe() { throw new Error('unused'); },
    async snapshot() { throw new Error('unused'); },
    async invoke() { effects += 1; },
    async setValue() { effects += 1; },
    async toggle() { effects += 1; },
    async select() { effects += 1; },
    async screenshot() { throw new Error('unused'); },
    async close() {
      return {
        desktopSessionId: 'desktop_00000000-0000-4000-8000-000000000011',
        owner: OWNER, target, createdAt: 1, lastSeenAt: 2, state: 'CLOSED',
      };
    },
  };
  const runtime = createPrivateDesktopMcpContext({
    owner: OWNER,
    machineContext: {} as never,
    effectStatePath: join(root, 'desktop-effects.sqlite'),
    killSwitch: () => stopped,
    port,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  const opened = await runtime.open(
    'ws_00000000-0000-4000-8000-000000000012',
    'proc_00000000-0000-4000-8000-000000000013',
  );
  stopped = true;
  await assert.rejects(
    () => runtime.exec(opened.desktopSessionId, 'desktop.blocked', {
      type: 'invoke',
      ref: 'desktop_node_00000000-0000-4000-8000-000000000014_0',
    }),
    /autonomous stop/,
  );
  assert.equal(effects, 0);
});
